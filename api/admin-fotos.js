// api/admin-fotos.js
// GET  → lista mudanceros con fotos actuales
// POST → actualiza foto y/o fotoCamion en Redis

var ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'mya-admin-2026';

async function redis(method) {
  var args  = Array.prototype.slice.call(arguments, 1);
  var url   = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  var r = await fetch(
    url + '/' + [method].concat(args).map(encodeURIComponent).join('/'),
    { headers: { Authorization: 'Bearer ' + token } }
  );
  var d = await r.json();
  return d.result;
}

async function getJSON(key) {
  var v = await redis('get', key);
  return v ? JSON.parse(v) : null;
}

async function setJSON(key, val) {
  await redis('set', key, JSON.stringify(val));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  var token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });

  // GET — listar todos los mudanceros con sus fotos actuales
  if (req.method === 'GET') {
    try {
      var todos = await getJSON('mudanceros:todos') || [];
      var lista = [];
      for (var i = 0; i < todos.length; i++) {
        var p = await getJSON('mudancero:perfil:' + todos[i]);
        if (p) lista.push({
          email:      p.email,
          nombre:     p.nombre,
          foto:       p.foto       || '',
          fotoCamion: p.fotoCamion || '',
          estado:     p.estado     || '',
        });
      }
      return res.status(200).json({ mudanceros: lista });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST — actualizar foto y/o fotoCamion
  if (req.method === 'POST') {
    try {
      var body = req.body;
      if (!body.email) return res.status(400).json({ error: 'Falta email' });

      var perfil = await getJSON('mudancero:perfil:' + body.email);
      if (!perfil) return res.status(404).json({ error: 'Mudancero no encontrado' });

      if (body.foto)       perfil.foto       = body.foto;
      if (body.fotoCamion) perfil.fotoCamion = body.fotoCamion;

      await setJSON('mudancero:perfil:' + body.email, perfil);
      return res.status(200).json({ ok: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Método no permitido' });
};
