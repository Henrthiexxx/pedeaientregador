// functions/index.js
// Cloud Function para enviar push notifications

const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

const db = admin.firestore();
const messaging = admin.messaging();

// Mensagens por status
const statusMessages = {
    confirmed: { title: '✅ Pedido Confirmado!', body: 'Seu pedido foi aceito e será preparado em breve.' },
    preparing: { title: '👨‍🍳 Preparando...', body: 'Seu pedido está sendo preparado!' },
    ready: { title: '📦 Pedido Pronto!', body: 'Seu pedido está pronto!' },
    delivering: { title: '🛵 Saiu para Entrega!', body: 'Seu pedido está a caminho!' },
    delivered: { title: '✅ Entregue!', body: 'Pedido entregue! Bom apetite!' },
    cancelled: { title: '❌ Pedido Cancelado', body: 'Seu pedido foi cancelado.' }
};

// Trigger: quando pedido é atualizado
exports.onOrderUpdate = functions.firestore
    .document('orders/{orderId}')
    .onUpdate(async (change, context) => {
        const before = change.before.data();
        const after = change.after.data();
        const orderId = context.params.orderId;
        
        // Se status não mudou, ignora
        if (before.status === after.status) {
            return null;
        }
        
        console.log(`📦 Pedido ${orderId}: ${before.status} → ${after.status}`);
        
        const newStatus = after.status;
        const userId = after.userId;
        const orderCode = orderId.slice(-6).toUpperCase();
        
        // Busca tokens do usuário
        try {
            const userDoc = await db.collection('users').doc(userId).get();
            
            if (!userDoc.exists) {
                console.log('Usuário não encontrado:', userId);
                return null;
            }
            
            const tokens = userDoc.data().fcmTokens || [];
            
            if (tokens.length === 0) {
                console.log('Usuário sem tokens FCM');
                return null;
            }
            
            const messageData = statusMessages[newStatus];
            if (!messageData) {
                console.log('Status sem mensagem:', newStatus);
                return null;
            }
            
            // Monta a notificação
            const message = {
                notification: {
                    title: messageData.title,
                    body: `Pedido #${orderCode} - ${messageData.body}`
                },
                data: {
                    type: 'order_update',
                    orderId: orderId,
                    status: newStatus,
                    click_action: 'OPEN_ORDER'
                },
                tokens: tokens
            };
            
            // Envia para todos os dispositivos do usuário
            const response = await messaging.sendEachForMulticast(message);
            
            console.log(`✅ Enviado: ${response.successCount} sucesso, ${response.failureCount} falha`);
            
            // Remove tokens inválidos
            if (response.failureCount > 0) {
                const tokensToRemove = [];
                response.responses.forEach((resp, idx) => {
                    if (!resp.success) {
                        const error = resp.error;
                        if (error.code === 'messaging/invalid-registration-token' ||
                            error.code === 'messaging/registration-token-not-registered') {
                            tokensToRemove.push(tokens[idx]);
                        }
                    }
                });
                
                if (tokensToRemove.length > 0) {
                    await db.collection('users').doc(userId).update({
                        fcmTokens: admin.firestore.FieldValue.arrayRemove(...tokensToRemove)
                    });
                    console.log('🗑️ Tokens removidos:', tokensToRemove.length);
                }
            }
            
            return response;
        } catch (err) {
            console.error('Erro ao enviar notificação:', err);
            return null;
        }
    });

// Trigger: novo pedido - notifica a loja
exports.onNewOrder = functions.firestore
    .document('orders/{orderId}')
    .onCreate(async (snap, context) => {
        const order = snap.data();
        const orderId = context.params.orderId;
        const storeId = order.storeId;
        const orderCode = orderId.slice(-6).toUpperCase();
        
        console.log(`🆕 Novo pedido ${orderId} para loja ${storeId}`);
        
        try {
            const storeDoc = await db.collection('stores').doc(storeId).get();
            
            if (!storeDoc.exists) {
                console.log('Loja não encontrada:', storeId);
                return null;
            }
            
            const tokens = storeDoc.data().fcmTokens || [];
            
            if (tokens.length === 0) {
                console.log('Loja sem tokens FCM');
                return null;
            }
            
            const message = {
                notification: {
                    title: '🔔 Novo Pedido!',
                    body: `#${orderCode} - ${order.userName} - ${formatCurrency(order.total)}`
                },
                data: {
                    type: 'new_order',
                    orderId: orderId,
                    storeId: storeId,
                    click_action: 'OPEN_STORE_PANEL'
                },
                android: {
                    priority: 'high',
                    notification: {
                        sound: 'default',
                        channelId: 'new_orders'
                    }
                },
                apns: {
                    payload: {
                        aps: {
                            sound: 'default',
                            badge: 1
                        }
                    }
                },
                tokens: tokens
            };
            
            const response = await messaging.sendEachForMulticast(message);
            console.log(`✅ Loja notificada: ${response.successCount} sucesso`);
            
            // Limpa tokens inválidos
            if (response.failureCount > 0) {
                const tokensToRemove = [];
                response.responses.forEach((resp, idx) => {
                    if (!resp.success) {
                        const error = resp.error;
                        if (error.code === 'messaging/invalid-registration-token' ||
                            error.code === 'messaging/registration-token-not-registered') {
                            tokensToRemove.push(tokens[idx]);
                        }
                    }
                });
                
                if (tokensToRemove.length > 0) {
                    await db.collection('stores').doc(storeId).update({
                        fcmTokens: admin.firestore.FieldValue.arrayRemove(...tokensToRemove)
                    });
                }
            }
            
            return response;
        } catch (err) {
            console.error('Erro ao notificar loja:', err);
            return null;
        }
    });

function formatCurrency(value) {
    return new Intl.NumberFormat('pt-BR', { 
        style: 'currency', 
        currency: 'BRL' 
    }).format(value || 0);
}
