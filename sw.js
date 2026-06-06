const CACHE_VERSION = 4;
const CACHE_NAME = 'pedrad-v' + CACHE_VERSION;
const urlsToCache = [
    './',
    'index.html',
    'manifest.json',
    'icon-192.png',
    'icon-512.png'
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
    const request = event.request;
    if (request.method !== 'GET') return;

    const requestUrl = new URL(request.url);
    if (requestUrl.origin !== self.location.origin) return;

    // HTML: sempre network first
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request).catch(async () => {
                return (await caches.match(request))
                    || (await caches.match('./index.html'))
                    || new Response('Offline', {
                        status: 503,
                        statusText: 'Service Unavailable'
                    });
            })
        );
        return;
    }

    // Resto: network first, cache fallback
    event.respondWith(
        fetch(request).then(response => {
            if (response.ok) {
                const clone = response.clone();
                caches.open(CACHE_NAME)
                    .then(c => c.put(request, clone))
                    .catch(() => {});
            }
            return response;
        }).catch(async () => {
            return (await caches.match(request)) || new Response('Offline', {
                status: 503,
                statusText: 'Service Unavailable'
            });
        })
    );
});
