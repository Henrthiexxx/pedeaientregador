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
            const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
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
            const vapidKey = 'SUA_VAPID_KEY_AQUI';
            
            this.token = await this.messaging.getToken({ vapidKey });
            console.log('🔑 FCM Token:', this.token);
            
            return this.token;
        } catch (err) {
            console.error('Erro ao obter token:', err);
            return null;
        }
    },
    
    async saveTokenToFirestore(userId, userType = 'customer') {
        if (!this.token || !userId) return;
        
        try {
            // Salva/atualiza token no documento do usuário
            const collection = userType === 'store' ? 'stores' : 'users';
            const field = 'fcmTokens';
            
            // Usa arrayUnion para não duplicar tokens
            await db.collection(collection).doc(userId).update({
                [field]: firebase.firestore.FieldValue.arrayUnion(this.token),
                lastTokenUpdate: firebase.firestore.FieldValue.serverTimestamp()
            });
            
            console.log('✅ Token salvo no Firestore');
        } catch (err) {
            // Se doc não existe, cria
            if (err.code === 'not-found') {
                await db.collection(userType === 'store' ? 'stores' : 'users').doc(userId).set({
                    fcmTokens: [this.token],
                    lastTokenUpdate: firebase.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
            } else {
                console.error('Erro ao salvar token:', err);
            }
        }
    },
    
    async removeToken(userId, userType = 'customer') {
        if (!this.token || !userId) return;
        
        try {
            const collection = userType === 'store' ? 'stores' : 'users';
            await db.collection(collection).doc(userId).update({
                fcmTokens: firebase.firestore.FieldValue.arrayRemove(this.token)
            });
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
        
        // Som (opcional)
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

// Adicione isso após o login bem-sucedido no app cliente:
async function setupPushNotifications() {
    const initialized = await FCMModule.init();
    if (!initialized) return;
    
    const token = await FCMModule.requestPermissionAndGetToken();
    if (token && currentUser) {
        await FCMModule.saveTokenToFirestore(currentUser.uid, 'customer');
    }
}

// Adicione isso após o login no painel da loja:
async function setupStorePushNotifications(storeId) {
    const initialized = await FCMModule.init();
    if (!initialized) return;
    
    const token = await FCMModule.requestPermissionAndGetToken();
    if (token && storeId) {
        await FCMModule.saveTokenToFirestore(storeId, 'store');
    }
}

// Chame no logout para limpar token:
async function cleanupPushNotifications(userId, userType) {
    await FCMModule.removeToken(userId, userType);
}
