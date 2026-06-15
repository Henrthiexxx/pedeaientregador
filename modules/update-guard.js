// ==================== APP UPDATE GUARD ====================
// Low-cost version gate for the driver app.
// Reads a remote Firestore config doc and blocks the app when local version
// is below the minimum required version.

const AppUpdateGuard = (() => {
    'use strict';

    const FALLBACK = {
        minVersion: '0.0.0',
        latestVersion: '0.0.0',
        downloadUrl: 'https://www.pedradelivery.com.br',
        message: 'Atualize o app para continuar usando o entregador.',
        title: 'Atualização obrigatória'
    };

    function parseVersion(v) {
        return String(v || '0.0.0').trim().split('.').map(n => Number.parseInt(n, 10) || 0);
    }

    function compareVersions(a, b) {
        const aa = parseVersion(a);
        const bb = parseVersion(b);
        const len = Math.max(aa.length, bb.length);
        for (let i = 0; i < len; i++) {
            const diff = (aa[i] || 0) - (bb[i] || 0);
            if (diff !== 0) return diff;
        }
        return 0;
    }

    function getLocalVersion() {
        return String(window.PEDRAD_DRIVER_APP_VERSION || '0.0.0');
    }

    async function loadRemoteConfig() {
        try {
            const doc = await db.collection('config').doc('driverApp').get();
            if (!doc.exists) return { ...FALLBACK };
            return { ...FALLBACK, ...doc.data() };
        } catch (err) {
            console.warn('[UpdateGuard] remote config unavailable:', err?.code || err?.message || err);
            return { ...FALLBACK };
        }
    }

    function ensureModal() {
        let modal = document.getElementById('appUpdateModal');
        if (modal) return modal;

        modal = document.createElement('div');
        modal.id = 'appUpdateModal';
        modal.style.cssText = [
            'position:fixed',
            'inset:0',
            'z-index:9999',
            'display:none',
            'align-items:center',
            'justify-content:center',
            'background:rgba(0,0,0,.86)',
            'padding:20px'
        ].join(';');
        modal.innerHTML = `
            <div style="width:min(460px,100%);background:#0b0b0b;border:1px solid #242424;border-radius:18px;padding:22px;color:#fff;box-shadow:0 24px 80px rgba(0,0,0,.55)">
                <div style="font-size:.72rem;letter-spacing:.18em;text-transform:uppercase;color:#22c55e;margin-bottom:10px">App desatualizado</div>
                <h2 id="appUpdateTitle" style="margin:0 0 10px;font-size:1.25rem;line-height:1.2">Atualização obrigatória</h2>
                <p id="appUpdateMessage" style="margin:0 0 10px;color:#a3a3a3;line-height:1.5"></p>
                <div id="appUpdateMeta" style="font-size:.84rem;color:#7a7a7a;margin-bottom:18px"></div>
                <div style="display:flex;gap:10px;flex-wrap:wrap">
                    <a id="appUpdateDownload" href="#" target="_blank" rel="noopener noreferrer" style="flex:1;min-width:180px;text-align:center;text-decoration:none;background:#fff;color:#000;padding:12px 14px;border-radius:12px;font-weight:700">Baixar atualização</a>
                    <button id="appUpdateRetry" type="button" style="flex:1;min-width:140px;background:transparent;color:#fff;border:1px solid #333;padding:12px 14px;border-radius:12px;font-weight:700">Verificar novamente</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('#appUpdateRetry').addEventListener('click', () => window.location.reload());
        return modal;
    }

    function showUpdateGate(remote) {
        const modal = ensureModal();
        modal.querySelector('#appUpdateTitle').textContent = remote.title || FALLBACK.title;
        modal.querySelector('#appUpdateMessage').textContent = remote.message || FALLBACK.message;
        modal.querySelector('#appUpdateMeta').textContent = `Versão instalada: ${getLocalVersion()} • mínima exigida: ${remote.minVersion || FALLBACK.minVersion} • disponível: ${remote.latestVersion || FALLBACK.latestVersion}`;
        const link = modal.querySelector('#appUpdateDownload');
        link.href = remote.downloadUrl || FALLBACK.downloadUrl;
        modal.style.display = 'flex';
    }

    async function checkAndBlockIfNeeded() {
        const remote = await loadRemoteConfig();
        const localVersion = getLocalVersion();
        const minVersion = remote.minVersion || FALLBACK.minVersion;
        if (compareVersions(localVersion, minVersion) < 0) {
            showUpdateGate(remote);
            return false;
        }
        return true;
    }

    return { checkAndBlockIfNeeded, compareVersions, getLocalVersion };
})();
