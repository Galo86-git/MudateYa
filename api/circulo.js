// api/circulo.js
// Catálogo de El Círculo: guardar pieza, listar drop, cambiar estado, eliminar.
// Redis vía REST (mismo patrón que el resto de la app).

// ── REDIS ────────────────────────────────────────────────────────
async function redisCall(method) {
  var extra = Array.prototype.slice.call(arguments, 1);
  var url = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  var partes = [method].concat(extra).map(encodeURIComponent).join('/');
  var response = await fetch(url + '/' + partes, { headers: { Authorization: 'Bearer ' + token } });
  var data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}
async function getJSON(key) {
  var val = await redisCall('GET', key);
  if (!val) return null;
  return JSON.parse(val);
}
async function setJSON(key, value) {
  await redisCall('SET', key, JSON.stringify(value));
}

// ── HELPERS ──────────────────────────────────────────────────────
function bandaDeUSD(usd) {
  usd = Number(usd) || 0;
  if (usd < 500) return 'Hasta 500';
  if (usd < 1000) return '500–1.000';
  return 'Firma';
}

function dropActual() {
  var d = new Date();
  var t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  var day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  var yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  var week = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
  return t.getUTCFullYear() + '-W' + (week < 10 ? '0' + week : week);
}

var ESTADOS = ['disponible', 'reservado', 'vendido'];

// ── HANDLER ──────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  var action = req.query.action;

  try {
    // ── GUARDAR PIEZA ──────────────────────────────────────────
    if (action === 'guardar-pieza' && req.method === 'POST') {
      var p = req.body || {};
      if (!p.nombre || !p.categoria) return res.status(400).json({ error: 'Faltan nombre o categoría' });

      var id = 'p' + Date.now().toString(36) + Math.random().toString(16).slice(2, 5);
      var drop = p.drop || dropActual();
      var pieza = {
        id: id,
        nombre: p.nombre,
        categoria: p.categoria,
        condicion: p.condicion || '',
        material: p.material || '',
        descripcion: p.descripcion || '',
        precioUSD: Number(p.precioUSD) || 0,
        banda: bandaDeUSD(p.precioUSD),
        fotos: Array.isArray(p.fotos) ? p.fotos : [],
        estado: 'disponible',
        drop: drop,
        creado: Date.now()
      };

      await setJSON('circulo:pieza:' + id, pieza);
      await redisCall('SADD', 'circulo:drop:' + drop, id);
      return res.status(200).json({ ok: true, pieza: pieza });
    }

    // ── LISTAR CATÁLOGO (drop) ─────────────────────────────────
    if (action === 'catalogo' && req.method === 'GET') {
      var dropQ = req.query.drop || dropActual();
      var ids = await redisCall('SMEMBERS', 'circulo:drop:' + dropQ) || [];
      var piezas = [];
      var i;
      for (i = 0; i < ids.length; i++) {
        var pz = await getJSON('circulo:pieza:' + ids[i]);
        if (pz) piezas.push(pz);
      }
      piezas.sort(function (a, b) { return a.creado - b.creado; });
      return res.status(200).json({ drop: dropQ, piezas: piezas });
    }

    // ── CAMBIAR ESTADO ─────────────────────────────────────────
    if (action === 'cambiar-estado' && req.method === 'POST') {
      var body = req.body || {};
      if (!body.id || ESTADOS.indexOf(body.estado) === -1) {
        return res.status(400).json({ error: 'Datos inválidos' });
      }
      var pieza2 = await getJSON('circulo:pieza:' + body.id);
      if (!pieza2) return res.status(404).json({ error: 'Pieza no encontrada' });
      pieza2.estado = body.estado;
      await setJSON('circulo:pieza:' + body.id, pieza2);
      return res.status(200).json({ ok: true, pieza: pieza2 });
    }

    // ── ELIMINAR (para pruebas) ────────────────────────────────
    if (action === 'eliminar' && req.method === 'POST') {
      var body2 = req.body || {};
      if (!body2.id) return res.status(400).json({ error: 'Falta id' });
      var pieza3 = await getJSON('circulo:pieza:' + body2.id);
      if (pieza3) await redisCall('SREM', 'circulo:drop:' + pieza3.drop, body2.id);
      await redisCall('DEL', 'circulo:pieza:' + body2.id);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Acción no reconocida' });
  } catch (e) {
    console.error('circulo:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
