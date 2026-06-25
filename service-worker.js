// KILL-SWITCH do Service Worker legado no site padrao.
//
// Este dominio compartilha historico de deploy entre apps diferentes.
// Alguns navegadores ainda mantem registrado um "service-worker.js" antigo,
// que pode servir cache errado ou gerar erros de fetch antes do app atual
// assumir com "sw.js". Este arquivo existe apenas para:
// 1. limpar caches antigos,
// 2. desregistrar o SW legado,
// 3. recarregar as abas para o app atual registrar o SW correto.

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    try {
      var keys = await caches.keys();
      await Promise.all(keys.map(function (key) { return caches.delete(key); }));
    } catch (e) {}

    try {
      await self.registration.unregister();
    } catch (e) {}

    try {
      var clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(function (client) {
        try { client.navigate(client.url); } catch (e) {}
      });
    } catch (e) {}
  })());
});

self.addEventListener('fetch', function () {});
