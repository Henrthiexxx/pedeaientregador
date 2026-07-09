const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();

// ==================== HELPERS ====================

async function sendToTokens(tokens, payload) {
    if (!tokens || tokens.length === 0) return;
    // Remove duplicatas
    const unique = [...new Set(tokens)];

    const results = await Promise.allSettled(
        unique.map(token =>
            admin.messaging().send({
                token,
                data: payload.data || {},
                notification: payload.notification || undefined,
                android: {
                    priority: "high",
                    notification: { channelId: "pedra_default", sound: "default" }
                },
                webpush: {
                    headers: { Urgency: "high", TTL: "86400" },
                    fcmOptions: { link: payload.link || "/" }
                }
            }).catch(err => {
                // Token inválido — marcar para limpeza
                if (err.code === "messaging/invalid-registration-token" ||
                    err.code === "messaging/registration-token-not-registered") {
                    return { invalidToken: token };
                }
                console.error("FCM send error:", err.code, token.slice(-8));
                return null;
            })
        )
    );

    // Limpa tokens inválidos
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
        console.log(`Limpou ${invalidTokens.length} tokens de ${collection}/${docId}`);
    } catch (e) { /* ignore */ }
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

// ==================== 1. NOVO PEDIDO → NOTIFICA LOJA ====================

exports.onNewOrder = functions.firestore
    .document("orders/{orderId}")
    .onCreate(async (snap, context) => {
        const order = snap.data();
        const orderId = context.params.orderId;

        if (!order.storeId) return;

        // Notifica a loja
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
                    orderId: orderId,
                    customerName: order.userName || "Cliente",
                    total: String(order.total || 0),
                    click_action: "/pedeai/index.html"
                },
                link: "/pedeai/index.html"
            });

            if (result.invalid.length > 0) {
                await cleanInvalidTokens("stores", order.storeId, result.invalid);
            }

            console.log(`Loja ${order.storeId} notificada: ${result.sent} enviados`);
        } catch (err) {
            console.error("onNewOrder erro:", err);
        }
    });

// ==================== 2. STATUS MUDOU → NOTIFICA DRIVERS / CLIENTE ====================

exports.onOrderUpdate = functions.firestore
    .document("orders/{orderId}")
    .onUpdate(async (change, context) => {
        const before = change.before.data();
        const after = change.after.data();
        const orderId = context.params.orderId;

        // Só age se status mudou
        if (before.status === after.status) return;

        const promises = [];

        // ---- A) Pedido precisa de entregador → notifica drivers online ----
        if (!after.driverId &&
            after.orderType === "delivery" &&
            ["store", "app"].includes(after.deliveryPool) &&
            ["preparing", "ready"].includes(after.status)) {

            promises.push(notifyAvailableDrivers(after, orderId));
        }

        // ---- B) Pedido pronto para retirada → notifica driver atribuído ----
        if (after.driverId &&
            before.status !== "ready" &&
            after.status === "ready") {

            promises.push(notifyAssignedDriver(after, orderId));
        }

        // ---- C) Pedido em entrega → notifica cliente ----
        if (after.status === "delivering" && before.status !== "delivering") {
            promises.push(notifyCustomer(after, orderId, "🛵 Saiu para entrega!", "Seu pedido está a caminho"));
        }

        // ---- D) Pedido entregue → notifica cliente ----
        if (after.status === "delivered" && before.status !== "delivered") {
            promises.push(notifyCustomer(after, orderId, "✅ Pedido Entregue!", "Seu pedido foi entregue. Bom apetite!"));
        }

        await Promise.allSettled(promises);
    });

// ==================== NOTIFY: DRIVERS DISPONÍVEIS ====================

async function notifyAvailableDrivers(order, orderId) {
    try {
        // Busca drivers online
        const driversSnap = await db.collection("drivers")
            .where("online", "==", true)
            .where("status", "==", "active")
            .get();

        if (driversSnap.empty) return;

        const allTokens = [];
        const tokenOwners = {}; // token → driverId (para limpeza)

        driversSnap.docs.forEach(doc => {
            const d = doc.data();
            const tokens = d.fcmTokens || [];
            const linkedStores = getDriverStoreIds(d);
            const isLinked = order.storeId && linkedStores.has(String(order.storeId));
            if (order.deliveryPool === "store" && !isLinked) return;
            if (order.deliveryPool === "app" && isStoreBoundDriver(d)) return;

            tokens.forEach(t => {
                allTokens.push(t);
                tokenOwners[t] = doc.id;
            });
        });

        if (allTokens.length === 0) return;

        const neighborhood = order.address?.neighborhood || "";
        const result = await sendToTokens(allTokens, {
            notification: {
                title: "📦 Nova Entrega!",
                body: `${order.storeName || "Loja"} → ${neighborhood}`
            },
            data: {
                type: "new_order",
                orderId: orderId,
                storeName: order.storeName || "Loja",
                neighborhood: neighborhood,
                storeId: order.storeId || "",
                click_action: "/pedeaientregador/home.html"
            },
            link: "/pedeaientregador/home.html"
        });

        // Limpa tokens inválidos por driver
        if (result.invalid.length > 0) {
            const byDriver = {};
            result.invalid.forEach(t => {
                const did = tokenOwners[t];
                if (did) {
                    if (!byDriver[did]) byDriver[did] = [];
                    byDriver[did].push(t);
                }
            });
            for (const [did, tokens] of Object.entries(byDriver)) {
                await cleanInvalidTokens("drivers", did, tokens);
            }
        }

        console.log(`Drivers notificados: ${result.sent} enviados para pedido ${orderId}`);
    } catch (err) {
        console.error("notifyAvailableDrivers erro:", err);
    }
}

// ==================== NOTIFY: DRIVER ATRIBUÍDO ====================

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
                orderId: orderId,
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

// ==================== NOTIFY: CLIENTE ====================

async function notifyCustomer(order, orderId, title, body) {
    // Tenta pelo userId do pedido
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
                orderId: orderId,
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
