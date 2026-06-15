// ==================== DRIVER AUTH MODULE ====================
// Handles: login, temp password (hard reset), status check, email verification
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

        // Step 1: Find driver doc by email
        let driverDoc = null;
        let driverData = null;
        try {
            const snap = await db.collection('drivers').where('email', '==', email).limit(1).get();
            if (!snap.empty) {
                driverDoc = snap.docs[0];
                driverData = { id: driverDoc.id, ...driverDoc.data() };
            }
        } catch (err) {
            console.error('Error finding driver:', err);
        }

        // Step 2: Check if driver exists
        if (!driverData) {
            showToast('Email não cadastrado');
            return false;
        }

        // Step 3: Check status before attempting login
        if (driverData.status === 'pending') {
            showToast('Seu cadastro está aguardando aprovação do administrador');
            return false;
        }
        if (driverData.status === 'blocked') {
            showToast('Sua conta está bloqueada. Entre em contato com a administração');
            return false;
        }

        // Step 4: Try Firebase Auth login
        try {
            await getAuth().signInWithEmailAndPassword(email, password);
            // Success! Clear any temp password flags
            if (driverData.passwordOverride) {
                await db.collection('drivers').doc(driverData.id).update({
                    passwordOverride: false,
                    tempPassword: firebase.firestore.FieldValue.delete()
                });
            }
            return true;
        } catch (authErr) {
            console.log('Firebase Auth failed:', authErr.code);

            // Step 5: If auth fails AND there's a temp password (hard reset), try it
            if (driverData.passwordOverride && driverData.tempPassword) {
                if (password === driverData.tempPassword) {
                    return await handleTempPasswordLogin(driverData, password);
                }
            }

            // Auth failed and no temp password match
            const msgs = {
                'auth/wrong-password': 'Senha incorreta',
                'auth/invalid-credential': 'Email ou senha incorretos',
                'auth/user-not-found': 'Conta não encontrada',
                'auth/too-many-requests': 'Muitas tentativas. Aguarde alguns minutos',
                'auth/user-disabled': 'Conta desativada'
            };
            showToast(msgs[authErr.code] || 'Erro ao entrar: ' + authErr.message);
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
            const existing = await db.collection('drivers').where('email', '==', data.email).limit(1).get();
            if (!existing.empty) {
                showToast('Este e-mail já está cadastrado');
                return false;
            }

            const auth = getAuth();
            const cred = await auth.createUserWithEmailAndPassword(data.email, password);
            await cred.user.sendEmailVerification();

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

            await auth.signOut();
            clearSession();
            showToast('Cadastro enviado. Aguarde aprovação do administrador.');
            return true;
        } catch (err) {
            const msgs = {
                'auth/email-already-in-use': 'Este e-mail já está em uso',
                'auth/invalid-email': 'E-mail inválido',
                'auth/weak-password': 'Senha muito fraca'
            };
            showToast(msgs[err.code] || ('Erro ao cadastrar: ' + err.message));
            return false;
        }
    }

    // ==================== TEMP PASSWORD LOGIN ====================
    async function handleTempPasswordLogin(driverData, tempPassword) {
        try {
            // If driver has an auth account, update its password to the temp one
            if (driverData.authUid) {
                // We can't update another user's password from client SDK
                // So we try: sign in with the reset email link approach
                // Or: if the auth account was recreated, sign in directly

                // Try creating a secondary app to update password
                const auth = getAuth();
                const tempApp = firebase.initializeApp(
                    auth.app.options,
                    'tempLogin_' + Date.now()
                );
                const tempAuth = tempApp.auth();

                try {
                    // Try signing in - maybe the password was already updated
                    await tempAuth.signInWithEmailAndPassword(driverData.email, tempPassword);
                    await tempAuth.signOut();
                    await tempApp.delete();

                    // Now sign in on main auth
                    await getAuth().signInWithEmailAndPassword(driverData.email, tempPassword);

                    // Clear temp password
                    await db.collection('drivers').doc(driverData.id).update({
                        passwordOverride: false,
                        tempPassword: firebase.firestore.FieldValue.delete()
                    });

                    showToast('✅ Login com senha temporária. Altere sua senha em breve!');
                    return true;
                } catch (e) {
                    await tempApp.delete();

                    // Auth account has different password - need to delete and recreate
                    // This can only be done server-side, so we use Firestore-only auth as fallback
                    return handleFirestoreOnlyLogin(driverData);
                }
            } else {
                // No auth account - create one with temp password
                return await createAuthAndLogin(driverData, tempPassword);
            }
        } catch (err) {
            console.error('Temp password login error:', err);
            showToast('Erro no login temporário');
            return false;
        }
    }

    // ==================== FIRESTORE-ONLY FALLBACK ====================
    // When Firebase Auth can't be updated (hard reset scenario),
    // use Firestore temp password to grant access
    async function handleFirestoreOnlyLogin(driverData) {
        // Store session in localStorage
        localStorage.setItem('driverId', driverData.id);
        localStorage.setItem('driverAuthFallback', 'true');

        // Update driver as active
        await db.collection('drivers').doc(driverData.id).update({
            status: driverData.status === 'approved' ? 'active' : driverData.status,
            lastLoginAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        showToast('⚠️ Login de emergência. Redefina sua senha o mais rápido possível!');

        // Redirect to main page
        window.location.href = 'home.html';
        return true;
    }

    // ==================== CREATE AUTH ACCOUNT ====================
    async function createAuthAndLogin(driverData, password) {
        try {
            const auth = getAuth();
            const cred = await auth.createUserWithEmailAndPassword(driverData.email, password);
            await cred.user.sendEmailVerification();

            // Save auth UID
            await db.collection('drivers').doc(driverData.id).update({
                authUid: cred.user.uid,
                passwordOverride: false,
                tempPassword: firebase.firestore.FieldValue.delete(),
                status: driverData.status === 'approved' ? 'active' : driverData.status
            });

            showToast('✅ Conta criada! Verifique seu email.');
            return true;
        } catch (err) {
            if (err.code === 'auth/email-already-in-use') {
                // Auth account exists but we don't know the password
                // Fall back to Firestore-only
                return handleFirestoreOnlyLogin(driverData);
            }
            console.error(err);
            showToast('Erro ao criar conta');
            return false;
        }
    }

    // ==================== SESSION VALIDATION ====================
    // Call this in your auth.onAuthStateChanged or on page load
    async function validateSession(firebaseUser) {
        let driverSnap;

        if (firebaseUser) {
            try {
                await firebaseUser.getIdToken(true);
            } catch (err) {
                console.warn('Sessão do entregador inválida ou revogada:', err?.code || err?.message || err);
                clearSession();
                await auth.signOut();
                showToast('Sessão expirada. Faça login novamente.');
                return null;
            }

            // Find by authUid
            driverSnap = await db.collection('drivers')
                .where('authUid', '==', firebaseUser.uid)
                .limit(1).get();
        } else {
            // Check fallback session
            const fallback = localStorage.getItem('driverAuthFallback');
            const dId = localStorage.getItem('driverId');
            if (!fallback || !dId) return null;

            const doc = await db.collection('drivers').doc(dId).get();
            if (!doc.exists) { clearSession(); return null; }

            const data = { id: doc.id, ...doc.data() };
            if (!data.passwordOverride) {
                // Temp access expired, admin cleared override
                clearSession();
                showToast('Sessão temporária expirada. Faça login novamente.');
                return null;
            }
            if (data.sessionRevokedAt || data.status === 'blocked') {
                clearSession();
                showToast('Sessão encerrada pelo administrador.');
                return null;
            }
            return data;
        }

        if (driverSnap.empty) return null;

        const data = { id: driverSnap.docs[0].id, ...driverSnap.docs[0].data() };

        // Check status
        if (data.status === 'blocked' || data.sessionRevokedAt) {
            await auth.signOut();
            showToast(data.sessionRevokedAt ? 'Sessão encerrada pelo administrador' : 'Conta bloqueada');
            return null;
        }
        if (data.status === 'pending') {
            await auth.signOut();
            showToast('Cadastro aguardando aprovação');
            return null;
        }

        // Update email verification status from Firebase Auth
        if (firebaseUser && firebaseUser.emailVerified && !data.emailVerified) {
            await db.collection('drivers').doc(data.id).update({ emailVerified: true });
            data.emailVerified = true;
        }

        // Set active on first successful validated login
        if (data.status === 'approved') {
            await db.collection('drivers').doc(data.id).update({ status: 'active' });
            data.status = 'active';
        }

        return data;
    }

    function clearSession() {
        localStorage.removeItem('driverId');
        localStorage.removeItem('driverAuthFallback');
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

            // Clear any override flags
            const dId = localStorage.getItem('driverId');
            if (dId) {
                await db.collection('drivers').doc(dId).update({
                    passwordOverride: false,
                    tempPassword: firebase.firestore.FieldValue.delete(),
                    passwordChangedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
            }

            showToast('✅ Senha alterada com sucesso!');
            return true;
        } catch (err) {
            const msgs = {
                'auth/wrong-password': 'Senha atual incorreta',
                'auth/requires-recent-login': 'Sessão expirada. Faça login novamente',
                'auth/weak-password': 'Senha muito fraca'
            };
            showToast(msgs[err.code] || 'Erro: ' + err.message);
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
            const dId = localStorage.getItem('driverId');
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
            const msgs = {
                'auth/email-already-in-use': 'Este email já está em uso',
                'auth/invalid-email': 'Email inválido',
                'auth/wrong-password': 'Senha incorreta',
                'auth/requires-recent-login': 'Faça login novamente'
            };
            showToast(msgs[err.code] || 'Erro: ' + err.message);
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
                showToast('Erro: ' + err.message);
            }
        }
    }

    // ==================== CHECK EMAIL STATUS ====================
    async function refreshEmailStatus() {
        const user = auth.currentUser;
        if (!user) return false;
        await user.reload();
        if (user.emailVerified) {
            const dId = localStorage.getItem('driverId');
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
        changePassword,
        changeEmail,
        resendVerification,
        refreshEmailStatus,
        clearSession
    };
})();
