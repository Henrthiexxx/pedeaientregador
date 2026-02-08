// ==================== IDLE DRIVER SYSTEM ====================
// States: OFFLINE, STORE_IDLE, STORE_ACTIVE, APP_ON_TRIP, COOLDOWN

const IdleDriver = {
    state: 'OFFLINE',
    cooldownUntil: null,
    storeConfig: null,
    listener: null,
    cooldownTimer: null,

    // Check if driver is a store driver
    isStoreDriver() {
        return driverData?.driverType === 'store' && driverData?.storeId;
    },

    // Initialize the idle system
    async init() {
        if (!this.isStoreDriver()) return;

        // Load store idle config
        await this.loadStoreConfig();

        // Restore state from cache
        const cached = Cache.getIdleState();
        if (cached) {
            this.state = cached.state || 'OFFLINE';
            this.cooldownUntil = cached.cooldownUntil ? new Date(cached.cooldownUntil) : null;
        }

        // Listen for state changes from Firestore
        this.setupListener();

        // Check cooldown expiry
        this.checkCooldown();
    },

    async loadStoreConfig() {
        if (!driverData?.storeId) return;

        const cached = Cache.get('idle_config_' + driverData.storeId);
        if (cached) {
            this.storeConfig = cached;
            return;
        }

        try {
            const doc = await db.collection('stores').doc(driverData.storeId).get();
            if (doc.exists) {
                const store = doc.data();
                this.storeConfig = {
                    cooldown_minutes: store.idleConfig?.cooldown_minutes || 30,
                    idle_threshold_minutes: store.idleConfig?.idle_threshold_minutes || 15,
                    store_radius_meters: store.idleConfig?.store_radius_meters || 250,
                    max_app_trips_per_window: store.idleConfig?.max_app_trips_per_window || 3,
                    window_minutes: store.idleConfig?.window_minutes || 120,
                    priority_mode: store.idleConfig?.priority_mode || 'FAIR',
                    enabled: store.idleConfig?.enabled || false
                };
                Cache.set('idle_config_' + driverData.storeId, this.storeConfig, 60);
            }
        } catch (e) {
            console.error('Error loading idle config:', e);
        }
    },

    setupListener() {
        if (!driverData) return;
        this.listener = db.collection('drivers').doc(driverData.id).onSnapshot(doc => {
            if (!doc.exists) return;
            const data = doc.data();
            
            if (data.idleState && data.idleState !== this.state) {
                this.state = data.idleState;
                this.cooldownUntil = data.cooldownUntil?.toDate?.() || 
                    (data.cooldownUntil ? new Date(data.cooldownUntil) : null);
                this.saveState();
                this.onStateChange();
            }
        });
    },

    // ==================== STATE TRANSITIONS ====================

    async transition(event) {
        const prev = this.state;
        let next = null;
        const actions = [];

        switch (this.state) {
            case 'OFFLINE':
                if (event === 'GO_ONLINE') {
                    next = this.isCooldownActive() ? 'COOLDOWN' : 'STORE_IDLE';
                    if (next === 'STORE_IDLE') actions.push('setEligible');
                }
                break;

            case 'STORE_IDLE':
                if (event === 'STORE_TRIP_STARTED') {
                    next = 'COOLDOWN';
                    actions.push('setCooldown', 'setIneligible');
                }
                if (event === 'APP_TRIP_ASSIGNED') {
                    next = 'APP_ON_TRIP';
                    actions.push('setIneligible');
                }
                if (event === 'GO_OFFLINE') {
                    next = 'OFFLINE';
                    actions.push('setIneligible');
                }
                break;

            case 'APP_ON_TRIP':
                if (event === 'APP_TRIP_ENDED') {
                    next = this.isCooldownActive() ? 'COOLDOWN' : 'STORE_IDLE';
                    if (next === 'STORE_IDLE') actions.push('setEligible');
                }
                break;

            case 'COOLDOWN':
                if (event === 'COOLDOWN_EXPIRED') {
                    next = 'STORE_IDLE';
                    actions.push('setEligible');
                }
                if (event === 'GO_OFFLINE') {
                    next = 'OFFLINE';
                    actions.push('setIneligible');
                }
                break;

            case 'STORE_ACTIVE':
                if (event === 'STORE_TRIP_ENDED') {
                    next = 'COOLDOWN';
                    actions.push('setCooldown', 'setIneligible');
                }
                break;
        }

        if (!next) {
            console.log(`Invalid transition: ${this.state} + ${event}`);
            return false;
        }

        // Execute actions
        for (const action of actions) {
            await this.executeAction(action);
        }

        this.state = next;
        await this.persistState(event, prev, next);
        this.saveState();
        this.onStateChange();

        console.log(`Idle transition: ${prev} → ${next} (${event})`);
        return true;
    },

    async executeAction(action) {
        switch (action) {
            case 'setCooldown': {
                const mins = this.storeConfig?.cooldown_minutes || 30;
                this.cooldownUntil = new Date(Date.now() + mins * 60000);
                break;
            }
            case 'setEligible':
                await this.updateEligibility(true);
                break;
            case 'setIneligible':
                await this.updateEligibility(false);
                break;
        }
    },

    async updateEligibility(eligible) {
        if (!driverData) return;
        try {
            await db.collection('drivers').doc(driverData.id).update({
                appEligible: eligible,
                eligibleSince: eligible ? firebase.firestore.FieldValue.serverTimestamp() : null
            });
        } catch (e) {
            console.error('Error updating eligibility:', e);
        }
    },

    async persistState(event, from, to) {
        if (!driverData) return;
        try {
            const update = {
                idleState: to,
                idleLastEvent: event,
                idleUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
            };

            if (this.cooldownUntil) {
                update.cooldownUntil = this.cooldownUntil.toISOString();
            }

            await db.collection('drivers').doc(driverData.id).update(update);

            // Audit log
            await db.collection('idleAuditLog').add({
                driverId: driverData.id,
                storeId: driverData.storeId,
                event,
                from,
                to,
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            });
        } catch (e) {
            console.error('Error persisting idle state:', e);
        }
    },

    // ==================== COOLDOWN ====================

    isCooldownActive() {
        return this.cooldownUntil && new Date() < this.cooldownUntil;
    },

    getCooldownRemaining() {
        if (!this.cooldownUntil) return 0;
        const remaining = this.cooldownUntil.getTime() - Date.now();
        return Math.max(0, Math.ceil(remaining / 60000));
    },

    checkCooldown() {
        if (this.cooldownTimer) clearInterval(this.cooldownTimer);

        this.cooldownTimer = setInterval(() => {
            if (this.state === 'COOLDOWN' && !this.isCooldownActive()) {
                this.transition('COOLDOWN_EXPIRED');
            }
            this.onStateChange(); // Update UI timer
        }, 10000);
    },

    // ==================== ELIGIBILITY CHECK ====================

    isEligibleForAppTrips() {
        if (!this.isStoreDriver()) return false;
        if (!this.storeConfig?.enabled) return false;
        if (this.state !== 'STORE_IDLE') return false;
        if (this.isCooldownActive()) return false;
        return true;
    },

    // ==================== STORE TRIP EVENTS ====================
    // Called when store owner signals a trip started/ended

    async onStoreTripStarted() {
        return this.transition('STORE_TRIP_STARTED');
    },

    async onStoreTripEnded() {
        return this.transition('STORE_TRIP_ENDED');
    },

    // ==================== HELPERS ====================

    saveState() {
        Cache.setIdleState({
            state: this.state,
            cooldownUntil: this.cooldownUntil?.toISOString() || null
        });
    },

    getStateLabel() {
        const labels = {
            'OFFLINE': 'Offline',
            'STORE_IDLE': 'Ocioso — Disponível',
            'STORE_ACTIVE': 'Entrega da Loja',
            'APP_ON_TRIP': 'Entrega do App',
            'COOLDOWN': `Cooldown (${this.getCooldownRemaining()} min)`
        };
        return labels[this.state] || this.state;
    },

    getStateColor() {
        const colors = {
            'OFFLINE': '#737373',
            'STORE_IDLE': '#ffffff',
            'STORE_ACTIVE': '#a3a3a3',
            'APP_ON_TRIP': '#ffffff',
            'COOLDOWN': '#a3a3a3'
        };
        return colors[this.state] || '#737373';
    },

    // Override this in the page for UI updates
    onStateChange() {},

    destroy() {
        if (this.listener) this.listener();
        if (this.cooldownTimer) clearInterval(this.cooldownTimer);
    }
};
