// firebase-messaging-sw.js
// Coloque na RAIZ do projeto (mesmo nível do index.html)

importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

firebase.initializeApp({
    apiKey: "AIzaSyAnIJRcUxN-0swpVnonPbJjTSK87o4CQ_g",
    authDomain: "pedrad-814d0.firebaseapp.com",
    projectId: "pedrad-814d0",
    storageBucket: "pedrad-814d0.firebasestorage.app",
    messagingSenderId: "293587190550",
    appId: "1:293587190550:web:80c9399f82847c80e20637"
});

const messaging = firebase.messaging();

// Recebe mensagens em background (app fechado)
messaging.onBackgroundMessage((payload) => {
    console.log('📩 Mensagem em background:', payload);
    
    const { title, body, icon } = payload.notification || {};
    const data = payload.data || {};
    
    const options = {
        body: body || 'Você tem uma nova atualização',
        icon: icon || '/icon-192.png',
        badge: '/icon-72.png',
        vibrate: [200, 100, 200],
        tag: data.orderId || 'pedrad-notification',
        data: data,
        actions: [
            { action: 'open', title: 'Abrir' },
            { action: 'close', title: 'Fechar' }
        ]
    };
    
    return self.registration.showNotification(title || 'Pedrad', options);
});

// Clique na notificação
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    
    const data = event.notification.data || {};
    let url = '/';
    
    // Abre na página correta
    if (data.type === 'order_update') {
        url = '/?page=orders';
    } else if (data.type === 'new_order') {
        url = '/loja.html';
    }
    
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then(clientList => {
                // Se já tem uma janela aberta, foca nela
                for (const client of clientList) {
                    if (client.url.includes(self.location.origin) && 'focus' in client) {
                        return client.focus();
                    }
                }
                // Senão, abre nova janela
                return clients.openWindow(url);
            })
    );
});
