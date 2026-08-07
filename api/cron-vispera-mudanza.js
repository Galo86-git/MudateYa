// api/cron-vispera-mudanza.js — Recordatorio 24 h antes, a las DOS partes.
//
// POR QUÉ
//   El no-show es la principal fuente de reclamos, y casi siempre sale de lo
//   mismo: el cliente no terminó de embalar, o el mudancero anotó mal el
//   horario, o uno de los dos ya no cuenta con ese día y no avisó. Un mensaje
//   la tarde anterior destapa eso cuando todavía hay margen para arreglarlo.
//
// A QUIÉN Y QUÉ
//   Cliente:   confirmá que vas a estar, tené todo embalado y los accesos libres.
//   Mudancero: confirmá horario y dirección.
//   Los dos mensajes salen una sola vez (flag avisoVispera en la mudanza).
//
// SI FALTA LA SEÑA
//   Se le agrega al cliente una línea avisándole. Una mudanza de mañana sin
//   anticipo pagado es de las que se caen.
//
// LÍMITE CONOCIDO
//   Solo encuentra mudanzas con fecha REAL (YYYY-MM-DD). Los pedidos viejos que
//   quedaron con la fecha en texto libre ("mañana", "7/8") no se pueden ubicar
//   en el calendario y quedan afuera — de ahí en más entran todos, porque el
//   schema de crear_pedido ahora obliga a Emi a normalizarla.

const TZ = 'America/Argentina/Buenos_Aires';
// Estados en los que la mudanza está cerrada con un mudancero y todavía no pasó.
const ESTADOS_CONFIRMADOS = ['cotizacion_aceptada', 'aceptada', 'confirmada'];

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

// Fecha de MAÑANA en hora argentina, como YYYY-MM-DD. Vercel corre en UTC, así
// que sin el timeZone explícito a la noche argentina el cron ya estaría mirando
// el día equivocado. 'en-CA' devuelve justo el formato ISO corto.
function mananaAR() {
  return new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: TZ });
}
// La fecha guardada puede venir como '2026-08-07' o '2026-08-07T09:00'.
function soloFecha(f) {
  return String(f || '').trim().split('T')[0];
}

async function avisarCliente(m, faltaSena) {
  if (!m.clienteWA) return false;
  const nombre = (m.clienteNombre || '').split(' ')[0] || 'Hola';
  const tipo = m.tipo === 'flete' ? 'tu flete' : 'tu mudanza';
  const cot = m.cotizacionAceptada || {};
  const quien = cot.mudanceroNombre || 'el mudancero';
  try {
    const { enviarPlantilla } = require('./_plantillas');
    let textoLibre =
      `¡Hola ${nombre}! Mañana es ${tipo} con ${quien} 🚚\n\n` +
      `¿Tenés todo listo? Lo ideal es tener las cajas cerradas y los pasillos libres antes de que lleguen. ` +
      `Si algo cambió, respondeme y lo vemos.`;
    if (faltaSena) {
      textoLibre += `\n\n⚠️ Ojo que todavía no figura pagada la seña — sin eso la reserva no queda firme.`;
    }
    const r = await enviarPlantilla(
      m.clienteWA, 'vispera_cliente',
      { 1: nombre, 2: tipo, 3: quien }, textoLibre
    );
    return !!(r && r.enviado);
  } catch (e) { console.warn('avisarCliente vispera:', e.message); return false; }
}

async function avisarMudancero(m) {
  const cot = m.cotizacionAceptada || {};
  if (!cot.mudanceroTel) return false;
  const nombre = (cot.mudanceroNombre || '').split(' ')[0] || 'Hola';
  const ruta = `${m.desde || m.origen || ''} → ${m.hasta || m.destino || ''}`;
  const hora = m.horaOrigen || (String(m.fecha || '').split('T')[1] || '').slice(0, 5);
  try {
    const { enviarPlantilla } = require('./_plantillas');
    const textoLibre =
      `¡Hola ${nombre}! Mañana tenés ${ruta}${hora ? ` a las ${hora}` : ''} 🚚\n\n` +
      `¿Confirmás horario y dirección? Si surgió algo, avisame ahora así reacomodamos con el cliente.`;
    const r = await enviarPlantilla(
      cot.mudanceroTel, 'vispera_mudancero',
      { 1: nombre, 2: ruta, 3: hora || 'a coordinar' }, textoLibre
    );
    return !!(r && r.enviado);
  } catch (e) { console.warn('avisarMudancero vispera:', e.message); return false; }
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
    const manana = mananaAR();
    let revisadas = 0, sinFechaUtil = 0;
    const avisadas = [];

    for (const id of activas) {
      const m = await getJSON(`mudanza:${id}`);
      if (!m) continue;
      if (!ESTADOS_CONFIRMADOS.includes(m.estado)) continue;
      revisadas++;

      const f = soloFecha(m.fecha);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) { sinFechaUtil++; continue; }
      if (f !== manana) continue;
      if (m.avisoVispera) continue;

      const faltaSena = !m.anticipoPagado;
      const cot = m.cotizacionAceptada || {};
      avisadas.push({
        id: id,
        ruta: `${m.desde || m.origen || ''} → ${m.hasta || m.destino || ''}`,
        cliente: m.clienteNombre || '—',
        mudancero: cot.mudanceroNombre || cot.mudanceroEmail || '—',
        faltaSena: faltaSena,
      });

      if (!dry) {
        const okCli = await avisarCliente(m, faltaSena);
        const okMud = await avisarMudancero(m);
        if (okCli || okMud) {
          m.avisoVispera = new Date().toISOString();
          await setJSON(`mudanza:${id}`, m, 604800);
        }
      }
    }

    return res.status(200).json({
      ok: true, dry: dry, manana: manana,
      confirmadasRevisadas: revisadas,
      sinFechaUtilizable: sinFechaUtil,
      avisadas: avisadas.length,
      detalle: avisadas,
    });
  } catch (e) {
    console.error('cron-vispera-mudanza:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
