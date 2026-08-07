// api/cron-recordar-pago.js — Recuerda a los clientes que ACEPTARON pero NO
// PAGARON (seña o saldo). Corre por cron (ver vercel.json). Manda el recordatorio
// UNA sola vez por tramo (flag en la mudanza). La cadencia del cron da el "delay"
// natural: el que acepta y paga enseguida no entra; el que se olvidó, sí.
//
// Envío por WhatsApp:
//   - Si TPL_RECORDATORIO_PAGO_SID está seteada → plantilla (llega fuera de 24h).
//   - Si no → texto libre con el link /pagar (solo llega dentro de la ventana 24h).
// Solo pedidos de canal 'whatsapp' con clienteWA.
//
// TIMEOUT DE RESERVA (2026-08-07): antes, si el cliente aceptaba una
// cotización y nunca pagaba la seña, el pedido quedaba en 'cotizacion_aceptada'
// PARA SIEMPRE — no vuelve a aparecer en por-zona (no está en los estados
// ABIERTOS que mira cron-cerrar-pedidos.js) y el mudancero elegido queda con
// un cupo reservado que nunca se concreta ni se libera. Ahora, si pasaron más
// de UMBRAL_LIBERAR_MS desde que se mandó el recordatorio y todavía no pagó,
// se libera la reserva: vuelve a 'vencido_con_cotizaciones' (mismo estado que
// usa cron-cerrar-pedidos.js para pedidos reabribles — el cliente puede
// aceptar cualquiera de sus cotizaciones vigentes de nuevo) y se avisa a
// ambos lados.

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

const UMBRAL_LIBERAR_MS = 48 * 60 * 60 * 1000; // 48hs desde el recordatorio de seña

// Avisa al cliente por WhatsApp que se venció el tiempo para pagar la seña y
// se liberó la reserva (mismo criterio de canal que enviarRecordatorio: solo
// clientes con WhatsApp cargado — es el único canal donde este cron notifica).
async function avisarLiberacionCliente(m) {
  if (!m.clienteWA) return;
  const nombre = (m.clienteNombre || '').split(' ')[0] || 'Hola';
  const tipoTxt = m.tipo === 'flete' ? 'tu flete' : 'tu mudanza';
  try {
    const { enviarPlantilla } = require('./_plantillas');
    const site = process.env.SITE_URL || 'https://mudateya.ar';
    const textoLibre =
      `¡Hola ${nombre}! Como no llegamos a recibir la seña, liberamos la reserva de ${tipoTxt}. ` +
      `Tus presupuestos siguen disponibles: entrá a ${site}/mi-mudanza y elegí cuando quieras.`;
    await enviarPlantilla(m.clienteWA, 'reserva_liberada_sin_pago', { 1: nombre, 2: tipoTxt }, textoLibre);
  } catch (e) { console.warn('avisarLiberacionCliente:', e.message); }
}

async function enviarRecordatorio(m, tipoPago, monto) {
  const site = process.env.SITE_URL || 'https://mudateya.ar';
  const nombre = (m.clienteNombre || '').split(' ')[0] || 'Hola';
  const cot = m.cotizacionAceptada || {};
  const mud = cot.mudanceroNombre || 'tu mudancero';
  const tramoTxt = tipoPago === 'anticipo' ? `la seña (${fmt(monto)})` : `el saldo (${fmt(monto)})`;
  const tipoTxt = m.tipo === 'flete' ? 'tu flete' : 'tu mudanza';
  try {
    const { enviarPlantilla } = require('./_plantillas');
    // Usa la plantilla si Meta ya la aprobó (resuelve el SID solo); si no, texto libre.
    const textoLibre =
      `¡Hola ${nombre}! Reservaste ${tipoTxt} con ${mud}, pero quedó pendiente ${tramoTxt}.\n` +
      `Pagalo acá para confirmar: ${site}/pagar/${m.id}`;
    const r = await enviarPlantilla(
      m.clienteWA, 'recordatorio_pago_pendiente',
      { 1: nombre, 2: tipoTxt, 3: mud, 4: tramoTxt, 5: m.id },
      textoLibre
    );
    return !!r.enviado;
  } catch (e) { console.warn('enviarRecordatorio:', e.message); return false; }
}

module.exports = async function handler(req, res) {
  let esVercelCron = false;
  try { esVercelCron = require('./_auth').esCronVercel(req); } catch (_) {}
  let esAdminReq = false;
  try { esAdminReq = require('./_auth').esAdmin(req); } catch (_) {}
  if (!esVercelCron && !esAdminReq) return res.status(401).json({ error: 'No autorizado' });

  try {
    const todos = (await getJSON('mudanzas:todos')) || [];
    // Procesar los más recientes primero (tope defensivo).
    const ids = todos.slice(-300).reverse();
    let enviados = 0, revisados = 0;
    const MAX = 50;

    for (const id of ids) {
      if (enviados >= MAX) break;
      const m = await getJSON(`mudanza:${id}`);
      if (!m || m.canal !== 'whatsapp' || !m.clienteWA) continue;
      revisados++;

      const cot = m.cotizacionAceptada || {};
      const total = parseInt(cot.precio || m.montoTotal || 0) || 0;
      if (!total) continue;

      // 1) Seña: aceptó la cotización pero no pagó el anticipo.
      if (m.estado === 'cotizacion_aceptada' && !m.anticipoPagado && !m.recordatorioPagoSena) {
        const monto = Math.round(total * 0.5);
        if (await enviarRecordatorio(m, 'anticipo', monto)) {
          m.recordatorioPagoSena = new Date().toISOString();
          await setJSON(`mudanza:${id}`, m, 60 * 60 * 24 * 30);
          enviados++;
        }
        continue;
      }

      // 2) Saldo: mudanza completada pero no pagó el saldo.
      if (m.estado === 'completada' && m.anticipoPagado && !m.saldoPagado && !m.recordatorioPagoSaldo) {
        const ant = parseInt(m.anticipoMonto || Math.round(total * 0.5)) || 0;
        const monto = Math.max(0, total - ant);
        if (monto > 0 && await enviarRecordatorio(m, 'saldo', monto)) {
          m.recordatorioPagoSaldo = new Date().toISOString();
          await setJSON(`mudanza:${id}`, m, 60 * 60 * 24 * 30);
          enviados++;
        }
        continue;
      }

      // 3) Liberar reserva: ya se mandó el recordatorio de seña y pasaron más
      // de 48hs sin pagar. Ver nota "TIMEOUT DE RESERVA" arriba.
      if (m.estado === 'cotizacion_aceptada' && !m.anticipoPagado && m.recordatorioPagoSena) {
        const desdeRecordatorio = Date.now() - new Date(m.recordatorioPagoSena).getTime();
        if (desdeRecordatorio > UMBRAL_LIBERAR_MS) {
          const cotAceptada = m.cotizacionAceptada;
          m.estado = 'vencido_con_cotizaciones';
          m.reservaLiberadaPorFaltaDePago = new Date().toISOString();
          delete m.cotizacionAceptada;
          delete m.mudanceroAceptado;
          delete m.montoTotal;
          if (Array.isArray(m.cotizaciones) && cotAceptada) {
            const c = m.cotizaciones.find((x) => x.id === cotAceptada.id);
            if (c && c.estado === 'aceptada') c.estado = 'pendiente';
          }
          await setJSON(`mudanza:${id}`, m, 60 * 60 * 24 * 30);
          try { await avisarLiberacionCliente(m); } catch (e) { console.warn('avisarLiberacionCliente:', e.message); }
          try {
            if (cotAceptada) await require('./cotizaciones').notificarMudanceroPedidoCancelado({ ...m, cotizacionAceptada: cotAceptada });
          } catch (e) { console.warn('notificarMudanceroPedidoCancelado (timeout pago):', e.message); }
          enviados++;
        }
      }
    }

    return res.status(200).json({ ok: true, revisados, enviados });
  } catch (e) {
    console.error('cron-recordar-pago:', e.message);
    return res.status(200).json({ error: e.message });
  }
};
