// ==================== FCM MODULE ====================
// Push notifications - App Entregador

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
            // Detecta path automaticamente baseado na URL atual
            const basePath = location.pathname.substring(0, location.pathname.lastIndexOf('/') + 1);
            this.swReg = await navigator.serviceWorker.register(basePath + 'firebase-messaging-sw.js', {
                scope: basePath
            });
            console.log('✅ SW registrado em', basePath);

            this.messaging = firebase.messaging();

            this.messaging.onMessage((payload) => {
                console.log('📩 Foreground:', payload);
                this.handleForegroundNotification(payload);
            });

            navigator.serviceWorker.addEventListener('message', (event) => {
                if (event.data?.type === 'NOTIFICATION_CLICK') {
                    this.handleNotificationClick(event.data.data || {});
                }
            });

            return true;
        } catch (err) {
            console.error('Erro FCM init:', err);
            return false;
        }
    },

    async requestPermissionAndGetToken() {
        try {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') return null;

            const vapidKey = 'BLt2icpkQT3LTtfJJybWVF4xjkZ1_L4dmt_qRszLGJF6ACFOK3MGtIIVgokt9l-zh5dSa1FqKG-XstNZVTrMpCc';
            if (!this.messaging || !this.swReg) return null;

            this.token = await this.messaging.getToken({
                vapidKey,
                serviceWorkerRegistration: this.swReg
            });
            console.log('🔑 Token obtido');
            return this.token;
        } catch (err) {
            console.error('Erro token:', err);
            return null;
        }
    },

    // ==================== COLLECTIONS ====================
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
            console.error('Erro salvar token:', err);
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

    // ==================== FOREGROUND NOTIFICATIONS ====================
    handleForegroundNotification(payload) {
        const data = payload.data || {};
        const notif = payload.notification || {};
        const type = data.type || 'order_status';

        // Monta mensagem baseada no tipo
        const messages = {
            new_order: {
                title: '📦 Nova Entrega!',
                body: `${data.storeName || 'Loja'} → ${data.neighborhood || ''}`,
                urgent: true
            },
            order_ready: {
                title: '✅ Pedido Pronto!',
                body: `#${(data.orderId || '').slice(-6).toUpperCase()} pronto para retirada`,
                urgent: true
            },
            order_status: {
                title: '🔔 Atualização',
                body: data.message || notif.body || 'Pedido atualizado',
                urgent: false
            },
            transfer_offer: {
                title: '🔄 Oferta de Troca',
                body: `${data.driverName || 'Entregador'} quer trocar entrega`,
                urgent: false
            },
            rating: {
                title: '⭐ Nova Avaliação',
                body: data.message || 'Você recebeu uma avaliação',
                urgent: false
            },
            marketing: {
                title: notif.title || data.title || '🎉 Pedrad',
                body: notif.body || data.body || 'Confira!',
                urgent: false
            }
        };

        const msg = messages[type] || messages.order_status;
        const title = notif.title || msg.title;
        const body = notif.body || msg.body;

        // Toast no app
        if (typeof showToast === 'function') {
            showToast(body);
        }

        // Som (notify.mp3 padrão obrigatório)
        playNotificationSound();

        // Vibração
        if (navigator.vibrate) {
            navigator.vibrate(msg.urgent ? [300, 100, 300, 100, 300] : [200, 100, 200]);
        }

        // Notificação do sistema (foreground)
        if (Notification.permission === 'granted') {
            new Notification(title, {
                body,
                icon: '/pedeaientregador/icon-192.png',
                tag: data.orderId || `pedrad-${type}`,
                data
            });
        }
    },

    handleNotificationClick(data) {
        // Quando usuário clica na notificação e app já está aberto
        if (data.type === 'new_order') {
            // Scroll para pedidos disponíveis
            const el = document.getElementById('availableSection');
            if (el) el.scrollIntoView({ behavior: 'smooth' });
        }
    }
};

// ==================== SETUP FUNCTIONS ====================

async function setupDriverPushNotifications() {
    const initialized = await FCMModule.init();
    if (!initialized) return;
    const token = await FCMModule.requestPermissionAndGetToken();
    if (token && typeof driverData !== 'undefined' && driverData) {
        await FCMModule.saveTokenToFirestore(driverData.id, 'driver');
    }
}

async function setupClientPushNotifications() {
    const initialized = await FCMModule.init();
    if (!initialized) return;
    const token = await FCMModule.requestPermissionAndGetToken();
    if (token) {
        const uid = localStorage.getItem('auth_uid');
        if (uid) await FCMModule.saveTokenToFirestore(uid, 'customer');
    }
}

async function setupStorePushNotifications(storeId) {
    const initialized = await FCMModule.init();
    if (!initialized) return;
    const token = await FCMModule.requestPermissionAndGetToken();
    if (token && storeId) {
        await FCMModule.saveTokenToFirestore(storeId, 'store');
    }
}

async function cleanupPushNotifications(userId, userType) {
    await FCMModule.removeToken(userId, userType);
}