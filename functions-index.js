const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();

// ══════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════

async function sendToTokens(tokens, payload) {
    if (!tokens || tokens.length === 0) return { sent: 0, invalid: [] };
    const unique = [...new Set(tokens)];

    const results = await Promise.allSettled(
        unique.map(token =>
            admin.messaging().send({
                token,
                data: payload.data || {},
                notification: payload.notification || undefined,
                android: {
                    priority: "high",
                    notification: { channelId: "pedrad_orders", sound: "default" }
                },
                webpush: {
                    headers: { Urgency: "high", TTL: "86400" },
                    fcmOptions: { link: payload.link || "/" }
                }
            }).catch(err => {
                if (err.code === "messaging/invalid-registration-token" ||
                    err.code === "messaging/registration-token-not-registered") {
                    return { invalidToken: token };
                }
                console.error("FCM send error:", err.code, token.slice(-8));
                return null;
            })
        )
    );

    const invalid = results
        .filter(r => r.status === "fulfilled" && r.value?.invalidToken)
        .map(r => r.value.invalidToken);

    return { sent: unique.length - invalid.length, invalid };
}

async function cleanInvalidTokens(collection, docId, invalidTokens) {
    if (!invalidTokens || invalidTokens.length === 0) return;
    try {
        await db.collection(collection).doc(docId).update({
            fcmTokens: admin.firestore.FieldValue.arrayRemove(...invalidTokens)
        });
    } catch (e) { /* ignore */ }
}

// Checa se pedido é local (PDV) e não precisa de entregador
function isLocalOrder(order) {
    const orderType = order.orderType || order.deliveryMode;
    return order.noDelivery === true ||
           order.source === 'pdv' ||
           orderType === 'local' ||
           orderType === 'pickup';
}

function getDriverStoreIds(driver) {
    const ids = new Set();
    if (driver.linkedStoreId) ids.add(String(driver.linkedStoreId));
    if (driver.storeId) ids.add(String(driver.storeId));
    if (Array.isArray(driver.linkedStores)) {
        driver.linkedStores.filter(Boolean).forEach(id => ids.add(String(id)));
    }
    return ids;
}

function isStoreBoundDriver(driver) {
    return getDriverStoreIds(driver).size > 0;
}

// ══════════════════════════════════════════════
//  1. NOVO PEDIDO → NOTIFICA LOJA
// ══════════════════════════════════════════════

exports.onNewOrder = functions.firestore
    .document("orders/{orderId}")
    .onCreate(async (snap, context) => {
        const order = snap.data();
        const orderId = context.params.orderId;
        if (!order.storeId) return;

        // Pedido local/PDV: notifica loja mas NÃO entregadores
        try {
            const storeDoc = await db.collection("stores").doc(order.storeId).get();
            if (!storeDoc.exists) return;
            const store = storeDoc.data();
            const tokens = store.fcmTokens || [];
            if (tokens.length === 0) return;

            const result = await sendToTokens(tokens, {
                notification: {
                    title: "🔔 Novo Pedido!",
                    body: `#${orderId.slice(-6).toUpperCase()} — ${order.userName || "Cliente"} — R$ ${(order.total || 0).toFixed(2)}`
                },
                data: {
                    type: "new_order",
                    orderId,
                    customerName: order.userName || "Cliente",
                    total: String(order.total || 0),
                    click_action: "/pedeai/index.html"
                },
                link: "/pedeai/index.html"
            });

            if (result.invalid.length > 0) {
                await cleanInvalidTokens("stores", order.storeId, result.invalid);
            }
        } catch (err) {
            console.error("onNewOrder erro:", err);
        }
    });

// ══════════════════════════════════════════════
//  2. STATUS MUDOU → DISPATCH INTELIGENTE
// ══════════════════════════════════════════════

exports.onOrderUpdate = functions.firestore
    .document("orders/{orderId}")
    .onUpdate(async (change, context) => {
        const before = change.before.data();
        const after = change.after.data();
        const orderId = context.params.orderId;

        if (before.status === after.status) return;

        // ★ Pedido local/PDV: NUNCA notifica entregadores
        if (isLocalOrder(after)) {
            // Apenas notifica cliente se necessário
            if (after.status === "delivering" && before.status !== "delivering") {
                await notifyCustomer(after, orderId, "🛵 Saiu para entrega!", "Seu pedido está a caminho");
            }
            if (after.status === "delivered" && before.status !== "delivered") {
                await notifyCustomer(after, orderId, "✅ Pedido Entregue!", "Seu pedido foi entregue. Bom apetite!");
            }
            return;
        }

        const promises = [];

        // A) Precisa de entregador → dispatch inteligente
        if (!after.driverId &&
            after.orderType === "delivery" &&
            ["store", "app"].includes(after.deliveryPool) &&
            ["preparing", "ready"].includes(after.status)) {
            promises.push(dispatchOrder(after, orderId));
        }

        // B) Pronto para retirada → notifica driver atribuído
        if (after.driverId && before.status !== "ready" && after.status === "ready") {
            promises.push(notifyAssignedDriver(after, orderId));
        }

        // C) Em entrega → notifica cliente
        if (after.status === "delivering" && before.status !== "delivering") {
            promises.push(notifyCustomer(after, orderId, "🛵 Saiu para entrega!", "Seu pedido está a caminho"));
        }

        // D) Entregue → notifica cliente
        if (after.status === "delivered" && before.status !== "delivered") {
            promises.push(notifyCustomer(after, orderId, "✅ Pedido Entregue!", "Seu pedido foi entregue. Bom apetite!"));
        }

        await Promise.allSettled(promises);
    });

// ══════════════════════════════════════════════
//  DISPATCH INTELIGENTE (substituiu notifyAvailableDrivers)
// ══════════════════════════════════════════════
//
//  Fluxo:
//  1. Busca drivers online + ativos
//  2. Filtra por elegibilidade (store drivers da loja > app eligible > app drivers)
//  3. Ordena por score (menos entregas recentes = mais prioridade)
//  4. Tier 1: notifica pool menor (vinculados à loja)
//  5. Tier 2: se ninguém vinculado, abre para pool geral
//  6. Rate limit: max 3 ofertas por pedido, max 5 ofertas/min por driver
//  7. Cria dispatch offer no Firestore com TTL

async function dispatchOrder(order, orderId) {
    try {
        // Evita duplicar ofertas para o mesmo pedido.
        const existingOffers = await db.collection("dispatchOffers")
            .where("orderId", "==", orderId)
            .where("status", "==", "pending")
            .get();

        if (!existingOffers.empty) return;

        // Busca drivers online e ativos
        const driversSnap = await db.collection("drivers")
            .where("online", "==", true)
            .where("status", "==", "active")
            .get();

        if (driversSnap.empty) return;

        const now = Date.now();
        const storeId = order.storeId;

        // Filtra drivers elegíveis
        const allDrivers = [];
        for (const doc of driversSnap.docs) {
            const d = doc.data();
            const tokens = d.fcmTokens || [];
            if (tokens.length === 0) continue;

            const linkedStores = getDriverStoreIds(d);
            const isLinked = storeId && linkedStores.has(String(storeId));
            const storeBound = isStoreBoundDriver(d);
            if (order.deliveryPool === "store" && !isLinked) continue;
            if (order.deliveryPool === "app" && storeBound) continue;

            const totalDeliveries = d.totalDeliveries || 0;
            const lastDelivery = d.lastDeliveryAt?.toDate?.()?.getTime() || 0;
            const score = ((now - lastDelivery) / 60000) - (totalDeliveries * 0.1);

            allDrivers.push({
                id: doc.id, tokens, isLinked, score,
                tier: isLinked ? 1 : 3
            });
        }

        if (allDrivers.length === 0) return;

        allDrivers.sort((a, b) => a.tier !== b.tier ? a.tier - b.tier : b.score - a.score);

        const pool = allDrivers;

        // Cria ofertas em batch
        const batch = db.batch();
        const allTokens = [];
        const tokenOwners = {};

        for (const driver of pool) {
            const ref = db.collection("dispatchOffers").doc();
            batch.set(ref, {
                orderId, driverId: driver.id, storeId: storeId || null,
                status: "pending", tier: driver.tier, score: driver.score,
                expiresAt: new Date(now + 120000),
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            driver.tokens.forEach(t => { allTokens.push(t); tokenOwners[t] = driver.id; });
        }

        await batch.commit();

        const neighborhood = order.address?.neighborhood || "";
        const result = await sendToTokens(allTokens, {
            notification: { title: "📦 Nova Entrega!", body: `${order.storeName || "Loja"} → ${neighborhood}` },
            data: {
                type: "new_order", orderId, storeName: order.storeName || "Loja",
                neighborhood, storeId: storeId || "",
                click_action: "/pedeaientregador/home.html"
            },
            link: "/pedeaientregador/home.html"
        });

        if (result.invalid.length > 0) {
            const byDriver = {};
            result.invalid.forEach(t => { const d = tokenOwners[t]; if (d) { if (!byDriver[d]) byDriver[d] = []; byDriver[d].push(t); } });
            for (const [did, tks] of Object.entries(byDriver)) await cleanInvalidTokens("drivers", did, tks);
        }

        console.log(`Dispatch ${orderId}: ${pool.length} drivers (tier1: ${tier1.length})`);
    } catch (err) {
        console.error("dispatchOrder erro:", err);
    }
}

// ══════════════════════════════════════════════
//  DISPATCH: LIMPA OFERTAS EXPIRADAS (scheduled)
// ══════════════════════════════════════════════

exports.cleanExpiredOffers = functions.pubsub
    .schedule("every 5 minutes")
    .onRun(async () => {
        const now = new Date();
        const expired = await db.collection("dispatchOffers")
            .where("status", "==", "pending")
            .where("expiresAt", "<", now)
            .limit(100)
            .get();

        if (expired.empty) return;

        const batch = db.batch();
        expired.docs.forEach(doc => {
            batch.update(doc.ref, { status: "expired" });
        });
        await batch.commit();
        console.log(`Limpou ${expired.size} ofertas expiradas`);
    });

// ══════════════════════════════════════════════
//  DISPATCH: DRIVER RECUSOU (callable)
// ══════════════════════════════════════════════

exports.declineOffer = functions.https.onCall(async (data, context) => {
    const { offerId } = data;
    if (!offerId) throw new functions.https.HttpsError("invalid-argument", "offerId required");

    const offerRef = db.collection("dispatchOffers").doc(offerId);
    const offer = await offerRef.get();
    if (!offer.exists) throw new functions.https.HttpsError("not-found", "Offer not found");

    await offerRef.update({
        status: "declined",
        declinedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { success: true };
});

// ══════════════════════════════════════════════
//  NOTIFY: DRIVER ATRIBUÍDO (pedido pronto)
// ══════════════════════════════════════════════

async function notifyAssignedDriver(order, orderId) {
    try {
        const driverDoc = await db.collection("drivers").doc(order.driverId).get();
        if (!driverDoc.exists) return;
        const tokens = driverDoc.data().fcmTokens || [];
        if (tokens.length === 0) return;

        const result = await sendToTokens(tokens, {
            notification: {
                title: "✅ Pedido Pronto!",
                body: `#${orderId.slice(-6).toUpperCase()} pronto para retirada em ${order.storeName || "Loja"}`
            },
            data: {
                type: "order_ready",
                orderId,
                storeName: order.storeName || "Loja",
                click_action: "/pedeaientregador/home.html"
            },
            link: "/pedeaientregador/home.html"
        });

        if (result.invalid.length > 0) {
            await cleanInvalidTokens("drivers", order.driverId, result.invalid);
        }
    } catch (err) {
        console.error("notifyAssignedDriver erro:", err);
    }
}

// ══════════════════════════════════════════════
//  NOTIFY: CLIENTE
// ══════════════════════════════════════════════

async function notifyCustomer(order, orderId, title, body) {
    const userId = order.userId || order.uid;
    if (!userId) return;

    try {
        const userDoc = await db.collection("users").doc(userId).get();
        if (!userDoc.exists) return;
        const tokens = userDoc.data().fcmTokens || [];
        if (tokens.length === 0) return;

        const result = await sendToTokens(tokens, {
            notification: { title, body },
            data: {
                type: "order_status",
                orderId,
                status: order.status,
                message: body
            }
        });

        if (result.invalid.length > 0) {
            await cleanInvalidTokens("users", userId, result.invalid);
        }
    } catch (err) {
        console.error("notifyCustomer erro:", err);
    }
}

// ══════════════════════════════════════════════
//  SYNC: COVERED STORES (mantém config doc)
// ══════════════════════════════════════════════
//  Quando linkedStores de um driver muda, atualiza config/coveredStores
//  Isso evita que o client leia TODOS os drivers para saber quais lojas tem entregador

exports.onDriverUpdate = functions.firestore
    .document("drivers/{driverId}")
    .onWrite(async (change, context) => {
        const before = change.before.exists ? change.before.data() : {};
        const after = change.after.exists ? change.after.data() : {};

        const beforeStores = (before.linkedStores || []).sort().join(",");
        const afterStores = (after.linkedStores || []).sort().join(",");

        // Só recomputa se linkedStores mudou
        if (beforeStores === afterStores) return;

        try {
            const snap = await db.collection("drivers")
                .where("status", "in", ["active", "approved"])
                .get();

            const allStoreIds = new Set();
            snap.docs.forEach(doc => {
                (doc.data().linkedStores || []).forEach(sid => allStoreIds.add(sid));
            });

            await db.collection("config").doc("coveredStores").set({
                storeIds: [...allStoreIds],
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (e) {
            console.error("syncCoveredStores erro:", e);
        }
    });
