// api/casos.js — Gestión de casos de MudateYa Mobility
// Guarda cada caso en Redis y sirve al tablero (casos.html) y a la ficha (caso.html).
// Acceso por token de admin compartido entre los socios (login multiusuario: más adelante).
//
// GET                      -> lista de casos (resumen, sin docsHtml)
// GET ?id=...              -> un caso completo
// POST {action:'crear', ...}        -> crea un caso
// POST {action:'actualizar', id, ...} -> actualiza campos / docsHtml / estado / avance
// POST {action:'archivar', id}      -> marca archivado

// ════════════════ REDIS (igual que cotizaciones.js / servicios.js)
async function redisCall(method, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  const response = await fetch(`${url}/${[method, ...args].map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}
async function getJSON(key) { const v = await redisCall('GET', key); return v ? JSON.parse(v) : null; }
async function setJSON(key, value) { await redisCall('SET', key, JSON.stringify(value)); }

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'mya-admin-2026';

// campos centrales de un caso (los que prellenan los documentos)
const CAMPOS = ['empresa', 'tipoOrg', 'contacto', 'nombre', 'cargo', 'origen', 'destino', 'fechaLlegada', 'duracion', 'coordinador'];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers['x-admin-token'] || (req.body && req.body.token) || (req.query && req.query.token);
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });

  try {
    // ── GET ──
    if (req.method === 'GET') {
      if (req.query && req.query.id) {
        const caso = await getJSON(`caso:${req.query.id}`);
        if (!caso) return res.status(404).json({ error: 'Caso no encontrado' });
        return res.status(200).json({ caso });
      }
      const idx = await getJSON('casos:index') || [];
      const casos = [];
      for (let i = 0; i < idx.length; i++) {
        try {
          const c = await getJSON(`caso:${idx[i]}`);
          if (c && c.estado !== 'archivado') {
            const { docsHtml, ...resumen } = c; // no mandamos el HTML pesado en la lista
            casos.push(resumen);
          }
        } catch (e) {}
      }
      return res.status(200).json({ casos });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
    const action = (req.body && req.body.action) || 'crear';

    // ── CREAR ──
    if (action === 'crear') {
      const id = 'caso-' + Date.now().toString(36);
      const idx = await getJSON('casos:index') || [];
      const seq = String(idx.length + 1).padStart(3, '0');
      const caso = {
        id,
        numeroCaso: 'MYA-MOB-' + new Date().getFullYear() + '-' + seq,
        estado: 'nuevo',
        avance: 0,
        docsHtml: '',
        creado: new Date().toISOString(),
        actualizado: new Date().toISOString(),
      };
      for (let i = 0; i < CAMPOS.length; i++) { caso[CAMPOS[i]] = (req.body[CAMPOS[i]] || ''); }
      await setJSON(`caso:${id}`, caso);
      idx.unshift(id);
      await setJSON('casos:index', idx);
      return res.status(200).json({ caso });
    }

    // ── ACTUALIZAR ──
    if (action === 'actualizar') {
      const { id } = req.body;
      const caso = await getJSON(`caso:${id}`);
      if (!caso) return res.status(404).json({ error: 'Caso no encontrado' });
      // campos centrales
      for (let i = 0; i < CAMPOS.length; i++) { if (req.body[CAMPOS[i]] !== undefined) caso[CAMPOS[i]] = req.body[CAMPOS[i]]; }
      // estado / avance / documentos
      if (req.body.estado !== undefined) caso.estado = req.body.estado;
      if (req.body.avance !== undefined) caso.avance = Number(req.body.avance) || 0;
      if (req.body.docsHtml !== undefined) caso.docsHtml = req.body.docsHtml;
      caso.actualizado = new Date().toISOString();
      await setJSON(`caso:${id}`, caso);
      return res.status(200).json({ ok: true });
    }

    // ── ARCHIVAR ──
    if (action === 'archivar') {
      const { id } = req.body;
      const caso = await getJSON(`caso:${id}`);
      if (!caso) return res.status(404).json({ error: 'Caso no encontrado' });
      caso.estado = 'archivado';
      caso.actualizado = new Date().toISOString();
      await setJSON(`caso:${id}`, caso);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Acción desconocida' });

  } catch (error) {
    console.error('Error en casos:', error);
    return res.status(500).json({ error: 'Error en el servidor', detalle: error.message });
  }
};
