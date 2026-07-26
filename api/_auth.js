// api/_auth.js
//
// Autenticación de admin compartida por todos los endpoints.
// Vercel ignora los archivos de /api que empiezan con "_": no se deploya como función.
//
// DOS FORMAS VÁLIDAS DE AUTENTICARSE
//   1. Master token   → process.env.ADMIN_TOKEN. Para curl, scripts y cron.
//   2. Token de sesión → lo emite /api/admin-sesion después del login con Google.
//
// El token de sesión va firmado con HMAC-SHA256 usando ADMIN_TOKEN como secreto.
// Eso lo hace verificable de forma SINCRÓNICA y sin pegarle a Redis, así que
// esAdmin(req) mantiene la misma firma que los chequeos que reemplaza y no
// obliga a tocar ningún call site.
//
// Formato del token de sesión:  {payloadB64url}.{firmaB64url}
//   payload = { email, exp }   con exp en milisegundos epoch
//
// IMPORTANTE: si ADMIN_TOKEN no está seteado en el entorno, esAdmin() devuelve
// false siempre (fail closed). No hay valor por defecto a propósito.

var crypto = require('crypto');

var TTL_SESION_MS = 12 * 60 * 60 * 1000; // 12 horas

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function deB64url(str) {
  var s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function firmar(payloadB64) {
  var secreto = process.env.ADMIN_TOKEN;
  if (!secreto) throw new Error('ADMIN_TOKEN no configurado');
  return b64url(crypto.createHmac('sha256', secreto).update(payloadB64).digest());
}

// Comparación en tiempo constante que no explota si los largos difieren.
function igualSeguro(a, b) {
  try {
    var ba = Buffer.from(String(a));
    var bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch (e) {
    return false;
  }
}

// Emite un token de sesión para un email ya validado contra Google + ADMIN_EMAILS.
function emitirToken(email) {
  var payload = JSON.stringify({
    email: String(email).toLowerCase().trim(),
    exp: Date.now() + TTL_SESION_MS
  });
  var p = b64url(payload);
  return p + '.' + firmar(p);
}

// Devuelve el payload si el token es válido y no venció, o null.
function verificarToken(token) {
  try {
    if (!token || typeof token !== 'string') return null;
    var partes = token.split('.');
    if (partes.length !== 2) return null;
    if (!igualSeguro(partes[1], firmar(partes[0]))) return null;
    var datos = JSON.parse(deB64url(partes[0]));
    if (!datos || !datos.exp || Date.now() > Number(datos.exp)) return null;
    return datos;
  } catch (e) {
    return null;
  }
}

// Busca el token en header, query o body — cubre los tres estilos que ya
// usaban los endpoints antes de unificarse.
function tokenDeRequest(req) {
  if (!req) return '';
  var h = req.headers || {};
  return h['x-admin-token'] ||
         (req.query && req.query.token) ||
         (req.body && (req.body.adminToken || req.body.token)) ||
         '';
}

// Sincrónica a propósito. true si el request trae master token o sesión válida.
function esAdmin(req) {
  var token = String(tokenDeRequest(req) || '');
  if (!token) return false;
  var master = process.env.ADMIN_TOKEN;
  if (!master) {
    console.error('[auth] ADMIN_TOKEN no configurado — se rechaza todo acceso admin');
    return false;
  }
  if (igualSeguro(token, master)) return true;
  return !!verificarToken(token);
}

// Devuelve el email del admin logueado, o null si vino con master token.
function emailAdmin(req) {
  var datos = verificarToken(String(tokenDeRequest(req) || ''));
  return datos ? datos.email : null;
}

module.exports = {
  esAdmin: esAdmin,
  emailAdmin: emailAdmin,
  emitirToken: emitirToken,
  verificarToken: verificarToken,
  TTL_SESION_MS: TTL_SESION_MS
};
