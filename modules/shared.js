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
    // Routing is derived client-side from linked store fields and should not be
    // persisted from the browser.
    return normalizeDriverData(driver);
}

// ==================== AUTH CHECK ====================

let _driverSessionTimer = null;
let _lastGuardCheck = 0;

function isDriverSessionRevoked(driver) {
    return driver?.status === 'blocked' || !!driver?.sessionRevokedAt;
}

function logoutDriverSession() {
    Cache.clearAll();
    try { firebase.auth?.().signOut?.(); } catch (_) {}
    window.location.href = 'index.html';
}

function waitForAuthUser() {
    return new Promise((resolve) => {
        const auth = firebase.auth?.();
        if (!auth) {
            resolve(null);
            return;
        }
        if (auth.currentUser) {
            resolve(auth.currentUser);
            return;
        }
        const unsub = auth.onAuthStateChanged((user) => {
            unsub();
            resolve(user || null);
        });
    });
}

// Resolve o doc do entregador pelo uid via callable (admin SDK) quando
// drivers/{uid} não existe/é negado — entregadores criados pelo admin têm id
// automático (authUid é só um campo). Ver admin/functions/index.js e
// [[drivers-get-not-list]].
async function resolveDriverByUid() {
    try {
        const f = (typeof fns !== 'undefined' && fns) ? fns
            : ((typeof firebase !== 'undefined' && firebase.functions) ? firebase.functions() : null);
        if (!f) return null;
        const res = await f.httpsCallable('resolveDriverByUid')();
        return (res && res.data && res.data.driver) ? res.data.driver : null;
    } catch (e) {
        try { console.error('resolveDriverByUid falhou:', e?.code || e); } catch (_) {}
        return null;
    }
}

async function loadAuthenticatedDriver() {
    const auth = firebase.auth?.();
    const user = auth?.currentUser || await waitForAuthUser();
    if (!user) return null;

    try {
        await user.getIdToken(true);

        // 1) Caminho rápido: entregador auto-cadastrado tem doc id == uid.
        let data = null;
        try {
            const doc = await db.collection('drivers').doc(user.uid).get();
            if (doc.exists) data = { id: doc.id, ...doc.data() };
        } catch (denied) {
            // Entregador criado pelo admin (id != uid): get por uid é negado
            // pelas regras (list). Resolve via callable abaixo em vez de falhar.
            try { console.warn('get(drivers/uid) falhou, resolvendo por uid:', denied?.code || denied); } catch (_) {}
        }
        if (!data) data = await resolveDriverByUid();
        if (!data) return null;

        if (isDriverSessionRevoked(data) || data.status === 'pending') {
            return null;
        }

        driverData = normalizeDriverData(data);
        Cache.setDriver(driverData);
        Cache.setDriverId(driverData.id);
        syncDriverRoutingMeta(driverData).catch(() => {});
        return driverData;
    } catch (e) {
        console.error('Auth check error:', e);
        return null;
    }
}

// Cada checagem faz getIdToken(true) + 1 read do doc do entregador. Antes rodava
// a cada foco/visibilitychange (tempestade de refresh/reads ao alternar abas).
// Agora limitamos a no máx. 1×/60s (foco/visibilidade), mantendo a checagem
// periódica de 60s. Reduz leituras/latência sem perder a validação de sessão.
async function runSessionGuardCheck(driverId, force = false) {
    const nowTs = Date.now();
    if (!force && (nowTs - _lastGuardCheck) < 60000) return;
    _lastGuardCheck = nowTs;
    const next = await loadAuthenticatedDriver();
    if (!next || next.id !== driverId) logoutDriverSession();
}

function startDriverSessionGuard(driverId) {
    if (_driverSessionTimer) return;
    _lastGuardCheck = Date.now(); // acabou de validar no checkAuth inicial
    _driverSessionTimer = setInterval(() => runSessionGuardCheck(driverId, true), 60000);
    window.addEventListener('focus', () => runSessionGuardCheck(driverId));
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) runSessionGuardCheck(driverId);
    });
}

async function checkAuth() {
    const current = await loadAuthenticatedDriver();
    if (current) {
        startDriverSessionGuard(current.id);
        return true;
    }

    logoutDriverSession();
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

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[char]);
}

function safeImageUrl(value) {
    const url = String(value || '').trim();
    if (!url) return '';
    if (!/^(https?:|data:image\/)/i.test(url)) return '';
    return url.replace(/["'()\\\n\r]/g, '');
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
