/* ==================== PEDRAD SERVICE WORKER (CACHE + FCM) ==================== */
/* ÚNICO SW por scope: PWA cache + Firebase Messaging */

const CACHE_VERSION = 4;
const CACHE_NAME = 'pedrad-v' + CACHE_VERSION;

// Descobre base do app pelo scope do SW (ex.: /pedeaientregador/)
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
        try {
            await cache.addAll(urlsToCache);
        } catch (e) {
            // ignora se algum arquivo não existir
            console.warn('[SW] Falha parcial no pre-cache:', e);
        }
    })());
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(
            names
                .filter((n) => n.startsWith('pedrad-v') && n !== CACHE_NAME)
                .map((n) => caches.delete(n))
        );
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const req = event.request;

    // Só GET
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // Não interceptar APIs/firebase/push
    const blockedHosts = [
        'fcmregistrations.googleapis.com',
        'firebaseinstallations.googleapis.com',
        'firestore.googleapis.com',
        'securetoken.googleapis.com',
        'identitytoolkit.googleapis.com'
    ];

    if (blockedHosts.includes(url.hostname)) return;

    // HTML navegação: network-first
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req).catch(async () => {
                return (await caches.match(req)) || (await caches.match(APP_BASE + 'index.html'));
            })
        );
        return;
    }

    // Para requests cross-origin, não cachear (evita problemas)
    if (url.origin !== self.location.origin) {
        event.respondWith(fetch(req).catch(() => caches.match(req)));
        return;
    }

    // Mesmo domínio: network-first + fallback cache
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

// ---------- FIREBASE FCM (v8 CDN) ----------
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');
// COLE A MESMA CONFIG DO SEU PROJETO FIREBASE AQUI:
const firebaseConfig = {
    apiKey: "AIzaSyAnIJRcUxN-0swpVnonPbJjTSK87o4CQ_g",
    authDomain: "pedrad-814d0.firebaseapp.com",
    projectId: "pedrad-814d0",
    storageBucket: "pedrad-814d0.firebasestorage.app",
    messagingSenderId: "293587190550",
    appId: "1:293587190550:web:80c9399f82847c80e20637"
    // measurementId opcional
};

let messaging = null;

try {
    if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
    }

    messaging = firebase.messaging();

    // Background message (v8)
    messaging.onBackgroundMessage(function(payload) {
        const data = payload?.data || {};
        const notif = payload?.notification || {};
        const type = data.type || 'order_status';

        const defaultTitle = {
            new_order: '📦 Nova Entrega!',
            order_ready: '✅ Pedido Pronto!',
            order_status: '🔔 Atualização',
            transfer_offer: '🔄 Oferta de Troca',
            rating: '⭐ Nova Avaliação',
            marketing: '🎉 Pedrad'
        };

        const defaultBody = {
            new_order: `${data.storeName || 'Loja'} → ${data.neighborhood || ''}`,
            order_ready: `#${(data.orderId || '').slice(-6).toUpperCase()} pronto para retirada`,
            order_status: data.message || 'Pedido atualizado',
            transfer_offer: `${data.driverName || 'Entregador'} quer trocar entrega`,
            rating: data.message || 'Você recebeu uma avaliação',
            marketing: data.body || 'Confira!'
        };

        const title = notif.title || data.title || defaultTitle[type] || '🔔 Pedrad';
        const body = notif.body || data.body || defaultBody[type] || 'Nova notificação';

        const options = {
            body,
            icon: APP_BASE + 'icon-192.png',
            badge: APP_BASE + 'icon-192.png',
            tag: data.orderId || `pedrad-${type}`,
            data: {
                ...data,
                click_action: data.click_action || (APP_BASE + 'index.html')
            },
            renotify: type === 'new_order' || type === 'order_ready',
            requireInteraction: type === 'new_order' || type === 'order_ready'
        };

        return self.registration.showNotification(title, options);
    });
} catch (e) {
    console.error('[SW] Erro Firebase Messaging:', e);
}

// Clique na notificação
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    const data = event.notification?.data || {};
    const clickUrl = data.click_action || (APP_BASE + 'index.html');

    event.waitUntil((async () => {
        const allClients = await clients.matchAll({
            type: 'window',
            includeUncontrolled: true
        });

        // Tenta focar janela existente no mesmo app
        for (const client of allClients) {
            try {
                const clientUrl = new URL(client.url);
                if (clientUrl.origin === self.location.origin && clientUrl.pathname.startsWith(APP_BASE)) {
                    client.postMessage({
                        type: 'NOTIFICATION_CLICK',
                        data
                    });
                    await client.focus();
                    return;
                }
            } catch (e) {}
        }

        // Se não achar janela, abre nova
        await clients.openWindow(clickUrl);
    })());
});
