// api/chat.js
// Sistema de mensajes entre cliente y mudancero via Redis

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

async function setJSON(key, value, ex) {
  const str = JSON.stringify(value);
  if (ex) await redisCall('SET', key, str, 'EX', String(ex));
  else await redisCall('SET', key, str);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, mudanzaId, email } = req.query;

  try {
    // ── ENVIAR MENSAJE ──────────────────────────────────────────────────────
    if (action === 'enviar' && req.method === 'POST') {
      const { mudanzaId, fromEmail, fromNombre, fromRol, texto } = req.body;
      if (!mudanzaId || !fromEmail || !texto) {
        return res.status(400).json({ error: 'Faltan datos' });
      }

      const key = `chat:${mudanzaId}`;
      const mensajes = await getJSON(key) || [];

      const msg = {
        id: Date.now(),
        fromEmail,
        fromNombre,
        fromRol, // 'cliente' | 'mudancero'
        texto,
        fecha: new Date().toISOString(),
      };

      mensajes.push(msg);
      await setJSON(key, mensajes, 2592000); // 30 días

      return res.status(200).json({ ok: true, msg });
    }

    // ── LEER MENSAJES ───────────────────────────────────────────────────────
    if (action === 'leer' && req.method === 'GET') {
      if (!mudanzaId) return res.status(400).json({ error: 'Falta mudanzaId' });
      const key = `chat:${mudanzaId}`;
      const mensajes = await getJSON(key) || [];
      return res.status(200).json({ mensajes, total: mensajes.length });
    }

    // ── MIS CONVERSACIONES ──────────────────────────────────────────────────
    if (action === 'conversaciones' && req.method === 'GET') {
      if (!email) return res.status(400).json({ error: 'Falta email' });

      // Buscar mudanzas del cliente
      const clienteIds = await getJSON(`cliente:${email}`) || [];
      // Buscar mudanzas del mudancero
      const mudanceroIds = await getJSON(`mudancero:${email}`) || [];

      const allIds = [...new Set([...clienteIds, ...mudanceroIds])];
      const conversaciones = [];

      for (const id of allIds) {
        const mensajes = await getJSON(`chat:${id}`) || [];
        if (mensajes.length > 0) {
          const mudanza = await getJSON(`mudanza:${id}`);
          conversaciones.push({
            mudanzaId: id,
            desde: mudanza?.desde || '—',
            hasta: mudanza?.hasta || '—',
            ultimoMensaje: mensajes[mensajes.length - 1],
            totalMensajes: mensajes.length,
          });
        }
      }

      return res.status(200).json({ conversaciones });
    }

    return res.status(400).json({ error: 'Acción no reconocida' });
  } catch (e) {
    console.error('Error en chat:', e.message);
    return res.status(200).json({ mensajes: [], error: e.message });
  }
};
