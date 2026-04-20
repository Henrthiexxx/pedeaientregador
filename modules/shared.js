// ==================== SHARED UTILITIES ====================

let platformConfig = { driverFee: 5, driverKmBonus: 0 };
let deliveryFees = [];
let storesCache = {};

// ==================== DRIVER ROUTING HELPERS ====================

function uniqueStrings(list) {
    return [...new Set((Array.isArray(list) ? list : []).filter(Boolean).map(v => String(v)))];
}

function sameStringArray(a, b) {
    const aa = uniqueStrings(a);
    const bb = uniqueStrings(b);
    return aa.length === bb.length && aa.every((v, i) => v === bb[i]);
}

function getDriverLinkedStoreIds(driver) {
    return uniqueStrings([
        driver?.linkedStoreId,
        driver?.storeId,
        ...(Array.isArray(driver?.linkedStores) ? driver.linkedStores : [])
    ]);
}

function getDriverPrimaryStoreId(driver) {
    return getDriverLinkedStoreIds(driver)[0] || null;
}

function isStoreBoundDriver(driver) {
    return getDriverLinkedStoreIds(driver).length > 0;
}

function getDriverDeliveryPool(driver) {
    return isStoreBoundDriver(driver) ? 'store' : 'app';
}

function normalizeDriverData(driver) {
    const routingStoreIds = getDriverLinkedStoreIds(driver);
    const primaryStoreId = routingStoreIds[0] || null;
    const deliveryPool = routingStoreIds.length ? 'store' : 'app';

    return {
        ...(driver || {}),
        routingStoreIds,
        primaryStoreId,
        deliveryPool
    };
}

async function syncDriverRoutingMeta(driver) {
    if (!driver?.id) return;

    const normalized = normalizeDriverData(driver);
    const patch = {};

    if ((driver.deliveryPool || null) !== normalized.deliveryPool) {
        patch.deliveryPool = normalized.deliveryPool;
    }

    if ((driver.primaryStoreId || null) !== (normalized.primaryStoreId || null)) {
        patch.primaryStoreId = normalized.primaryStoreId || null;
    }

    if (!sameStringArray(driver.routingStoreIds, normalized.routingStoreIds)) {
        patch.routingStoreIds = normalized.routingStoreIds;
    }

    if (Object.keys(patch).length === 0) return;

    try {
        await db.collection('drivers').doc(driver.id).update(patch);
    } catch (e) {
        console.error('Error syncing driver routing meta:', e);
    }
}

// ==================== AUTH CHECK ====================

async function checkAuth() {
    const driverId = Cache.getDriverId();
    if (!driverId) {
        window.location.href = 'index.html';
        return false;
    }

    const cached = Cache.getDriver();
    if (cached) {
        driverData = normalizeDriverData(cached);
        Cache.setDriver(driverData);
        syncDriverRoutingMeta(driverData).catch(() => {});
        return true;
    }

    try {
        const doc = await db.collection('drivers').doc(driverId).get();
        if (doc.exists && doc.data().status !== 'blocked') {
            driverData = normalizeDriverData({ id: doc.id, ...doc.data() });
            Cache.setDriver(driverData);
            syncDriverRoutingMeta(driverData).catch(() => {});
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

    if (storesCache[storeId]) return storesCache[storeId];

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
        if (!doc.exists) return;

        const old = driverData;
        const next = normalizeDriverData({ id: doc.id, ...doc.data() });

        driverData = next;
        Cache.setDriver(driverData);

        if (driverData.status === 'blocked') {
            showToast('Sua conta foi bloqueada');
            Cache.clearAll();
            window.location.href = 'index.html';
            return;
        }

        syncDriverRoutingMeta(driverData).catch(() => {});

        if (onChange) onChange(driverData, old);
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
    if ('vibrate' in navigator) {
        navigator.vibrate([200, 100, 200]);
    }

    try {
        const basePath = (typeof window.BASE_PATH !== 'undefined')
            ? window.BASE_PATH
            : location.pathname.substring(0, location.pathname.lastIndexOf('/') + 1);

        const audio = new Audio(basePath + 'notify.mp3');
        audio.volume = 1.0;
        audio.play().catch(() => playGeneratedSound());
    } catch (e) {
        playGeneratedSound();
    }
}

function playGeneratedSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 800;
        osc.type = 'sine';

        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);

        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.2);
    } catch (e) {}
}
