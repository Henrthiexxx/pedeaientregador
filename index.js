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
let availableOrders = [];
let completedToday = [];
let deliveryFees = [];
let pendingAcceptOrder = null;
let capturedLocation = null;
let platformConfig = { driverFee: 5, driverKmBonus: 1 };

// ==================== AUTH ====================

// Verificar sessão salva
document.addEventListener('DOMContentLoaded', async () => {
    const savedDriverId = localStorage.getItem('pedrad_driver_id');
    if (savedDriverId) {
        const driver = await loadDriverById(savedDriverId);
        if (driver && driver.status !== 'blocked') {
            driverData = driver;
            currentUser = { email: driver.email };
            showMainApp();
            await loadAllData();
            setupRealtimeListeners();
        } else {
            localStorage.removeItem('pedrad_driver_id');
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
        if (!driver) {
            showToast('Entregador não cadastrado');
            return;
        }
        if (driver.status === 'blocked') {
            showToast('Sua conta está bloqueada');
            return;
        }
        if (driver.password !== password) {
            showToast('Senha incorreta');
            return;
        }

        // Login OK - salvar sessão
        driverData = driver;
        currentUser = { email: driver.email };
        localStorage.setItem('pedrad_driver_id', driver.id);
        
        showMainApp();
        await loadAllData();
        setupRealtimeListeners();
        showToast('✅ Bem-vindo, ' + driver.name);
    } catch (err) {
        console.error('Login error:', err);
        showToast('Erro ao entrar');
    }
}

async function loadDriverData(email) {
    try {
        const snapshot = await db.collection('drivers')
            .where('email', '==', email)
            .limit(1)
            .get();
        if (!snapshot.empty) {
            return { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
        }
        return null;
    } catch (err) {
        console.error('Error loading driver:', err);
        return null;
    }
}

async function loadDriverById(id) {
    try {
        const doc = await db.collection('drivers').doc(id).get();
        if (doc.exists) {
            return { id: doc.id, ...doc.data() };
        }
        return null;
    } catch (err) {
        console.error('Error loading driver:', err);
        return null;
    }
}

function handleLogout() {
    if (confirm('Deseja sair?')) {
        if (isOnline) {
            updateDriverOnlineStatus(false);
        }
        localStorage.removeItem('pedrad_driver_id');
        driverData = null;
        currentUser = null;
        showAuthPage();
    }
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

    const vehicleIcons = { moto: '🏍️', bicicleta: '🚲', carro: '🚗' };
    const vehicleIcon = vehicleIcons[driverData.vehicle] || '🛵';

    // Header card
    document.getElementById('driverAvatar').textContent = vehicleIcon;
    document.getElementById('driverName').textContent = driverData.name || 'Entregador';
    document.getElementById('driverVehicle').textContent = `${vehicleIcon} ${driverData.vehicle || 'Moto'} ${driverData.plate ? '• ' + driverData.plate : ''}`;
    document.getElementById('driverRating').textContent = (driverData.rating || 5.0).toFixed(1);

    // Profile
    document.getElementById('profileAvatar').textContent = vehicleIcon;
    document.getElementById('profileName').textContent = driverData.name || 'Entregador';
    document.getElementById('profileEmail').textContent = driverData.email || '';
    document.getElementById('profilePhone').textContent = driverData.phone || '-';
    document.getElementById('profileVehicle').textContent = driverData.vehicle || '-';
    document.getElementById('profilePlate').textContent = driverData.plate || '-';
    document.getElementById('profileRating').textContent = (driverData.rating || 5.0).toFixed(1);

    // Earnings
    document.getElementById('pixKey').textContent = driverData.pix || 'Não cadastrado';
}

// ==================== DATA LOADING ====================

async function loadAllData() {
    await Promise.all([
        loadDeliveryFees(),
        loadPlatformConfig(),
        loadAvailableOrders(),
        loadCurrentDelivery(),
        loadTodayHistory()
    ]);
    updateStats();
}

async function loadDeliveryFees() {
    try {
        const snapshot = await db.collection('deliveryFees').where('active', '==', true).get();
        deliveryFees = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (err) {
        console.error('Error loading fees:', err);
    }
}

async function loadPlatformConfig() {
    try {
        const doc = await db.collection('config').doc('platform').get();
        if (doc.exists) {
            platformConfig = { ...platformConfig, ...doc.data() };
        }
    } catch (err) {
        console.error('Error loading config:', err);
    }
}

async function loadAvailableOrders() {
    try {
        const snapshot = await db.collection('orders')
            .where('status', 'in', ['preparing', 'ready'])
            .get();

        availableOrders = snapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(o => !o.driverId);

        renderAvailableOrders();
    } catch (err) {
        console.error('Error loading orders:', err);
    }
}

async function loadCurrentDelivery() {
    if (!driverData) return;

    try {
        const snapshot = await db.collection('orders')
            .where('driverId', '==', driverData.id)
            .where('status', 'in', ['ready', 'delivering'])
            .limit(1)
            .get();

        if (!snapshot.empty) {
            currentDelivery = { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
            renderCurrentDelivery();
        } else {
            currentDelivery = null;
            document.getElementById('currentDeliverySection').style.display = 'none';
        }
    } catch (err) {
        console.error('Error loading current delivery:', err);
    }
}

async function loadTodayHistory() {
    if (!driverData) return;

    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const snapshot = await db.collection('orders')
            .where('driverId', '==', driverData.id)
            .where('status', '==', 'delivered')
            .get();

        completedToday = snapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(o => {
                const date = o.deliveredAt?.toDate?.() || new Date(o.deliveredAt);
                return date >= today;
            })
            .sort((a, b) => {
                const dateA = a.deliveredAt?.toDate?.() || new Date(a.deliveredAt);
                const dateB = b.deliveredAt?.toDate?.() || new Date(b.deliveredAt);
                return dateB - dateA;
            });

        renderHistory();
    } catch (err) {
        console.error('Error loading history:', err);
    }
}

// ==================== REAL-TIME ====================

function setupRealtimeListeners() {
    // Available orders
    db.collection('orders')
        .where('status', 'in', ['preparing', 'ready'])
        .onSnapshot(snapshot => {
            const prevCount = availableOrders.length;
            availableOrders = snapshot.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(o => !o.driverId);

            renderAvailableOrders();

            if (availableOrders.length > prevCount && isOnline && !currentDelivery) {
                playNotificationSound();
                showToast('📦 Nova entrega disponível!');
            }
        });

    // My current delivery
    if (driverData) {
        db.collection('orders')
            .where('driverId', '==', driverData.id)
            .onSnapshot(snapshot => {
                const myOrders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                const active = myOrders.find(o => ['ready', 'delivering'].includes(o.status));

                if (active) {
                    currentDelivery = active;
                    renderCurrentDelivery();
                } else {
                    currentDelivery = null;
                    document.getElementById('currentDeliverySection').style.display = 'none';
                    renderAvailableOrders();
                }

                loadTodayHistory();
                updateStats();
            });

        // Driver data changes
        db.collection('drivers').doc(driverData.id).onSnapshot(doc => {
            if (doc.exists) {
                driverData = { id: doc.id, ...doc.data() };
                updateDriverUI();

                if (driverData.status === 'blocked') {
                    showToast('Sua conta foi bloqueada');
                    auth.signOut();
                }
            }
        });
    }

    // Delivery fees
    db.collection('deliveryFees').where('active', '==', true).onSnapshot(snapshot => {
        deliveryFees = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    });
}

function playNotificationSound() {
    try {
        if ('vibrate' in navigator) {
            navigator.vibrate([200, 100, 200]);
        }
    } catch (e) {}
}

// ==================== RENDER ====================

function renderAvailableOrders() {
    const container = document.getElementById('availableDeliveries');
    document.getElementById('availableCount').textContent = availableOrders.length;

    if (!isOnline) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">😴</div>
                <div class="empty-state-title">Você está offline</div>
                <div class="empty-state-text">Ative o botão acima para receber entregas</div>
            </div>
        `;
        return;
    }

    if (currentDelivery) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">🚀</div>
                <div class="empty-state-title">Você tem uma entrega ativa</div>
                <div class="empty-state-text">Finalize antes de aceitar outra</div>
            </div>
        `;
        return;
    }

    if (availableOrders.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📭</div>
                <div class="empty-state-title">Nenhuma entrega disponível</div>
                <div class="empty-state-text">Aguarde novos pedidos...</div>
            </div>
        `;
        return;
    }

    container.innerHTML = availableOrders.map(order => {
        const waitTime = getWaitTime(order.createdAt);
        const isUrgent = waitTime > 15;
        const fee = getDeliveryFee(order.address?.neighborhood);
        const driverEarning = calculateDriverEarning(fee);

        return `
            <div class="delivery-card ${isUrgent ? 'urgent' : ''}">
                <div class="delivery-header">
                    <div class="delivery-store">
                        <div class="delivery-store-icon">🏪</div>
                        <div>
                            <div class="delivery-store-name">${order.storeName || 'Loja'}</div>
                            <div class="delivery-store-time">Aguardando há ${waitTime} min</div>
                        </div>
                    </div>
                    <div class="delivery-value">
                        <div class="delivery-fee">+ ${formatCurrency(driverEarning)}</div>
                        <div class="delivery-distance">${order.address?.neighborhood || ''}</div>
                    </div>
                </div>
                <div class="delivery-body">
                    <div class="delivery-address">
                        <div class="address-icon">🏪</div>
                        <div class="address-info">
                            <div class="address-label">RETIRAR EM</div>
                            <div class="address-text">${order.storeName || 'Loja'}</div>
                        </div>
                    </div>
                    <div class="delivery-address">
                        <div class="address-icon">📍</div>
                        <div class="address-info">
                            <div class="address-label">ENTREGAR EM</div>
                            <div class="address-text">${order.address?.street || ''}, ${order.address?.number || ''} - ${order.address?.neighborhood || ''}</div>
                        </div>
                    </div>
                    <div class="delivery-actions">
                        <button class="btn btn-primary" onclick="acceptOrder('${order.id}')">
                            ✓ Aceitar Entrega
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function renderCurrentDelivery() {
    if (!currentDelivery) return;

    document.getElementById('currentDeliverySection').style.display = 'block';

    const isPickup = currentDelivery.status === 'ready';
    const statusClass = isPickup ? 'status-pickup' : 'status-delivering';
    const statusText = isPickup ? '🏪 Retirar pedido' : '📍 Entregar';
    const fee = getDeliveryFee(currentDelivery.address?.neighborhood);
    const driverEarning = calculateDriverEarning(fee);

    // Buscar dados do cliente
    const clientName = currentDelivery.userName || 'Cliente';
    const clientPhone = currentDelivery.userPhone || '';

    document.getElementById('currentDelivery').innerHTML = `
        <div class="current-delivery-header">
            <div class="current-delivery-title">Pedido #${currentDelivery.id.slice(-6).toUpperCase()}</div>
            <span class="current-delivery-status ${statusClass}">${statusText}</span>
        </div>

        <div class="route-line">
            <div class="route-dots">
                <div class="route-dot"></div>
                <div class="route-line-connector"></div>
                <div class="route-dot end"></div>
            </div>
            <div class="route-addresses">
                <div class="route-address">
                    <div class="route-address-label">RETIRAR</div>
                    <div class="route-address-text">🏪 ${currentDelivery.storeName || 'Loja'}</div>
                </div>
                <div class="route-address">
                    <div class="route-address-label">ENTREGAR</div>
                    <div class="route-address-text">📍 ${currentDelivery.address?.street || ''}, ${currentDelivery.address?.number || ''}</div>
                </div>
            </div>
        </div>

        <div class="client-box">
            <div class="client-label">Cliente</div>
            <div class="client-name">${clientName}</div>
            ${clientPhone ? `<div class="client-phone"><a href="tel:${clientPhone}" style="color: var(--info); text-decoration: none;">📞 ${clientPhone}</a></div>` : ''}
            ${currentDelivery.address?.complement ? `<div style="font-size:0.85rem;color:var(--text-muted);margin-top:6px;">📝 ${currentDelivery.address.complement}</div>` : ''}
            ${currentDelivery.address?.reference ? `<div style="font-size:0.85rem;color:var(--text-muted);">📍 Ref: ${currentDelivery.address.reference}</div>` : ''}
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding:10px;background:var(--bg-input);border-radius:10px;">
            <span style="color:var(--text-muted);">Seu ganho:</span>
            <span style="font-weight:700;color:var(--primary);">${formatCurrency(driverEarning)}</span>
        </div>

        <div class="delivery-actions">
            ${isPickup
                ? `<button class="btn btn-warning btn-block" onclick="openModal('pickupModal')">🏪 Retirei o Pedido</button>`
                : `<button class="btn btn-success btn-block" onclick="openDeliverModal()">✅ Finalizar Entrega</button>`
            }
        </div>
    `;
}

function renderHistory() {
    const container = document.getElementById('historyList');

    if (completedToday.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📋</div>
                <div class="empty-state-title">Nenhuma entrega hoje</div>
                <div class="empty-state-text">Suas entregas aparecerão aqui</div>
            </div>
        `;
        return;
    }

    container.innerHTML = completedToday.map(order => {
        const time = order.deliveredAt?.toDate?.() || new Date(order.deliveredAt);
        const timeStr = time.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const fee = getDeliveryFee(order.address?.neighborhood);
        const driverEarning = calculateDriverEarning(order.driverEarning || fee);

        return `
            <div class="history-item">
                <div class="history-info">
                    <div class="history-store">🏪 ${order.storeName || 'Loja'}</div>
                    <div class="history-time">${timeStr} - ${order.address?.neighborhood || ''}</div>
                </div>
                <div class="history-value">+ ${formatCurrency(driverEarning)}</div>
            </div>
        `;
    }).join('');
}

function updateStats() {
    const todayCount = completedToday.length;
    let todayMoney = 0;

    completedToday.forEach(order => {
        const fee = order.driverEarning || getDeliveryFee(order.address?.neighborhood);
        todayMoney += calculateDriverEarning(fee);
    });

    const distance = todayCount * 3.5;

    document.getElementById('todayEarnings').textContent = formatCurrency(todayMoney);
    document.getElementById('todayDeliveries').textContent = todayCount;
    document.getElementById('todayDistance').textContent = `${distance.toFixed(0)} km`;

    // Week stats (estimativas)
    const weekMultiplier = 5;
    document.getElementById('weekEarningsTotal').textContent = formatCurrency(todayMoney * weekMultiplier);
    document.getElementById('weekDeliveriesCount').textContent = todayCount * weekMultiplier;
    document.getElementById('weekDistanceTotal').textContent = `${(distance * weekMultiplier).toFixed(0)} km`;
    document.getElementById('weekHoursTotal').textContent = `${todayCount * 2}h`;

    // Profile total
    document.getElementById('totalDeliveries').textContent = (driverData?.totalDeliveries || 0) + todayCount;
}

// ==================== ACTIONS ====================

function toggleOnline() {
    isOnline = !isOnline;

    const toggle = document.getElementById('onlineToggle');
    const text = document.getElementById('statusText');

    toggle.classList.toggle('active', isOnline);
    text.textContent = isOnline ? 'Online' : 'Offline';

    updateDriverOnlineStatus(isOnline);
    renderAvailableOrders();
    showToast(isOnline ? '🟢 Você está online!' : '🔴 Você está offline');
}

async function updateDriverOnlineStatus(online) {
    if (!driverData) return;
    try {
        await db.collection('drivers').doc(driverData.id).update({
            online,
            lastOnlineAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    } catch (err) {
        console.error('Error updating status:', err);
    }
}

function acceptOrder(orderId) {
    pendingAcceptOrder = availableOrders.find(o => o.id === orderId);
    if (!pendingAcceptOrder) return;

    const fee = getDeliveryFee(pendingAcceptOrder.address?.neighborhood);
    const driverEarning = calculateDriverEarning(fee);

    document.getElementById('acceptModalText').textContent =
        `${pendingAcceptOrder.storeName} → ${pendingAcceptOrder.address?.neighborhood}`;

    document.getElementById('acceptModalInfo').innerHTML = `
        <div style="display:flex;justify-content:space-between;">
            <span>Taxa de entrega:</span>
            <span>${formatCurrency(fee)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:6px;font-weight:700;color:var(--primary);">
            <span>Seu ganho:</span>
            <span>${formatCurrency(driverEarning)}</span>
        </div>
    `;

    openModal('acceptModal');
}

async function confirmAccept() {
    if (!pendingAcceptOrder || !driverData) return;

    try {
        const fee = getDeliveryFee(pendingAcceptOrder.address?.neighborhood);
        const driverEarning = calculateDriverEarning(fee);

        const timeline = pendingAcceptOrder.timeline || [];
        timeline.push({
            status: 'accepted',
            timestamp: new Date().toISOString(),
            message: `Entregador ${driverData.name} aceitou`
        });

        await db.collection('orders').doc(pendingAcceptOrder.id).update({
            driverId: driverData.id,
            driverName: driverData.name,
            driverPhone: driverData.phone,
            driverVehicle: driverData.vehicle,
            driverEarning,
            timeline,
            acceptedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        closeModal('acceptModal');
        showToast('✅ Entrega aceita! Vá até a loja.');
        pendingAcceptOrder = null;

    } catch (err) {
        console.error('Error accepting:', err);
        showToast('Erro ao aceitar entrega');
    }
}

async function confirmPickup() {
    if (!currentDelivery) return;

    try {
        const timeline = currentDelivery.timeline || [];
        timeline.push({
            status: 'delivering',
            timestamp: new Date().toISOString(),
            message: 'Pedido retirado, saiu para entrega'
        });

        await db.collection('orders').doc(currentDelivery.id).update({
            status: 'delivering',
            timeline,
            pickedUpAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        closeModal('pickupModal');
        showToast('🛵 Pedido retirado! Siga para o cliente.');

    } catch (err) {
        console.error('Error confirming pickup:', err);
        showToast('Erro ao confirmar retirada');
    }
}

function openDeliverModal() {
    capturedLocation = null;
    document.getElementById('locationStatus').innerHTML = `
        <span class="location-icon">📍</span>
        <span class="location-text">Toque para capturar localização</span>
    `;
    document.getElementById('locationStatus').className = 'location-status';
    document.getElementById('captureLocationBtn').disabled = false;
    document.getElementById('captureLocationBtn').textContent = '📍 Capturar Localização';
    openModal('deliverModal');
}

async function captureLocation() {
    const statusEl = document.getElementById('locationStatus');
    const btnEl = document.getElementById('captureLocationBtn');

    statusEl.innerHTML = `
        <span class="location-icon">⏳</span>
        <span class="location-text">Obtendo localização...</span>
    `;
    statusEl.className = 'location-status loading';
    btnEl.disabled = true;
    btnEl.textContent = 'Aguarde...';

    if (!navigator.geolocation) {
        statusEl.innerHTML = `
            <span class="location-icon">❌</span>
            <span class="location-text">GPS não disponível</span>
        `;
        statusEl.className = 'location-status error';
        btnEl.disabled = false;
        btnEl.textContent = '📍 Tentar novamente';
        return;
    }

    navigator.geolocation.getCurrentPosition(
        (position) => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;

            const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;
            const wazeUrl = `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;

            capturedLocation = {
                lat,
                lng,
                accuracy: position.coords.accuracy,
                timestamp: new Date().toISOString(),
                mapsUrl,
                wazeUrl
            };

            statusEl.innerHTML = `
                <div style="margin-bottom:8px;font-weight:600;">📍 Localização capturada</div>

                <iframe
                    src="https://maps.google.com/maps?q=${lat},${lng}&z=16&output=embed"
                    style="width:100%;height:160px;border-radius:12px;border:0;margin-bottom:10px;">
                </iframe>

                <div style="display:flex;gap:8px;">
                    <a href="${mapsUrl}" target="_blank" class="btn btn-secondary btn-sm" style="flex:1;">🗺️ Google Maps</a>
                    <a href="${wazeUrl}" target="_blank" class="btn btn-secondary btn-sm" style="flex:1;">🚗 Waze</a>
                </div>
            `;
            statusEl.className = 'location-status success';
            btnEl.textContent = '✅ Localização OK';
        },
        (error) => {
            let msg = 'Erro ao obter localização';
            if (error.code === error.PERMISSION_DENIED) msg = 'Permissão negada';
            if (error.code === error.POSITION_UNAVAILABLE) msg = 'Localização indisponível';
            if (error.code === error.TIMEOUT) msg = 'Tempo esgotado';

            statusEl.innerHTML = `
                <span class="location-icon">❌</span>
                <span class="location-text">${msg}</span>
            `;
            statusEl.className = 'location-status error';
            btnEl.disabled = false;
            btnEl.textContent = '📍 Tentar novamente';
        },
        {
            enableHighAccuracy: true,
            timeout: 15000,
            maximumAge: 0
        }
    );
}


async function confirmDelivery() {
    if (!currentDelivery) return;

    // Verificar se tem localização (opcional, mas recomendado)
    if (!capturedLocation) {
        const proceed = confirm('Localização não capturada. Deseja confirmar mesmo assim?');
        if (!proceed) return;
    }

    try {
        const timeline = currentDelivery.timeline || [];
        timeline.push({
            status: 'delivered',
            timestamp: new Date().toISOString(),
            message: 'Pedido entregue ao cliente',
            location: capturedLocation
        });

        const updateData = {
            status: 'delivered',
            timeline,
            deliveredAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        if (capturedLocation) {
            updateData.deliveryLocation = capturedLocation;
        }

        await db.collection('orders').doc(currentDelivery.id).update(updateData);

        // Atualizar contador do entregador
        if (driverData) {
            await db.collection('drivers').doc(driverData.id).update({
                totalDeliveries: firebase.firestore.FieldValue.increment(1),
                lastDeliveryAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        }

        const earning = currentDelivery.driverEarning || platformConfig.driverFee;
        closeModal('deliverModal');
        showToast(`✅ Entrega concluída! +${formatCurrency(earning)}`);
        capturedLocation = null;

    } catch (err) {
        console.error('Error confirming delivery:', err);
        showToast('Erro ao confirmar entrega');
    }
}

function requestLocationPermission() {
    if (!navigator.geolocation) {
        showToast('GPS não disponível neste dispositivo');
        return;
    }

    navigator.geolocation.getCurrentPosition(
        () => {
            showToast('✅ Permissão concedida!');
            closeModal('locationPermissionModal');
        },
        (error) => {
            if (error.code === error.PERMISSION_DENIED) {
                showToast('❌ Permissão negada. Ative nas configurações do navegador.');
            } else {
                showToast('❌ Erro ao obter permissão');
            }
        }
    );
}

// ==================== NAVIGATION ====================

function showPage(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    document.getElementById(`${page}Page`).classList.add('active');

    const navIndex = { home: 0, history: 1, earnings: 2, profile: 3 };
    document.querySelectorAll('.nav-item')[navIndex[page]]?.classList.add('active');
}

// ==================== UTILITIES ====================

function openModal(id) {
    document.getElementById(id).classList.add('active');
}

function closeModal(id) {
    document.getElementById(id).classList.remove('active');
}

function getWaitTime(createdAt) {
    if (!createdAt) return 0;
    const date = createdAt.toDate ? createdAt.toDate() : new Date(createdAt);
    return Math.floor((Date.now() - date.getTime()) / 60000);
}

function getDeliveryFee(neighborhood) {
    if (!neighborhood) return platformConfig.driverFee || 5;

    const fee = deliveryFees.find(f =>
        f.name?.toLowerCase() === neighborhood.toLowerCase()
    );

    return fee?.fee || platformConfig.driverFee || 5;
}

function calculateDriverEarning(deliveryFee) {
    // Entregador recebe a taxa base + bônus por km (simplificado)
    return platformConfig.driverFee || deliveryFee || 5;
}

function formatCurrency(value) {
    return new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL'
    }).format(value || 0);
}

function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}
