const CACHE_VERSION = 2;
const CACHE_NAME = 'pedrad-v' + CACHE_VERSION;
const urlsToCache = [
    '/',
    '/index.html',
    '/manifest.json'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(urlsToCache))
    );
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(names =>
            Promise.all(
                names.filter(n => n.startsWith('pedrad-v') && n !== CACHE_NAME)
                    .map(n => caches.delete(n))
            )
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    // HTML: sempre network first
    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request).catch(() => caches.match(event.request))
        );
        return;
    }
    // Resto: network first, cache fallback
    event.respondWith(
        fetch(event.request).then(response => {
            if (response.ok) {
                const clone = response.clone();
                caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
            }
            return response;
        }).catch(() => caches.match(event.request))
    );
});