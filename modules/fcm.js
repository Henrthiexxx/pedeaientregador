// ==================== FCM MODULE ====================
// Push notifications com app fechado

const FCMModule = {
    messaging: null,
    token: null,
    
    async init() {
        // Verifica suporte
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            console.log('Push não suportado');
            return false;
        }
        
        try {
            // Registra Service Worker
            const registration = await navigator.serviceWorker.register('/pedeaientregador/firebase-messaging-sw.js');


            console.log('✅ Service Worker registrado');
            
            // Inicializa messaging
            this.messaging = firebase.messaging();
            
            // Usa o SW registrado
            this.messaging.useServiceWorker(registration);
            
            // Listener para mensagens em foreground
            this.messaging.onMessage((payload) => {
                console.log('📩 Mensagem recebida:', payload);
                this.showForegroundNotification(payload);
            });
            
            return true;
        } catch (err) {
            console.error('Erro ao inicializar FCM:', err);
            return false;
        }
    },
    
    async requestPermissionAndGetToken() {
        try {
            const permission = await Notification.requestPermission();
            
            if (permission !== 'granted') {
                console.log('Permissão negada');
                return null;
            }
            
            // Obtém token FCM
            // IMPORTANTE: Substitua pela sua VAPID key do Firebase Console
            // Firebase Console > Project Settings > Cloud Messaging > Web Push certificates
            const vapidKey = 'BEyLjUm82KxRNv4fCZOWxBln45CjHSleYDOgBCDffXVPP45SsFmZHxJxP0A0hJ0c8uZWdWU8u_YLIacXXYWtCV4';
            
            this.token = await this.messaging.getToken({ vapidKey });
            console.log('🔑 FCM Token:', this.token);
            
            return this.token;
        } catch (err) {
            console.error('Erro ao obter token:', err);
            return null;
        }
    },
    
    getCollection(userType) {
        if (userType === 'store') return 'stores';
        if (userType === 'driver') return 'drivers';
        return 'users';
    },
    
    async saveTokenToFirestore(userId, userType = 'customer') {
        if (!this.token || !userId) return;
        
        const collection = this.getCollection(userType);
        
        try {
            // Usa arrayUnion para não duplicar tokens
            await db.collection(collection).doc(userId).update({
                fcmTokens: firebase.firestore.FieldValue.arrayUnion(this.token),
                lastTokenUpdate: firebase.firestore.FieldValue.serverTimestamp()
            });
            
            console.log('✅ Token salvo no Firestore:', collection);
        } catch (err) {
            // Se doc não existe, cria
            if (err.code === 'not-found') {
                await db.collection(collection).doc(userId).set({
                    fcmTokens: [this.token],
                    lastTokenUpdate: firebase.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
                console.log('✅ Token criado no Firestore:', collection);
            } else {
                console.error('Erro ao salvar token:', err);
            }
        }
    },
    
    async removeToken(userId, userType = 'customer') {
        if (!this.token || !userId) return;
        
        const collection = this.getCollection(userType);
        
        try {
            await db.collection(collection).doc(userId).update({
                fcmTokens: firebase.firestore.FieldValue.arrayRemove(this.token)
            });
            console.log('✅ Token removido do Firestore');
        } catch (err) {
            console.error('Erro ao remover token:', err);
        }
    },
    
    showForegroundNotification(payload) {
        const { title, body } = payload.notification || {};
        const data = payload.data || {};
        
        // Toast no app
        if (typeof showToast === 'function') {
            showToast(body || title || 'Nova atualização');
        }
        
        // Vibra
        if (navigator.vibrate) {
            navigator.vibrate([200, 100, 200]);
        }
        
        // Som
        try {
            const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2teleVVcjrqxlYRwZoOdscCwln10dY2ntbG0sKKYiIJ6dnJ0dnh8gIWJj5SVmJqcoaGhpKSkoqKfn5yZl5KQjYuKiYmJiYmJiYmJiYmJ');
            audio.play().catch(() => {});
        } catch (e) {}
        
        // Notificação do sistema (mesmo em foreground)
        if (Notification.permission === 'granted') {
            new Notification(title || 'Pedrad', {
                body: body,
                icon: '/icon-192.png',
                tag: data.orderId || 'pedrad',
                data: data
            });
        }
    }
};

// ==================== INTEGRAÇÃO ====================

// App Cliente - após login
async function setupPushNotifications() {
    const initialized = await FCMModule.init();
    if (!initialized) return;
    
    const token = await FCMModule.requestPermissionAndGetToken();
    if (token && currentUser) {
        await FCMModule.saveTokenToFirestore(currentUser.uid, 'customer');
    }
}

// Painel da Loja - após carregar loja
async function setupStorePushNotifications(storeId) {
    const initialized = await FCMModule.init();
    if (!initialized) return;
    
    const token = await FCMModule.requestPermissionAndGetToken();
    if (token && storeId) {
        await FCMModule.saveTokenToFirestore(storeId, 'store');
    }
}

// App Entregador - após login
async function setupDriverPushNotifications() {
    const initialized = await FCMModule.init();
    if (!initialized) return;
    
    const token = await FCMModule.requestPermissionAndGetToken();
    if (token && driverData) {
        await FCMModule.saveTokenToFirestore(driverData.id, 'driver');
    }
}

// Logout - limpar token
async function cleanupPushNotifications(userId, userType) {
    await FCMModule.removeToken(userId, userType);
}
