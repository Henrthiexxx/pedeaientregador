// ==================== ALERT SOUND SYSTEM ====================
var alertAudio = null;
var alertInterval = null;

function startAlertLoop() {
    if (alertAudio) return;
    try {
        alertAudio = new Audio('notify.mp3');
        alertAudio.loop = true;
        alertAudio.play().catch(() => {});
        if ('vibrate' in navigator) {
            alertInterval = setInterval(() => navigator.vibrate([300, 200, 300]), 4000);
        }
    } catch(e) {}
}

function stopAlertLoop() {
    if (alertAudio) { alertAudio.pause(); alertAudio.currentTime = 0; alertAudio = null; }
    if (alertInterval) { clearInterval(alertInterval); alertInterval = null; }
}

function playNotificationSound() {
    try {
        const a = new Audio('notify.mp3');
        a.play().catch(() => {});
        if ('vibrate' in navigator) navigator.vibrate([200, 100, 200]);
    } catch(e) {}
}

function normalizeCopyText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function buildClientAddressText(order) {
    if (!order?.address) return '';
    const a = order.address;
    const line1 = [a.street, a.number].filter(Boolean).join(', ');
    const line2 = [a.neighborhood, a.complement ? `Compl: ${a.complement}` : '', a.reference ? `Ref: ${a.reference}` : '']
        .filter(Boolean)
        .join(' | ');
    return [line1, line2].filter(Boolean).join(' - ');
}

function buildStoreAddressText(storeLike) {
    if (!storeLike) return '';
    const address = normalizeCopyText(storeLike.address || '');
    if (address) return address;
    const neighborhood = normalizeCopyText(storeLike.neighborhood || '');
    return neighborhood;
}

async function copyClientField(type, orderId) {
    const order = orderId ? getDeliveringOrder(orderId) : currentDelivery;
    if (!order) return;

    const clientName = normalizeCopyText(order.userName || 'Cliente');
    const clientPhone = normalizeCopyText(order.userPhone || '');
    const address = normalizeCopyText(buildClientAddressText(order));

    let text = '';
    if (type === 'name') text = clientName;
    if (type === 'phone') text = clientPhone;
    if (type === 'address') text = address;
    if (type === 'all') {
        text = [
            `Cliente: ${clientName}`,
            clientPhone ? `Telefone: ${clientPhone}` : '',
            address ? `Endereço: ${address}` : ''
        ].filter(Boolean).join('\n');
    }

    if (!text) {
        showToast('Sem informação para copiar');
        return;
    }

    try {
        await navigator.clipboard.writeText(text);
        showToast('Copiado');
    } catch (e) {
        console.error('clipboard error:', e);
        showToast('Não foi possível copiar');
    }
}

// ==================== DRIVER CARD ====================
function updateDriverCard() {
    if (!driverData) return;
    const vehicleNames = { moto: 'Moto', bicicleta: 'Bicicleta', carro: 'Carro' };
    const v = vehicleNames[driverData.vehicle] || 'Moto';
    document.getElementById('driverName').textContent = driverData.name || 'Entregador';
    document.getElementById('driverVehicle').textContent = `${v} ${driverData.plate ? '• ' + driverData.plate : ''}`;
    document.getElementById('driverRating').textContent = (driverData.rating || 5.0).toFixed(1);
    const avatar = document.getElementById('driverAvatar');
    const photoUrl = safeImageUrl(driverData.photoUrl);
    if (photoUrl) {
        avatar.style.backgroundImage = `url("${photoUrl}")`;
        avatar.style.backgroundSize = 'cover';
        avatar.style.backgroundPosition = 'center';
        avatar.textContent = '';
    } else {
        avatar.style.backgroundImage = 'none';
        avatar.textContent = driverData.name ? driverData.name.charAt(0).toUpperCase() : '—';
    }
}

function updateIdleUI() {
    const text = document.getElementById('idleStatusText');
    const dot  = document.getElementById('idleDot');
    if (!text || !dot) return;
    text.textContent = IdleDriver.getStateLabel();
    dot.style.background = IdleDriver.getStateColor();
    if (IdleDriver.state === 'COOLDOWN') {
        dot.style.animation = 'none';
    } else if (IdleDriver.state === 'STORE_IDLE') {
        dot.style.animation = 'trackingPulse 1.5s infinite';
    }
}

// ==================== RENDER ====================
function renderAvailableOrders() {
    const container     = document.getElementById('availableDeliveries');
    const linkedStoreIds = getLinkedStoreIds(driverData);
    const filtered      = getFilteredOrders();

    document.getElementById('availableCount').textContent = filtered.length;

    if (!isOnline) {
        container.innerHTML = `<div class="empty-state">
            <div class="empty-state-icon">○</div>
            <div class="empty-state-title">Você está offline</div>
            <div class="empty-state-text">Ative o botão acima para receber entregas</div>
        </div>`;
        return;
    }

    const maxOrders = driverData?.maxSimultaneousOrders || 1;
    const myActive  = (acceptedOrders.length || 0) + (currentDelivery ? 1 : 0);

    if (myActive >= maxOrders && !filtered.length) {
        container.innerHTML = `<div class="empty-state">
            <div class="empty-state-icon">◎</div>
            <div class="empty-state-title">Limite atingido</div>
            <div class="empty-state-text">Finalize suas entregas antes de aceitar novas</div>
        </div>`;
        return;
    }

    if (!filtered.length) {
        container.innerHTML = `<div class="empty-state">
            <div class="empty-state-icon">—</div>
            <div class="empty-state-title">Nenhuma entrega disponível</div>
            <div class="empty-state-text">Aguarde novos pedidos</div>
        </div>`;
        return;
    }

    container.innerHTML = filtered.map(order => {
        const waitTime = getWaitTime(order.createdAt);
        const fee      = getDeliveryFee(order.address?.neighborhood);
        const earning  = calculateDriverEarning(fee, order.distance);
        const isOwn    = linkedStoreIds.includes(String(order.storeId || ''));
        const storeName = escapeHtml(order.storeName || 'Loja');
        const storeAddressText = escapeHtml(buildStoreAddressText(order));
        const neighborhood = escapeHtml(order.address?.neighborhood || '');
        const street = escapeHtml(order.address?.street || '');
        const number = escapeHtml(order.address?.number || '');
        const storeAddressHtml = `
            <div class="address-text" id="store-address-${order.id}" style="font-size:.8rem;color:var(--text-muted);margin-top:3px;${storeAddressText ? '' : 'display:none;'}">
                ${storeAddressText || ''}
            </div>`;

        return `
        <div class="delivery-card ${waitTime > 15 ? 'urgent' : ''}" id="order-${order.id}"
             ${isOwn ? 'style="border-left:3px solid var(--primary);"' : ''}>
            <div class="delivery-header">
                <div class="delivery-store">
                    <div class="delivery-store-icon" id="icon-${order.id}">□</div>
                    <div>
                        <div class="delivery-store-name">${storeName}${isOwn ? ' ★' : ''}</div>
                        <div class="delivery-store-time">Aguardando há ${waitTime} min</div>
                    </div>
                </div>
                <div class="delivery-value">
                    <div class="delivery-fee">+ ${formatCurrency(earning)}</div>
                    <div class="delivery-distance">${order.distance ? Number(order.distance).toFixed(1) + ' km' : neighborhood}</div>
                </div>
            </div>
            <div class="delivery-body">
                <div class="delivery-address">
                    <div class="address-icon">□</div>
                    <div class="address-info">
                        <div class="address-label">Retirar em</div>
                        <div class="address-text">${storeName}</div>
                        ${storeAddressHtml}
                    </div>
                </div>
                <div class="delivery-address">
                    <div class="address-icon">◎</div>
                    <div class="address-info">
                        <div class="address-label">Entregar em</div>
                        <div class="address-text">${street}, ${number} - ${neighborhood}</div>
                    </div>
                </div>
                <div class="delivery-actions">
                    <button class="btn btn-primary" onclick="acceptOrder('${order.id}')">Aceitar Entrega</button>
                </div>
            </div>
        </div>`;
    }).join('');

    filtered.forEach(async order => {
        if (order.storeId) {
            const store = await getStoreData(order.storeId);
            const logoUrl = safeImageUrl(store?.logoUrl);
            if (logoUrl) {
                const el = document.getElementById('icon-' + order.id);
                if (el) {
                    el.style.backgroundImage = `url("${logoUrl}")`;
                    el.style.backgroundSize = 'cover';
                    el.style.backgroundPosition = 'center';
                    el.textContent = '';
                }
            }
            const storeAddressEl = document.getElementById('store-address-' + order.id);
            if (storeAddressEl) {
                const addr = buildStoreAddressText(store);
                if (addr) {
                    storeAddressEl.textContent = addr;
                    storeAddressEl.style.display = 'block';
                }
            }
        }
    });
}

function renderAcceptedOrders() {
    const section   = document.getElementById('acceptedSection');
    const container = document.getElementById('acceptedOrders');
    if (!acceptedOrders.length) { section.style.display = 'none'; return; }
    section.style.display = 'block';
    document.getElementById('acceptedCount').textContent = acceptedOrders.length;

    container.innerHTML = acceptedOrders.map(order => {
        const fee         = getDeliveryFee(order.address?.neighborhood);
        const earning     = calculateDriverEarning(order.driverEarning || fee, order.distance);
        const statusLabel = order.status === 'preparing' ? 'Preparando' : 'Pronto p/ retirada';
        const canPickup   = order.status === 'ready';
        const storeName = escapeHtml(order.storeName || 'Loja');
        const storeAddressText = escapeHtml(buildStoreAddressText(order));
        const neighborhood = escapeHtml(order.address?.neighborhood || '');
        const street = escapeHtml(order.address?.street || '');
        const number = escapeHtml(order.address?.number || '');
        const storeAddressHtml = `
            <div class="address-text" id="accepted-store-address-${order.id}" style="font-size:.8rem;color:var(--text-muted);margin-top:3px;${storeAddressText ? '' : 'display:none;'}">
                ${storeAddressText || ''}
            </div>`;
        return `
        <div class="delivery-card" id="accepted-${order.id}" style="border-color: var(--text-muted);">
            <div class="delivery-header">
                <div class="delivery-store">
                    <div class="delivery-store-icon" id="aicon-${order.id}">□</div>
                    <div>
                        <div class="delivery-store-name">${storeName}</div>
                        <div class="delivery-store-time">${statusLabel}</div>
                    </div>
                </div>
                <div class="delivery-value">
                    <div class="delivery-fee">+ ${formatCurrency(earning)}</div>
                    <div class="delivery-distance">${order.distance ? Number(order.distance).toFixed(1) + ' km' : neighborhood}</div>
                </div>
            </div>
            <div class="delivery-body">
                <div class="delivery-address">
                    <div class="address-icon">□</div>
                    <div class="address-info">
                        <div class="address-label">Retirar em</div>
                        <div class="address-text">${storeName}</div>
                        ${storeAddressHtml}
                    </div>
                </div>
                <div class="delivery-address">
                    <div class="address-icon">◎</div>
                    <div class="address-info">
                        <div class="address-label">Entregar em</div>
                        <div class="address-text">${street}, ${number} - ${neighborhood}</div>
                    </div>
                </div>
                <div class="delivery-actions">
                    ${canPickup
                        ? `<button class="btn btn-warning" onclick="startDelivery('${order.id}')" style="flex:1;">Iniciar Retirada</button>`
                        : `<button class="btn btn-secondary" disabled style="flex:1;">Aguardando preparo</button>`
                    }
                </div>
            </div>
        </div>`;
    }).join('');

    acceptedOrders.forEach(async order => {
        if (order.storeId) {
            const store = await getStoreData(order.storeId);
            const logoUrl = safeImageUrl(store?.logoUrl);
            if (logoUrl) {
                const el = document.getElementById('aicon-' + order.id);
                if (el) {
                    el.style.backgroundImage = `url("${logoUrl}")`;
                    el.style.backgroundSize = 'cover';
                    el.style.backgroundPosition = 'center';
                    el.textContent = '';
                }
            }
            const storeAddressEl = document.getElementById('accepted-store-address-' + order.id);
            if (storeAddressEl) {
                const addr = buildStoreAddressText(store);
                if (addr) {
                    storeAddressEl.textContent = addr;
                    storeAddressEl.style.display = 'block';
                }
            }
        }
    });
}

function buildDeliveryCardHtml(order, index, total) {
    const fee        = getDeliveryFee(order.address?.neighborhood);
    const earning    = calculateDriverEarning(order.driverEarning || fee, order.distance);
    const clientName = escapeHtml(order.userName || 'Cliente');
    const clientPhone= escapeHtml(order.userPhone || '');
    const clientAddressText = escapeHtml(buildClientAddressText(order));
    const storeName = escapeHtml(order.storeName || 'Loja');
    const storeAddressFallback = escapeHtml(buildStoreAddressText(order));
    const street = escapeHtml(order.address?.street || '');
    const number = escapeHtml(order.address?.number || '');
    const complement = escapeHtml(order.address?.complement || '');
    const reference = escapeHtml(order.address?.reference || '');
    const orderId = order.id;
    const seq = total > 1 ? `<span class="current-delivery-status" style="background:var(--bg-input);color:var(--text-muted);margin-right:6px;">${index + 1}º</span>` : '';
    return `
    <div class="current-delivery" id="delivering-${orderId}" style="margin-bottom:16px;">
        <div class="current-delivery-header">
            <div class="current-delivery-title">${seq}Pedido #${orderId.slice(-6).toUpperCase()}</div>
            <span class="current-delivery-status status-delivering">Entregar</span>
        </div>
        <div class="tracking-indicator">
            <span class="tracking-dot"></span>
            <span>Compartilhando localização com cliente</span>
        </div>
        <div class="route-line">
            <div class="route-dots">
                <div class="route-dot"></div>
                <div class="route-line-connector"></div>
                <div class="route-dot end"></div>
            </div>
            <div class="route-addresses">
                <div class="route-address">
                    <div class="route-address-label">Retirar</div>
                    <div class="route-address-text">${storeName}</div>
                    <div class="route-address-text" id="pickupStoreAddress-${orderId}" style="font-size:.8rem;color:var(--text-muted);margin-top:3px;">
                        ${storeAddressFallback || 'Endereço da loja não informado'}
                    </div>
                </div>
                <div class="route-address">
                    <div class="route-address-label">Entregar</div>
                    <div class="route-address-text">${street}, ${number}</div>
                </div>
            </div>
        </div>
        <div class="client-box">
            <div class="client-label">Cliente</div>
            <div class="client-name">${clientName}</div>
            ${clientPhone ? `<div class="client-phone"><a href="tel:${clientPhone}" style="color:var(--primary);text-decoration:none;">${clientPhone}</a></div>` : ''}
            ${complement ? `<div style="font-size:0.8rem;color:var(--text-muted);margin-top:8px;">${complement}</div>` : ''}
            ${reference ? `<div style="font-size:0.8rem;color:var(--text-muted);">Ref: ${reference}</div>` : ''}
            <div class="client-copy-actions">
                <button class="btn btn-secondary btn-sm" onclick="copyClientField('phone','${orderId}')">Copiar telefone</button>
                <button class="btn btn-secondary btn-sm" onclick="copyClientField('name','${orderId}')">Copiar nome</button>
                <button class="btn btn-secondary btn-sm" onclick="copyClientField('address','${orderId}')" ${clientAddressText ? '' : 'disabled'}>Copiar endereço</button>
                <button class="btn btn-primary btn-sm" onclick="copyClientField('all','${orderId}')">Copiar tudo</button>
            </div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding:12px;background:var(--bg-input);border-radius:8px;border:1px solid var(--border);">
            <span style="color:var(--text-muted);font-size:0.85rem;">Seu ganho</span>
            <span style="font-weight:500;color:var(--primary);">${formatCurrency(earning)}</span>
        </div>
        <div class="delivery-actions">
            <button class="btn btn-success btn-block" onclick="openDeliverModal('${orderId}')">Finalizar Entrega</button>
        </div>
    </div>`;
}

function renderCurrentDelivery() {
    const orders = (deliveringOrders && deliveringOrders.length)
        ? deliveringOrders
        : (currentDelivery ? [currentDelivery] : []);
    const section = document.getElementById('currentDeliverySection');
    const container = document.getElementById('currentDelivery');
    const titleEl = document.getElementById('currentDeliveryTitle');
    if (!orders.length) { if (section) section.style.display = 'none'; return; }

    section.style.display = 'block';
    if (titleEl) titleEl.textContent = orders.length > 1
        ? `Entregas em Andamento (${orders.length})`
        : 'Entrega em Andamento';

    container.innerHTML = orders.map((o, i) => buildDeliveryCardHtml(o, i, orders.length)).join('');

    orders.forEach(order => {
        if (!order.storeId) return;
        getStoreData(order.storeId).then((store) => {
            const el = document.getElementById('pickupStoreAddress-' + order.id);
            if (!el) return;
            const addr = buildStoreAddressText(store);
            if (addr) el.textContent = addr;
        }).catch((err) => {
            console.error('Erro ao carregar endereço da loja:', err);
        });
    });
}

function updateStats() {
    loadHistoryForStats().then(() => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayOrders = allHistory.filter(o => {
            const date = o.deliveredAt?.toDate?.() || new Date(o.deliveredAt);
            return date >= today;
        });
        let money = 0, dist = 0;
        todayOrders.forEach(o => {
            const fee = o.driverEarning || getDeliveryFee(o.address?.neighborhood);
            money += calculateDriverEarning(fee, o.distance) || 0;
            dist  += o.distance || 3.5;
        });
        document.getElementById('todayEarnings').textContent   = formatCurrency(money || 0);
        document.getElementById('todayDeliveries').textContent  = todayOrders.length;
        document.getElementById('todayDistance').textContent    = `${((dist || 0)).toFixed(1)} km`;
    });
}

// ==================== ACCEPT ORDER ====================
function acceptOrder(orderId) {
    pendingAcceptOrder = availableOrders.find(o => o.id === orderId);
    if (!pendingAcceptOrder) return;
    const fee     = getDeliveryFee(pendingAcceptOrder.address?.neighborhood);
    const earning = calculateDriverEarning(fee, pendingAcceptOrder.distance);
    document.getElementById('acceptModalText').textContent =
        `${pendingAcceptOrder.storeName} → ${pendingAcceptOrder.address?.neighborhood}`;
    document.getElementById('acceptModalInfo').innerHTML = `
        <div style="display:flex;justify-content:space-between;">
            <span>Taxa de entrega</span><span>${formatCurrency(fee)}</span>
        </div>
        ${pendingAcceptOrder.distance ? `<div style="display:flex;justify-content:space-between;margin-top:8px;">
            <span>Distância</span><span>${Number(pendingAcceptOrder.distance).toFixed(1)} km</span>
        </div>` : ''}
        <div style="display:flex;justify-content:space-between;margin-top:8px;font-weight:500;color:var(--primary);">
            <span>Seu ganho</span><span>${formatCurrency(earning)}</span>
        </div>`;
    openModal('acceptModal');
}

function startDelivery(orderId) {
    const order = acceptedOrders.find(o => o.id === orderId);
    if (!order) return;
    showConfirmModal('Retirar pedido?', 'Confirme que você está retirando o pedido na loja.',
        () => executeStartDelivery(order), 'Confirmar retirada');
}

// ==================== DELIVER MODAL ====================
// Finalização sem captura de GPS (era lenta e gerava custo). O entregador
// apenas confirma a entrega; a localização já é compartilhada em tempo real
// durante o trajeto.
function openDeliverModal(orderId) {
    deliverTargetId = orderId || (currentDelivery && currentDelivery.id) || null;
    const target = getDeliveringOrder(deliverTargetId);
    const txt = document.getElementById('deliverModalText');
    if (txt) txt.textContent = target
        ? `Confirme que o pedido #${target.id.slice(-6).toUpperCase()} foi entregue ao cliente.`
        : 'Confirme que o pedido foi entregue ao cliente.';
    openModal('deliverModal');
}

// ==================== NAV MAP ====================
function openNavMap() {
    if (!currentDelivery?.address?.location) { showToast('Cliente não tem localização salva'); return; }
    document.getElementById('navMapPopup').classList.add('active');
    document.getElementById('navMapBtn').classList.remove('active');
    setTimeout(() => {
        const loc = currentDelivery.address.location;
        if (navMap) navMap.remove();
        navMap = L.map('navMap').setView([loc.lat, loc.lng], 16);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(navMap);
        L.marker([loc.lat, loc.lng]).addTo(navMap)
            .bindPopup(`${currentDelivery.address.street}, ${currentDelivery.address.number}`).openPopup();
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
