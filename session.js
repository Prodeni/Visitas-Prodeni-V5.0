// ============================================================
//  PRODENI v4 — session.js
//  Gestor de sesión compartido: index + admin + tecnico
//  Estrategia 3 capas: localStorage + sessionStorage + cookie
//  NO borrar este archivo — lo usan los 3 HTML
// ============================================================

(function () {
  const KEY = 'prodeni_session_v2';
  const CREDS_KEY = 'prodeni_creds_v2';      // credenciales offline cifradas
  const USER_KEY  = 'prodeni_user_v2';       // perfil del usuario (rol, nombre)

  // ── Expiración: 23:59:59 del día actual ─────────────────
  // La sesión muere a medianoche — el técnico debe re-loguear cada día.
  function expToday() {
    var d = new Date();
    d.setHours(23, 59, 59, 0);
    return d.getTime();
  }

  // ── Verificar si un timestamp es del día de hoy ──────────
  function isSameDay(ts) {
    var then = new Date(ts);
    var now  = new Date();
    return then.getFullYear() === now.getFullYear() &&
           then.getMonth()    === now.getMonth()    &&
           then.getDate()     === now.getDate();
  }

  // ── Leer cookie por nombre ───────────────────────────────
  function getCookie(name) {
    const m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    return m ? decodeURIComponent(m[2]) : null;
  }

  // ── Escribir cookie ──────────────────────────────────────
  function setCookie(name, value, expiresMs) {
    const exp = new Date(expiresMs).toUTCString();
    document.cookie = name + '=' + encodeURIComponent(value) +
      '; expires=' + exp + '; path=/; SameSite=Lax';
  }

  // ── Borrar cookie ────────────────────────────────────────
  function delCookie(name) {
    document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; SameSite=Lax';
  }

  // ── Hash simple para credenciales offline (no criptografía real,
  //    solo evita texto plano en localStorage) ─────────────
  function hashCreds(user, pass) {
    // btoa doble con separador no predecible
    return btoa(unescape(encodeURIComponent(user + '\x00' + pass + '\x01prodeni')));
  }

  window.ProdenSession = {

    // ── Guardar sesión tras login exitoso ──────────────────
    set: function (userData) {
      const exp = expToday();
      const session = {
        username:  userData.username,
        role:      (userData.role || 'tecnico').toLowerCase(),
        email:     userData.email || '',
        expiresAt: exp,
      };
      const str = JSON.stringify(session);
      try { localStorage.setItem(KEY, str); }   catch(e) {}
      try { sessionStorage.setItem(KEY, str); } catch(e) {}
      try { setCookie(KEY, str, exp); }          catch(e) {}

      // Identificar al usuario en PostHog (si está disponible)
      try {
        if (window.posthog) {
          window.posthog.identify(session.username, {
            role: session.role,
            email: session.email,
          });
        }
      } catch(e) {}
    },

    // ── Guardar credenciales offline ───────────────────────
    saveOfflineCreds: function (username, password, role) {
      try {
        localStorage.setItem(CREDS_KEY, JSON.stringify({
          h: hashCreds(username, password),
          r: role,
          u: username,
          t: Date.now(),
        }));
        localStorage.setItem(USER_KEY, JSON.stringify({ username, role, email: '' }));
      } catch(e) {}
    },

    // ── Validar credenciales offline ───────────────────────
    // Solo acepta si el login fue HOY — expira a las 11:59pm
    checkOffline: function (username, password) {
      try {
        var c = JSON.parse(localStorage.getItem(CREDS_KEY) || 'null');
        if (!c) return null;
        if (!isSameDay(c.t)) return null;
        if (c.h !== hashCreds(username, password)) return null;
        return { username: c.u, role: c.r };
      } catch(e) { return null; }
    },

    // ── Invalidar credenciales cacheadas (login rechazado) ─
    invalidateCreds: function () {
      try { localStorage.removeItem(CREDS_KEY); } catch(e) {}
      try { localStorage.removeItem(USER_KEY);  } catch(e) {}
    },

    // ── Obtener sesión activa (3 capas) ────────────────────
    get: function () {
      const sources = [
        () => localStorage.getItem(KEY),
        () => sessionStorage.getItem(KEY),
        () => getCookie(KEY),
      ];
      for (const src of sources) {
        try {
          const raw = src();
          if (!raw) continue;
          const s = JSON.parse(raw);
          if (!s || !s.username || !s.role) continue;
          // Si la sesión expiró → rechazarla siempre
          // (el técnico debe re-loguear cada día para registrar asistencia)
          if (s.expiresAt && Date.now() > s.expiresAt) {
            // Limpiar sesión expirada
            try { localStorage.removeItem(KEY); }   catch(e) {}
            try { sessionStorage.removeItem(KEY); } catch(e) {}
            try { delCookie(KEY); }                 catch(e) {}
            return null;
          }
          return s;
        } catch(e) {}
      }
      return null;
    },

    // ── Requiere sesión activa o redirige al login ─────────
    require: function () {
      const s = this.get();
      if (!s) { window.location.href = 'index.html'; return null; }
      return s;
    },

    // ── Requiere rol admin o redirige ──────────────────────
    requireAdmin: function () {
      var s = this.require();
      if (!s) return null;
      if (s.role !== 'admin') { window.location.href = 'tecnico.html'; return null; }
      return s;
    },

    // ── Cerrar sesión voluntaria ───────────────────────────
    //    SOLO borra sesión activa — conserva credenciales offline
    logout: function () {
      try { localStorage.removeItem(KEY); }   catch(e) {}
      try { sessionStorage.removeItem(KEY); } catch(e) {}
      try { delCookie(KEY); }                 catch(e) {}
      // NO tocar CREDS_KEY ni USER_KEY — necesarios para offline

      // Limpiar identidad de PostHog (si está disponible)
      try { if (window.posthog) window.posthog.reset(); } catch(e) {}
    },
  };

})();
