// KILL-SWITCH do Service Worker legado no site padrao.
//
// Este dominio compartilha historico de deploy entre apps diferentes.
// Alguns navegadores ainda mantem registrado um "service-worker.js" antigo,
// que pode servir cache errado ou gerar erros de fetch antes do app atual
// assumir com "sw.js". Este arquivo existe apenas para:
// 1. limpar caches antigos,
// 2. desregistrar o SW legado.
//
// IMPORTANTE: NAO forcar reload das abas aqui. Chamar client.navigate() dentro
// do activate de um SW que se auto-desregistra provoca LOOP de reload (o script
// ainda e servido e a aba reentra no ciclo install/activate). A pagina assume o
// SW correto naturalmente na proxima navegacao do usuario.

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

    // Sem client.navigate(): evita o loop de service worker.
  })());
});

self.addEventListener('fetch', function () {});
