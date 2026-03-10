// Firebase Config
const firebaseConfig = {
    apiKey: "AIzaSyAnIJRcUxN-0swpVnonPbJjTSK87o4CQ_g",
    authDomain: "pedrad-814d0.firebaseapp.com",
    projectId: "pedrad-814d0",
    storageBucket: "pedrad-814d0.firebasestorage.app",
    messagingSenderId: "293587190550",
    appId: "1:293587190550:web:80c9399f82847c80e20637"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// State
let currentUser = null;
let driverData = null;
let isOnline = false;
let currentDelivery = null;
let acceptedOrders = [];
let availableOrders = [];
let allHistory = [];
let historyFilter = 'week';
let deliveryFees = [];
let pendingAcceptOrder = null;
let capturedLocation = null;
let platformConfig = { driverFee: 5, driverKmBonus: 1 };
let onlineInterval = null;
let storesCache = {};

// Store coverage: stores with an online assigned driver
let coveredStoreIds = new Set();

// ==================== LOCATION TRACKING ====================
let locationWatchId = null;
let lastLocationUpdate = 0;
const LOCATION_UPDATE_INTERVAL = 10000;

function startLocationTracking() {
    if (!navigator.geolocation) return;
    stopLocationTracking();

    locationWatchId = navigator.geolocation.watchPosition(
        (position) => {
            const now = Date.now();
            if (now - lastLocationUpdate < LOCATION_UPDATE_INTERVAL) return;
            lastLocationUpdate = now;
            updateDriverLocationInOrder({
                lat: position.coords.latitude,
                lng: position.coords.longitude,
                accuracy: position.coords.accuracy,
                updatedAt: new Date().toISOString()
            });
        },
        (error) => { console.error('Location error:', error.message); },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
}

function stopLocationTracking() {
    if (locationWatchId !== null) {
        navigator.geolocation.clearWatch(locationWatchId);
        locationWatchId = null;
    }
}

async function updateDriverLocationInOrder(location) {
    if (!currentDelivery || !driverData) return;
    try {
        await db.collection('orders').doc(currentDelivery.id).update({
            driverLocation: location,
            driver: {
                id: driverData.id,
                name: driverData.name,
                phone: driverData.phone || '',
                vehicle: driverData.vehicle || 'Moto',
                photoUrl: driverData.photoUrl || null
            }
        });
    } catch (err) { console.error('Error updating location:', err); }
}

// ==================== TOKEN SYSTEM ====================

function generateDriverToken() {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const digits = '0123456789';
    let token = '';
    for (let i = 0; i < 3; i++) token += letters.charAt(Math.floor(Math.random() * 26));
    for (let i = 0; i < 3; i++) token += digits.charAt(Math.floor(Math.random() * 10));
    return token;
}

async function ensureDriverToken() {
    if (!driverData) return;
    if (driverData.driverToken) return; // already has token

    const token = generateDriverToken();
    try {
        await db.collection('drivers').doc(driverData.id).update({
            driverToken: token,
            tokenCreatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        driverData.driverToken = token;
        console.log('Driver token generated:', token);
    } catch (err) {
        console.error('Error generating token:', err);
    }
}

// ==================== AUTH ====================

document.addEventListener('DOMContentLoaded', async () => {
    const savedDriverId = localStorage.getItem('pedrad_driver_id');
    if (savedDriverId) {
        const driver = await loadDriverById(savedDriverId);
        if (driver && driver.status !== 'blocked') {
            driverData = driver;
            currentUser = { email: driver.email };

            const wasOnline = localStorage.getItem('pedrad_driver_online') === 'true';
            if (wasOnline && driver.online) {
                isOnline = true;
                startOnlineHeartbeat();
            }

            showMainApp();
            await ensureDriverToken();
            await loadAllData();
            setupRealtimeListeners();
            initTransferSystem();

            if (isOnline) {
                document.getElementById('onlineToggle').classList.add('active');
                document.getElementById('statusText').textContent = 'Online';
            }
        } else {
            localStorage.removeItem('pedrad_driver_id');
            localStorage.removeItem('pedrad_driver_online');
            showAuthPage();
        }
    } else {
        showAuthPage();
    }
});

async function handleLogin(e) {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value.trim().toLowerCase();
    const password = document.getElementById('loginPassword').value;

    try {
        const driver = await loadDriverData(email);
        if (!driver) { showToast('Entregador não cadastrado'); return; }
        if (driver.status === 'blocked') { showToast('Sua conta está bloqueada'); return; }
        if (driver.password !== password) { showToast('Senha incorreta'); return; }

        driverData = driver;
        currentUser = { email: driver.email };
        localStorage.setItem('pedrad_driver_id', driver.id);

        showMainApp();
        await ensureDriverToken();
        await loadAllData();
        setupRealtimeListeners();
        initTransferSystem();
        showToast('Bem-vindo, ' + driver.name);
        setupDriverPushNotifications();
    } catch (err) {
        console.error('Login error:', err);
        showToast('Erro ao entrar');
    }
}

async function loadDriverData(email) {
    try {
        const snapshot = await db.collection('drivers').where('email', '==', email).limit(1).get();
        if (!snapshot.empty) return { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
        return null;
    } catch (err) { console.error('Error loading driver:', err); return null; }
}

async function loadDriverById(id) {
    try {
        const doc = await db.collection('drivers').doc(id).get();
        if (doc.exists) return { id: doc.id, ...doc.data() };
        return null;
    } catch (err) { console.error('Error loading driver:', err); return null; }
}

function handleLogout() {
    showConfirmModal('Deseja sair?', 'Você será desconectado do aplicativo.', () => {
        if (isOnline) updateDriverOnlineStatus(false);
        if (onlineInterval) clearInterval(onlineInterval);
        stopLocationTracking();
        localStorage.removeItem('pedrad_driver_id');
        localStorage.removeItem('pedrad_driver_online');
        driverData = null;
        currentUser = null;
        showAuthPage();
    });
}

function showConfirmModal(title, text, onConfirm, confirmText = 'Confirmar', cancelText = 'Cancelar') {
    document.getElementById('confirmModalTitle').textContent = title;
    document.getElementById('confirmModalText').textContent = text;
    document.getElementById('confirmModalBtn').textContent = confirmText;
    document.getElementById('confirmModalCancel').textContent = cancelText;
    document.getElementById('confirmModalBtn').onclick = () => {
        closeModal('confirmModal');
        if (onConfirm) onConfirm();
    };
    openModal('confirmModal');
}

function showAuthPage() {
    document.getElementById('authPage').style.display = 'flex';
    document.getElementById('mainApp').style.display = 'none';
}

function showMainApp() {
    document.getElementById('authPage').style.display = 'none';
    document.getElementById('mainApp').style.display = 'block';
    updateDriverUI();
}

function updateDriverUI() {
    if (!driverData) return;
    const vehicleNames = { moto: 'Moto', bicicleta: 'Bicicleta', carro: 'Carro' };
    const vehicleName = vehicleNames[driverData.vehicle] || 'Moto';

    [document.getElementById('driverAvatar'), document.getElementById('profileAvatar')].forEach(el => {
        if (!el) return;
        if (driverData.photoUrl) {
            el.style.backgroundImage = 'url(' + driverData.photoUrl + ')';
            el.style.backgroundSize = 'cover';
            el.style.backgroundPosition = 'center';
            el.textContent = '';
        } else {
            el.style.backgroundImage = 'none';
            el.textContent = driverData.name ? driverData.name.charAt(0).toUpperCase() : '—';
        }
    });

    var rating = driverData.rating || 5.0;
    var ratingEl = document.getElementById('driverRating');
    if (ratingEl) ratingEl.textContent = rating.toFixed(1);
    var prEl = document.getElementById('profileRating');
    if (prEl) prEl.textContent = rating.toFixed(1);

    var nameEl = document.getElementById('driverName');
    if (nameEl) nameEl.textContent = driverData.name || 'Entregador';
    var vehEl = document.getElementById('driverVehicle');
    if (vehEl) vehEl.textContent = vehicleName + (driverData.plate ? ' • ' + driverData.plate : '');

    var pnEl = document.getElementById('profileName');
    if (pnEl) pnEl.textContent = driverData.name || 'Entregador';
    var peEl = document.getElementById('profileEmail');
    if (peEl) peEl.textContent = driverData.email || '';
    var ppEl = document.getElementById('profilePhone');
    if (ppEl) ppEl.textContent = driverData.phone || '-';
    var pvEl = document.getElementById('profileVehicle');
    if (pvEl) pvEl.textContent = driverData.vehicle || '-';
    var plEl = document.getElementById('profilePlate');
    if (plEl) plEl.textContent = driverData.plate || '-';
    var pmEl = document.getElementById('profileMaxOrders');
    if (pmEl) pmEl.textContent = driverData.maxSimultaneousOrders || 1;
    var pxEl = document.getElementById('pixKey');
    if (pxEl) pxEl.textContent = driverData.pix || 'Não cadastrado';

    // Token display
    var tkEl = document.getElementById('profileToken');
    if (tkEl) tkEl.textContent = driverData.driverToken || '-';
}

// ==================== PHOTO UPLOAD ====================

function changeProfilePhoto() {
    document.getElementById('photoInput').click();
}

async function handlePhotoUpload(event) {
    var file = event.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { showToast('Selecione uma imagem'); return; }
    if (file.size > 5 * 1024 * 1024) { showToast('Imagem muito grande (max 5MB)'); return; }

    showToast('Enviando foto...');
    var reader = new FileReader();
    reader.onload = async function(e) {
        var base64 = e.target.result;
        try {
            await db.collection('drivers').doc(driverData.id).update({
                photoUrl: base64,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            driverData.photoUrl = base64;
            updateDriverUI();
            showToast('Foto atualizada');
        } catch (err) { showToast('Erro ao enviar foto'); }
    };
    reader.readAsDataURL(file);
}

// ==================== DATA LOADING ====================

async function loadAllData() {
    await Promise.all([
        loadDeliveryFees(),
        loadPlatformConfig(),
        loadAvailableOrders(),
        loadAcceptedOrders(),
        loadCurrentDelivery(),
        loadAllHistory()
    ]);
    updateStats();
}

async function loadDeliveryFees() {
    try {
        var snapshot = await db.collection('deliveryFees').where('active', '==', true).get();
        deliveryFees = snapshot.docs.map(function(doc) { return { id: doc.id, ...doc.data() }; });
    } catch (err) { console.error('Error loading fees:', err); }
}

async function loadPlatformConfig() {
    try {
        var doc = await db.collection('config').doc('platform').get();
        if (doc.exists) platformConfig = { ...platformConfig, ...doc.data() };
    } catch (err) { console.error('Error loading config:', err); }
}

async function loadAvailableOrders() {
    try {
        var snapshot = await db.collection('orders')
            .where('status', 'in', ['preparing', 'ready'])
            .get();
        availableOrders = snapshot.docs
            .map(function(doc) { return { id: doc.id, ...doc.data() }; })
            .filter(function(o) { return !o.driverId && o.deliveryMode !== 'pickup'; });
        renderAvailableOrders();
    } catch (err) { console.error('Error loading orders:', err); }
}

async function loadAcceptedOrders() {
    if (!driverData) return;
    try {
        var snapshot = await db.collection('orders')
            .where('driverId', '==', driverData.id)
            .where('status', '==', 'ready')
            .get();
        acceptedOrders = snapshot.docs.map(function(doc) { return { id: doc.id, ...doc.data() }; });
        renderAcceptedOrders();
    } catch (err) { console.error('Error loading accepted orders:', err); }
}

async function loadCurrentDelivery() {
    if (!driverData) return;
    try {
        var snapshot = await db.collection('orders')
            .where('driverId', '==', driverData.id)
            .where('status', '==', 'delivering')
            .limit(1)
            .get();
        if (!snapshot.empty) {
            currentDelivery = { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
            renderCurrentDelivery();
            startLocationTracking();
        } else {
            currentDelivery = null;
            document.getElementById('currentDeliverySection').style.display = 'none';
            stopLocationTracking();
        }
    } catch (err) { console.error('Error loading current delivery:', err); }
    showNavMapButton();
}

async function loadAllHistory() {
    if (!driverData) return;
    try {
        var snapshot = await db.collection('orders')
            .where('driverId', '==', driverData.id)
            .where('status', '==', 'delivered')
            .get();
        allHistory = snapshot.docs
            .map(function(doc) { return { id: doc.id, ...doc.data() }; })
            .sort(function(a, b) {
                var dateA = a.deliveredAt?.toDate?.() || new Date(a.deliveredAt);
                var dateB = b.deliveredAt?.toDate?.() || new Date(b.deliveredAt);
                return dateB - dateA;
            });
        renderHistory();
    } catch (err) { console.error('Error loading history:', err); }
}

async function getStoreData(storeId) {
    if (!storeId) return null;
    if (storesCache[storeId]) return storesCache[storeId];
    try {
        var doc = await db.collection('stores').doc(storeId).get();
        if (doc.exists) { storesCache[storeId] = doc.data(); return doc.data(); }
    } catch (err) { console.error('Error loading store:', err); }
    return null;
}

// ==================== REAL-TIME ====================

function setupRealtimeListeners() {
    // Available orders with optimized rendering
    var availMap = new Map();
    var rafAvail = null;

    function scheduleAvailRender() {
        if (rafAvail) return;
        rafAvail = requestAnimationFrame(function() {
            rafAvail = null;
            renderAvailableOrders();
        });
    }

    db.collection('orders')
        .where('status', 'in', ['confirmed', 'preparing', 'ready'])
        .onSnapshot(function(snapshot) {
            var had = availableOrders.length;

            snapshot.docChanges().forEach(function(change) {
                var o = { id: change.doc.id, ...change.doc.data() };
                if (change.type === 'removed') availMap.delete(o.id);
                else availMap.set(o.id, o);
            });

            availableOrders = [];
            availMap.forEach(function(o) {
                if (!o.driverId && o.deliveryMode !== 'pickup') availableOrders.push(o);
            });

            scheduleAvailRender();

            var hasNew = snapshot.docChanges().some(function(c) { return c.type === 'added'; });
            if (hasNew && isOnline && !currentDelivery) {
                playNotificationSound();
                showToast('Nova entrega disponível');
            }
        });

    // Coverage listener: track which stores have online assigned drivers
    db.collection('drivers')
        .where('driverType', '==', 'store')
        .onSnapshot(function(snapshot) {
            coveredStoreIds = new Set();
            snapshot.docs.forEach(function(doc) {
                var d = doc.data();
                if (d.storeId && d.online === true) {
                    coveredStoreIds.add(d.storeId);
                }
            });
            scheduleAvailRender();
        });

    // My orders
    if (driverData) {
        db.collection('orders')
            .where('driverId', '==', driverData.id)
            .where('status', 'in', ['preparing', 'ready', 'delivering'])
            .onSnapshot(function(snapshot) {
                var myOrders = snapshot.docs.map(function(doc) { return { id: doc.id, ...doc.data() }; });

                acceptedOrders = myOrders.filter(function(o) { return o.status === 'preparing' || o.status === 'ready'; });
                renderAcceptedOrders();

                var delivering = myOrders.find(function(o) { return o.status === 'delivering'; });
                if (delivering) {
                    var wasDelivering = !!currentDelivery;
                    currentDelivery = delivering;
                    renderCurrentDelivery();
                    if (!wasDelivering) startLocationTracking();
                } else {
                    if (currentDelivery) stopLocationTracking();
                    currentDelivery = null;
                    document.getElementById('currentDeliverySection').style.display = 'none';
                }

                showNavMapButton();
                updateStats();
            });

        // Driver data changes
        db.collection('drivers').doc(driverData.id).onSnapshot(function(doc) {
            if (!doc.exists) return;
            var oldRating = driverData.rating;
            driverData = { id: doc.id, ...doc.data() };
            updateDriverUI();
            if (oldRating && driverData.rating && driverData.rating !== oldRating) {
                var diff = (driverData.rating - oldRating).toFixed(1);
                showToast((diff > 0 ? '↑' : '↓') + ' Avaliação: ' + driverData.rating.toFixed(1));
            }
        });
    }

    loadAllHistory();
} // ← setupRealtimeListeners CLOSED properly

// ==================== NOTIFICATION SOUND ====================

function playNotificationSound() {
    try {
        var audio = new Audio('notify.mp3');
        audio.play().catch(function() {});
        if ('vibrate' in navigator) navigator.vibrate([200, 100, 200]);
    } catch (e) {}
}

// ==================== RENDER ====================

function renderAvailableOrders() {
    var container = document.getElementById('availableDeliveries');
    if (!container) return;

    // FILTERING: regular driver doesn't see orders from stores with online assigned driver
    var isStoreDriver = driverData?.driverType === 'store' && driverData?.storeId;
    var filtered;

    if (isStoreDriver) {
        var ownStore = availableOrders.filter(function(o) { return o.storeId === driverData.storeId; });
        var otherStores = driverData.appEligible
            ? availableOrders.filter(function(o) { return o.storeId !== driverData.storeId; })
            : [];
        filtered = ownStore.concat(otherStores);
    } else {
        // Regular driver: hide orders from stores with an online assigned driver
        filtered = availableOrders.filter(function(o) {
            return !o.storeId || !coveredStoreIds.has(o.storeId);
        });
    }

    document.getElementById('availableCount').textContent = filtered.length;

    if (!isOnline) {
        container.innerHTML = '<div class="empty-state">'
            + '<div class="empty-state-icon">○</div>'
            + '<div class="empty-state-title">Você está offline</div>'
            + '<div class="empty-state-text">Ative o botão acima para receber entregas</div>'
            + '</div>';
        return;
    }

    var maxOrders = driverData?.maxSimultaneousOrders || 1;
    var myActiveCount = (acceptedOrders.length || 0) + (currentDelivery ? 1 : 0);

    if (myActiveCount >= maxOrders) {
        // Store driver still sees own store
        if (isStoreDriver) {
            filtered = filtered.filter(function(o) { return o.storeId === driverData.storeId; });
            if (filtered.length === 0) {
                container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">◎</div>'
                    + '<div class="empty-state-title">Limite atingido</div>'
                    + '<div class="empty-state-text">Finalize suas entregas antes de aceitar novas</div></div>';
                return;
            }
        } else {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">◎</div>'
                + '<div class="empty-state-title">Limite atingido</div>'
                + '<div class="empty-state-text">Finalize suas entregas antes de aceitar novas</div></div>';
            return;
        }
    }

    if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">—</div>'
            + '<div class="empty-state-title">Nenhuma entrega disponível</div>'
            + '<div class="empty-state-text">Aguarde novos pedidos</div></div>';
        return;
    }

    container.innerHTML = filtered.map(function(order) {
        var waitTime = getWaitTime(order.createdAt);
        var isUrgent = waitTime > 15;
        var fee = getDeliveryFee(order.address?.neighborhood);
        var earning = calculateDriverEarning(fee, order.distance);
        var isOwn = isStoreDriver && order.storeId === driverData.storeId;

        return '<div class="delivery-card ' + (isUrgent ? 'urgent' : '') + '" id="order-' + order.id + '"'
            + (isOwn ? ' style="border-left:3px solid var(--primary);"' : '') + '>'
            + '<div class="delivery-header">'
            + '<div class="delivery-store">'
            + '<div class="delivery-store-icon" id="icon-' + order.id + '">□</div>'
            + '<div>'
            + '<div class="delivery-store-name">' + (order.storeName || 'Loja') + (isOwn ? ' ★' : '') + '</div>'
            + '<div class="delivery-store-time">Aguardando há ' + waitTime + ' min</div>'
            + '</div></div>'
            + '<div class="delivery-value">'
            + '<div class="delivery-fee">+ ' + formatCurrency(earning) + '</div>'
            + '<div class="delivery-distance">' + (order.distance ? order.distance.toFixed(1) + ' km' : order.address?.neighborhood || '') + '</div>'
            + '</div></div>'
            + '<div class="delivery-body">'
            + '<div class="delivery-address"><div class="address-icon">□</div>'
            + '<div class="address-info"><div class="address-label">Retirar em</div>'
            + '<div class="address-text">' + (order.storeName || 'Loja') + '</div></div></div>'
            + '<div class="delivery-address"><div class="address-icon">◎</div>'
            + '<div class="address-info"><div class="address-label">Entregar em</div>'
            + '<div class="address-text">' + (order.address?.street || '') + ', ' + (order.address?.number || '') + ' - ' + (order.address?.neighborhood || '') + '</div></div></div>'
            + '<div class="delivery-actions">'
            + '<button class="btn btn-primary" onclick="acceptOrder(\'' + order.id + '\')">Aceitar Entrega</button>'
            + '</div></div></div>';
    }).join('');

    // Load store icons async
    filtered.forEach(async function(order) {
        if (order.storeId) {
            var storeData = await getStoreData(order.storeId);
            if (storeData?.logoUrl) {
                var iconEl = document.getElementById('icon-' + order.id);
                if (iconEl) {
                    iconEl.style.backgroundImage = 'url(' + storeData.logoUrl + ')';
                    iconEl.style.backgroundSize = 'cover';
                    iconEl.style.backgroundPosition = 'center';
                    iconEl.textContent = '';
                }
            }
        }
    });
}

function renderAcceptedOrders() {
    var section = document.getElementById('acceptedSection');
    var container = document.getElementById('acceptedOrders');
    if (!section || !container) return;

    if (acceptedOrders.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';
    document.getElementById('acceptedCount').textContent = acceptedOrders.length;

    container.innerHTML = acceptedOrders.map(function(order) {
        var fee = getDeliveryFee(order.address?.neighborhood);
        var earning = calculateDriverEarning(order.driverEarning || fee, order.distance);

        return '<div class="delivery-card" id="accepted-' + order.id + '" style="border-color: var(--text-muted);">'
            + '<div class="delivery-header">'
            + '<div class="delivery-store">'
            + '<div class="delivery-store-icon" id="aicon-' + order.id + '">□</div>'
            + '<div>'
            + '<div class="delivery-store-name">' + (order.storeName || 'Loja') + '</div>'
            + '<div class="delivery-store-time">Pedido aceito</div>'
            + '</div></div>'
            + '<div class="delivery-value">'
            + '<div class="delivery-fee">+ ' + formatCurrency(earning) + '</div>'
            + '<div class="delivery-distance">' + (order.distance ? order.distance.toFixed(1) + ' km' : order.address?.neighborhood || '') + '</div>'
            + '</div></div>'
            + '<div class="delivery-body">'
            + '<div class="delivery-address"><div class="address-icon">□</div>'
            + '<div class="address-info"><div class="address-label">Retirar em</div>'
            + '<div class="address-text">' + (order.storeName || 'Loja') + '</div></div></div>'
            + '<div class="delivery-address"><div class="address-icon">◎</div>'
            + '<div class="address-info"><div class="address-label">Entregar em</div>'
            + '<div class="address-text">' + (order.address?.street || '') + ', ' + (order.address?.number || '') + '</div></div></div>'
            + '<div class="delivery-actions">'
            + '<button class="btn btn-warning" onclick="startDelivery(\'' + order.id + '\')" style="flex:1;">Iniciar Retirada</button>'
            + '<button class="btn btn-secondary" id="transfer-btn-' + order.id + '" onclick="openTransferModal(\'' + order.id + '\')" style="flex:1;">Trocar</button>'
            + '</div></div></div>';
    }).join('');

    updateTransferButtons();

    acceptedOrders.forEach(async function(order) {
        if (order.storeId) {
            var storeData = await getStoreData(order.storeId);
            if (storeData?.logoUrl) {
                var iconEl = document.getElementById('aicon-' + order.id);
                if (iconEl) {
                    iconEl.style.backgroundImage = 'url(' + storeData.logoUrl + ')';
                    iconEl.style.backgroundSize = 'cover';
                    iconEl.style.backgroundPosition = 'center';
                    iconEl.textContent = '';
                }
            }
        }
    });
}

function renderCurrentDelivery() {
    if (!currentDelivery) return;
    document.getElementById('currentDeliverySection').style.display = 'block';

    var fee = getDeliveryFee(currentDelivery.address?.neighborhood);
    var earning = calculateDriverEarning(currentDelivery.driverEarning || fee, currentDelivery.distance);
    var clientName = currentDelivery.userName || 'Cliente';
    var clientPhone = currentDelivery.userPhone || currentDelivery.phone || currentDelivery.customerPhone || '';

    document.getElementById('currentDelivery').innerHTML =
        '<div class="current-delivery-header">'
        + '<div class="current-delivery-title">Pedido #' + currentDelivery.id.slice(-6).toUpperCase() + '</div>'
        + '<span class="current-delivery-status status-delivering">Entregar</span>'
        + '</div>'
        + '<div class="tracking-indicator"><span class="tracking-dot"></span><span>Compartilhando localização com cliente</span></div>'
        + '<div class="route-line"><div class="route-dots"><div class="route-dot"></div><div class="route-line-connector"></div><div class="route-dot end"></div></div>'
        + '<div class="route-addresses">'
        + '<div class="route-address"><div class="route-address-label">Retirar</div><div class="route-address-text">' + (currentDelivery.storeName || 'Loja') + '</div></div>'
        + '<div class="route-address"><div class="route-address-label">Entregar</div><div class="route-address-text">' + (currentDelivery.address?.street || '') + ', ' + (currentDelivery.address?.number || '') + '</div></div>'
        + '</div></div>'
        + '<div class="client-box">'
        + '<div class="client-label">Cliente</div>'
        + '<div class="client-name">' + clientName + '</div>'
        + (clientPhone ? '<div class="client-phone"><a href="tel:' + clientPhone + '" style="color:var(--primary);text-decoration:none;">' + clientPhone + '</a>'
            + ' <a href="https://wa.me/55' + clientPhone.replace(/\D/g, '') + '" target="_blank" style="color:#25D366;text-decoration:none;font-size:1.1rem;">💬</a>'
            + '</div>' : '')
        + (currentDelivery.address?.complement ? '<div style="font-size:0.8rem;color:var(--text-muted);margin-top:8px;">' + currentDelivery.address.complement + '</div>' : '')
        + (currentDelivery.address?.reference ? '<div style="font-size:0.8rem;color:var(--text-muted);">Ref: ' + currentDelivery.address.reference + '</div>' : '')
        + '</div>'
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding:12px;background:var(--bg-input);border-radius:8px;border:1px solid var(--border);">'
        + '<span style="color:var(--text-muted);font-size:0.85rem;">Seu ganho</span>'
        + '<span style="font-weight:500;color:var(--primary);">' + formatCurrency(earning) + '</span></div>'
        + '<div class="delivery-actions"><button class="btn btn-success btn-block" onclick="openDeliverModal()">Finalizar Entrega</button></div>';
}

function renderHistory() {
    var container = document.getElementById('historyList');
    if (!container) return;

    var filtered = getFilteredHistory();

    if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">—</div>'
            + '<div class="empty-state-title">Nenhuma entrega neste período</div>'
            + '<div class="empty-state-text">Suas entregas aparecerão aqui</div></div>';
        var heEl = document.getElementById('historyEarnings');
        if (heEl) heEl.textContent = formatCurrency(0);
        return;
    }

    var totalEarnings = 0;
    container.innerHTML = filtered.map(function(order) {
        var time = order.deliveredAt?.toDate?.() || new Date(order.deliveredAt);
        var timeStr = time.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        var dateStr = time.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        var fee = getDeliveryFee(order.address?.neighborhood);
        var earning = calculateDriverEarning(order.driverEarning || fee, order.distance);
        totalEarnings += earning;

        return '<div class="history-item"><div class="history-info">'
            + '<div class="history-store">' + (order.storeName || 'Loja') + '</div>'
            + '<div class="history-time">' + dateStr + ' ' + timeStr + ' - '
            + (order.distance ? order.distance.toFixed(1) + ' km' : order.address?.neighborhood || '') + '</div>'
            + '</div><div class="history-value">+ ' + formatCurrency(earning) + '</div></div>';
    }).join('');

    var heEl = document.getElementById('historyEarnings');
    if (heEl) heEl.textContent = formatCurrency(totalEarnings);
}

function getFilteredHistory() {
    var now = new Date();
    if (historyFilter === 'today') {
        var today = new Date(); today.setHours(0, 0, 0, 0);
        return allHistory.filter(function(o) { var d = o.deliveredAt?.toDate?.() || new Date(o.deliveredAt); return d >= today; });
    }
    if (historyFilter === 'week') {
        var weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        return allHistory.filter(function(o) { var d = o.deliveredAt?.toDate?.() || new Date(o.deliveredAt); return d >= weekAgo; });
    }
    if (historyFilter === 'month') {
        var monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        return allHistory.filter(function(o) { var d = o.deliveredAt?.toDate?.() || new Date(o.deliveredAt); return d >= monthAgo; });
    }
    return allHistory;
}

function setHistoryFilter(filter) {
    historyFilter = filter;
    document.querySelectorAll('[id^="filter"]').forEach(function(btn) {
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-secondary');
    });
    var activeBtn = document.getElementById('filter' + filter.charAt(0).toUpperCase() + filter.slice(1));
    if (activeBtn) { activeBtn.classList.add('btn-primary'); activeBtn.classList.remove('btn-secondary'); }
    renderHistory();
}

function updateStats() {
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var todayOrders = allHistory.filter(function(o) {
        var date = o.deliveredAt?.toDate?.() || new Date(o.deliveredAt);
        return date >= today;
    });

    var todayMoney = 0, todayDistance = 0;
    todayOrders.forEach(function(order) {
        var fee = order.driverEarning || getDeliveryFee(order.address?.neighborhood);
        todayMoney += (calculateDriverEarning(fee, order.distance) || 0);
        todayDistance += (order.distance || 3.5);
    });

    document.getElementById('todayEarnings').textContent = formatCurrency(todayMoney || 0);
    document.getElementById('todayDeliveries').textContent = todayOrders.length;
    document.getElementById('todayDistance').textContent = ((todayDistance || 0)).toFixed(1) + ' km';

    var weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    var weekOrders = allHistory.filter(function(o) {
        var date = o.deliveredAt?.toDate?.() || new Date(o.deliveredAt);
        return date >= weekAgo;
    });

    var weekMoney = 0, weekDistance = 0;
    weekOrders.forEach(function(order) {
        var fee = order.driverEarning || getDeliveryFee(order.address?.neighborhood);
        weekMoney += (calculateDriverEarning(fee, order.distance) || 0);
        weekDistance += (order.distance || 3.5);
    });

    document.getElementById('weekEarningsTotal').textContent = formatCurrency(weekMoney || 0);
    document.getElementById('weekDeliveriesCount').textContent = weekOrders.length;
    document.getElementById('weekDistanceTotal').textContent = ((weekDistance || 0)).toFixed(1) + ' km';
    document.getElementById('weekHoursTotal').textContent = (weekOrders.length * 0.5).toFixed(0) + 'h';
    document.getElementById('totalDeliveries').textContent = allHistory.length;
}
// ==================== ACTIONS ====================

async function toggleOnline() {
    try {
        if (typeof FCMModule !== 'undefined' && !FCMModule.token && Notification.permission === 'default') {
            setupDriverPushNotifications().catch(function() {});
        }
    } catch(e) {}

    isOnline = !isOnline;
    document.getElementById('onlineToggle').classList.toggle('active', isOnline);
    document.getElementById('statusText').textContent = isOnline ? 'Online' : 'Offline';
    localStorage.setItem('pedrad_driver_online', isOnline ? 'true' : 'false');
    updateDriverOnlineStatus(isOnline);

    if (isOnline) {
        startOnlineHeartbeat();
        if (typeof IdleDriver !== 'undefined' && IdleDriver.isStoreDriver()) IdleDriver.transition('GO_ONLINE');
    } else {
        stopOnlineHeartbeat();
        if (typeof IdleDriver !== 'undefined' && IdleDriver.isStoreDriver()) IdleDriver.transition('GO_OFFLINE');
    }

    renderAvailableOrders();
    showToast(isOnline ? 'Você está online' : 'Você está offline');
}

function startOnlineHeartbeat() {
    if (onlineInterval) clearInterval(onlineInterval);
    onlineInterval = setInterval(function() {
        if (isOnline && driverData) updateDriverOnlineStatus(true);
    }, 60000);
}

function stopOnlineHeartbeat() {
    if (onlineInterval) { clearInterval(onlineInterval); onlineInterval = null; }
}

async function updateDriverOnlineStatus(online) {
    if (!driverData) return;
    try {
        await db.collection('drivers').doc(driverData.id).update({
            online: online,
            lastOnlineAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    } catch (err) { console.error('Error updating status:', err); }
}

// ==================== ACCEPT ORDER ====================

function acceptOrder(orderId) {
    pendingAcceptOrder = availableOrders.find(function(o) { return o.id === orderId; });
    if (!pendingAcceptOrder) return;

    var fee = getDeliveryFee(pendingAcceptOrder.address?.neighborhood);
    var earning = calculateDriverEarning(fee, pendingAcceptOrder.distance);

    document.getElementById('acceptModalText').textContent =
        (pendingAcceptOrder.storeName || 'Loja') + ' → ' + (pendingAcceptOrder.address?.neighborhood || '');

    document.getElementById('acceptModalInfo').innerHTML =
        '<div style="display:flex;justify-content:space-between;"><span>Taxa de entrega</span><span>' + formatCurrency(fee) + '</span></div>'
        + (pendingAcceptOrder.distance ? '<div style="display:flex;justify-content:space-between;margin-top:8px;"><span>Distância</span><span>' + pendingAcceptOrder.distance.toFixed(1) + ' km</span></div>' : '')
        + '<div style="display:flex;justify-content:space-between;margin-top:8px;font-weight:500;color:var(--primary);"><span>Seu ganho</span><span>' + formatCurrency(earning) + '</span></div>';

    openModal('acceptModal');
}

async function confirmAccept() {
    if (!pendingAcceptOrder || !driverData) return;

    // FIX: declare the variables that were missing
    var maxOrders = driverData.maxSimultaneousOrders || 1;
    var myActiveCount = acceptedOrders.length + (currentDelivery ? 1 : 0);

    // Store driver check
    var isStoreDriver = driverData.driverType === 'store' && driverData.storeId;
    var isOwnStore = isStoreDriver && pendingAcceptOrder.storeId === driverData.storeId;

    // Store driver can accept other stores ONLY if appEligible
    if (isStoreDriver && !isOwnStore && !driverData.appEligible) {
        closeModal('acceptModal');
        showToast('Você não está liberado para entregas de outras lojas');
        return;
    }

    // Own store orders bypass limit
    if (!isOwnStore && myActiveCount >= maxOrders) {
        closeModal('acceptModal');
        showToast('Limite de entregas simultâneas atingido');
        return;
    }

    // Regular driver: check if store is covered by assigned driver
    if (!isStoreDriver && pendingAcceptOrder.storeId && coveredStoreIds.has(pendingAcceptOrder.storeId)) {
        closeModal('acceptModal');
        showToast('Esta loja tem entregador próprio online');
        return;
    }

    // OPTIMISTIC UI: remove from available immediately
    var orderId = pendingAcceptOrder.id;
    var orderCard = document.getElementById('order-' + orderId);
    if (orderCard) orderCard.style.opacity = '0.3';

    try {
        var fee = getDeliveryFee(pendingAcceptOrder.address?.neighborhood);
        var earning = calculateDriverEarning(fee, pendingAcceptOrder.distance);
        var timeline = pendingAcceptOrder.timeline || [];
        timeline.push({
            status: 'accepted',
            timestamp: new Date().toISOString(),
            message: 'Entregador ' + driverData.name + ' aceitou'
        });

        await db.collection('orders').doc(orderId).update({
            driverId: driverData.id,
            driverName: driverData.name,
            driverPhone: driverData.phone,
            driverVehicle: driverData.vehicle,
            driver: {
                id: driverData.id,
                name: driverData.name,
                phone: driverData.phone || '',
                vehicle: driverData.vehicle || 'Moto',
                photoUrl: driverData.photoUrl || null,
                driverToken: driverData.driverToken || null
            },
            driverEarning: earning,
            timeline: timeline,
            acceptedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        closeModal('acceptModal');
        showToast('Entrega aceita');
        pendingAcceptOrder = null;

    } catch (err) {
        console.error('Error accepting:', err);
        // Revert optimistic UI
        if (orderCard) orderCard.style.opacity = '1';
        showToast('Erro ao aceitar entrega');
    }
}

// ==================== START DELIVERY ====================

function startDelivery(orderId) {
    var order = acceptedOrders.find(function(o) { return o.id === orderId; });
    if (!order) return;
    showConfirmModal('Retirar pedido?', 'Confirme que você está retirando o pedido na loja.',
        function() { executeStartDelivery(order); }, 'Confirmar retirada');
}

async function executeStartDelivery(order) {
    try {
        var timeline = order.timeline || [];
        timeline.push({
            status: 'delivering',
            timestamp: new Date().toISOString(),
            message: 'Pedido retirado, saiu para entrega'
        });
        await db.collection('orders').doc(order.id).update({
            status: 'delivering',
            timeline: timeline,
            pickedUpAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        showToast('Pedido retirado - Siga para o cliente');
        openNavMap();
    } catch (err) {
        console.error('Error starting delivery:', err);
        showToast('Erro ao iniciar entrega');
    }
}

// ==================== CONFIRM DELIVERY ====================

function openDeliverModal() {
    capturedLocation = null;
    openModal('deliverModal');
    setTimeout(captureLocationAuto, 500);
}

function captureLocationAuto() {
    var statusEl = document.getElementById('locationStatus');
    var btnEl = document.getElementById('confirmDeliveryBtn');
    statusEl.innerHTML = '<span class="location-icon">◌</span><span class="location-text">Capturando localização...</span>';
    statusEl.className = 'location-status loading';
    btnEl.disabled = true;
    btnEl.textContent = 'Aguarde GPS...';

    if (!navigator.geolocation) {
        statusEl.innerHTML = '<span class="location-icon">×</span><span class="location-text">GPS não disponível</span>';
        statusEl.className = 'location-status error';
        btnEl.disabled = false;
        btnEl.textContent = 'Confirmar mesmo assim';
        return;
    }

    navigator.geolocation.getCurrentPosition(
        function(pos) {
            capturedLocation = {
                lat: pos.coords.latitude, lng: pos.coords.longitude,
                accuracy: pos.coords.accuracy, timestamp: new Date().toISOString()
            };
            statusEl.innerHTML = '<span class="location-icon">✓</span><span class="location-text">Localização capturada<br><small>Precisão: ' + pos.coords.accuracy.toFixed(0) + 'm</small></span>';
            statusEl.className = 'location-status success';
            btnEl.disabled = false;
            btnEl.textContent = 'Confirmar Entrega';
        },
        function(err) {
            var msg = 'Erro ao capturar';
            if (err.code === 1) msg = 'Permissão negada';
            if (err.code === 2) msg = 'GPS indisponível';
            if (err.code === 3) msg = 'Tempo esgotado';
            statusEl.innerHTML = '<span class="location-icon">!</span><span class="location-text">' + msg + '</span>';
            statusEl.className = 'location-status error';
            btnEl.disabled = false;
            btnEl.textContent = 'Confirmar mesmo assim';
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
}

async function confirmDelivery() {
    if (!currentDelivery) return;
    stopLocationTracking();

    try {
        var timeline = currentDelivery.timeline || [];
        timeline.push({
            status: 'delivered',
            timestamp: new Date().toISOString(),
            message: 'Pedido entregue ao cliente',
            location: capturedLocation
        });

        var updateData = {
            status: 'delivered',
            timeline: timeline,
            deliveredAt: new Date().toISOString(),
            driverLocation: null
        };
        if (capturedLocation) updateData.deliveryLocation = capturedLocation;

        await db.collection('orders').doc(currentDelivery.id).update(updateData);

        if (driverData) {
            await db.collection('drivers').doc(driverData.id).update({
                totalDeliveries: firebase.firestore.FieldValue.increment(1),
                lastDeliveryAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        }

        if (typeof IdleDriver !== 'undefined' && IdleDriver.isStoreDriver()) {
            var wasOwnStore = currentDelivery.storeId === driverData.storeId;
            IdleDriver.transition(wasOwnStore ? 'STORE_DELIVERY_DONE' : 'APP_TRIP_ENDED');
        }

        var earning = currentDelivery.driverEarning || platformConfig.driverFee;
        closeModal('deliverModal');
        hideNavMapButton();
        showToast('Entrega concluída +' + formatCurrency(earning));
        capturedLocation = null;
    } catch (err) {
        console.error('Error confirming delivery:', err);
        showToast('Erro: ' + (err.message || 'Tente novamente'));
    }
}

function requestLocationPermission() {
    if (!navigator.geolocation) { showToast('GPS não disponível'); return; }
    navigator.geolocation.getCurrentPosition(
        function() { showToast('Permissão concedida'); },
        function(err) {
            showToast(err.code === 1 ? 'Permissão negada - Ative nas configurações' : 'Erro ao obter permissão');
        }
    );
}

// ==================== NAVIGATION ====================

function showPage(page) {
    document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
    document.querySelectorAll('.nav-item').forEach(function(n) { n.classList.remove('active'); });
    var el = document.getElementById(page + 'Page');
    if (el) el.classList.add('active');
    var navIndex = { home: 0, history: 1, earnings: 2, profile: 3 };
    var items = document.querySelectorAll('.nav-item');
    if (items[navIndex[page]]) items[navIndex[page]].classList.add('active');
}

// ==================== UTILITIES ====================

function openModal(id) { var el = document.getElementById(id); if (el) el.classList.add('active'); }
function closeModal(id) { var el = document.getElementById(id); if (el) el.classList.remove('active'); }

function getWaitTime(createdAt) {
    if (!createdAt) return 0;
    var date = createdAt.toDate ? createdAt.toDate() : new Date(createdAt);
    return Math.floor((Date.now() - date.getTime()) / 60000);
}

function getDeliveryFee(neighborhood) {
    if (!neighborhood) return platformConfig.driverFee || 5;
    var fee = deliveryFees.find(function(f) { return f.name?.toLowerCase() === neighborhood.toLowerCase(); });
    return fee?.fee || platformConfig.driverFee || 5;
}

function calculateDriverEarning(baseFee, distance) {
    var kmBonus = (distance || 0) * (platformConfig.driverKmBonus || 1);
    return (baseFee || platformConfig.driverFee || 5) + kmBonus;
    
}

function formatCurrency(value) {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

function showToast(message) {
    var toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(function() { toast.classList.remove('show'); }, 3000);
}

// ==================== NAV MAP ====================
var navMap = null;

function openNavMap() {
    if (!currentDelivery?.address?.location) { showToast('Cliente não tem localização salva'); return; }
    document.getElementById('navMapPopup').classList.add('active');
    document.getElementById('navMapBtn').classList.remove('active');
    setTimeout(function() {
        var loc = currentDelivery.address.location;
        if (navMap) navMap.remove();
        navMap = L.map('navMap').setView([loc.lat, loc.lng], 16);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(navMap);
        L.marker([loc.lat, loc.lng]).addTo(navMap)
            .bindPopup((currentDelivery.address.street || '') + ', ' + (currentDelivery.address.number || '')).openPopup();
    }, 100);
}

function closeNavMap() {
    document.getElementById('navMapPopup').classList.remove('active');
    if (currentDelivery) document.getElementById('navMapBtn').classList.add('active');
}

function showNavMapButton() {
    if (currentDelivery?.address?.location) document.getElementById('navMapBtn').classList.add('active');
}

function hideNavMapButton() {
    document.getElementById('navMapBtn').classList.remove('active');
    document.getElementById('navMapPopup').classList.remove('active');
}

// ==================== TRANSFER SYSTEM ====================

var transferOffers = [];
var myTransferOffer = null;

function setupTransferListener() {
    if (!driverData) return;
    db.collection('transferOffers').where('status', '==', 'open').onSnapshot(function(snapshot) {
        transferOffers = snapshot.docs.map(function(doc) { return { id: doc.id, ...doc.data() }; });
        renderTransferOffers();
        checkMyOffer();
    });
}

function checkMyOffer() {
    myTransferOffer = transferOffers.find(function(o) { return o.driverId === driverData.id; });
    updateTransferButtons();
}

function updateTransferButtons() {
    acceptedOrders.forEach(function(order) {
        var btn = document.getElementById('transfer-btn-' + order.id);
        if (!btn) return;
        if (myTransferOffer && myTransferOffer.orderId === order.id) {
            btn.textContent = 'Cancelar';
            btn.onclick = function() { cancelTransferOffer(); };
        } else if (myTransferOffer) {
            btn.style.display = 'none';
        } else {
            btn.textContent = 'Trocar';
            btn.onclick = function() { openTransferModal(order.id); };
            btn.style.display = '';
        }
    });
}

function openTransferModal(orderId) {
    var order = acceptedOrders.find(function(o) { return o.id === orderId; });
    if (!order) return;
    var container = document.getElementById('transferNeighborhoods');
    if (!container) return;
    container.innerHTML = deliveryFees.map(function(fee) {
        return '<label class="transfer-neighborhood-option"><input type="checkbox" value="' + fee.name + '" class="transfer-checkbox"><span>' + fee.name + '</span></label>';
    }).join('');
    document.getElementById('transferOrderInfo').textContent = (order.storeName || 'Loja') + ' → ' + (order.address?.neighborhood || 'N/A');
    document.getElementById('transferModal').dataset.orderId = orderId;
    openModal('transferModal');
}

async function createTransferOffer() {
    var orderId = document.getElementById('transferModal').dataset.orderId;
    var order = acceptedOrders.find(function(o) { return o.id === orderId; });
    if (!order) return;
    var checkboxes = document.querySelectorAll('.transfer-checkbox:checked');
    var wantNeighborhoods = Array.from(checkboxes).map(function(cb) { return cb.value; });
    if (wantNeighborhoods.length === 0) { showToast('Selecione pelo menos um bairro'); return; }
    try {
        await db.collection('transferOffers').add({
            orderId: order.id,
            orderNeighborhood: order.address?.neighborhood || '',
            storeName: order.storeName,
            storeId: order.storeId,
            driverId: driverData.id,
            driverName: driverData.name,
            wantNeighborhoods: wantNeighborhoods,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            status: 'open'
        });
        closeModal('transferModal');
        showToast('Oferta de troca criada');
    } catch (err) { showToast('Erro ao criar oferta'); }
}

async function cancelTransferOffer() {
    if (!myTransferOffer) return;
    try {
        await db.collection('transferOffers').doc(myTransferOffer.id).delete();
        showToast('Oferta cancelada');
    } catch (err) { showToast('Erro ao cancelar'); }
}

function renderTransferOffers() {
    var section = document.getElementById('transferOffersSection');
    var container = document.getElementById('transferOffersList');
    if (!section || !container) return;

    var myNeighborhoods = acceptedOrders.map(function(o) { return o.address?.neighborhood; }).filter(Boolean);
    var compatible = transferOffers.filter(function(offer) {
        if (offer.driverId === driverData.id) return false;
        if (offer.status !== 'open') return false;
        return offer.wantNeighborhoods.some(function(n) { return myNeighborhoods.includes(n); });
    });

    if (compatible.length === 0) { section.style.display = 'none'; return; }

    section.style.display = 'block';
    var countEl = document.getElementById('transferOffersCount');
    if (countEl) countEl.textContent = compatible.length;

    container.innerHTML = compatible.map(function(offer) {
        var myMatching = acceptedOrders.filter(function(o) {
            return offer.wantNeighborhoods.includes(o.address?.neighborhood);
        });
        return '<div class="transfer-offer-card">'
            + '<div class="transfer-offer-header"><div class="transfer-offer-driver">' + offer.driverName + '</div>'
            + '<div class="transfer-offer-time">' + getOfferTimeAgo(offer.createdAt) + '</div></div>'
            + '<div class="transfer-offer-details">'
            + '<div class="transfer-offer-has"><span class="transfer-label">Oferece</span><span class="transfer-value">' + offer.storeName + ' → ' + offer.orderNeighborhood + '</span></div>'
            + '<div class="transfer-offer-wants"><span class="transfer-label">Aceita</span><span class="transfer-value">' + offer.wantNeighborhoods.join(', ') + '</span></div></div>'
            + '<div class="transfer-offer-match"><span class="transfer-label">Você pode trocar</span>'
            + '<select class="input transfer-select" id="match-' + offer.id + '">'
            + myMatching.map(function(o) { return '<option value="' + o.id + '">' + o.storeName + ' → ' + (o.address?.neighborhood || '') + '</option>'; }).join('')
            + '</select></div>'
            + '<button class="btn btn-primary" onclick="acceptTransfer(\'' + offer.id + '\')">Aceitar troca</button></div>';
    }).join('');
}

async function acceptTransfer(offerId) {
    var offer = transferOffers.find(function(o) { return o.id === offerId; });
    if (!offer) return;
    var selectEl = document.getElementById('match-' + offerId);
    var myOrderId = selectEl?.value;
    var myOrder = acceptedOrders.find(function(o) { return o.id === myOrderId; });
    if (!myOrder) { showToast('Selecione um pedido para trocar'); return; }
    showConfirmModal('Trocar entregas?',
        'Recebe: ' + offer.storeName + ' → ' + offer.orderNeighborhood + '\nPassa: ' + myOrder.storeName + ' → ' + (myOrder.address?.neighborhood || ''),
        function() { executeTransfer(offer, myOrder); }, 'Trocar');
}

async function executeTransfer(offer, myOrder) {
    try {
        var batch = db.batch();
        batch.update(db.collection('orders').doc(offer.orderId), {
            driverId: driverData.id, driverName: driverData.name, driverPhone: driverData.phone, driverVehicle: driverData.vehicle,
            timeline: firebase.firestore.FieldValue.arrayUnion({ status: 'transferred', timestamp: new Date().toISOString(), message: 'Troca: ' + offer.driverName + ' → ' + driverData.name })
        });
        batch.update(db.collection('orders').doc(myOrder.id), {
            driverId: offer.driverId, driverName: offer.driverName, driverPhone: '',
            timeline: firebase.firestore.FieldValue.arrayUnion({ status: 'transferred', timestamp: new Date().toISOString(), message: 'Troca: ' + driverData.name + ' → ' + offer.driverName })
        });
        batch.delete(db.collection('transferOffers').doc(offer.id));
        await batch.commit();
        showToast('Troca realizada!');
    } catch (err) { showToast('Erro ao realizar troca'); }
}

function getOfferTimeAgo(timestamp) {
    if (!timestamp) return '';
    var date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    var mins = Math.floor((Date.now() - date.getTime()) / 60000);
    if (mins < 1) return 'agora';
    if (mins < 60) return mins + 'min';
    return Math.floor(mins / 60) + 'h';
}

async function cleanExpiredOffers() {
    var now = new Date();
    transferOffers.filter(function(o) {
        var exp = o.expiresAt?.toDate ? o.expiresAt.toDate() : new Date(o.expiresAt);
        return exp < now;
    }).forEach(async function(offer) {
        try { await db.collection('transferOffers').doc(offer.id).delete(); } catch (e) {}
    });
}

function initTransferSystem() {
    setupTransferListener();
    setInterval(cleanExpiredOffers, 60000);
}

// ==================== NOTIFICATIONS ====================

async function requestNotificationPermission() {
    if (!driverData) { showToast('Faça login primeiro'); return; }
    if (Notification.permission === 'granted') {
        showToast('Notificações já estão ativas');
        await setupDriverPushNotifications();
        return;
    }
    if (Notification.permission === 'denied') {
        showToast('Notificações bloqueadas. Libere nas configurações do navegador.');
        return;
    }
    await setupDriverPushNotifications();
    if (Notification.permission === 'granted') showToast('Notificações ativadas!');
}
