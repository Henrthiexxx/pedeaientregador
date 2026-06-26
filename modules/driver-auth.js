// ==================== DRIVER AUTH MODULE ====================
// Handles: login, signup, status check, email verification
// Drop-in replacement for basic login flow in driver's index.html
//
// USAGE: Replace your current handleLogin with:
//   DriverAuth.login(email, password)
//
// And add to your auth state listener:
//   DriverAuth.validateSession(user)

const DriverAuth = (() => {
    'use strict';

    function getAuth() {
        if (typeof firebase === 'undefined' || !firebase.auth) {
            throw new Error('Firebase Auth não carregado');
        }
        return firebase.auth();
    }

    // Converte qualquer erro tecnico em mensagem amigavel com codigo de 3 digitos.
    function toFriendlyError(err) {
        if (typeof ErrorCodes !== 'undefined') return ErrorCodes.toFriendly(err);
        try { console.error('Erro:', err && (err.code || err.message)); } catch (_) {}
        return 'Ocorreu um erro. Tente novamente. (Erro 999)';
    }

    function persistSession(driver) {
        if (!driver || !driver.id || typeof Cache === 'undefined') return;
        Cache.setDriverId(driver.id);
        Cache.setDriver(driver);
        Cache.setOnline(false);
    }

    function buildDriverPayload(input) {
        const name = (input.name || '').trim();
        const email = (input.email || '').trim().toLowerCase();
        const phoneRaw = String(input.phone || '');
        const cpfRaw = String(input.cpf || '');
        const plateRaw = String(input.plate || '');
        const instagramHandle = String(input.instagramHandle || '').trim().replace(/^@+/, '');
        const availableDays = Array.isArray(input.availableDays) ? input.availableDays.filter(Boolean) : [];
        const availableHours = Array.isArray(input.availableHours) ? input.availableHours.filter(Boolean) : [];
        const phone = phoneRaw.replace(/\D/g, '');
        const cpf = cpfRaw.replace(/\D/g, '');
        const plate = plateRaw.trim().toUpperCase();

        return {
            name,
            email,
            phone,
            cpf,
            vehicle: input.vehicle || 'moto',
            plate,
            pix: (input.pix || '').trim(),
            instagramHandle,
            availableDays,
            availableHours,
        };
    }

    function validateDriverInput(input) {
        const errors = [];
        if (!/^[A-Za-zÀ-ÿ' -]{3,}$/.test((input.name || '').trim())) errors.push('Nome inválido');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((input.email || '').trim().toLowerCase())) errors.push('E-mail inválido');
        if (!/^\d{11}$/.test(String(input.phone || '').replace(/\D/g, ''))) errors.push('Telefone inválido');
        if (!/^\d{11}$/.test(String(input.cpf || '').replace(/\D/g, ''))) errors.push('CPF inválido');
        const plate = String(input.plate || '').trim().toUpperCase();
        if (plate && !/^([A-Z]{3}-\d[A-Z0-9]\d{2}|[A-Z]{3}\d{4})$/.test(plate)) errors.push('Placa inválida');
        const instagram = String(input.instagramHandle || '').trim().replace(/^@+/, '');
        if (instagram && !/^[A-Za-z0-9._]{1,30}$/.test(instagram)) errors.push('Instagram inválido');
        if (Array.isArray(input.availableHours)) {
            for (const range of input.availableHours) {
                if (!/^\d{2}:\d{2}\s*-\s*\d{2}:\d{2}$/.test(String(range).trim())) errors.push('Horário inválido');
            }
        }
        if (Array.isArray(input.availableDays) && input.availableDays.some(d => !['seg','ter','qua','qui','sex','sab','dom'].includes(d))) {
            errors.push('Dia inválido');
        }
        const password = String(input.password || '');
        const confirmPassword = String(input.confirmPassword || '');
        if (password && confirmPassword && password !== confirmPassword) errors.push('As senhas não conferem');
        if (password && !isStrongPassword(password)) errors.push('Senha fraca');
        return errors;
    }

    function isStrongPassword(password) {
        return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/.test(String(password || ''));
    }

    // ==================== LOGIN ====================
    async function login(email, password) {
        email = email.trim().toLowerCase();
        if (!email || !password) {
            showToast('Informe email e senha');
            return false;
        }

        // Authenticate first, then resolve the driver doc through authUid.
        try {
            await getAuth().signInWithEmailAndPassword(email, password);

            const validated = await validateSession(getAuth().currentUser);
            if (!validated) {
                await getAuth().signOut();
                showToast('Sessão inválida. Faça login novamente.');
                return false;
            }

            persistSession(validated);
            return true;
        } catch (authErr) {
            // Nunca exibir o texto tecnico cru ao usuario — usar codigo interno.
            showToast(toFriendlyError(authErr));
            return false;
        }
    }

    // ==================== SELF REGISTRATION ====================
    async function register(input) {
        const validationErrors = validateDriverInput(input);
        if (validationErrors.length) {
            showToast(validationErrors[0]);
            return false;
        }
        const data = buildDriverPayload(input);
        const password = String(input.password || '');

        if (!data.name || !data.email || !data.phone || !data.cpf || !password) {
            showToast('Preencha todos os campos obrigatórios');
            return false;
        }
        if (!isStrongPassword(password)) {
            showToast('A senha deve ter 8+ caracteres, com maiúscula, minúscula e número');
            return false;
        }

        try {
            const auth = getAuth();
            const cred = await auth.createUserWithEmailAndPassword(data.email, password);
            await cred.user.sendEmailVerification();

            try {
                await db.collection('drivers').doc(cred.user.uid).set({
                ...data,
                authUid: cred.user.uid,
                status: 'pending',
                online: false,
                selfRegistered: true,
                emailVerified: false,
                registeredAt: firebase.firestore.FieldValue.serverTimestamp(),
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
            } catch (writeErr) {
                try { await cred.user.delete(); } catch (_) {}
                throw writeErr;
            }

            await auth.signOut();
            clearSession();
            showToast('Cadastro enviado. Aguarde aprovação do administrador.');
            return true;
        } catch (err) {
            showToast(toFriendlyError(err));
            return false;
        }
    }

    // ==================== SESSION VALIDATION ====================
    // Call this in your auth.onAuthStateChanged or on page load
    async function validateSession(firebaseUser) {
        if (!firebaseUser) {
            return null;
        }

        try {
            await firebaseUser.getIdToken(true);
        } catch (err) {
            console.warn('Sessão do entregador inválida ou revogada:', err?.code || err?.message || err);
            clearSession();
            await getAuth().signOut();
            showToast('Sessão expirada. Faça login novamente.');
            return null;
        }

        let data = null;

        // 1) Caminho rápido: entregador AUTO-cadastrado tem doc id == uid == authUid
        //    (register() usa doc(uid).set()). Leitura direta por ID é permitida.
        try {
            const snap = await db.collection('drivers').doc(firebaseUser.uid).get();
            if (snap.exists) data = { id: snap.id, ...snap.data() };
        } catch (queryErr) {
            // Pode ser permission-denied quando o entregador foi criado pelo ADMIN
            // (doc com id automático; authUid é só um campo). Não propaga: resolve
            // pelo uid via callable abaixo, em vez de mostrar Erro 201.
            try { console.warn('get(drivers/uid) falhou, resolvendo por uid:', queryErr?.code || queryErr); } catch (_) {}
        }

        // 2) Entregador criado pelo admin (id != uid): a query where('authUid'==uid)
        //    é negada pelas regras (list), então resolvemos via Cloud Function
        //    (admin SDK) que retorna só o doc cujo authUid bate com o chamador.
        if (!data) {
            data = await resolveDriverByUid();
        }

        if (!data) return null;

        // Check status
        if (data.status === 'blocked' || data.sessionRevokedAt) {
            await getAuth().signOut();
            showToast(data.sessionRevokedAt ? 'Sessão encerrada pelo administrador' : 'Conta bloqueada');
            return null;
        }
        if (data.status === 'pending') {
            await getAuth().signOut();
            showToast('Cadastro aguardando aprovação');
            return null;
        }

        // Update email verification status from Firebase Auth
        if (firebaseUser && firebaseUser.emailVerified && !data.emailVerified) {
            await db.collection('drivers').doc(data.id).update({ emailVerified: true });
            data.emailVerified = true;
        }

        return data;
    }

    // Resolve o doc do entregador pelo uid quando drivers/{uid} não existe/é negado
    // (entregadores criados pelo admin têm id automático). Usa a callable
    // resolveDriverByUid (admin SDK, ignora regras com segurança). Retorna
    // { id, ...campos } ou null. Ver admin/functions/index.js.
    async function resolveDriverByUid() {
        try {
            if (typeof fns === 'undefined' || !fns) return null;
            const res = await fns.httpsCallable('resolveDriverByUid')();
            return (res && res.data && res.data.driver) ? res.data.driver : null;
        } catch (e) {
            try { console.error('resolveDriverByUid falhou:', e?.code || e); } catch (_) {}
            return null;
        }
    }

    function clearSession() {
        localStorage.removeItem('driverId');
        localStorage.removeItem('driverAuthFallback');
        if (typeof Cache !== 'undefined') {
            Cache.clearAll();
        }
    }

    // ==================== PASSWORD CHANGE ====================
    // Driver changes their own password (requires current password)
    async function changePassword(currentPassword, newPassword) {
        const user = getAuth().currentUser;
        if (!user) {
            showToast('Faça login primeiro');
            return false;
        }

        if (!newPassword || newPassword.length < 6) {
            showToast('Nova senha deve ter no mínimo 6 caracteres');
            return false;
        }

        try {
            // Re-authenticate
            const credential = firebase.auth.EmailAuthProvider.credential(user.email, currentPassword);
            await user.reauthenticateWithCredential(credential);

            // Update password
            await user.updatePassword(newPassword);
            const dId = (typeof Cache !== 'undefined' && Cache.getDriverId()) || localStorage.getItem('driverId');
            if (dId) {
                await db.collection('drivers').doc(dId).update({
                    passwordChangedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
            }

            showToast('✅ Senha alterada com sucesso!');
            return true;
        } catch (err) {
            // 'auth/wrong-password' aqui = senha ATUAL incorreta (reautenticacao).
            showToast(err.code === 'auth/wrong-password'
                ? 'Senha atual incorreta. (Erro 101)'
                : toFriendlyError(err));
            return false;
        }
    }

    // ==================== EMAIL CHANGE ====================
    async function changeEmail(newEmail, currentPassword) {
            const user = getAuth().currentUser;
        if (!user) { showToast('Faça login primeiro'); return false; }
        if (!newEmail || !newEmail.includes('@')) { showToast('Email inválido'); return false; }

        try {
            // Re-authenticate
            const credential = firebase.auth.EmailAuthProvider.credential(user.email, currentPassword);
            await user.reauthenticateWithCredential(credential);

            // Update email in Firebase Auth
            await user.verifyBeforeUpdateEmail(newEmail);

            // Update in Firestore
            const dId = (typeof Cache !== 'undefined' && Cache.getDriverId()) || localStorage.getItem('driverId');
            if (dId) {
                await db.collection('drivers').doc(dId).update({
                    email: newEmail.toLowerCase(),
                    emailVerified: false,
                    emailChangedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
            }

            showToast('📧 Email de verificação enviado para ' + newEmail);
            return true;
        } catch (err) {
            showToast(toFriendlyError(err));
            return false;
        }
    }

    // ==================== RESEND VERIFICATION ====================
    async function resendVerification() {
        const user = getAuth().currentUser;
        if (!user) { showToast('Faça login primeiro'); return; }
        if (user.emailVerified) { showToast('Email já verificado'); return; }

        try {
            await user.sendEmailVerification();
            showToast('📧 Email de verificação reenviado!');
        } catch (err) {
            if (err.code === 'auth/too-many-requests') {
                showToast('Aguarde antes de reenviar');
            } else {
                showToast(toFriendlyError(err));
            }
        }
    }

    // ==================== SEND PASSWORD RESET (self-service) ====================
    // Envia link oficial de redefinição para o e-mail do proprio entregador.
    // Nunca expõe/define senha — o usuário escolhe a nova senha pelo link.
    async function sendPasswordReset() {
        const user = getAuth().currentUser;
        const email = (user && user.email)
            || (typeof Cache !== 'undefined' && Cache.getDriver && Cache.getDriver()?.email)
            || '';
        if (!email) { showToast('E-mail não encontrado. Faça login novamente.'); return false; }
        try {
            await getAuth().sendPasswordResetEmail(email);
            showToast('📧 Enviamos um link de redefinição para ' + email);
            return true;
        } catch (err) {
            showToast(toFriendlyError(err));
            return false;
        }
    }

    // ==================== CHECK EMAIL STATUS ====================
    async function refreshEmailStatus() {
        const user = getAuth().currentUser;
        if (!user) return false;
        await user.reload();
        if (user.emailVerified) {
            const dId = (typeof Cache !== 'undefined' && Cache.getDriverId()) || localStorage.getItem('driverId');
            if (dId) {
                await db.collection('drivers').doc(dId).update({ emailVerified: true });
            }
            return true;
        }
        return false;
    }

    // ==================== PUBLIC API ====================
    return {
        login,
        register,
        validateSession,
        persistSession,
        changePassword,
        changeEmail,
        sendPasswordReset,
        resendVerification,
        refreshEmailStatus,
        clearSession
    };
})();
