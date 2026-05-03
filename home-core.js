// ==================== STATE ====================
var currentUser = null;
var driverData = null;
var isOnline = false;
var currentDelivery = null;
var acceptedOrders = [];
var availableOrders = [];
var allHistory = [];
var historyFilter = 'week';

var pendingAcceptOrder = null;
var capturedLocation = null;

var onlineInterval = null;
var availableOrdersUnsub = null;
var availableListenerKey = '';

var locationWatchId = null;
var lastLocationUpdate = 0;
var navMap = null;

// ==================== HELPERS ====================
function getLinkedStoreIds(driver) {
    const ids = new Set();
    if (driver?.linkedStoreId) ids.add(String(driver.linkedStoreId));
    if (driver?.storeId) ids.add(String(driver.storeId));
    if (Array.isArray(driver?.linkedStores)) {
        driver.linkedStores.filter(Boolean).forEach(id => ids.add(String(id)));
    }
    return [...ids];
}

function isStoreBoundDriver(driver) {
    return getLinkedStoreIds(driver).length > 0;
}

function getAvailableListenerKey() {
    return JSON.stringify({
        online: !!isOnline,
        driverType: driverData?.driverType || '',
        linkedStoreIds: getLinkedStoreIds(driverData)
    });
}

function teardownAvailableOrdersListener(clearList = true) {
    if (typeof availableOrdersUnsub === 'function') {
        availableOrdersUnsub();
        availableOrdersUnsub = null;
    }
    availableListenerKey = '';
    stopAlertLoop();
    if (clearList) {
        availableOrders = [];
        renderAvailableOrders();
    }
}

function buildAvailableOrdersQuery() {
    const linkedStoreIds = getLinkedStoreIds(driverData);

    // Entregador vinculado: apenas pedidos das lojas vinculadas, status ativo.
    // Não depende mais de salesChannel — se é da loja vinculada, é dele.
    if (isStoreBoundDriver(driverData) && linkedStoreIds.length) {
        let query = db.collection('orders')
            .where('status', 'in', ['preparing', 'ready'])
            .where('orderType', '==', 'delivery')
            .where('deliveryPool', '==', 'store');
        query = linkedStoreIds.length === 1
            ? query.where('storeId', '==', linkedStoreIds[0])
            : query.where('storeId', 'in', linkedStoreIds.slice(0, 10));
        return query;
    }

    // Entregador avulso: apenas pedidos com pool 'app' (lojas sem vínculo).
    return db.collection('orders')
        .where('deliveryPool', '==', 'app')
        .where('status', 'in', ['preparing', 'ready'])
        .where('orderType', '==', 'delivery');
}

function syncAvailableOrdersListener(force = false) {
    if (!driverData || !isOnline) {
        teardownAvailableOrdersListener(true);
        return;
    }
    const nextKey = getAvailableListenerKey();
    if (!force && availableOrdersUnsub && availableListenerKey === nextKey) return;
    teardownAvailableOrdersListener(false);
    setupAvailableOrdersListener();
}

// ==================== STATS ====================
async function loadHistoryForStats() {
    const cached = Cache.getHistory();
    if (cached) { allHistory = cached; return; }
    try {
        const weekAgo = new Date(Date.now() - 7 * 86400000);
        const snapshot = await db.collection('orders')
            .where('driverId', '==', driverData.id)
            .where('status', '==', 'delivered')
            .where('createdAt', '>=', weekAgo)
            .orderBy('createdAt', 'desc')
            .limit(100)
            .get();
        allHistory = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        Cache.setHistory(allHistory);
    } catch (e) { console.error('Error loading history:', e); }
}

// ==================== LISTENERS ====================
function setupListeners() {
    syncAvailableOrdersListener(true);

    if (driverData) {
        db.collection('orders')
            .where('driverId', '==', driverData.id)
            .where('status', 'in', ['preparing', 'ready', 'delivering'])
            .onSnapshot(snapshot => {
                const myOrders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                acceptedOrders = myOrders.filter(o => o.status === 'preparing' || o.status === 'ready');
                renderAcceptedOrders();
                const delivering = myOrders.find(o => o.status === 'delivering');
                if (delivering) {
                    const wasDelivering = !!currentDelivery;
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

        setupDriverListener((newData) => {
            const prevKey = getAvailableListenerKey();
            Object.keys(driverData).forEach(k => {
                if (k !== 'id' && !(k in newData)) delete driverData[k];
            });
            Object.assign(driverData, newData);
            updateDriverCard();
            const nextKey = getAvailableListenerKey();
            if (prevKey !== nextKey) {
                syncAvailableOrdersListener(true);
            } else {
                renderAvailableOrders();
            }
        });

        setupFeesListener();
    }

    loadHistoryForStats();
}

function setupAvailableOrdersListener() {
    const linkedStoreIds = getLinkedStoreIds(driverData);
    const availableQuery = buildAvailableOrdersQuery();
    availableListenerKey = getAvailableListenerKey();

    availableOrdersUnsub = availableQuery.onSnapshot(snapshot => {
        const prevFilteredCount = getFilteredOrders().length;
        availableOrders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        const nextFilteredCount = getFilteredOrders().length;

        if (IdleDriver.isStoreDriver() && IdleDriver.state === 'STORE_IDLE') {
            if (availableOrders.some(o => linkedStoreIds.includes(String(o.storeId || '')))) {
                IdleDriver.transition('STORE_ORDER_ARRIVED');
                showToast('Pedido da sua loja — saindo do modo ocioso');
            }
        }

        renderAvailableOrders();

        if (nextFilteredCount > prevFilteredCount && isOnline && !currentDelivery) {
            startAlertLoop();
            showToast('Nova entrega disponível');
        } else if (nextFilteredCount === 0 || currentDelivery) {
            stopAlertLoop();
        }
    }, (error) => {
        console.error('Erro no listener de pedidos disponíveis:', error);
        teardownAvailableOrdersListener(true);
    });
}

function getFilteredOrders() {
    if (!driverData) return [];
    const linkedStoreIds = getLinkedStoreIds(driverData);
    const storeBound = isStoreBoundDriver(driverData);
    return availableOrders.filter(order => {
        if (order.driverId) return false;
        if (order.orderType !== 'delivery') return false;
        if (storeBound) return linkedStoreIds.includes(String(order.storeId || ''));
        return order.deliveryPool === 'app';
    });
}

// ==================== ONLINE ====================
async function toggleOnline() {
    try {
        if (typeof FCMModule !== 'undefined' && !FCMModule.token && Notification.permission === 'default') {
            setupDriverPushNotifications().catch(() => {});
        }
    } catch(e) {}

    isOnline = !isOnline;
    document.getElementById('onlineToggle').classList.toggle('active', isOnline);
    document.getElementById('statusText').textContent = isOnline ? 'Online' : 'Offline';
    Cache.setOnline(isOnline);
    updateDriverOnlineStatus(isOnline);

    if (isOnline) {
        startOnlineHeartbeat();
        syncAvailableOrdersListener(true);
        if (IdleDriver.isStoreDriver()) IdleDriver.transition('GO_ONLINE');
    } else {
        stopOnlineHeartbeat();
        teardownAvailableOrdersListener(true);
        if (IdleDriver.isStoreDriver()) IdleDriver.transition('GO_OFFLINE');
    }

    renderAvailableOrders();
    showToast(isOnline ? 'Você está online' : 'Você está offline');
}

function startOnlineHeartbeat() {
    if (onlineInterval) clearInterval(onlineInterval);
    onlineInterval = setInterval(() => {
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
            online,
            lastOnlineAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    } catch (e) { console.error('Error updating status:', e); }
}

// ==================== ACCEPT ORDER ====================
async function confirmAccept() {
    if (!pendingAcceptOrder || !driverData) return;

    const linkedStoreIds = getLinkedStoreIds(driverData);
    const storeBound = isStoreBoundDriver(driverData);

if (storeBound) {
        if (!linkedStoreIds.includes(String(pendingAcceptOrder.storeId || ''))) {
            closeModal('acceptModal');
            showToast('Sem permissão para aceitar este pedido');
            return;
        }
    } else {
        if (pendingAcceptOrder.deliveryPool !== 'app') {
            closeModal('acceptModal');
            showToast('Sem permissão para aceitar este pedido');
            return;
        }
    }
    const maxOrders = driverData.maxSimultaneousOrders || 1;
    const myActive  = acceptedOrders.length + (currentDelivery ? 1 : 0);
    if (myActive >= maxOrders) {
        closeModal('acceptModal');
        showToast('Limite de entregas simultâneas atingido');
        return;
    }

    const confirmBtn = document.querySelector('#acceptModal .btn-primary');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Processando...';

    try {
        await db.runTransaction(async (transaction) => {
            const docRef  = db.collection('orders').doc(pendingAcceptOrder.id);
            const docSnap = await transaction.get(docRef);

            if (!docSnap.exists) throw new Error('ORDER_NOT_FOUND');
            if (docSnap.data().driverId) throw new Error('ALREADY_ACCEPTED');

            const fee      = getDeliveryFee(pendingAcceptOrder.address?.neighborhood);
            const earning  = calculateDriverEarning(fee, pendingAcceptOrder.distance);
            const timeline = pendingAcceptOrder.timeline || [];
            timeline.push({
                status: 'accepted',
                timestamp: new Date().toISOString(),
                message: `Entregador ${driverData.name} aceitou`
            });

            transaction.update(docRef, {
                driverId:      driverData.id,
                driverName:    driverData.name,
                driverPhone:   driverData.phone,
                driverVehicle: driverData.vehicle,
                driver: {
                    id:            driverData.id,
                    name:          driverData.name,
                    phone:         driverData.phone,
                    vehicle:       driverData.vehicle,
                    photoUrl:      driverData.photoUrl || null,
                    allowPhone:    driverData.allowPhone || false,
                    allowWhatsapp: driverData.allowWhatsapp || false
                },
                driverEarning: earning,
                timeline,
                acceptedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        });

        stopAlertLoop();
        closeModal('acceptModal');
        showToast('Entrega aceita');
        pendingAcceptOrder = null;

    } catch (e) {
        if (e.message === 'ALREADY_ACCEPTED') {
            const takenId = pendingAcceptOrder?.id;
            if (takenId) availableOrders = availableOrders.filter(order => order.id !== takenId);
            pendingAcceptOrder = null;
            closeModal('acceptModal');
            renderAvailableOrders();
            if (getFilteredOrders().length === 0) stopAlertLoop();
            showToast('Outro entregador pegou essa entrega');
        } else if (e.message === 'ORDER_NOT_FOUND') {
            const missingId = pendingAcceptOrder?.id;
            if (missingId) availableOrders = availableOrders.filter(order => order.id !== missingId);
            pendingAcceptOrder = null;
            closeModal('acceptModal');
            renderAvailableOrders();
            if (getFilteredOrders().length === 0) stopAlertLoop();
            showToast('Pedido não encontrado');
        } else {
            console.error('Error accepting:', e);
            showToast('Erro ao aceitar entrega');
        }
    } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Aceitar';
    }
}

// ==================== DELIVERY FLOW ====================
async function executeStartDelivery(order) {
    try {
        const timeline = order.timeline || [];
        timeline.push({ status: 'delivering', timestamp: new Date().toISOString(), message: 'Pedido retirado, saiu para entrega' });
        await db.collection('orders').doc(order.id).update({
            status: 'delivering', timeline,
            pickedUpAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        showToast('Pedido retirado - Siga para o cliente');
    } catch (e) { console.error('Error starting delivery:', e); showToast('Erro ao iniciar entrega'); }
}

async function confirmDelivery() {
    if (!currentDelivery) return;
    const deliveryRef = currentDelivery;
    stopLocationTracking();
    try {
        const timeline = deliveryRef.timeline || [];
        timeline.push({ status: 'delivered', timestamp: new Date().toISOString(), message: 'Pedido entregue ao cliente', location: capturedLocation });
        const updateData = { status: 'delivered', timeline, deliveredAt: new Date().toISOString(), driverLocation: null };
        if (capturedLocation) updateData.deliveryLocation = capturedLocation;
        await db.collection('orders').doc(deliveryRef.id).update(updateData);
        if (driverData) {
            await db.collection('drivers').doc(driverData.id).update({
                totalDeliveries: firebase.firestore.FieldValue.increment(1),
                lastDeliveryAt:  firebase.firestore.FieldValue.serverTimestamp()
            });
        }
        if (IdleDriver.isStoreDriver()) {
            IdleDriver.transition(deliveryRef.storeId === getLinkedStoreIds(driverData)[0] ? 'STORE_DELIVERY_DONE' : 'APP_TRIP_ENDED');
        }
        Cache.remove('history');
        const earning = deliveryRef.driverEarning || platformConfig.driverFee;
        closeModal('deliverModal');
        hideNavMapButton();
        showToast(`Entrega concluída +${formatCurrency(earning)}`);
        capturedLocation = null;
    } catch (e) { console.error('Error confirming delivery:', e); showToast('Erro: ' + (e.message || 'Tente novamente')); }
}

// ==================== LOCATION TRACKING ====================
function startLocationTracking() {
    if (!navigator.geolocation) return;
    stopLocationTracking();
    lastLocationUpdate = 0;
    locationWatchId = navigator.geolocation.watchPosition(
        async (pos) => {
            const now = Date.now();
            if (now - lastLocationUpdate < 5000) return;
            lastLocationUpdate = now;
            await updateDriverLocationInOrder({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, timestamp: new Date().toISOString() });
        },
        (err) => { console.warn('GPS watch error:', err); },
        { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
    );
}

function stopLocationTracking() {
    if (locationWatchId !== null) { navigator.geolocation.clearWatch(locationWatchId); locationWatchId = null; }
}

async function updateDriverLocationInOrder(location) {
    if (!currentDelivery || !driverData) return;
    try {
        await db.collection('orders').doc(currentDelivery.id).update({
            driverLocation: location,
            driver: { id: driverData.id, name: driverData.name, phone: driverData.phone || '', vehicle: driverData.vehicle || 'Moto', photoUrl: driverData.photoUrl || null, allowPhone: driverData.allowPhone || false, allowWhatsapp: driverData.allowWhatsapp || false }
        });
    } catch (e) { console.error('Error updating location:', e); }
}
