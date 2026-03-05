// functions/index.js
// Cloud Functions - Push Notifications Pedrad
// Unificado: 2 functions (onCreate + onUpdate) em vez de 5

const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

const db = admin.firestore();
const messaging = admin.messaging();

function formatCurrency(value) {
    return new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL'
    }).format(value || 0);
}

// Remove tokens inválidos de uma collection
async function cleanInvalidTokens(collection, docId, tokens, responses) {
    const tokensToRemove = [];
    responses.forEach((resp, idx) => {
        if (!resp.success) {
            const code = resp.error?.code;
            if (code === 'messaging/invalid-registration-token' ||
                code === 'messaging/registration-token-not-registered') {
                tokensToRemove.push(tokens[idx]);
            }
        }
    });
    if (tokensToRemove.length > 0) {
        await db.collection(collection).doc(docId).update({
            fcmTokens: admin.firestore.FieldValue.arrayRemove(...tokensToRemove)
        });
        console.log(`🗑️ ${tokensToRemove.length} tokens removidos de ${collection}/${docId}`);
    }
}

// Envia multicast em lotes de 500
async function sendInChunks(tokens, payload) {
    for (let i = 0; i < tokens.length; i += 500) {
        const chunk = tokens.slice(i, i + 500);
        const res = await messaging.sendEachForMulticast({ tokens: chunk, ...payload });
        console.log(`✅ Lote: ${res.successCount} ok, ${res.failureCount} falha`);
    }
}

// ============================================================
// 1. NOVO PEDIDO → notifica LOJA + DRIVERS online
// ============================================================
exports.onNewOrder = functions.firestore
    .document('orders/{orderId}')
    .onCreate(async (snap, context) => {
        const order = snap.data();
        const orderId = context.params.orderId;
        const orderCode = orderId.slice(-6).toUpperCase();
        const storeId = order.storeId;

        console.log(`🆕 Novo pedido ${orderId} para loja ${storeId}`);

        // --- Notifica a LOJA ---
        if (storeId) {
            try {
                const storeDoc = await db.collection('stores').doc(storeId).get();
                const storeTokens = storeDoc.exists ? (storeDoc.data().fcmTokens || []) : [];

                if (storeTokens.length > 0) {
                    const res = await messaging.sendEachForMulticast({
                        tokens: storeTokens,
                        notification: {
                            title: '🔔 Novo Pedido!',
                            body: `#${orderCode} - ${order.userName || 'Cliente'} - ${formatCurrency(order.total)}`
                        },
                        data: {
                            type: 'new_order',
                            orderId,
                            storeId,
                            click_action: 'OPEN_STORE_PANEL'
                        },
                        android: { priority: 'high', notification: { sound: 'default', channelId: 'new_orders' } },
                        apns: { payload: { aps: { sound: 'default', badge: 1 } } }
                    });
                    console.log(`✅ Loja notificada: ${res.successCount} ok`);
                    if (res.failureCount > 0) await cleanInvalidTokens('stores', storeId, storeTokens, res.responses);
                }
            } catch (err) {
                console.error('Erro notificar loja:', err);
            }
        }

        // --- Notifica DRIVERS online (pedido sem entregador e não é pickup) ---
        if (!order.driverId && order.deliveryMode !== 'pickup') {
            try {
                const driversSnap = await db.collection('drivers').where('online', '==', true).get();
                const driverTokens = [];
                driversSnap.docs.forEach(doc => {
                    (doc.data().fcmTokens || []).forEach(t => driverTokens.push(t));
                });

                if (driverTokens.length > 0) {
                    await sendInChunks(driverTokens, {
                        notification: {
                            title: '📦 Nova Entrega!',
                            body: `${order.storeName || 'Loja'} → ${order.address?.neighborhood || ''}`
                        },
                        data: {
                            type: 'new_order',
                            orderId,
                            storeName: order.storeName || '',
                            neighborhood: order.address?.neighborhood || ''
                        }
                    });
                    console.log(`✅ ${driverTokens.length} tokens de drivers notificados`);
                }
            } catch (err) {
                console.error('Erro notificar drivers:', err);
            }
        }

        return null;
    });

// ============================================================
// 2. PEDIDO ATUALIZADO → unificado (cliente + driver)
//    Substitui: onOrderUpdate + onOrderReady + onDriverAssignedReady
// ============================================================
const statusMessages = {
    confirmed:  { title: '✅ Pedido Confirmado!', body: 'Seu pedido foi aceito e será preparado em breve.' },
    preparing:  { title: '👨‍🍳 Preparando...',     body: 'Seu pedido está sendo preparado!' },
    ready:      { title: '📦 Pedido Pronto!',     body: 'Seu pedido está pronto!' },
    delivering: { title: '🛵 Saiu para Entrega!', body: 'Seu pedido está a caminho!' },
    delivered:  { title: '✅ Entregue!',           body: 'Pedido entregue! Bom apetite!' },
    cancelled:  { title: '❌ Pedido Cancelado',    body: 'Seu pedido foi cancelado.' }
};

exports.onOrderUpdate = functions.firestore
    .document('orders/{orderId}')
    .onUpdate(async (change, context) => {
        const before = change.before.data();
        const after = change.after.data();
        const orderId = context.params.orderId;
        const orderCode = orderId.slice(-6).toUpperCase();

        const statusChanged = before.status !== after.status;
        const driverJustAssigned = !before.driverId && !!after.driverId;

        // Nada relevante mudou → sai
        if (!statusChanged && !driverJustAssigned) return null;

        console.log(`📦 Pedido ${orderId}: ${before.status}→${after.status} | driver: ${before.driverId || 'none'}→${after.driverId || 'none'}`);

        // --- A) Notifica CLIENTE sobre mudança de status ---
        if (statusChanged && after.userId) {
            const msg = statusMessages[after.status];
            if (msg) {
                try {
                    const userDoc = await db.collection('users').doc(after.userId).get();
                    const tokens = userDoc.exists ? (userDoc.data().fcmTokens || []) : [];

                    if (tokens.length > 0) {
                        const res = await messaging.sendEachForMulticast({
                            tokens,
                            notification: {
                                title: msg.title,
                                body: `Pedido #${orderCode} - ${msg.body}`
                            },
                            data: {
                                type: 'order_update',
                                orderId,
                                status: after.status,
                                click_action: 'OPEN_ORDER'
                            }
                        });
                        console.log(`✅ Cliente: ${res.successCount} ok, ${res.failureCount} falha`);
                        if (res.failureCount > 0) await cleanInvalidTokens('users', after.userId, tokens, res.responses);
                    }
                } catch (err) {
                    console.error('Erro notificar cliente:', err);
                }
            }
        }

        // --- B) Notifica DRIVER quando pedido fica "ready" ---
        // Cenário 1: status mudou para ready e já tem driver
        // Cenário 2: driver acabou de ser atribuído e pedido já estava ready
        const shouldNotifyDriver =
            (statusChanged && after.status === 'ready' && after.driverId) ||
            (driverJustAssigned && after.status === 'ready');

        if (shouldNotifyDriver) {
            try {
                const driverDoc = await db.collection('drivers').doc(after.driverId).get();
                const tokens = driverDoc.exists ? (driverDoc.data().fcmTokens || []) : [];

                if (tokens.length > 0) {
                    const res = await messaging.sendEachForMulticast({
                        tokens,
                        notification: {
                            title: '📦 Pedido Pronto!',
                            body: `#${orderCode} - ${after.storeName || 'Loja'} pronto para retirada`
                        },
                        data: {
                            type: 'order_ready',
                            orderId
                        }
                    });
                    console.log(`✅ Driver: ${res.successCount} ok`);
                    if (res.failureCount > 0) await cleanInvalidTokens('drivers', after.driverId, tokens, res.responses);
                }
            } catch (err) {
                console.error('Erro notificar driver:', err);
            }
        }

        return null;
    });