// api/webhook-mp.js
// Recibe notificaciones de Mercado Pago cuando un pago cambia de estado
// Configurar en: https://www.mercadopago.com.ar/developers/panel/notifications
// Evento a suscribir: payment

const { MercadoPagoConfig, Payment } = require('mercadopago');

// ── Redis helpers (igual que cotizaciones.js) ─────────────────────────────
async function redisCall(method, ...args) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const res   = await fetch(`${url}/${[method, ...args.map(a => encodeURIComponent(a))].join('/')}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  return data.result;
}
async function getJSON(key) {
  const val = await redisCall('GET', key);
  try { return val ? JSON.parse(val) : null; } catch(e) { return null; }
}
async function setJSON(key, value, exSeconds) {
  const str = JSON.stringify(value);
  if (exSeconds) await redisCall('SET', key, str, 'EX', String(exSeconds));
  else           await redisCall('SET', key, str);
}

// Monto que el sistema espera para este tramo (misma lógica que transferencias.js).
// Sirve para rechazar pagos por menos de lo debido.
function montoEsperado(m, tipoPago) {
  const cot = (m && m.cotizacionAceptada) || {};
  const total = parseInt(cot.precio || (m && m.montoTotal) || 0) || 0;
  if (!total) return null;
  if (tipoPago === 'anticipo') return Math.round(total * 0.5);
  if (tipoPago === 'saldo') {
    const ant = parseInt(m.anticipoMonto || Math.round(total * 0.5)) || 0;
    return Math.max(total - ant, 0);
  }
  return null;
}

// ── Handler ───────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  try {
    const { type, data } = req.body;

    // Solo procesar notificaciones de pagos
    if (type !== 'payment') {
      return res.status(200).json({ status: 'ignorado', type });
    }

    if (!data || !data.id) {
      return res.status(200).json({ status: 'sin_id' });
    }

    // Obtener el pago completo desde MP
    const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
    const paymentClient = new Payment(client);
    const pago = await paymentClient.get({ id: data.id });

    const { status, status_detail, external_reference, metadata, transaction_amount } = pago;

    console.log(`[Webhook MP] Pago ${data.id} — ${status} (${status_detail})`);
    console.log(`  Referencia: ${external_reference}`);
    console.log(`  Tipo:       ${metadata?.tipoPago}`);
    console.log(`  MudanzaId:  ${metadata?.mudanzaId}`);
    console.log(`  Monto:      $${transaction_amount}`);

    // Solo procesar pagos aprobados
    if (status !== 'approved') {
      return res.status(200).json({ status: 'no_aprobado', pago_status: status });
    }

    // Extraer datos del metadata
    const mudanzaId = metadata?.mudanzaId;
    const tipoPago  = metadata?.tipoPago; // 'anticipo' | 'saldo'

    if (!mudanzaId || !tipoPago) {
      console.warn('[Webhook MP] Sin mudanzaId o tipoPago en metadata');
      return res.status(200).json({ status: 'sin_metadata' });
    }

    // Evitar doble procesamiento — verificar si ya fue registrado
    const m = await getJSON(`mudanza:${mudanzaId}`);
    if (!m) {
      console.warn(`[Webhook MP] Mudanza ${mudanzaId} no encontrada en Redis`);
      return res.status(200).json({ status: 'mudanza_no_encontrada' });
    }

    // Verificar si ya estaba registrado (idempotencia)
    if (tipoPago === 'anticipo' && m.anticipoPagado) {
      return res.status(200).json({ status: 'ya_registrado' });
    }
    if (tipoPago === 'saldo' && m.saldoPagado) {
      return res.status(200).json({ status: 'ya_registrado' });
    }

    // VALIDAR EL MONTO: no acreditar si se pagó menos de lo esperado (evita que
    // alguien libere el tramo pagando de menos, ej. $1, ya que crear-preferencia
    // acepta el monto del frontend). Si no se puede calcular lo esperado, se
    // avisa pero se procesa (para no romper casos borde legítimos).
    const esperado = montoEsperado(m, tipoPago);
    const pagado   = Math.round(Number(transaction_amount) || 0);
    if (esperado && pagado < Math.round(esperado * 0.99)) {
      console.error(`[Webhook MP] MONTO INSUFICIENTE mudanza ${mudanzaId} (${tipoPago}): pagó $${pagado}, esperado ~$${esperado}. NO se acredita.`);
      m.pagoInsuficiente = { tipoPago, pagado, esperado, pagoId: String(data.id), cuando: new Date().toISOString() };
      await setJSON(`mudanza:${mudanzaId}`, m, 604800);
      return res.status(200).json({ status: 'monto_insuficiente', esperado, pagado });
    }

    // Registrar el pago
    if (tipoPago === 'anticipo') {
      m.anticipoPagado    = true;
      m.mpAnticipoPagoId  = String(data.id);
      // Fecha en que MP confirmó el pago — base para calcular liquidación al mudancero (15 días hábiles)
      if (!m.fechaPagoAnticipo) m.fechaPagoAnticipo = new Date().toISOString();
      // Guardar el monto REAL cobrado por MP (transaction_amount), no calcularlo a partir del precio
      // que puede estar desactualizado por ajustes de precio. Es la fuente de verdad.
      m.anticipoMonto = Math.round(Number(transaction_amount) || 0);
    }
    if (tipoPago === 'saldo') {
      m.saldoPagado    = true;
      m.mpSaldoPagoId  = String(data.id);
      if (!m.fechaPagoSaldo) m.fechaPagoSaldo = new Date().toISOString();
      // Idem: guardar monto real del saldo cobrado
      m.saldoMonto = Math.round(Number(transaction_amount) || 0);
      // Al pagar el saldo, la mudanza queda completada
      m.estado = 'completada';
      if (!m.fechaCompletada) m.fechaCompletada = new Date().toISOString();
    }
    m.ultimoUpdatePago = new Date().toISOString();

    // TTL largo (90 días): una mudanza con pago confirmado tiene que sobrevivir
    // hasta la liquidación al mudancero (~15 días hábiles) y su conciliación.
    // Con 7 días el registro del cobro podía expirar antes de liquidar.
    await setJSON(`mudanza:${mudanzaId}`, m, 7776000);

    // Cerrar el círculo por WhatsApp: al confirmar la SEÑA, avisar al cliente
    // (reservada) y al mudancero elegido (ganó). Solo pedidos de canal whatsapp
    // avisan al cliente; el mudancero se avisa por su tel de la cotización.
    if (tipoPago === 'anticipo') {
      try {
        const { avisarSenaConfirmada } = require('./_whatsapp');
        await avisarSenaConfirmada(m);
      } catch (e) { console.warn('[Webhook MP] aviso WhatsApp seña:', e.message); }
    }

    console.log(`[Webhook MP] ✅ Pago ${tipoPago} registrado para mudanza ${mudanzaId}`);
    return res.status(200).json({ status: 'ok', tipoPago, mudanzaId });

  } catch (error) {
    console.error('[Webhook MP] Error:', error.message);
    // MP reintenta si devolvés error — siempre devolver 200
    return res.status(200).json({ status: 'error_procesado', error: error.message });
  }
};
