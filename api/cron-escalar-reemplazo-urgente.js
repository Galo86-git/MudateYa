// api/cron-escalar-reemplazo-urgente.js — Red de seguridad del flujo de
// "reemplazo urgente" (ver action=cancelar-mudancero en api/cotizaciones.js).
//
// POR QUÉ
//   Cuando un mudancero cancela con menos de 24hs de margen, el sistema barre
//   automáticamente a los demás mudanceros de la zona. Pero puede pasar que
//   nadie confirme (todos ocupados, nadie contesta a tiempo) — y sin este
//   cron, el pedido se queda en 'buscando_reemplazo_urgente' sin que nadie
//   del equipo se entere. Con el reloj corriendo (la mudanza es en <24hs), eso
//   es justo el caso que más necesita que una persona lo tome a mano.
//
// CUÁNDO ESCALA
//   Si pasaron UMBRAL_ESCALAR_HORAS desde que el mudancero canceló y el
//   pedido SIGUE sin reemplazo. Corre cada hora; el flag escaladoReemplazoUrgente
//   evita mandar la alerta más de una vez por pedido.
//
// A QUIÉN
//   Mismo mecanismo que la alerta urgente de derivar_a_humano (whatsapp.js):
//   ALERTA_URGENTE_TEL si está seteada (modo arranque, una sola persona), si
//   no a todo EQUIPO_TELEFONOS. Usa la plantilla alerta_urgente_equipo, que
//   ya existe (no hace falta esperar una aprobación nueva de Meta para esto).

const UMBRAL_ESCALAR_HORAS = 3;

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

function cargarEquipo() {
  try { return JSON.parse(process.env.EQUIPO_TELEFONOS || '{}'); } catch { return {}; }
}
function alertaUrgenteTels() {
  return String(process.env.ALERTA_URGENTE_TEL || '').split(',').map((t) => t.trim()).filter(Boolean);
}

async function escalar(m) {
  const { enviarPlantilla } = require('./_plantillas');
  const tipo = (m.tipo || 'mudanza').toUpperCase();
  const ruta = `${m.desde || m.origen || ''} → ${m.hasta || m.destino || ''}`;
  const candidatos = m.candidatosAvisadosReemplazo != null ? m.candidatosAvisadosReemplazo : '?';
  const detalle =
    `Reemplazo urgente sin resolver hace más de ${UMBRAL_ESCALAR_HORAS}hs — ${ruta}. ` +
    `Precio acordado: $${(m.precioReemplazoUrgente || 0).toLocaleString('es-AR')}. ` +
    `Se avisó a ${candidatos} mudancero(s) de la zona y nadie confirmó todavía.`;
  const digitos = String(m.clienteWA || '').replace(/\D/g, '') || '';

  const equipo = cargarEquipo();
  const listaFija = alertaUrgenteTels();
  const destinos = listaFija.length ? listaFija : Object.keys(equipo);
  let enviados = 0;
  for (const tel of destinos) {
    const texto = `🚨 ${tipo} URGENTE — SIN REEMPLAZO\n\n${detalle}\n\n` +
      (digitos ? `Abrir chat con el cliente: https://wa.me/${digitos}\n\n` : '') +
      `Emi no consiguió reemplazo a tiempo. Tomalo cuanto antes.`;
    try {
      const r = await enviarPlantilla(tel, 'alerta_urgente_equipo', { '1': tipo, '2': ruta, '3': detalle, '4': digitos || '5491133364677' }, texto);
      if (r && r.enviado) enviados++;
    } catch (e) { console.warn('[escalar-reemplazo] wa', tel, e.message); }
  }
  return enviados;
}

module.exports = async function handler(req, res) {
  let esVercelCron = false;
  try { esVercelCron = require('./_auth').esCronVercel(req); } catch (_) {}
  let esAdminReq = false;
  try { esAdminReq = require('./_auth').esAdmin(req); } catch (_) {}
  if (!esVercelCron && !esAdminReq) return res.status(401).json({ error: 'No autorizado' });

  const dry = String((req.query && req.query.dry) || '') === '1';

  try {
    const activas = (await getJSON('mudanzas:activas')) || [];
    const ahora = Date.now();
    const escaladas = [];

    for (const id of activas) {
      const m = await getJSON(`mudanza:${id}`);
      if (!m) continue;
      if (m.estado !== 'buscando_reemplazo_urgente') continue;
      if (m.escaladoReemplazoUrgente) continue;
      const canceladoEn = m.mudanceroQueCancelo && m.mudanceroQueCancelo.canceladoEn;
      if (!canceladoEn) continue;
      const horasEsperando = (ahora - new Date(canceladoEn).getTime()) / 3600000;
      if (horasEsperando < UMBRAL_ESCALAR_HORAS) continue;

      escaladas.push({ id, horasEsperando: Math.round(horasEsperando * 10) / 10 });
      if (!dry) {
        const enviados = await escalar(m);
        m.escaladoReemplazoUrgente = new Date().toISOString();
        await setJSON(`mudanza:${id}`, m, 60 * 60 * 24 * 180);
        console.log(`[escalar-reemplazo] ${id}: alertados ${enviados}`);
      }
    }

    return res.status(200).json({ ok: true, dry, revisadas: activas.length, escaladas: escaladas.length, detalle: escaladas });
  } catch (e) {
    console.error('cron-escalar-reemplazo-urgente:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
