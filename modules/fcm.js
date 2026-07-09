// ==================== FCM MODULE ====================
// Push notifications - App Entregador

const FCMModule = {
    messaging: null,
    token: null,
    swReg: null,
    basePath: null,
    initPromise: null,
    listenersRegistered: false,
    cacheVersion: '2026-06-25-1',
    cachePrefixes: ['pedrad-v', 'pedrad-driver-v'],

    async init() {
        if (this.initPromise) return this.initPromise;

        this.initPromise = this.initialize();
        return this.initPromise;
    },

    async initialize() {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            console.log('Push não suportado');
            return false;
        }
        try {
            this.basePath = location.pathname.substring(0, location.pathname.lastIndexOf('/') + 1);
            await this.cleanupLegacyServiceWorkers();
            const registration = await navigator.serviceWorker.register(this.basePath + 'firebase-messaging-sw.js', {
                scope: this.basePath
            });
            this.swReg = await this.waitForActiveWorker(registration);
            await this.activateWaitingWorker();
            await this.cleanupLegacyCaches();
            console.log('✅ SW registrado em', this.basePath);

            this.messaging = firebase.messaging();

            if (!this.listenersRegistered) {
                this.messaging.onMessage((payload) => {
                    console.log('📩 Foreground:', payload);
                    this.handleForegroundNotification(payload);
                });

                navigator.serviceWorker.addEventListener('message', (event) => {
                    if (event.data?.type === 'NOTIFICATION_CLICK') {
                        this.handleNotificationClick(event.data.data || {});
                    }
                });

                this.listenersRegistered = true;
            }

            return true;
        } catch (err) {
            console.error('Erro FCM init:', err);
            this.initPromise = null;
            return false;
        }
    },

    async cleanupLegacyServiceWorkers() {
        if (!navigator.serviceWorker?.getRegistrations) return;

        const expectedScriptSuffix = this.basePath + 'firebase-messaging-sw.js';
        const registrations = await navigator.serviceWorker.getRegistrations();

        await Promise.all(registrations.map(async (registration) => {
            const scopeUrl = new URL(registration.scope);
            if (scopeUrl.origin !== location.origin) return;

            const scriptUrl = registration.active?.scriptURL
                || registration.waiting?.scriptURL
                || registration.installing?.scriptURL
                || '';

            const inAppScope = scopeUrl.pathname === this.basePath
                || scopeUrl.pathname.startsWith(this.basePath);
            const isLegacyScript = scriptUrl.includes('/service-worker.js')
                || scriptUrl.includes('/sw.js');
            const isUnexpectedScope = scopeUrl.pathname !== this.basePath && inAppScope;
            const isUnexpectedScript = scriptUrl && !scriptUrl.endsWith(expectedScriptSuffix);

            if (isLegacyScript || isUnexpectedScope || (inAppScope && isUnexpectedScript)) {
                await registration.unregister().catch(() => {});
            }
        }));
    },

    async waitForActiveWorker(registration) {
        if (registration?.active) return registration;

        const readyRegistration = await navigator.serviceWorker.ready;
        if (readyRegistration?.active) {
            return readyRegistration;
        }

        return new Promise((resolve, reject) => {
            const candidate = registration?.installing || registration?.waiting;
            if (!candidate) {
                reject(new Error('Service Worker sem worker ativo'));
                return;
            }

            const timeoutId = setTimeout(() => {
                reject(new Error('Timeout aguardando ativação do Service Worker'));
            }, 15000);

            candidate.addEventListener('statechange', () => {
                if (candidate.state === 'activated') {
                    clearTimeout(timeoutId);
                    resolve(registration);
                }
            });
        });
    },

    async activateWaitingWorker() {
        if (!this.swReg?.waiting) return;

        this.swReg.waiting.postMessage({ type: 'SKIP_WAITING' });
        await navigator.serviceWorker.ready.catch(() => {});
    },

    async cleanupLegacyCaches() {
        if (!('caches' in window)) return;

        const activeNames = new Set([
            'pedrad-driver-v' + this.cacheVersion,
            'pedrad-v' + this.cacheVersion
        ]);

        const names = await caches.keys();
        await Promise.all(names.map(async (name) => {
            const matchesPrefix = this.cachePrefixes.some(prefix => name.startsWith(prefix));
            if (!matchesPrefix || activeNames.has(name)) return;
            await caches.delete(name).catch(() => {});
        }));
    },

    async requestPermissionAndGetToken(requestPermission = true) {
        try {
            let permission = Notification.permission;
            if (permission === 'default' && requestPermission) {
                permission = await Notification.requestPermission();
            }
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
        const payload = {
            fcmTokens: firebase.firestore.FieldValue.arrayUnion(this.token),
            lastTokenUpdate: firebase.firestore.FieldValue.serverTimestamp()
        };

        try {
            await db.collection(col).doc(userId).set(payload, { merge: true });
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

    // ==================== TOKEN NATIVO (APK) ====================
    // O APK entrega o token FCM nativo via window.PedradNative.onAndroidToken().
    // É esse token que entrega a notificação com o app FECHADO (o token web/SW só
    // entrega com o WebView vivo). Aqui salvamos em drivers/{id}.fcmTokens — o JS
    // está autenticado, então a regra permite a escrita.
    androidToken: null,

    isNativeApp() {
        try { return !!(window.Android && typeof window.Android.isNativeApp === 'function' && window.Android.isNativeApp()); }
        catch (e) { return false; }
    },

    setAndroidToken(token) {
        if (!token) return;
        this.androidToken = token;
        this.saveAndroidTokenToFirestore();
    },

    async saveAndroidTokenToFirestore() {
        if (!this.androidToken) return;
        // Precisa estar logado (auth confirmado) para a regra permitir a escrita.
        if (typeof driverData === 'undefined' || !driverData || !driverData.id) return;
        try {
            await db.collection('drivers').doc(driverData.id).set({
                fcmTokens: firebase.firestore.FieldValue.arrayUnion(this.androidToken),
                lastTokenUpdate: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            console.log('🔑 Token NATIVO (Android) salvo em drivers/' + driverData.id);
        } catch (err) {
            console.error('Erro salvar token nativo:', err);
        }
    },

    // ==================== FOREGROUND NOTIFICATIONS ====================
    handleForegroundNotification(payload) {
        const data = payload.data || {};
        const notif = payload.notification || {};
        const type = data.type || 'order_status';

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
                title: notif.title || data.title || '🎉 Pedra Delivery',
                body: notif.body || data.body || 'Confira!',
                urgent: false
            }
        };

        const msg = messages[type] || messages.order_status;
        const title = notif.title || msg.title;
        const body = notif.body || msg.body;

        if (typeof showToast === 'function') {
            showToast(body);
        }

        playNotificationSound();

        if (navigator.vibrate) {
            navigator.vibrate(msg.urgent ? [300, 100, 300, 100, 300] : [200, 100, 200]);
        }

        if (Notification.permission === 'granted' && this.swReg) {
            this.swReg.showNotification(title, {
                body,
                icon: this.basePath + 'icon-192.png',
                tag: data.orderId || `pedrad-${type}`,
                data: {
                    ...data,
                    click_action: data.click_action || new URL('home.html', location.href).href
                }
            }).catch(err => console.error('Erro ao exibir notificação:', err));
        }
    },

    handleNotificationClick(data) {
        if (data.type === 'new_order') {
            const el = document.getElementById('availableSection');
            if (el) el.scrollIntoView({ behavior: 'smooth' });
        }
    }
};

// ==================== SETUP FUNCTIONS ====================

async function setupDriverPushNotifications(options = {}) {
    // App NATIVO (APK): a entrega confiável com o app fechado é via token NATIVO
    // (FirebaseMessagingService), entregue pelo PedradNative.onAndroidToken. Não
    // usamos o token web (Service Worker só entrega com o WebView vivo) — isso
    // era a fonte da fragilidade e evita notificação dupla.
    if (FCMModule.isNativeApp()) {
        await FCMModule.saveAndroidTokenToFirestore(); // salva o token nativo já entregue (se houver)
        return;
    }

    const requestPermission = options.requestPermission !== false;
    const initialized = await FCMModule.init();
    if (!initialized) return;
    const token = await FCMModule.requestPermissionAndGetToken(requestPermission);
    if (token && typeof driverData !== 'undefined' && driverData) {
        await FCMModule.saveTokenToFirestore(driverData.id, 'driver');
    }
}

// Ponte APK → Web: o nativo chama isto no onPageFinished com o token FCM nativo.
// Guardamos e salvamos assim que o login estiver pronto (setupDriverPushNotifications).
window.PedradNative = window.PedradNative || {};
window.PedradNative.onAndroidToken = function (token) {
    try { FCMModule.setAndroidToken(token); } catch (e) { console.error('onAndroidToken:', e); }
};

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
