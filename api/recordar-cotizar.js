// api/recordar-cotizar.js — Recordatorio por WhatsApp a mudanceros que tienen
// pedidos ABIERTOS esperando su cotización (todavía no cotizaron ninguno).
// Acción manual, admin-gated. NO es un cron automático: se dispara a mano
// desde la consola de admin cuando el equipo decide mandar la tanda.
//
// GET  -> arma la lista de destinatarios + el texto real que les llegaría,
//         SIN mandar nada (para revisar antes de disparar el POST).
// POST -> manda de verdad (reusa la MISMA lógica de cálculo que el GET).
//
// Mismo filtro que ya usa el propio mudancero al ver sus pedidos disponibles
// (action=por-zona en api/cotizaciones.js / tool ver_pedidos del bot): pedido
// en estado 'buscando', no vencido, respeta modo dirigido, y que ese
// mudancero todavía no haya cotizado ni rechazado. No inventa un filtro de
// zona nuevo: usa exactamente lo mismo que ya ve el mudancero hoy.

const { enviarPlantilla } = require('./_plantillas');

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

function textoRecordatorio(nombre, cantidad) {
  const primerNombre = String(nombre || '').trim().split(' ')[0] || 'che';
  const plural = cantidad === 1 ? 'pedido' : 'pedidos';
  return (
    `¡Hola ${primerNombre}! Tenés ${cantidad} ${plural} esperando tu cotización en MudateYa 🚚\n\n` +
    `Entrá a mudateya.ar/mi-cuenta y cotizalos antes de que se los lleve otro mudancero. Cualquier duda, respondé este mensaje.`
  );
}

// Arma la lista de mudanceros con pedidos pendientes de cotizar + el texto
// exacto que le llegaría a cada uno. Sin efectos secundarios (no manda nada).
async function calcularDestinatarios() {
  const idsActivas = (await getJSON('mudanzas:activas')) || [];
  const ahora = new Date();
  const pedidosAbiertos = [];
  for (const id of idsActivas) {
    const m = await getJSON(`mudanza:${id}`);
    if (!m || m.estado !== 'buscando' || new Date(m.expira) < ahora) continue;
    pedidosAbiertos.push(m);
  }
  if (!pedidosAbiertos.length) return [];

  const todosEmails = (await getJSON('mudanceros:todos')) || [];
  const destinatarios = [];
  for (const email of todosEmails) {
    const p = await getJSON(`mudancero:perfil:${email}`);
    if (!p || p.estado !== 'aprobado' || !p.telefono) continue;
    const rechazados = (await getJSON(`rechazados:${email}`)) || [];
    const pendientes = pedidosAbiertos.filter((m) => {
      if (m.modoCotizacion === 'dirigido' && !(m.mudancerosInvitados || []).includes(email)) return false;
      if ((m.cotizaciones || []).find((c) => c.mudanceroEmail === email)) return false;
      if (rechazados.includes(m.id)) return false;
      return true;
    });
    if (!pendientes.length) continue;
    destinatarios.push({
      email,
      nombre: p.nombre || '',
      telefono: p.telefono,
      cantidad: pendientes.length,
      pedidos: pendientes.map((m) => ({ id: m.id, tipo: m.tipo, ruta: `${m.desde || ''} → ${m.hasta || ''}` })),
      texto: textoRecordatorio(p.nombre, pendientes.length),
    });
  }
  return destinatarios;
}

module.exports = async function handler(req, res) {
  if (!require('./_auth').esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });

  try {
    const destinatarios = await calcularDestinatarios();

    if (req.method === 'GET') {
      return res.status(200).json({
        ok: true,
        totalDestinatarios: destinatarios.length,
        destinatarios: destinatarios.map((d) => ({ email: d.email, nombre: d.nombre, telefono: d.telefono, cantidad: d.cantidad, pedidos: d.pedidos, texto: d.texto })),
      });
    }

    if (req.method === 'POST') {
      // Filtro opcional { soloEmails: [...] } -- para reintentar SOLO los que
      // fallaron sin volver a mandarle a quien ya le llegó bien.
      const soloEmails = req.body && Array.isArray(req.body.soloEmails) ? req.body.soloEmails : null;
      const aEnviar = soloEmails ? destinatarios.filter((d) => soloEmails.includes(d.email)) : destinatarios;

      const resultados = [];
      for (const d of aEnviar) {
        const r = await enviarPlantilla(d.telefono, 'recordatorio_pedido_sin_cotizar', { 1: (d.nombre || '').split(' ')[0] || 'che', 2: String(d.cantidad) }, d.texto);
        resultados.push({ email: d.email, telefono: d.telefono, cantidad: d.cantidad, ...r });
      }
      const enviados = resultados.filter((r) => r.enviado).length;
      return res.status(200).json({ ok: true, totalDestinatarios: aEnviar.length, enviados, fallidos: aEnviar.length - enviados, resultados });
    }

    return res.status(405).json({ error: 'Método no permitido' });
  } catch (e) {
    console.error('recordar-cotizar:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
