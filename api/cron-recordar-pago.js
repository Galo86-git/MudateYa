// api/cron-recordar-pago.js — Recuerda a los clientes que ACEPTARON pero NO
// PAGARON (seña o saldo). Corre por cron (ver vercel.json). Manda el recordatorio
// UNA sola vez por tramo (flag en la mudanza). La cadencia del cron da el "delay"
// natural: el que acepta y paga enseguida no entra; el que se olvidó, sí.
//
// Envío por WhatsApp:
//   - Si TPL_RECORDATORIO_PAGO_SID está seteada → plantilla (llega fuera de 24h).
//   - Si no → texto libre con el link /pagar (solo llega dentro de la ventana 24h).
// Solo pedidos de canal 'whatsapp' con clienteWA.

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

async function enviarRecordatorio(m, tipoPago, monto) {
  const site = process.env.SITE_URL || 'https://mudateya.ar';
  const nombre = (m.clienteNombre || '').split(' ')[0] || 'Hola';
  const cot = m.cotizacionAceptada || {};
  const mud = cot.mudanceroNombre || 'tu mudancero';
  const tramoTxt = tipoPago === 'anticipo' ? `la seña (${fmt(monto)})` : `el saldo (${fmt(monto)})`;
  const tipoTxt = m.tipo === 'flete' ? 'tu flete' : 'tu mudanza';
  const sid = process.env.TPL_RECORDATORIO_PAGO_SID; // ContentSid de la plantilla aprobada
  try {
    const wa = require('./_whatsapp');
    if (sid && wa.enviarWhatsApp) {
      // Plantilla: variables 1=nombre 2=tu mudanza/flete 3=mudancero 4=tramo 5=mudanzaId (botón)
      await wa.enviarWhatsApp(m.clienteWA, sid, { 1: nombre, 2: tipoTxt, 3: mud, 4: tramoTxt, 5: m.id });
    } else {
      await wa.enviarWhatsAppTexto(
        m.clienteWA,
        `¡Hola ${nombre}! Reservaste ${tipoTxt} con ${mud}, pero quedó pendiente ${tramoTxt}.\n` +
        `Pagalo acá para confirmar: ${site}/pagar/${m.id}`
      );
    }
    return true;
  } catch (e) { console.warn('enviarRecordatorio:', e.message); return false; }
}

module.exports = async function handler(req, res) {
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
      }
    }

    return res.status(200).json({ ok: true, revisados, enviados });
  } catch (e) {
    console.error('cron-recordar-pago:', e.message);
    return res.status(200).json({ error: e.message });
  }
};
