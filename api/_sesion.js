// api/_sesion.js
// Verificación de sesión de mudancero/cliente para los endpoints que hoy
// confiaban solo en el email (IDOR). El token de sesión (opaco, aleatorio) lo
// emiten cotizaciones.js (magic link / Google) y passkey.js, y queda en Redis
// bajo `session:{prefix}:{email}` con TTL. Acá lo verificamos server-side.
//
// Vercel ignora los archivos de /api que empiezan con "_" (no se deploya como fn).
//
// Uso:
//   const { esMudanceroDe } = require('./_sesion');
//   if (!(await esMudanceroDe(req, email))) return res.status(401)...
//
// El token se busca en el header `x-session-token`, o en query/body `sessionToken`.

const crypto = require('crypto');

async function redisGet(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/GET/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const d = await r.json();
    return d.result || null;
  } catch (e) { return null; }
}

// El token queda guardado con setJSON (JSON.stringify de un string) → al leerlo
// con GET viene como `"abc..."`; lo desenvolvemos para comparar el valor crudo.
function desenvolver(v) {
  if (v == null) return null;
  try { const p = JSON.parse(v); return typeof p === 'string' ? p : v; }
  catch (e) { return v; }
}

// Comparación en tiempo constante (no filtra por longitud ni por contenido).
function igualSeguro(a, b) {
  try {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch (e) { return false; }
}

function tokenDeReq(req) {
  if (!req) return '';
  const h = req.headers || {};
  return h['x-session-token'] ||
    (req.query && req.query.sessionToken) ||
    (req.body && req.body.sessionToken) || '';
}

// true si el request trae un token de sesión válido para ese email+rol.
// Prueba el email tal cual y su versión normalizada (minúsculas), porque
// según el flujo de login la sesión pudo guardarse con uno u otro.
async function sesionValida(prefix, email, req) {
  const token = String(tokenDeReq(req) || '');
  if (!token || !email) return false;
  const candidatos = [String(email)];
  const norm = String(email).trim().toLowerCase();
  if (norm !== String(email)) candidatos.push(norm);
  for (const e of candidatos) {
    const guardado = desenvolver(await redisGet(`session:${prefix}:${e}`));
    if (guardado && igualSeguro(guardado, token)) return true;
  }
  return false;
}

async function esMudanceroDe(req, email) { return sesionValida('mudancero', email, req); }
async function esClienteDe(req, email) { return sesionValida('cliente', email, req); }

module.exports = { esMudanceroDe, esClienteDe, sesionValida, tokenDeReq };
