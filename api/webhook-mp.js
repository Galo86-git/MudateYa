// api/webhook-mp.js
// Recibe notificaciones de Mercado Pago cuando un pago cambia de estado
// Configurar en: https://www.mercadopago.com.ar/developers/panel/notifications
// Evento a suscribir: payment
//
// QUÉ CAMBIÓ (2026-08-07): este archivo ANTES reimplementaba en paralelo toda
// la lógica de "marcar pago" (anticipoPagado/saldoPagado, monto, etc.) pero
// SIN los hooks de negocio que sí tiene registrar-pago en cotizaciones.js
// (hookAcreditarAliado, hookAsesorPagado, notificarMudanceroPago,
// notificarAsesorMudanzaCompletada/AnticipoPagado, logPedidoSheets). Los dos
// caminos comparten el mismo lock e idempotencia, así que si el webhook de MP
// ganaba la carrera contra pago-exitoso.html (muy plausible: el cliente cierra
// la pestaña apenas ve "aprobado", mala señal, adblocker, etc.), el pago
// quedaba marcado como pagado pero SIN acreditar comisión a aliados/asesores
// ni avisar al mudancero — sin ningún error visible, en silencio.
//
// Ahora este archivo NO vuelve a implementar nada de eso: solo identifica de
// qué mudanza/tramo se trata y delega en la MISMA acción interna que usa
// pago-exitoso.html (POST /api/cotizaciones?action=registrar-pago con
// mpPaymentId) — que ya re-verifica el pago contra la API de MP de forma
// independiente (no confía en este webhook para nada financiero) y dispara
// TODOS los hooks. Así hay una sola fuente de verdad para "qué pasa cuando se
// paga", gane la carrera quien gane.

const { MercadoPagoConfig, Payment } = require('mercadopago');
const { alertarEquipo } = require('./_alerta-equipo');

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

    // Consultamos el pago solo para saber a qué mudanza/tramo corresponde
    // (mudanzaId/tipoPago van en el metadata que se cargó al crear la
    // preferencia). La verificación de que el pago es real, está aprobado y
    // cubre el monto esperado la vuelve a hacer registrar-pago desde cero —
    // acá no se toma nada de esto como fuente de verdad financiera.
    const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
    const paymentClient = new Payment(client);
    const pago = await paymentClient.get({ id: data.id });

    const { status, status_detail, metadata, external_reference } = pago;
    console.log(`[Webhook MP] Pago ${data.id} — ${status} (${status_detail})`);

    if (status !== 'approved') {
      return res.status(200).json({ status: 'no_aprobado', pago_status: status });
    }

    const { mudanzaId, tipoPago } = extraerReferencia(metadata, external_reference);
    if (!mudanzaId || !tipoPago) {
      console.warn('[Webhook MP] Sin mudanzaId o tipoPago (metadata ni external_reference)', JSON.stringify({ metadata, external_reference }));
      await alertarEquipo(
        'Pago de MP aprobado SIN registrar (no se pudo asociar a un pedido)',
        'Mercado Pago acreditó un pago pero el webhook no pudo saber a qué pedido corresponde. Hay que registrarlo a mano.',
        { 'Pago MP': data.id, 'Monto': pago.transaction_amount, 'Pagador': pago.payer && pago.payer.email, 'external_reference': external_reference, 'metadata': JSON.stringify(metadata || {}) }
      );
      return res.status(200).json({ status: 'sin_metadata' });
    }

    // Delegar en la acción real — mismo camino que pago-exitoso.html, mismo
    // lock, misma idempotencia, mismos hooks. Si pago-exitoso.html ya lo
    // procesó, esto devuelve 'ya_registrado' y no hace nada más (correcto).
    const base = process.env.SITE_URL || 'https://mudateya.ar';
    const r = await fetch(`${base}/api/cotizaciones?action=registrar-pago`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mudanzaId, tipoPago, mpPaymentId: String(data.id) })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error(`[Webhook MP] registrar-pago devolvió ${r.status}:`, d.error);
      await alertarEquipo(
        'Pago de MP aprobado que NO se pudo registrar',
        'Mercado Pago acreditó el pago pero registrar-pago lo rechazó. El mudancero y el cliente no fueron notificados.',
        { 'Pedido': mudanzaId, 'Tramo': tipoPago, 'Pago MP': data.id, 'Monto': pago.transaction_amount, 'Error': d.error || r.status }
      );
      // Devolvemos 200 igual: si devolviéramos error, MP reintentaría este
      // mismo webhook en loop, y si el motivo del fallo es permanente (ej. el
      // pago no corresponde a la mudanza) reintentar no lo arregla.
      return res.status(200).json({ status: 'error_registrar_pago', error: d.error });
    }

    console.log(`[Webhook MP] ✅ Pago ${tipoPago} procesado para mudanza ${mudanzaId} (${d.status || 'ok'})`);
    return res.status(200).json({ status: 'ok', tipoPago, mudanzaId, resultado: d });

  } catch (error) {
    console.error('[Webhook MP] Error:', error.message);
    await alertarEquipo(
      'Error procesando el webhook de Mercado Pago',
      'El webhook falló antes de poder registrar un pago. Revisá en MP si hay un pago aprobado sin registrar.',
      { 'Pago MP': req.body && req.body.data && req.body.data.id, 'Error': error.message }
    );
    // MP reintenta si devolvés error — siempre devolver 200
    return res.status(200).json({ status: 'error_procesado', error: error.message });
  }
};

// MP suele devolver las claves del metadata en snake_case (mudanza_id) aunque
// se hayan cargado en camelCase (mudanzaId): se aceptan las dos. Si no hay
// metadata, se intenta con external_reference, que tiene dos formatos:
//   crear-preferencia.js → {mudanzaId}-{anticipo|saldo}-{cotizacionId}
//   cotizaciones.js      → {mudanzaId}-COT-{n}-{anticipo|saldo}
// registrar-pago vuelve a verificar que el pago corresponda a ese pedido.
function extraerReferencia(metadata, externalReference) {
  const md = metadata || {};
  let mudanzaId = md.mudanzaId || md.mudanza_id || '';
  let tipoPago  = md.tipoPago  || md.tipo_pago  || '';
  if (!mudanzaId || !tipoPago) {
    const ref = String(externalReference || '');
    const m = ref.match(/^(MYA-\d+|[a-z0-9]+)-(anticipo|saldo)-/i) ||
              ref.match(/^(MYA-\d+|[a-z0-9]+)-COT-\d+-(anticipo|saldo)$/i);
    if (m) {
      mudanzaId = mudanzaId || m[1];
      tipoPago  = tipoPago  || m[2].toLowerCase();
    }
  }
  return { mudanzaId, tipoPago };
}
module.exports.extraerReferencia = extraerReferencia;
