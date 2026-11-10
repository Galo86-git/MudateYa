// api/dni.js
//
// Subida y lectura de las fotos de DNI de los mudanceros, en store PRIVADO.
//
//   POST /api/dni?email=...&lado=frente|dorso   (body = la imagen cruda)
//        Auth: sesión del propio mudancero (x-session-token) o admin.
//        Devuelve { ok, pathname }. El pathname es lo que se guarda en el perfil.
//
//   GET  /api/dni?pathname=dni/...&email=...
//        Auth: admin (x-admin-token), o el propio mudancero si ese pathname es
//        de su perfil. Devuelve la imagen. Nunca cacheable ni indexable.
//
// Sin CORS a propósito: lo llaman solo nuestras páginas, mismo origen.

const { esAdmin } = require('./_auth');
const { esMudanceroDe } = require('./_sesion');
const dniPriv = require('./_dni-privado');

async function redisGetJSON(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(url + '/GET/' + encodeURIComponent(key), { headers: { Authorization: 'Bearer ' + token } });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch (e) { return null; }
}

function leerCuerpo(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let total = 0;
    let grande = false;
    req.on('data', function (c) {
      total += c.length;
      if (total > dniPriv.MAX_BYTES) { grande = true; return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(grande ? null : Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

// ¿El mudancero con esa sesión es dueño de ese pathname? Se compara contra lo
// guardado en su perfil, no contra lo que diga el request.
async function esDuenoDelArchivo(req, email, pathname) {
  if (!email || !(await esMudanceroDe(req, email))) return false;
  if (!dniPriv.perteneceA(pathname, email)) return false;
  const perfil = (await redisGetJSON('mudancero:perfil:' + email)) ||
                 (await redisGetJSON('mudancero:perfil:' + String(email).trim().toLowerCase()));
  if (!perfil) return false;
  return perfil.dniFrente === pathname || perfil.dniDorso === pathname;
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'POST') {
    const email = String((req.query && req.query.email) || '').trim();
    const lado = (req.query && req.query.lado) === 'dorso' ? 'dorso' : 'frente';
    if (!email) return res.status(400).json({ error: 'Falta email' });
    const autorizado = esAdmin(req) || (await esMudanceroDe(req, email));
    if (!autorizado) return res.status(401).json({ error: 'No autorizado' });
    try {
      const buf = await leerCuerpo(req);
      if (buf === null) return res.status(413).json({ error: 'Archivo demasiado grande (máximo 8MB).' });
      if (!buf.length) return res.status(400).json({ error: 'Archivo vacío' });
      const pathname = await dniPriv.subirDni(buf, email, lado);
      return res.status(200).json({ ok: true, pathname: pathname });
    } catch (e) {
      console.error('dni subir:', e.message);
      const usuario = /imagen válida|demasiado grande/.test(e.message);
      return res.status(usuario ? 400 : 500).json({ error: usuario ? e.message : 'No se pudo guardar el archivo' });
    }
  }

  if (req.method === 'GET') {
    const pathname = String((req.query && req.query.pathname) || '');
    const email = String((req.query && req.query.email) || '').trim();
    if (!dniPriv.esPathnameDni(pathname)) return res.status(400).json({ error: 'pathname inválido' });
    const ok = esAdmin(req) || (await esDuenoDelArchivo(req, email, pathname));
    if (!ok) return res.status(401).json({ error: 'No autorizado' });
    try {
      const f = await dniPriv.leerDni(pathname);
      res.setHeader('Content-Type', f.contentType);
      return res.status(200).send(f.buffer);
    } catch (e) {
      console.error('dni leer:', e.message);
      return res.status(404).json({ error: 'No encontrada' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Método no permitido' });
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
