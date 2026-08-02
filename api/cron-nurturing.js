// api/cron-nurturing.js — Recuperación de leads (clientes tibios).
// Cliente que YA recibió presupuestos pero todavía no eligió mudancero: lo
// empujamos a decidir ("tenés N presupuestos esperando, desde $X"). Se manda UNA
// vez por pedido mientras siga activo/vigente; la cadencia del cron da el delay
// natural (el que elige rápido no entra; el que se quedó pensando, sí).
// Solo toca al cliente. Seguro en testing. Corre por cron (ver vercel.json).

async function redisCall(method, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/${[method, ...args].map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d = await r.json();
  return d.result;
}
async function getJSON(k) { const v = await redisCall('GET', k); return v ? JSON.parse(v) : null; }
async function setJSON(k, v, ex) {
  const a = ['SET', k, JSON.stringify(v)];
  if (ex) a.push('EX', String(ex));
  return redisCall(...a);
}

const fmt = (n) => '$' + Number(n || 0).toLocaleString('es-AR');
function precioDe(c) {
  return c.precio || (Array.isArray(c.propuestas) && c.propuestas[0] && c.propuestas[0].precio) || 0;
}

// Empujón al cliente: tiene presupuestos y no eligió.
async function avisarPresupuestosEsperando(m, cots) {
  const nombre = (m.clienteNombre || '').split(' ')[0] || 'Hola';
  const tipo = m.tipo === 'flete' ? 'tu flete' : 'tu mudanza';
  const n = cots.length;
  const precios = cots.map(precioDe).filter(Boolean);
  const desde = precios.length ? Math.min(...precios) : 0;
  try {
    const { enviarPlantilla } = require('./_plantillas');
    const textoLibre =
      `¡Hola ${nombre}! Tenés ${n} presupuesto${n > 1 ? 's' : ''} para ${tipo}` +
      `${desde ? ` desde ${fmt(desde)}` : ''} esperando que elijas. ` +
      `¿Te ayudo a decidir? Respondé este mensaje y lo vemos juntos. 😊`;
    const r = await enviarPlantilla(
      m.clienteWA, 'presupuestos_esperando',
      { 1: nombre, 2: String(n), 3: tipo, 4: desde ? fmt(desde) : '—' },
      textoLibre
    );
    return !!(r && r.enviado);
  } catch (e) { console.warn('avisarPresupuestosEsperando:', e.message); return false; }
}

module.exports = async function handler(req, res) {
  try {
    const activas = (await getJSON('mudanzas:activas')) || [];
    const ahora = Date.now();
    let revisados = 0, avisados = 0;
    const MAX = 40;

    for (const id of activas) {
      if (avisados >= MAX) break;
      const m = await getJSON(`mudanza:${id}`);
      if (!m || !m.clienteWA) continue;
      revisados++;

      const cots = Array.isArray(m.cotizaciones) ? m.cotizaciones : [];
      const abierto = m.estado === 'buscando' || m.estado === 'cotizando';
      const vigente = !m.expira || new Date(m.expira).getTime() > ahora;
      // Solo si: sigue abierto, no venció, TIENE cotizaciones y no lo empujamos aún.
      if (!abierto || !vigente || cots.length === 0 || m.nudgePresupuestos) continue;

      if (await avisarPresupuestosEsperando(m, cots)) {
        m.nudgePresupuestos = new Date().toISOString();
        await setJSON(`mudanza:${id}`, m, 60 * 60 * 24 * 7);
        avisados++;
      }
    }

    return res.status(200).json({ ok: true, revisados, avisados });
  } catch (e) {
    console.error('cron-nurturing:', e.message);
    return res.status(200).json({ error: e.message });
  }
};
