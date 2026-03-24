// api/webhook-mp.js
// Recibe notificaciones de Mercado Pago cuando un pago cambia de estado
// Configurar en: https://www.mercadopago.com.ar/developers/panel/notifications

const { MercadoPagoConfig, Payment } = require('mercadopago');

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

    const client = new MercadoPagoConfig({
      accessToken: process.env.MP_ACCESS_TOKEN,
    });
    const paymentClient = new Payment(client);

    // Obtener el pago completo desde MP
    const pago = await paymentClient.get({ id: data.id });

    const {
      status,           // approved | pending | rejected
      status_detail,
      external_reference,
      metadata,
      transaction_amount,
      payer,
    } = pago;

    console.log(`[Webhook MP] Pago ${data.id} — ${status} (${status_detail})`);
    console.log(`  Referencia: ${external_reference}`);
    console.log(`  Mudancero:  ${metadata?.mudancero}`);
    console.log(`  Tipo:       ${metadata?.tipo_pago}`);
    console.log(`  Monto:      $${transaction_amount}`);

    if (status === 'approved') {
      // ── Acá va tu lógica de negocio ──────────────────────────────────
      // 1. Guardar en DB: crear registro de mudanza confirmada
      // 2. Notificar al mudancero (email / WhatsApp)
      // 3. Notificar al usuario con la confirmación
      // 4. Si tipo_pago === 'fee': recordar que queda saldo al mudancero
      //
      // Ejemplo con base de datos (pseudocódigo):
      // await db.mudanzas.create({
      //   estado: 'confirmada',
      //   tipo_pago: metadata.tipo_pago,
      //   precio_total: metadata.precio_total,
      //   fee_pagado: transaction_amount,
      //   saldo_al_mudancero: metadata.precio_total - transaction_amount,
      //   mudancero: metadata.mudancero,
      //   desde: metadata.desde,
      //   hasta: metadata.hasta,
      //   payer_email: payer.email,
      //   mp_payment_id: data.id,
      // });
      //
      // await enviarEmailConfirmacion(payer.email, metadata);
      // await notificarMudancero(metadata.mudancero, metadata);
      // ────────────────────────────────────────────────────────────────
    }

    return res.status(200).json({ status: 'ok', pago_status: status });

  } catch (error) {
    console.error('Error procesando webhook MP:', error);
    // MP reintenta si devolvés un error, no devolver 500 por errores menores
    return res.status(200).json({ status: 'error_procesado', error: error.message });
  }
};
