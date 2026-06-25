// ==================== ERROR CODE REGISTRY (RUNTIME) ====================
// Mapeia erros tecnicos (Firebase Auth / Firestore / rede) para os nossos
// codigos internos de 3 digitos, exibindo ao usuario uma mensagem amigavel
// — NUNCA o texto tecnico cru (ex.: "Missing or insufficient permissions").
//
// FONTE DE VERDADE: este mapa deve espelhar a tabela de admin/error-codes.html.
// Ao adicionar/alterar um codigo aqui, atualize tambem aquela tabela.

const ErrorCodes = (() => {
    'use strict';

    // code (3 digitos) -> mensagem amigavel exibida ao usuario.
    const MESSAGES = {
        101: 'E-mail ou senha incorretos.',
        102: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
        103: 'Esta conta está desativada. Fale com o administrador.',
        104: 'Este e-mail já está cadastrado.',
        105: 'Senha fraca. Use 8+ caracteres, com maiúscula, minúscula e número.',
        106: 'Sua sessão expirou. Faça login novamente.',
        107: 'E-mail inválido.',
        201: 'Não foi possível concluir agora. Tente novamente; se persistir, contate o suporte.',
        202: 'Serviço temporariamente indisponível. Tente novamente em instantes.',
        203: 'Registro não encontrado.',
        301: 'Sem conexão com a internet. Verifique sua rede.',
        302: 'Falha ao atualizar o aplicativo. Feche e abra novamente.',
        999: 'Ocorreu um erro inesperado. Tente novamente.'
    };

    // codigo tecnico do Firebase -> nosso codigo de 3 digitos.
    const CODE_MAP = {
        // --- Autenticacao (1xx) ---
        'auth/invalid-credential': 101,
        'auth/wrong-password': 101,
        'auth/user-not-found': 101,
        'auth/invalid-login-credentials': 101,
        'auth/too-many-requests': 102,
        'auth/user-disabled': 103,
        'auth/email-already-in-use': 104,
        'auth/weak-password': 105,
        'auth/requires-recent-login': 106,
        'auth/invalid-email': 107,

        // --- Permissoes / backend (2xx) ---
        'permission-denied': 201,
        'PERMISSION_DENIED': 201,
        'unavailable': 202,
        'not-found': 203,

        // --- Rede (3xx) ---
        'auth/network-request-failed': 301,
        'unauthenticated': 106
    };

    // Resolve o codigo de 3 digitos a partir de um erro do Firebase.
    function resolve(err) {
        if (!err) return 999;
        const raw = err.code || err.message || '';
        if (CODE_MAP[raw] != null) return CODE_MAP[raw];
        // Fallbacks por substring (mensagens nao normalizadas).
        const text = String(raw).toLowerCase();
        if (text.includes('insufficient permission') || text.includes('permission-denied')) return 201;
        if (text.includes('network') || text.includes('offline')) return 301;
        return 999;
    }

    // Mensagem amigavel "<texto> (Erro NNN)". Loga o tecnico no console.
    function toFriendly(err, fallbackCode) {
        const code = (err == null && fallbackCode) ? fallbackCode : resolve(err);
        if (err) {
            try { console.error('[Erro ' + code + ']', err.code || '', err.message || err); } catch (_) {}
        }
        const base = MESSAGES[code] || MESSAGES[999];
        return base + ' (Erro ' + code + ')';
    }

    return { resolve, toFriendly, MESSAGES, CODE_MAP };
})();

if (typeof window !== 'undefined') window.ErrorCodes = ErrorCodes;
