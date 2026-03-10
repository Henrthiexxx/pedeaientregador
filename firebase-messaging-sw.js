/* ==================== PEDRAD SERVICE WORKER (CACHE + FCM) ==================== */
/* ÚNICO SW por scope: PWA cache + Firebase Messaging */

const CACHE_VERSION = 4;
const CACHE_NAME = 'pedrad-v' + CACHE_VERSION;

// Path dinâmico — funciona em qualquer subdiretório
const APP_BASE = new URL(self.registration.scope).pathname;

const urlsToCache = [
    APP_BASE,
    APP_BASE + 'index.html',
    APP_BASE + 'manifest.json'
];

// ---------- CACHE / PWA ----------
self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        try { await cache.addAll(urlsToCache); }
        catch (e) { console.warn('[SW] Falha parcial no pre-cache:', e); }
    })());
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(
            names.filter(n => n.startsWith('pedrad-v') && n !== CACHE_NAME).map(n => caches.delete(n))
        );
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    const blockedHosts = [
        'fcmregistrations.googleapis.com',
        'firebaseinstallations.googleapis.com',
        'firestore.googleapis.com',
        'securetoken.googleapis.com',
        'identitytoolkit.googleapis.com'
    ];
    if (blockedHosts.includes(url.hostname)) return;

    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req).catch(async () => {
                return (await caches.match(req)) || (await caches.match(APP_BASE + 'index.html'));
            })
        );
        return;
    }

    if (url.origin !== self.location.origin) {
        event.respondWith(fetch(req).catch(() => caches.match(req)));
        return;
    }

    event.respondWith((async () => {
        try {
            const response = await fetch(req);
            if (response && response.ok) {
                const clone = response.clone();
                const cache = await caches.open(CACHE_NAME);
                cache.put(req, clone).catch(() => {});
            }
            return response;
        } catch (err) {
            return (await caches.match(req)) || Response.error();
        }
    })());
});

// ---------- FIREBASE FCM (v10 COMPAT — mesma versão do app) ----------
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

const firebaseConfig = {
    apiKey: "AIzaSyAnIJRcUxN-0swpVnonPbJjTSK87o4CQ_g",
    authDomain: "pedrad-814d0.firebaseapp.com",
    projectId: "pedrad-814d0",
    storageBucket: "pedrad-814d0.firebasestorage.app",
    messagingSenderId: "293587190550",
    appId: "1:293587190550:web:80c9399f82847c80e20637"
};

let messaging = null;

try {
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    messaging = firebase.messaging();

    // v10 compat usa onBackgroundMessage (não setBackgroundMessageHandler)
    messaging.onBackgroundMessage(function(payload) {
        console.log('[SW] Background message:', payload);

        const data = payload.data || {};
        const notif = payload.notification || {};
        const type = data.type || 'order_status';

        const defaultTitle = {
            new_order:      '📦 Nova Entrega!',
            order_ready:    '✅ Pedido Pronto!',
            order_status:   '🔔 Atualização',
            transfer_offer: '🔄 Oferta de Troca',
            rating:         '⭐ Nova Avaliação',
            marketing:      '🎉 Pedrad'
        };

        const defaultBody = {
            new_order:      (data.storeName || 'Loja') + ' → ' + (data.neighborhood || ''),
            order_ready:    '#' + (data.orderId || '').slice(-6).toUpperCase() + ' pronto para retirada',
            order_status:   data.message || 'Pedido atualizado',
            transfer_offer: (data.driverName || 'Entregador') + ' quer trocar entrega',
            rating:         data.message || 'Você recebeu uma avaliação',
            marketing:      data.body || 'Confira!'
        };

        const title = notif.title || data.title || defaultTitle[type] || '🔔 Pedrad';
        const body  = notif.body  || data.body  || defaultBody[type]  || 'Nova notificação';

        const isUrgent = (type === 'new_order' || type === 'order_ready');

        const options = {
            body: body,
            icon: APP_BASE + 'icon-192.png',
            badge: APP_BASE + 'icon-192.png',
            tag: data.orderId || ('pedrad-' + type),
            data: {
                ...data,
                click_action: data.click_action || (APP_BASE + 'home.html')
            },
            vibrate: isUrgent ? [300, 100, 300, 100, 300] : [200, 100, 200],
            renotify: isUrgent,
            requireInteraction: isUrgent,
            actions: isUrgent
                ? [{ action: 'open', title: '📦 Ver' }, { action: 'close', title: 'Fechar' }]
                : []
        };

        return self.registration.showNotification(title, options);
    });

} catch (e) {
    console.error('[SW] Erro Firebase Messaging:', e);
}

// ---------- CLIQUE NA NOTIFICAÇÃO ----------
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    const data = event.notification.data || {};
    const action = event.action;
    if (action === 'close') return;

    const clickUrl = data.click_action || (APP_BASE + 'home.html');

    event.waitUntil((async () => {
        const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });

        for (const client of allClients) {
            try {
                const clientUrl = new URL(client.url);
                if (clientUrl.origin === self.location.origin && clientUrl.pathname.startsWith(APP_BASE)) {
                    client.postMessage({ type: 'NOTIFICATION_CLICK', data: data });
                    await client.focus();
                    return;
                }
            } catch (e) {}
        }

        await clients.openWindow(clickUrl);
    })());
});

// ---------- SKIP WAITING ----------
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});