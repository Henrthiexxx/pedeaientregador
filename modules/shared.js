// ==================== SHARED UTILITIES ====================

let driverData = null;
let platformConfig = { driverFee: 5, driverKmBonus: 1 };
let deliveryFees = [];
let storesCache = {};

// ==================== AUTH CHECK ====================

async function checkAuth() {
    const driverId = Cache.getDriverId();
    if (!driverId) {
        window.location.href = 'index.html';
        return false;
    }

    // Try cache first
    const cached = Cache.getDriver();
    if (cached) {
        driverData = cached;
        return true;
    }

    // Fetch from Firestore
    try {
        const doc = await db.collection('drivers').doc(driverId).get();
        if (doc.exists && doc.data().status !== 'blocked') {
            driverData = { id: doc.id, ...doc.data() };
            Cache.setDriver(driverData);
            return true;
        }
    } catch (e) {
        console.error('Auth check error:', e);
    }

    Cache.clearAll();
    window.location.href = 'index.html';
    return false;
}

// ==================== DATA LOADING (with cache) ====================

async function loadDeliveryFees() {
    const cached = Cache.getFees();
    if (cached) {
        deliveryFees = cached;
        return;
    }
    try {
        const snapshot = await db.collection('deliveryFees').where('active', '==', true).get();
        deliveryFees = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        Cache.setFees(deliveryFees);
    } catch (e) {
        console.error('Error loading fees:', e);
    }
}

async function loadPlatformConfig() {
    const cached = Cache.getConfig();
    if (cached) {
        platformConfig = cached;
        return;
    }
    try {
        const doc = await db.collection('config').doc('platform').get();
        if (doc.exists) {
            platformConfig = { ...platformConfig, ...doc.data() };
            Cache.setConfig(platformConfig);
        }
    } catch (e) {
        console.error('Error loading config:', e);
    }
}

async function getStoreData(storeId) {
    if (!storeId) return null;

    // Memory cache
    if (storesCache[storeId]) return storesCache[storeId];

    // localStorage cache
    const cached = Cache.getStore(storeId);
    if (cached) {
        storesCache[storeId] = cached;
        return cached;
    }

    try {
        const doc = await db.collection('stores').doc(storeId).get();
        if (doc.exists) {
            const data = doc.data();
            storesCache[storeId] = data;
            Cache.setStore(storeId, data);
            return data;
        }
    } catch (e) {
        console.error('Error loading store:', e);
    }
    return null;
}

async function loadSharedData() {
    await Promise.all([loadDeliveryFees(), loadPlatformConfig()]);
}

// ==================== DRIVER LISTENER ====================

function setupDriverListener(onChange) {
    if (!driverData) return;
    return db.collection('drivers').doc(driverData.id).onSnapshot(doc => {
        if (doc.exists) {
            const old = driverData;
            driverData = { id: doc.id, ...doc.data() };
            Cache.setDriver(driverData);

            if (driverData.status === 'blocked') {
                showToast('Sua conta foi bloqueada');
                Cache.clearAll();
                window.location.href = 'index.html';
                return;
            }

            if (onChange) onChange(driverData, old);
        }
    });
}

// ==================== FEES LISTENER ====================

function setupFeesListener() {
    return db.collection('deliveryFees').where('active', '==', true).onSnapshot(snapshot => {
        deliveryFees = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        Cache.setFees(deliveryFees);
    });
}

// ==================== CALCULATIONS ====================

function getDeliveryFee(neighborhood) {
    if (!neighborhood) return platformConfig.driverFee || 5;
    const fee = deliveryFees.find(f => f.name?.toLowerCase() === neighborhood.toLowerCase());
    return fee?.fee || platformConfig.driverFee || 5;
}

function calculateDriverEarning(baseFee, distance) {
    const kmBonus = (distance || 0) * (platformConfig.driverKmBonus || 1);
    return (baseFee || platformConfig.driverFee || 5) + kmBonus;
}

function formatCurrency(value) {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

function getWaitTime(createdAt) {
    if (!createdAt) return 0;
    const date = createdAt.toDate ? createdAt.toDate() : new Date(createdAt);
    return Math.floor((Date.now() - date.getTime()) / 60000);
}

// ==================== TOAST ====================

function showToast(message) {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        toast.className = 'toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}

// ==================== MODAL ====================

function openModal(id) { document.getElementById(id)?.classList.add('active'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('active'); }

function showConfirmModal(title, text, onConfirm, confirmText = 'Confirmar') {
    document.getElementById('confirmModalTitle').textContent = title;
    document.getElementById('confirmModalText').textContent = text;
    document.getElementById('confirmModalBtn').textContent = confirmText;
    document.getElementById('confirmModalBtn').onclick = () => {
        closeModal('confirmModal');
        if (onConfirm) onConfirm();
    };
    openModal('confirmModal');
}

// ==================== NAVIGATION ====================

function navigateTo(page) {
    window.location.href = page;
}

function renderBottomNav(activePage) {
    const nav = document.querySelector('.nav');
    if (!nav) return;

    const pages = [
        { page: 'home.html', icon: '⌂', label: 'Início' },
        { page: 'history.html', icon: '≡', label: 'Histórico' },
        { page: 'earnings.html', icon: '$', label: 'Ganhos' },
        { page: 'profile.html', icon: '○', label: 'Perfil' }
    ];

    nav.innerHTML = pages.map(p => `
        <div class="nav-item ${p.page === activePage ? 'active' : ''}" onclick="navigateTo('${p.page}')">
            <span class="nav-icon">${p.icon}</span>
            <span class="nav-label">${p.label}</span>
        </div>
    `).join('');
}

// ==================== NOTIFICATION SOUND ====================

function playNotificationSound() {
    try {
        if ('vibrate' in navigator) navigator.vibrate([200, 100, 200]);
    } catch (e) {}
}
