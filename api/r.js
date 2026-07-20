// api/r.js
//
// REDIRECTOR DE QR — la URL del QR nunca cambia, el destino sí.
//
// El QR impreso apunta a mudateya.ar/r/{slug}. Este endpoint mira en Redis a
// dónde tiene que mandar hoy ese slug y redirige. Cambiás el destino desde el
// admin y el mismo cartón impreso pasa de una campaña a otra sin reimprimir.
//
//   QR  →  /r/asesores  →  (hoy)     /mudafy-registro.html?origen=planetario-2026
//                       →  (mañana)  /asesor-registro.html?origen=colegio-martilleros
//
// IMPORTANTE: la redirección es 302 (temporal), NUNCA 301. Un 301 lo cachea el
// navegador de por vida y el QR queda pegado al primer destino para siempre.
//
// RUTEO: agregar en vercel.json, ANTES del catch-all:
//   { "src": "/r/(.*)", "dest": "/api/r?slug=$1" }
//
// REDIS:
//   redir:{slug}        → { slug, destino, nombre, activo, createdAt, updatedAt }
//   redir:slugs         → array de slugs (índice)
//   redir:hits:{slug}   → contador total de escaneos (INCR)
//
// ACTIONS:
//   GET  /api/r?slug=X                       → redirige 302 (público)
//   GET  ?action=admin-listar&token=…        → lista con contador de escaneos
//   POST ?action=admin-set&token=…           → crea o actualiza { slug, destino, nombre, activo }
//   POST ?action=admin-eliminar&token=…      → borra un slug

// ── Fallback cuando el slug no existe o está apagado ──
var DESTINO_FALLBACK = 'https://mudateya.ar/';

// ── Wrappers Redis (mismo patrón que mudafy.js / independientes.js) ──
async function redisCall(method, args) {
  var url   = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  var r = await fetch(url + '/' + method + '/' + args.map(encodeURIComponent).join('/'), {
    headers: { Authorization: 'Bearer ' + token }
  });
  var data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function getJSON(key) {
  var v = await redisCall('get', [key]);
  if (!v) return null;
  try { return JSON.parse(v); } catch(e) { return null; }
}

async function setJSON(key, value) {
  return redisCall('set', [key, JSON.stringify(value)]);
}

// ── Validación de admin ──
function esAdmin(req) {
  var token = (req.query && req.query.token) || req.headers['x-admin-token'] || '';
  return token === process.env.ADMIN_TOKEN || token === 'mya-admin-2026';
}

// ── Normalizar slug: minúsculas, sin acentos, solo a-z 0-9 y guión ──
function normSlug(txt) {
  return (txt || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// ── Validar destino: solo http(s), para no habilitar redirects raros ──
function destinoValido(url) {
  if (!url || url.length > 500) return false;
  return /^https?:\/\/[^\s]+$/i.test(url);
}

// ── Índice ──
async function agregarAlIndice(slug) {
  var lista = (await getJSON('redir:slugs')) || [];
  if (lista.indexOf(slug) === -1) {
    lista.push(slug);
    await setJSON('redir:slugs', lista);
  }
}

module.exports = async function handler(req, res) {
  var action = (req.query && req.query.action) || '';

  try {
    // ══════════════════════════════════════════════════════════════
    // ADMIN
    // ══════════════════════════════════════════════════════════════

    // ── Listar todos los redirects con su contador de escaneos ──
    if (action === 'admin-listar' && req.method === 'GET') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      var slugs = (await getJSON('redir:slugs')) || [];
      var lista = [];
      for (var i = 0; i < slugs.length; i++) {
        var cfg = await getJSON('redir:' + slugs[i]);
        if (!cfg) continue;
        var hits = await redisCall('get', ['redir:hits:' + slugs[i]]);
        cfg.escaneos = parseInt(hits) || 0;
        lista.push(cfg);
      }
      lista.sort(function(a, b) { return (b.escaneos || 0) - (a.escaneos || 0); });
      return res.status(200).json({ ok: true, redirects: lista });
    }

    // ── Crear o actualizar un redirect ──
    if (action === 'admin-set' && req.method === 'POST') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      var body    = req.body || {};
      var slug    = normSlug(body.slug);
      var destino = String(body.destino || '').trim();
      var nombre  = String(body.nombre || '').trim().slice(0, 80);

      if (!slug)                    return res.status(400).json({ error: 'Slug inválido.' });
      if (!destinoValido(destino))  return res.status(400).json({ error: 'El destino tiene que ser una URL http/https completa.' });

      var previo = await getJSON('redir:' + slug);
      var cfg = {
        slug:      slug,
        destino:   destino,
        nombre:    nombre || (previo && previo.nombre) || slug,
        activo:    body.activo === false ? false : true,
        createdAt: (previo && previo.createdAt) || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await setJSON('redir:' + slug, cfg);
      await agregarAlIndice(slug);

      return res.status(200).json({
        ok: true,
        redirect: cfg,
        url: 'https://mudateya.ar/r/' + slug
      });
    }

    // ── Eliminar un redirect ──
    if (action === 'admin-eliminar' && req.method === 'POST') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      var slugDel = normSlug((req.body || {}).slug);
      if (!slugDel) return res.status(400).json({ error: 'Falta el slug.' });
      await redisCall('del', ['redir:' + slugDel]);
      await redisCall('del', ['redir:hits:' + slugDel]);
      var idx = (await getJSON('redir:slugs')) || [];
      await setJSON('redir:slugs', idx.filter(function(s){ return s !== slugDel; }));
      return res.status(200).json({ ok: true });
    }

    // ══════════════════════════════════════════════════════════════
    // PÚBLICO — el escaneo del QR entra por acá
    // ══════════════════════════════════════════════════════════════
    var slugIn = normSlug(req.query && req.query.slug);
    if (!slugIn) {
      res.setHeader('Location', DESTINO_FALLBACK);
      return res.status(302).end();
    }

    var cfgIn = await getJSON('redir:' + slugIn);
    var destinoFinal = (cfgIn && cfgIn.activo !== false && cfgIn.destino)
      ? cfgIn.destino
      : DESTINO_FALLBACK;

    // Contar el escaneo. Si falla, redirigimos igual: la métrica nunca puede
    // romper el flujo de alguien parado frente a un cartel con el celular.
    try { await redisCall('incr', ['redir:hits:' + slugIn]); }
    catch(e) { console.warn('No se pudo contar el escaneo:', e.message); }

    // 302 + no-store: el navegador vuelve a preguntar cada vez, así el cambio
    // de destino tiene efecto inmediato en todos los QR ya impresos.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Location', destinoFinal);
    return res.status(302).end();

  } catch (e) {
    console.error('Error en /api/r:', e.message);
    // Ante cualquier error, mandamos al home en vez de mostrar una pantalla de error.
    res.setHeader('Location', DESTINO_FALLBACK);
    return res.status(302).end();
  }
};
