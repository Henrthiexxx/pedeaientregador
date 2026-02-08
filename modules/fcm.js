// ==================== FCM MODULE ====================
const FCMModule = {
    messaging: null,
    token: null,
    swReg: null,

    async init() {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            console.log('Push não suportado');
            return false;
        }
        try {
            this.swReg = await navigator.serviceWorker.register('/pedeaientregador/firebase-messaging-sw.js', {
                scope: '/pedeaientregador/'
            });
            console.log('SW registrado');
            this.messaging = firebase.messaging();
            this.messaging.onMessage((payload) => {
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
            if (permission !== 'granted') return null;

            const vapidKey = 'BEyLjUm82KxRNv4fCZOWxBln45CjHSleYDOgBCDffXVPP45SsFmZHxJxP0A0hJ0c8uZWdWU8u_YLIacXXYWtCV4';
            if (!this.messaging || !this.swReg) return null;

            this.token = await this.messaging.getToken({
                vapidKey,
                serviceWorkerRegistration: this.swReg
            });
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
        const col = this.getCollection(userType);
        try {
            await db.collection(col).doc(userId).set({
                fcmTokens: firebase.firestore.FieldValue.arrayUnion(this.token),
                lastTokenUpdate: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        } catch (err) {
            console.error('Erro ao salvar token:', err);
        }
    },

    async removeToken(userId, userType = 'customer') {
        if (!this.token || !userId) return;
        const col = this.getCollection(userType);
        try {
            await db.collection(col).doc(userId).set({
                fcmTokens: firebase.firestore.FieldValue.arrayRemove(this.token)
            }, { merge: true });
        } catch (err) {}
    },

    showForegroundNotification(payload) {
        const { title, body } = payload.notification || {};
        const data = payload.data || {};
        if (typeof showToast === 'function') showToast(body || title || 'Nova atualização');
        if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
        if (Notification.permission === 'granted') {
            new Notification(title || 'Pedrad', {
                body: body || 'Nova atualização',
                icon: '/pedeaientregador/icon-192.png',
                tag: data.orderId || 'pedrad',
                data
            });
        }
    }
};

async function setupDriverPushNotifications() {
    const initialized = await FCMModule.init();
    if (!initialized) return;
    const token = await FCMModule.requestPermissionAndGetToken();
    if (token && driverData) {
        await FCMModule.saveTokenToFirestore(driverData.id, 'driver');
    }
}

async function cleanupPushNotifications(userId, userType) {
    await FCMModule.removeToken(userId, userType);
}
