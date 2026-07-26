// api/admin-sesion.js
//
// POST { googleIdToken } → { ok, token, expiraEn, email }
//
// Único emisor de tokens de admin. Verifica el id_token de Google del lado del
// servidor (aud + email_verified + vencimiento), chequea que el email esté en
// ADMIN_EMAILS y recién ahí emite un token firmado con TTL de 12hs.
//
// Antes de esto, admin.html llevaba el token hardcodeado en el HTML: cualquiera
// que abriera /admin y mirara el fuente lo tenía. Ahora el HTML no contiene
// ningún secreto — el token se obtiene en runtime y sólo si Google confirma
// quién sos.

var auth = require('./_auth');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  if (!process.env.ADMIN_TOKEN) {
    console.error('[admin-sesion] falta ADMIN_TOKEN en el entorno');
    return res.status(500).json({ error: 'Servidor sin configurar' });
  }
  if (!process.env.GOOGLE_CLIENT_ID) {
    console.error('[admin-sesion] falta GOOGLE_CLIENT_ID en el entorno');
    return res.status(500).json({ error: 'Servidor sin configurar' });
  }

  var body = req.body || {};
  var idToken = body.googleIdToken;
  if (!idToken) return res.status(400).json({ error: 'Falta googleIdToken' });

  // ── Verificación server-side contra Google ────────────────────────
  var datos;
  try {
    var r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
    datos = await r.json();
  } catch (e) {
    console.error('[admin-sesion] error consultando a Google:', e);
    return res.status(502).json({ error: 'No se pudo validar con Google' });
  }

  if (!datos || datos.error || datos.error_description || !datos.email) {
    return res.status(401).json({ error: 'Token inválido' });
  }
  if (datos.aud !== process.env.GOOGLE_CLIENT_ID) {
    return res.status(401).json({ error: 'Token inválido' });
  }
  if (datos.email_verified !== 'true' && datos.email_verified !== true) {
    return res.status(401).json({ error: 'Email no verificado por Google' });
  }
  if (datos.exp && (Date.now() / 1000) > Number(datos.exp)) {
    return res.status(401).json({ error: 'Token vencido' });
  }

  // ── Allowlist ─────────────────────────────────────────────────────
  var email = String(datos.email).toLowerCase().trim();
  var permitidos = (process.env.ADMIN_EMAILS || '')
    .split(',').map(function (e) { return e.trim().toLowerCase(); })
    .filter(Boolean);

  if (permitidos.length === 0) {
    console.error('[admin-sesion] ADMIN_EMAILS vacío — se rechaza por seguridad');
    return res.status(500).json({ error: 'Servidor sin configurar' });
  }
  if (permitidos.indexOf(email) === -1) {
    console.warn('[admin-sesion] acceso denegado a ' + email);
    return res.status(403).json({ error: 'Tu email no tiene acceso al panel' });
  }

  return res.status(200).json({
    ok: true,
    token: auth.emitirToken(email),
    expiraEn: auth.TTL_SESION_MS,
    email: email
  });
};
