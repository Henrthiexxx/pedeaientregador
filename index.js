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

// ==================== AUTH ====================

document.addEventListener('DOMContentLoaded', async () => {
    const savedDriverId = localStorage.getItem('pedrad_driver_id');
    if (savedDriverId) {
        const driver = await loadDriverById(savedDriverId);
        if (driver && driver.status !== 'blocked') {
            driverData = driver;
            currentUser = { email: driver.email };
            
            // Restaurar estado online
            const wasOnline = localStorage.getItem('pedrad_driver_online') === 'true';
            if (wasOnline && driver.online) {
                isOnline = true;
                startOnlineHeartbeat();
            }
            
            showMainApp();
            await loadAllData();
            setupRealtimeListeners();
            
            // Atualizar UI do toggle
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
        if (onlineInterval) {
            clearInterval(onlineInterval);
        }
        localStorage.removeItem('pedrad_driver_id');
        localStorage.removeItem('pedrad_driver_online');
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

    // Avatar com foto ou emoji
    const avatarElements = [
        document.getElementById('driverAvatar'),
        document.getElementById('profileAvatar')
    ];
    
    avatarElements.forEach(el => {
        if (driverData.photoUrl) {
            el.style.backgroundImage = `url(${driverData.photoUrl})`;
            el.style.backgroundSize = 'cover';
            el.style.backgroundPosition = 'center';
            el.textContent = '';
        } else {
            el.style.backgroundImage = 'none';
            el.textContent = vehicleIcon;
        }
    });

    // Rating do servidor
    const rating = driverData.rating || 5.0;
    document.getElementById('driverRating').textContent = rating.toFixed(1);
    document.getElementById('profileRating').textContent = rating.toFixed(1);

    document.getElementById('driverName').textContent = driverData.name || 'Entregador';
    document.getElementById('driverVehicle').textContent = `${vehicleIcon} ${driverData.vehicle || 'Moto'} ${driverData.plate ? '• ' + driverData.plate : ''}`;

    document.getElementById('profileName').textContent = driverData.name || 'Entregador';
    document.getElementById('profileEmail').textContent = driverData.email || '';
    document.getElementById('profilePhone').textContent = driverData.phone || '-';
    document.getElementById('profileVehicle').textContent = driverData.vehicle || '-';
    document.getElementById('profilePlate').textContent = driverData.plate || '-';
    document.getElementById('profileMaxOrders').textContent = driverData.maxSimultaneousOrders || 1;

    document.getElementById('pixKey').textContent = driverData.pix || 'Não cadastrado';
}

// ==================== PHOTO UPLOAD ====================

function changeProfilePhoto() {
    document.getElementById('photoInput').click();
}

async function handlePhotoUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
        showToast('❌ Selecione uma imagem');
        return;
    }

    if (file.size > 5 * 1024 * 1024) {
        showToast('❌ Imagem muito grande (max 5MB)');
        return;
    }

    try {
        showToast('📤 Enviando foto...');
        
        const reader = new FileReader();
        reader.onload = async (e) => {
            const base64 = e.target.result;
            
            await db.collection('drivers').doc(driverData.id).update({
                photoUrl: base64,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            driverData.photoUrl = base64;
            updateDriverUI();
            showToast('✅ Foto atualizada!');
        };
        
        reader.readAsDataURL(file);
    } catch (err) {
        console.error('Error uploading photo:', err);
        showToast('❌ Erro ao enviar foto');
    }
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

async function loadAcceptedOrders() {
    if (!driverData) return;

    try {
        const snapshot = await db.collection('orders')
            .where('driverId', '==', driverData.id)
            .where('status', '==', 'ready')
            .get();

        acceptedOrders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderAcceptedOrders();
    } catch (err) {
        console.error('Error loading accepted orders:', err);
    }
}

async function loadCurrentDelivery() {
    if (!driverData) return;

    try {
        const snapshot = await db.collection('orders')
            .where('driverId', '==', driverData.id)
            .where('status', '==', 'delivering')
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

async function loadAllHistory() {
    if (!driverData) return;

    try {
        const snapshot = await db.collection('orders')
            .where('driverId', '==', driverData.id)
            .where('status', '==', 'delivered')
            .get();

        allHistory = snapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
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

async function getStoreData(storeId) {
    if (!storeId) return null;
    
    if (storesCache[storeId]) {
        return storesCache[storeId];
    }
    
    try {
        const doc = await db.collection('stores').doc(storeId).get();
        if (doc.exists) {
            const data = doc.data();
            storesCache[storeId] = data;
            return data;
        }
    } catch (err) {
        console.error('Error loading store:', err);
    }
    
    return null;
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

    // My orders
    if (driverData) {
        db.collection('orders')
            .where('driverId', '==', driverData.id)
            .onSnapshot(snapshot => {
                const myOrders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                
                // Aceitas mas não iniciadas
                acceptedOrders = myOrders.filter(o => o.status === 'ready');
                renderAcceptedOrders();
                
                // Em andamento
                const delivering = myOrders.find(o => o.status === 'delivering');
                if (delivering) {
                    currentDelivery = delivering;
                    renderCurrentDelivery();
                } else {
                    currentDelivery = null;
                    document.getElementById('currentDeliverySection').style.display = 'none';
                }

                loadAllHistory();
                updateStats();
            });

        // Driver data
        db.collection('drivers').doc(driverData.id).onSnapshot(doc => {
            if (doc.exists) {
                const oldRating = driverData.rating;
                driverData = { id: doc.id, ...doc.data() };
                updateDriverUI();

                if (driverData.status === 'blocked') {
                    showToast('Sua conta foi bloqueada');
                    handleLogout();
                }

                // Notificar mudança de rating
                if (oldRating && driverData.rating && driverData.rating !== oldRating) {
                    const diff = (driverData.rating - oldRating).toFixed(1);
                    const emoji = diff > 0 ? '⭐' : '📉';
                    showToast(`${emoji} Avaliação: ${driverData.rating.toFixed(1)}`);
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

    const maxOrders = driverData?.maxSimultaneousOrders || 1;
    const myActiveCount = (acceptedOrders.length || 0) + (currentDelivery ? 1 : 0);

    if (myActiveCount >= maxOrders) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">🚀</div>
                <div class="empty-state-title">Limite de entregas atingido</div>
                <div class="empty-state-text">Finalize suas entregas antes de aceitar novas</div>
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

    // Render placeholder primeiro
    container.innerHTML = availableOrders.map(order => {
        const waitTime = getWaitTime(order.createdAt);
        const isUrgent = waitTime > 15;
        const fee = getDeliveryFee(order.address?.neighborhood);
        const driverEarning = calculateDriverEarning(fee, order.distance);

        return `
            <div class="delivery-card ${isUrgent ? 'urgent' : ''}" id="order-${order.id}">
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
                        <div class="delivery-distance">${order.distance ? order.distance.toFixed(1) + ' km' : order.address?.neighborhood || ''}</div>
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

    // Carregar fotos das lojas
    availableOrders.forEach(async order => {
        if (order.storeId) {
            const storeData = await getStoreData(order.storeId);
            if (storeData && storeData.logoUrl) {
                const iconEl = document.querySelector(`#order-${order.id} .delivery-store-icon`);
                if (iconEl) {
                    iconEl.style.backgroundImage = `url(${storeData.logoUrl})`;
                    iconEl.style.backgroundSize = 'cover';
                    iconEl.style.backgroundPosition = 'center';
                    iconEl.textContent = '';
                }
            }
        }
    });
}

function renderAcceptedOrders() {
    const section = document.getElementById('acceptedSection');
    const container = document.getElementById('acceptedOrders');
    
    if (acceptedOrders.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';
    document.getElementById('acceptedCount').textContent = acceptedOrders.length;

    container.innerHTML = acceptedOrders.map(order => {
        const fee = getDeliveryFee(order.address?.neighborhood);
        const driverEarning = calculateDriverEarning(order.driverEarning || fee, order.distance);

        return `
            <div class="delivery-card" id="accepted-${order.id}" style="border-color: var(--warning);">
                <div class="delivery-header">
                    <div class="delivery-store">
                        <div class="delivery-store-icon">🏪</div>
                        <div>
                            <div class="delivery-store-name">${order.storeName || 'Loja'}</div>
                            <div class="delivery-store-time">Pedido aceito</div>
                        </div>
                    </div>
                    <div class="delivery-value">
                        <div class="delivery-fee">+ ${formatCurrency(driverEarning)}</div>
                        <div class="delivery-distance">${order.distance ? order.distance.toFixed(1) + ' km' : order.address?.neighborhood || ''}</div>
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
                            <div class="address-text">${order.address?.street || ''}, ${order.address?.number || ''}</div>
                        </div>
                    </div>
                    <div class="delivery-actions">
                        <button class="btn btn-warning btn-block" onclick="startDelivery('${order.id}')">
                            🏪 Iniciar Retirada
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    // Carregar fotos
    acceptedOrders.forEach(async order => {
        if (order.storeId) {
            const storeData = await getStoreData(order.storeId);
            if (storeData && storeData.logoUrl) {
                const iconEl = document.querySelector(`#accepted-${order.id} .delivery-store-icon`);
                if (iconEl) {
                    iconEl.style.backgroundImage = `url(${storeData.logoUrl})`;
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

    const fee = getDeliveryFee(currentDelivery.address?.neighborhood);
    const driverEarning = calculateDriverEarning(currentDelivery.driverEarning || fee, currentDelivery.distance);

    const clientName = currentDelivery.userName || 'Cliente';
    const clientPhone = currentDelivery.userPhone || '';

    document.getElementById('currentDelivery').innerHTML = `
        <div class="current-delivery-header">
            <div class="current-delivery-title">Pedido #${currentDelivery.id.slice(-6).toUpperCase()}</div>
            <span class="current-delivery-status status-delivering">📍 Entregar</span>
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
            <button class="btn btn-success btn-block" onclick="openDeliverModal()">✅ Finalizar Entrega</button>
        </div>
    `;
}

function renderHistory() {
    const container = document.getElementById('historyList');
    
    const filtered = getFilteredHistory();

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📋</div>
                <div class="empty-state-title">Nenhuma entrega neste período</div>
                <div class="empty-state-text">Suas entregas aparecerão aqui</div>
            </div>
        `;
        document.getElementById('historyEarnings').textContent = formatCurrency(0);
        return;
    }

    let totalEarnings = 0;
    
    container.innerHTML = filtered.map(order => {
        const time = order.deliveredAt?.toDate?.() || new Date(order.deliveredAt);
        const timeStr = time.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const dateStr = time.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        const fee = getDeliveryFee(order.address?.neighborhood);
        const driverEarning = calculateDriverEarning(order.driverEarning || fee, order.distance);
        totalEarnings += driverEarning;

        return `
            <div class="history-item">
                <div class="history-info">
                    <div class="history-store">🏪 ${order.storeName || 'Loja'}</div>
                    <div class="history-time">${dateStr} ${timeStr} - ${order.distance ? order.distance.toFixed(1) + ' km' : order.address?.neighborhood || ''}</div>
                </div>
                <div class="history-value">+ ${formatCurrency(driverEarning)}</div>
            </div>
        `;
    }).join('');

    document.getElementById('historyEarnings').textContent = formatCurrency(totalEarnings);
}

function getFilteredHistory() {
    const now = new Date();
    
    if (historyFilter === 'today') {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return allHistory.filter(o => {
            const date = o.deliveredAt?.toDate?.() || new Date(o.deliveredAt);
            return date >= today;
        });
    }
    
    if (historyFilter === 'week') {
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        return allHistory.filter(o => {
            const date = o.deliveredAt?.toDate?.() || new Date(o.deliveredAt);
            return date >= weekAgo;
        });
    }
    
    if (historyFilter === 'month') {
        const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        return allHistory.filter(o => {
            const date = o.deliveredAt?.toDate?.() || new Date(o.deliveredAt);
            return date >= monthAgo;
        });
    }
    
    return allHistory;
}

function setHistoryFilter(filter) {
    historyFilter = filter;
    
    document.querySelectorAll('[id^="filter"]').forEach(btn => {
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-secondary');
    });
    
    document.getElementById(`filter${filter.charAt(0).toUpperCase() + filter.slice(1)}`).classList.add('btn-primary');
    document.getElementById(`filter${filter.charAt(0).toUpperCase() + filter.slice(1)}`).classList.remove('btn-secondary');
    
    renderHistory();
}

function updateStats() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayOrders = allHistory.filter(o => {
        const date = o.deliveredAt?.toDate?.() || new Date(o.deliveredAt);
        return date >= today;
    });

    let todayMoney = 0;
    let todayDistance = 0;

    todayOrders.forEach(order => {
        const fee = order.driverEarning || getDeliveryFee(order.address?.neighborhood);
        todayMoney += calculateDriverEarning(fee, order.distance);
        todayDistance += order.distance || 3.5; // fallback
    });

    document.getElementById('todayEarnings').textContent = formatCurrency(todayMoney);
    document.getElementById('todayDeliveries').textContent = todayOrders.length;
    document.getElementById('todayDistance').textContent = `${todayDistance.toFixed(1)} km`;

    // Week
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const weekOrders = allHistory.filter(o => {
        const date = o.deliveredAt?.toDate?.() || new Date(o.deliveredAt);
        return date >= weekAgo;
    });

    let weekMoney = 0;
    let weekDistance = 0;

    weekOrders.forEach(order => {
        const fee = order.driverEarning || getDeliveryFee(order.address?.neighborhood);
        weekMoney += calculateDriverEarning(fee, order.distance);
        weekDistance += order.distance || 3.5;
    });

    document.getElementById('weekEarningsTotal').textContent = formatCurrency(weekMoney);
    document.getElementById('weekDeliveriesCount').textContent = weekOrders.length;
    document.getElementById('weekDistanceTotal').textContent = `${weekDistance.toFixed(1)} km`;
    document.getElementById('weekHoursTotal').textContent = `${(weekOrders.length * 0.5).toFixed(0)}h`;

    // Profile
    document.getElementById('totalDeliveries').textContent = allHistory.length;
}

// ==================== ACTIONS ====================

function toggleOnline() {
    isOnline = !isOnline;

    const toggle = document.getElementById('onlineToggle');
    const text = document.getElementById('statusText');

    toggle.classList.toggle('active', isOnline);
    text.textContent = isOnline ? 'Online' : 'Offline';

    // Salvar estado
    localStorage.setItem('pedrad_driver_online', isOnline);

    updateDriverOnlineStatus(isOnline);
    
    if (isOnline) {
        startOnlineHeartbeat();
    } else {
        stopOnlineHeartbeat();
    }
    
    renderAvailableOrders();
    showToast(isOnline ? '🟢 Você está online!' : '🔴 Você está offline');
}

function startOnlineHeartbeat() {
    if (onlineInterval) clearInterval(onlineInterval);
    
    onlineInterval = setInterval(() => {
        if (isOnline && driverData) {
            updateDriverOnlineStatus(true);
        }
    }, 60000); // 1 minuto
}

function stopOnlineHeartbeat() {
    if (onlineInterval) {
        clearInterval(onlineInterval);
        onlineInterval = null;
    }
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
    const driverEarning = calculateDriverEarning(fee, pendingAcceptOrder.distance);

    document.getElementById('acceptModalText').textContent =
        `${pendingAcceptOrder.storeName} → ${pendingAcceptOrder.address?.neighborhood}`;

    document.getElementById('acceptModalInfo').innerHTML = `
        <div style="display:flex;justify-content:space-between;">
            <span>Taxa de entrega:</span>
            <span>${formatCurrency(fee)}</span>
        </div>
        ${pendingAcceptOrder.distance ? `<div style="display:flex;justify-content:space-between;margin-top:6px;">
            <span>Distância:</span>
            <span>${pendingAcceptOrder.distance.toFixed(1)} km</span>
        </div>` : ''}
        <div style="display:flex;justify-content:space-between;margin-top:6px;font-weight:700;color:var(--primary);">
            <span>Seu ganho:</span>
            <span>${formatCurrency(driverEarning)}</span>
        </div>
    `;

    openModal('acceptModal');
}

async function confirmAccept() {
    if (!pendingAcceptOrder || !driverData) return;

    // Verificar limite
    const maxOrders = driverData.maxSimultaneousOrders || 1;
    const myActiveCount = acceptedOrders.length + (currentDelivery ? 1 : 0);
    
    if (myActiveCount >= maxOrders) {
        closeModal('acceptModal');
        showToast('❌ Você atingiu o limite de entregas simultâneas');
        return;
    }

    try {
        const fee = getDeliveryFee(pendingAcceptOrder.address?.neighborhood);
        const driverEarning = calculateDriverEarning(fee, pendingAcceptOrder.distance);

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
        showToast('✅ Entrega aceita!');
        pendingAcceptOrder = null;

    } catch (err) {
        console.error('Error accepting:', err);
        showToast('Erro ao aceitar entrega');
    }
}

async function startDelivery(orderId) {
    const order = acceptedOrders.find(o => o.id === orderId);
    if (!order) return;

    if (confirm('Confirma que está retirando o pedido na loja?')) {
        try {
            const timeline = order.timeline || [];
            timeline.push({
                status: 'delivering',
                timestamp: new Date().toISOString(),
                message: 'Pedido retirado, saiu para entrega'
            });

            await db.collection('orders').doc(orderId).update({
                status: 'delivering',
                timeline,
                pickedUpAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            showToast('🛵 Pedido retirado! Siga para o cliente.');

        } catch (err) {
            console.error('Error starting delivery:', err);
            showToast('Erro ao iniciar entrega');
        }
    }
}

function openDeliverModal() {
    capturedLocation = null;
    openModal('deliverModal');
    
    // Iniciar captura automática
    setTimeout(() => {
        captureLocationAuto();
    }, 500);
}

async function captureLocationAuto() {
    const statusEl = document.getElementById('locationStatus');
    const btnEl = document.getElementById('confirmDeliveryBtn');

    statusEl.innerHTML = `
        <span class="location-icon">⏳</span>
        <span class="location-text">Capturando localização...</span>
    `;
    statusEl.className = 'location-status loading';
    btnEl.disabled = true;
    btnEl.textContent = '⏳ Aguarde GPS...';

    if (!navigator.geolocation) {
        statusEl.innerHTML = `
            <span class="location-icon">❌</span>
            <span class="location-text">GPS não disponível</span>
        `;
        statusEl.className = 'location-status error';
        btnEl.disabled = false;
        btnEl.textContent = '✅ Confirmar mesmo assim';
        return;
    }

    navigator.geolocation.getCurrentPosition(
        (position) => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;

            capturedLocation = {
                lat,
                lng,
                accuracy: position.coords.accuracy,
                timestamp: new Date().toISOString()
            };

            statusEl.innerHTML = `
                <span class="location-icon">✅</span>
                <span class="location-text">Localização capturada!<br><small>Precisão: ${position.coords.accuracy.toFixed(0)}m</small></span>
            `;
            statusEl.className = 'location-status success';
            btnEl.disabled = false;
            btnEl.textContent = '✅ Confirmar Entrega';
        },
        (error) => {
            let msg = 'Erro ao capturar';
            if (error.code === error.PERMISSION_DENIED) msg = 'Permissão negada';
            if (error.code === error.POSITION_UNAVAILABLE) msg = 'GPS indisponível';
            if (error.code === error.TIMEOUT) msg = 'Tempo esgotado';

            statusEl.innerHTML = `
                <span class="location-icon">⚠️</span>
                <span class="location-text">${msg}</span>
            `;
            statusEl.className = 'location-status error';
            btnEl.disabled = false;
            btnEl.textContent = '✅ Confirmar mesmo assim';
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
            deliveredAt: new Date().toISOString() // String ISO em vez de Timestamp
        };

        if (capturedLocation) {
            updateData.deliveryLocation = capturedLocation;
        }

        await db.collection('orders').doc(currentDelivery.id).update(updateData);

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
        showToast('Erro: ' + (err.message || 'Tente novamente'));
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
        },
        (error) => {
            if (error.code === error.PERMISSION_DENIED) {
                showToast('❌ Permissão negada. Ative nas configurações.');
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

function calculateDriverEarning(baseFee, distance) {
    // Fórmula: taxa base + bônus por km
    const kmBonus = (distance || 0) * (platformConfig.driverKmBonus || 1);
    return (baseFee || platformConfig.driverFee || 5) + kmBonus;
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
