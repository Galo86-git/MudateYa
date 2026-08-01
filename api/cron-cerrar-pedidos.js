// api/cron-cerrar-pedidos.js — Cierra pedidos VENCIDOS del marketplace.
// Un pedido "vence" cuando pasó su fecha `expira` y el cliente todavía no eligió
// mudancero (estado sigue en 'buscando'/'cotizando'). Al cerrarlo:
//   - lo saca del índice mudanzas:activas (deja de aparecer en por-zona),
//   - marca estado 'vencido_con_cotizaciones' o 'vencido_sin_cotizaciones',
//   - avisa UNA sola vez al cliente (WhatsApp) ofreciéndole reactivar.
// Solo toca al cliente y al índice: NO manda nada a mudanceros. Seguro en testing.
// Corre por cron (ver vercel.json).

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

// Aviso al cliente de que su pedido venció. Usa la plantilla si Meta la aprobó
// (llega fuera de 24h); si no, texto libre (solo dentro de la ventana).
async function avisarVencimiento(m, nCots) {
  const nombre = (m.clienteNombre || '').split(' ')[0] || 'Hola';
  const tipo = m.tipo === 'flete' ? 'tu flete' : 'tu mudanza';
  try {
    const { enviarPlantilla } = require('./_plantillas');
    let nombrePlantilla, vars, textoLibre;
    if (nCots > 0) {
      nombrePlantilla = 'pedido_vencido_con_presupuestos';
      vars = { 1: nombre, 2: String(nCots), 3: tipo };
      textoLibre =
        `¡Hola ${nombre}! Recibiste ${nCots} presupuesto${nCots > 1 ? 's' : ''} para ${tipo}, ` +
        `pero venció el plazo para elegir. ¿Querés que lo reactivemos? Respondé este mensaje y seguimos. 🚚`;
    } else {
      nombrePlantilla = 'pedido_vencido_sin_presupuestos';
      vars = { 1: nombre, 2: tipo };
      textoLibre =
        `¡Hola ${nombre}! No llegamos a conseguirte un mudancero para ${tipo} a tiempo. ` +
        `¿Reintentamos con un poco más de anticipación? Respondé este mensaje y lo republicamos. 🙌`;
    }
    const r = await enviarPlantilla(m.clienteWA, nombrePlantilla, vars, textoLibre);
    return !!(r && r.enviado);
  } catch (e) { console.warn('avisarVencimiento:', e.message); return false; }
}

module.exports = async function handler(req, res) {
  try {
    const activas = (await getJSON('mudanzas:activas')) || [];
    const ahora = Date.now();
    const ABIERTOS = ['buscando', 'cotizando'];
    let revisados = 0, cerrados = 0, avisados = 0;
    const quedan = []; // ids que siguen activos (reescribimos el índice al final)

    for (const id of activas) {
      const m = await getJSON(`mudanza:${id}`);
      if (!m) continue; // ya expiró de Redis (TTL) → lo sacamos del índice
      revisados++;

      const vencido = m.expira && new Date(m.expira).getTime() < ahora;
      const abierto = ABIERTOS.includes(m.estado);
      if (!vencido || !abierto) { quedan.push(id); continue; }

      // Cerrar el pedido
      const cots = Array.isArray(m.cotizaciones) ? m.cotizaciones : [];
      m.estado = cots.length ? 'vencido_con_cotizaciones' : 'vencido_sin_cotizaciones';
      m.cerradoAuto = new Date().toISOString();

      // Avisar al cliente (una sola vez)
      if (m.canal === 'whatsapp' && m.clienteWA && !m.avisoVencimiento) {
        if (await avisarVencimiento(m, cots.length)) {
          m.avisoVencimiento = new Date().toISOString();
          avisados++;
        }
      }
      await setJSON(`mudanza:${id}`, m, 60 * 60 * 24 * 30);
      cerrados++;
      // no se re-agrega a `quedan` → sale del índice de activas
    }

    await setJSON('mudanzas:activas', quedan, 60 * 60 * 24 * 7);
    return res.status(200).json({ ok: true, revisados, cerrados, avisados });
  } catch (e) {
    console.error('cron-cerrar-pedidos:', e.message);
    return res.status(200).json({ error: e.message });
  }
};
