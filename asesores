// api/admin.js
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
async function getJSON(key) {
  const val = await redisCall('GET', key);
  if (!val) return null;
  return JSON.parse(val);
}
async function setJSON(key, value, exSeconds) {
  const str = JSON.stringify(value);
  if (exSeconds) await redisCall('SET', key, str, 'EX', String(exSeconds));
  else await redisCall('SET', key, str);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Verificar admin password básico
  const adminPass = process.env.ADMIN_PASSWORD || 'mudateya2024';
  const authHeader = req.headers['x-admin-key'] || req.query.key;
  if (authHeader !== adminPass && process.env.NODE_ENV === 'production') {
    // En desarrollo no bloquear para facilitar testing
    if (process.env.VERCEL_ENV === 'production') {
      return res.status(401).json({ error: 'No autorizado' });
    }
  }

  const { type } = req.query;

  try {
    // ── GET mudanceros ────────────────────────────────
    if (req.method === 'GET' && type === 'mudanceros') {
      const sheetsUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
      // Intentar leer del Google Sheet si está configurado
      if (sheetsUrl) {
        try {
          const sheetRead = sheetsUrl.replace('/exec', '/exec?action=read&sheet=Mudanceros');
          const r = await fetch(sheetRead);
          const d = await r.json();
          if (d.rows) return res.status(200).json({ rows: d.rows });
        } catch(e) {
          console.warn('Sheet read failed, falling back to Redis:', e.message);
        }
      }
      // Fallback: construir desde Redis
      const mudanceroKeys = await redisCall('KEYS', 'mudancero:*').catch(() => []);
      const rows = [];
      if (Array.isArray(mudanceroKeys)) {
        for (const key of mudanceroKeys.slice(0, 100)) {
          const email = key.replace('mudancero:', '');
          const ids = await getJSON(key) || [];
          rows.push([
            '',           // A: timestamp
            email,        // B: nombre (usamos email como fallback)
            '',           // C: zona
            '',           // D: tel
            email,        // E: email
            '',           // F-T: campos vacíos
            '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
            'Aprobado',   // U: estado
          ]);
        }
      }
      return res.status(200).json({ rows });
    }

    // ── GET pagos (mudanzas completadas) ─────────────
    if (req.method === 'GET' && type === 'pagos') {
      const ids = await getJSON('mudanzas:activas') || [];
      const allKeys = await redisCall('KEYS', 'mudanza:*').catch(() => []);
      const rows = [];
      const claves = Array.isArray(allKeys) ? allKeys : [];
      for (const key of claves.slice(0, 200)) {
        const m = await getJSON(key.replace('mudanza:', '')).catch(() => null);
        if (!m) continue;
        const cot = m.cotizacionAceptada || {};
        if (!cot.precio) continue;
        const esFlete = m.tipo === 'flete' || m.ambientes === 'Flete';
        const feePct = esFlete ? 0.20 : 0.15;
        const fee = Math.round(cot.precio * feePct);
        rows.push({
          id:            m.id,
          fecha:         m.fechaPublicacion || '',
          fechaCompletada: m.fechaCompletada || '',
          tipo:          (m.tipo || 'mudanza').toUpperCase(),
          desde:         m.desde,
          hasta:         m.hasta,
          cliente:       m.clienteNombre || m.clienteEmail || '—',
          mudancero:     cot.mudanceroNombre || '—',
          precio:        cot.precio,
          fee:           fee,
          neto:          cot.precio - fee,
          estado:        m.estado,
          anticipoPagado: m.anticipoPagado || false,
          saldoPagado:   m.saldoPagado || false,
        });
      }
      // Ordenar por fecha desc
      rows.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
      return res.status(200).json({ rows });
    }

    // ── POST cambiar estado mudancero ─────────────────
    if (req.method === 'POST') {
      const { tipo, email, nuevoEstado, rowIndex } = req.body;
      if (tipo === 'cambiar-estado-mudancero') {
        // Actualizar en Google Sheets si está configurado
        const sheetsUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
        if (sheetsUrl) {
          await fetch(sheetsUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'update-estado', email, estado: nuevoEstado, rowIndex }),
          }).catch(e => console.warn('Sheet update failed:', e.message));
        }
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: 'Tipo de acción no reconocido' });
    }

    return res.status(400).json({ error: 'Parámetros inválidos' });

  } catch(e) {
    console.error('Admin API error:', e.message);
    return res.status(500).json({ error: e.message, rows: [] });
  }
};
