// ==================== FCM MODULE ====================
// Push notifications com app fechado (GitHub Pages /pedeaientregador)

const FCMModule = {
    messaging: null,
    token: null,
    swReg: null, // <- guarda o Service Worker registration correto

    async init() {
        // Verifica suporte
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            console.log('Push não suportado');
            return false;
        }

        try {
            // Registra Service Worker (caminho correto no GitHub Pages)
            this.swReg = await navigator.serviceWorker.register('/pedeaientregador/firebase-messaging-sw.js', {
                scope: '/pedeaientregador/'
            });

            console.log('✅ Service Worker registrado');

            // Inicializa messaging (compat)
            this.messaging = firebase.messaging();

            // Listener para mensagens em foreground
            this.messaging.onMessage((payload) => {
                console.log('📩 Mensagem recebida (foreground):', payload);
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

            // Firebase Console > Project Settings > Cloud Messaging > Web Push certificates
            const vapidKey = 'BEyLjUm82KxRNv4fCZOWxBln45CjHSleYDOgBCDffXVPP45SsFmZHxJxP0A0hJ0c8uZWdWU8u_YLIacXXYWtCV4';

            if (!this.messaging) {
                console.error('FCM messaging não inicializado. Chame FCMModule.init() antes.');
                return null;
            }
            if (!this.swReg) {
                console.error('Service Worker não registrado. Não é possível obter token.');
                return null;
            }

            // ✅ Aqui é onde você liga o token ao Service Worker correto (Firebase 10 compat)
            this.token = await this.messaging.getToken({
                vapidKey,
                serviceWorkerRegistration: this.swReg
            });

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
            await db.collection(collection).doc(userId).set({
                fcmTokens: firebase.firestore.FieldValue.arrayUnion(this.token),
                lastTokenUpdate: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            console.log('✅ Token salvo no Firestore:', collection);
        } catch (err) {
            console.error('Erro ao salvar token:', err);
        }
    },

    async removeToken(userId, userType = 'customer') {
        if (!this.token || !userId) return;

        const collection = this.getCollection(userType);

        try {
            await db.collection(collection).doc(userId).set({
                fcmTokens: firebase.firestore.FieldValue.arrayRemove(this.token)
            }, { merge: true });

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

        // ⚠️ Som via JS pode ser bloqueado no mobile sem interação do usuário
        try {
            const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2teleVVcjrqxlYRwZoOdscCwln10dY2ntbG0sKKYiIJ6dnJ0dnh8gIWJj5SVmJqcoaGhpKSkoqKfn5yZl5KQjYuKiYmJiYmJiYmJiYmJ');
            audio.play().catch(() => {});
        } catch (e) {}

        // Notificação do sistema (foreground)
        if (Notification.permission === 'granted') {
            new Notification(title || 'Pedrad', {
                body: body || 'Nova atualização',
                icon: '/pedeaientregador/icon-192.png', // ajustado pra subpasta
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
