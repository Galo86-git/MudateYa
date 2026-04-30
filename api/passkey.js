// api/passkey.js
// MudateYa - WebAuthn / Passkeys (login con huella, Face ID, etc.)
//
// Endpoints:
//   POST ?action=register-options&email=xxx
//        Auth: sessionToken (mudancero ya logueado)
//        Devuelve challenge para que el browser cree una passkey nueva.
//
//   POST ?action=register-verify&email=xxx
//        Auth: sessionToken (mudancero ya logueado)
//        Body: { credential: AttestationResponse }
//        Verifica la credential y la guarda en Redis.
//
//   POST ?action=login-options&email=xxx
//        SIN auth (estamos logueando justamente).
//        Devuelve challenge para que el browser firme con su passkey.
//
//   POST ?action=login-verify&email=xxx
//        SIN auth.
//        Body: { credential: AssertionResponse }
//        Verifica la firma y crea sessionToken igual que magic link.
//
//   POST ?action=list&email=xxx
//        Auth: sessionToken
//        Lista las passkeys registradas del usuario.
//
//   POST ?action=delete&email=xxx
//        Auth: sessionToken
//        Body: { credentialId: '...' (opcional, si no viene borra todas) }
//        Borra una passkey específica o todas.
//
//   POST ?action=logout-all&email=xxx
//        Auth: sessionToken
//        Cierra TODAS las sesiones del usuario (passkey + magic link).
//
// Convenciones MudateYa: var/const, fail-closed en auth, sesiones de 90 días.

var SimpleWebAuthn = require('@simplewebauthn/server');
var generateRegistrationOptions = SimpleWebAuthn.generateRegistrationOptions;
var verifyRegistrationResponse = SimpleWebAuthn.verifyRegistrationResponse;
var generateAuthenticationOptions = SimpleWebAuthn.generateAuthenticationOptions;
var verifyAuthenticationResponse = SimpleWebAuthn.verifyAuthenticationResponse;
var crypto = require('crypto');

// ── Config WebAuthn ─────────────────────────────────────────────────────────────
// rpID es el dominio (sin protocolo, sin puerto). DEBE ser exactamente
// el dominio donde corre la app, si no las passkeys no funcionan.
var RP_ID = process.env.PASSKEY_RP_ID || 'mudateya.ar';
var RP_NAME = 'MudateYa';
var ORIGIN = process.env.PASSKEY_ORIGIN || 'https://mudateya.ar';

// Sesión por huella: 90 días (segundos)
var SESSION_TTL = 90 * 24 * 60 * 60;
// Tope de passkeys por usuario
var MAX_PASSKEYS_PER_USER = 5;

// ── Redis (Upstash REST) ────────────────────────────────────────────────────────
var REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
var REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisCmd(args) {
  var r = await fetch(REDIS_URL + '/' + args.map(encodeURIComponent).join('/'), {
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN }
  });
  var j = await r.json();
  return j.result;
}

async function getJSON(key) {
  var raw = await redisCmd(['GET', key]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function setJSON(key, val, ttl) {
  if (ttl) {
    return redisCmd(['SET', key, JSON.stringify(val), 'EX', String(ttl)]);
  }
  return redisCmd(['SET', key, JSON.stringify(val)]);
}

async function delKey(key) {
  return redisCmd(['DEL', key]);
}

// ── Helpers ─────────────────────────────────────────────────────────────────────
// Convertir Buffer/Uint8Array a base64url (lo que usa WebAuthn)
function toBase64Url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Convertir base64url a Buffer
function fromBase64Url(str) {
  var padding = '='.repeat((4 - str.length % 4) % 4);
  var base64 = (str + padding).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64');
}

// Generar token de sesión seguro
function generarSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Auth: validar sessionToken contra Redis (mismo patrón que cotizaciones.js)
async function autorizar(req, email) {
  if (!email) return false;
  var emailLow = email.toLowerCase();
  var token = req.headers['x-session-token'] || (req.query && req.query.sessionToken);
  if (!token) return false;
  var t1 = await getJSON('session:mudancero:' + emailLow);
  if (t1 && t1 === token) return 'mudancero';
  return false;
}

// Cargar perfil mudancero
async function cargarPerfilMudancero(email) {
  return getJSON('mudancero:perfil:' + email.toLowerCase());
}

// Cargar passkeys de un usuario
async function getPasskeys(email) {
  var emailLow = email.toLowerCase();
  var arr = await getJSON('passkey:' + emailLow);
  return Array.isArray(arr) ? arr : [];
}

async function setPasskeys(email, passkeys) {
  var emailLow = email.toLowerCase();
  if (!passkeys || passkeys.length === 0) {
    return delKey('passkey:' + emailLow);
  }
  return setJSON('passkey:' + emailLow, passkeys);
}

// ── Handler HTTP ────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  var action = (req.query && req.query.action) || '';
  var email = (req.query && req.query.email) || (req.body && req.body.email) || '';
  email = (email + '').toLowerCase().trim();

  if (!email) {
    return res.status(400).json({ error: 'Falta email' });
  }

  try {
    // ════════════════════════════════════════════════════════════════════════
    // REGISTRO de una passkey nueva (requiere sesión activa)
    // ════════════════════════════════════════════════════════════════════════
    if (action === 'register-options' && req.method === 'POST') {
      var rolReg = await autorizar(req, email);
      if (!rolReg) return res.status(401).json({ error: 'No autorizado' });

      var perfil = await cargarPerfilMudancero(email);
      if (!perfil) return res.status(404).json({ error: 'Perfil no encontrado' });

      var existentes = await getPasskeys(email);
      if (existentes.length >= MAX_PASSKEYS_PER_USER) {
        return res.status(400).json({
          error: 'Llegaste al máximo de ' + MAX_PASSKEYS_PER_USER + ' dispositivos. Borrá uno desde Mi Perfil para sumar este.'
        });
      }

      var options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: RP_ID,
        userID: Buffer.from(email),
        userName: email,
        userDisplayName: perfil.nombre || email,
        attestationType: 'none',
        // Excluir credenciales ya registradas para evitar duplicados
        excludeCredentials: existentes.map(function(p){
          return {
            id: p.credentialID,
            type: 'public-key',
            transports: p.transports || []
          };
        }),
        authenticatorSelection: {
          residentKey: 'preferred',       // Synced passkeys (iCloud/Google PM)
          userVerification: 'preferred',  // Pide huella/Face ID si está disponible
          authenticatorAttachment: 'platform' // Sensor del dispositivo, no llaves USB
        },
        supportedAlgorithmIDs: [-7, -257]
      });

      // Guardar challenge en Redis (5 min TTL) para verificarlo después
      await setJSON('passkey:challenge:reg:' + email, options.challenge, 300);

      return res.status(200).json(options);
    }

    if (action === 'register-verify' && req.method === 'POST') {
      var rolRV = await autorizar(req, email);
      if (!rolRV) return res.status(401).json({ error: 'No autorizado' });

      var body = req.body || {};
      var credential = body.credential;
      if (!credential) return res.status(400).json({ error: 'Falta credential' });

      var expectedChallenge = await getJSON('passkey:challenge:reg:' + email);
      if (!expectedChallenge) {
        return res.status(400).json({ error: 'Challenge expirado o no encontrado, intentá de nuevo' });
      }

      var verification;
      try {
        verification = await verifyRegistrationResponse({
          response: credential,
          expectedChallenge: expectedChallenge,
          expectedOrigin: ORIGIN,
          expectedRPID: RP_ID,
          requireUserVerification: false
        });
      } catch (e) {
        console.error('[passkey] register-verify error:', e.message);
        return res.status(400).json({ error: 'Verificación falló: ' + e.message });
      }

      if (!verification.verified || !verification.registrationInfo) {
        return res.status(400).json({ error: 'No verificado' });
      }

      var info = verification.registrationInfo;
      // SimpleWebAuthn v11: estructura es info.credential.{id,publicKey,counter}
      var credInfo = info.credential || info;
      var credentialID = credInfo.id || (credInfo.credentialID ? toBase64Url(credInfo.credentialID) : null);
      var credentialPublicKey = credInfo.publicKey || credInfo.credentialPublicKey;
      var counter = credInfo.counter || 0;

      if (!credentialID || !credentialPublicKey) {
        return res.status(500).json({ error: 'Estructura de credential inesperada' });
      }

      // Guardar la passkey nueva
      var passkeys = await getPasskeys(email);
      passkeys.push({
        credentialID: credentialID,
        credentialPublicKey: toBase64Url(credentialPublicKey),
        counter: counter,
        transports: (credential.response && credential.response.transports) || [],
        creadaEn: new Date().toISOString(),
        ultimoUso: null,
        nombreDispositivo: detectarDispositivo(req.headers['user-agent'] || '')
      });

      // Tope de seguridad
      if (passkeys.length > MAX_PASSKEYS_PER_USER) {
        passkeys = passkeys.slice(-MAX_PASSKEYS_PER_USER);
      }

      await setPasskeys(email, passkeys);
      await delKey('passkey:challenge:reg:' + email);

      return res.status(200).json({ ok: true, total: passkeys.length });
    }

    // ════════════════════════════════════════════════════════════════════════
    // LOGIN con passkey (NO requiere sesión, justamente está logueando)
    // ════════════════════════════════════════════════════════════════════════
    if (action === 'login-options' && req.method === 'POST') {
      var passkeysLogin = await getPasskeys(email);
      if (passkeysLogin.length === 0) {
        return res.status(404).json({ error: 'No hay passkeys registradas para este email' });
      }

      var optsLogin = await generateAuthenticationOptions({
        rpID: RP_ID,
        allowCredentials: passkeysLogin.map(function(p){
          return {
            id: p.credentialID,
            type: 'public-key',
            transports: p.transports || []
          };
        }),
        userVerification: 'preferred'
      });

      // Guardar challenge para la verificación posterior
      await setJSON('passkey:challenge:login:' + email, optsLogin.challenge, 300);

      return res.status(200).json(optsLogin);
    }

    if (action === 'login-verify' && req.method === 'POST') {
      var bodyLV = req.body || {};
      var credLV = bodyLV.credential;
      if (!credLV) return res.status(400).json({ error: 'Falta credential' });

      var expectedChallengeLV = await getJSON('passkey:challenge:login:' + email);
      if (!expectedChallengeLV) {
        return res.status(400).json({ error: 'Challenge expirado, intentá de nuevo' });
      }

      var passkeysLV = await getPasskeys(email);
      var passkeyMatch = null;
      for (var i = 0; i < passkeysLV.length; i++) {
        if (passkeysLV[i].credentialID === credLV.id) {
          passkeyMatch = passkeysLV[i];
          break;
        }
      }
      if (!passkeyMatch) {
        return res.status(400).json({ error: 'Passkey no reconocida' });
      }

      var verLogin;
      try {
        verLogin = await verifyAuthenticationResponse({
          response: credLV,
          expectedChallenge: expectedChallengeLV,
          expectedOrigin: ORIGIN,
          expectedRPID: RP_ID,
          credential: {
            id: passkeyMatch.credentialID,
            publicKey: fromBase64Url(passkeyMatch.credentialPublicKey),
            counter: passkeyMatch.counter || 0,
            transports: passkeyMatch.transports || []
          },
          requireUserVerification: false
        });
      } catch (e) {
        console.error('[passkey] login-verify error:', e.message);
        return res.status(400).json({ error: 'Verificación falló: ' + e.message });
      }

      if (!verLogin.verified) {
        return res.status(400).json({ error: 'No verificado' });
      }

      // Actualizar contador y último uso (anti-replay)
      passkeyMatch.counter = verLogin.authenticationInfo.newCounter;
      passkeyMatch.ultimoUso = new Date().toISOString();
      await setPasskeys(email, passkeysLV);
      await delKey('passkey:challenge:login:' + email);

      // Cargar perfil para devolver datos al frontend
      var perfilLV = await cargarPerfilMudancero(email);
      if (!perfilLV) {
        return res.status(404).json({ error: 'Perfil no encontrado' });
      }

      // Crear sessionToken nuevo (mismo patrón que magic link)
      var sessionToken = generarSessionToken();
      await setJSON('session:mudancero:' + email, sessionToken, SESSION_TTL);

      return res.status(200).json({
        ok: true,
        email: email,
        nombre: perfilLV.nombre || '',
        foto: perfilLV.foto || '',
        sessionToken: sessionToken
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // GESTIÓN de passkeys (requiere sesión)
    // ════════════════════════════════════════════════════════════════════════
    if (action === 'list' && req.method === 'POST') {
      var rolList = await autorizar(req, email);
      if (!rolList) return res.status(401).json({ error: 'No autorizado' });

      var pksList = await getPasskeys(email);
      // No devolver la public key cruda (no es secreta pero no hace falta exponerla)
      var pksSafe = pksList.map(function(p){
        return {
          credentialID: p.credentialID,
          nombreDispositivo: p.nombreDispositivo || 'Dispositivo',
          creadaEn: p.creadaEn,
          ultimoUso: p.ultimoUso
        };
      });
      return res.status(200).json({ ok: true, passkeys: pksSafe });
    }

    if (action === 'delete' && req.method === 'POST') {
      var rolDel = await autorizar(req, email);
      if (!rolDel) return res.status(401).json({ error: 'No autorizado' });

      var bodyDel = req.body || {};
      var pksDel = await getPasskeys(email);

      if (bodyDel.credentialID) {
        // Borrar una específica
        pksDel = pksDel.filter(function(p){ return p.credentialID !== bodyDel.credentialID; });
      } else {
        // Borrar todas
        pksDel = [];
      }

      await setPasskeys(email, pksDel);
      return res.status(200).json({ ok: true, restantes: pksDel.length });
    }

    if (action === 'logout-all' && req.method === 'POST') {
      var rolLA = await autorizar(req, email);
      if (!rolLA) return res.status(401).json({ error: 'No autorizado' });

      // Borrar sessionToken de magic link Y todas las passkeys
      await delKey('session:mudancero:' + email);
      await delKey('passkey:' + email);

      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'action inválida' });

  } catch (err) {
    console.error('[passkey] error general:', err && err.message, err && err.stack);
    return res.status(500).json({ error: 'Error interno: ' + (err && err.message) });
  }
};

// ── Detectar dispositivo desde User-Agent (best effort, solo para mostrar) ────
function detectarDispositivo(ua) {
  if (!ua) return 'Dispositivo';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua) && /Mobile/.test(ua)) return 'Celular Android';
  if (/Android/.test(ua)) return 'Tablet Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Dispositivo';
}
