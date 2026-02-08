// ==================== CACHE MODULE ====================
const Cache = {
    PREFIX: 'pedrad_',

    set(key, data, ttlMinutes = 60) {
        try {
            const item = {
                data,
                expires: Date.now() + (ttlMinutes * 60000),
                cached: Date.now()
            };
            localStorage.setItem(this.PREFIX + key, JSON.stringify(item));
        } catch (e) {
            console.warn('Cache write error:', e);
        }
    },

    get(key) {
        try {
            const raw = localStorage.getItem(this.PREFIX + key);
            if (!raw) return null;
            const item = JSON.parse(raw);
            if (Date.now() > item.expires) {
                localStorage.removeItem(this.PREFIX + key);
                return null;
            }
            return item.data;
        } catch (e) {
            return null;
        }
    },

    remove(key) {
        localStorage.removeItem(this.PREFIX + key);
    },

    // Driver data - long TTL, updated on changes via listener
    setDriver(data) { this.set('driver', data, 1440); },
    getDriver() { return this.get('driver'); },

    // Delivery fees - medium TTL
    setFees(data) { this.set('fees', data, 120); },
    getFees() { return this.get('fees'); },

    // Platform config - medium TTL
    setConfig(data) { this.set('config', data, 120); },
    getConfig() { return this.get('config'); },

    // Store data - long TTL per store
    setStore(storeId, data) { this.set('store_' + storeId, data, 1440); },
    getStore(storeId) { return this.get('store_' + storeId); },

    // History - short TTL
    setHistory(data) { this.set('history', data, 30); },
    getHistory() { return this.get('history'); },

    // Session state
    setOnline(val) { localStorage.setItem(this.PREFIX + 'online', val); },
    getOnline() { return localStorage.getItem(this.PREFIX + 'online') === 'true'; },

    setDriverId(id) { localStorage.setItem(this.PREFIX + 'driver_id', id); },
    getDriverId() { return localStorage.getItem(this.PREFIX + 'driver_id'); },

    // Idle driver state
    setIdleState(state) { this.set('idle_state', state, 60); },
    getIdleState() { return this.get('idle_state'); },

    clearAll() {
        const keys = Object.keys(localStorage).filter(k => k.startsWith(this.PREFIX));
        keys.forEach(k => localStorage.removeItem(k));
    }
};
