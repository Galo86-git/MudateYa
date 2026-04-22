// api/crear-preferencia.js
const { MercadoPagoConfig, Preference } = require('mercadopago');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (!process.env.MP_ACCESS_TOKEN) return res.status(500).json({ error: 'Configuración de pago incompleta' });

  try {
    const { mudanceroNombre, monto, desde, hasta, ambientes, mudanzaId, cotizacionId, tipoPago } = req.body;
    if (!monto || monto <= 0) return res.status(400).json({ error: 'Monto inválido' });

    // tipoPago: 'anticipo' | 'saldo' | undefined (pago único)
    // IMPORTANTE: El monto llega ya calculado correctamente desde el frontend.
    // Antes se multiplicaba por 0.5 acá, pero eso rompe los ajustes de precio
    // (si hubo ajuste, el saldo NO es el 50% del nuevo precio, sino
    // precio_nuevo - anticipo_ya_pagado). Confiamos en el monto enviado.
    const montoFinal = Math.round(Number(monto));
    const labelTipo = tipoPago === 'anticipo' ? 'Anticipo' : tipoPago === 'saldo' ? 'Saldo final' : '';
    const tituloItem = `MudateYa${labelTipo ? ' — '+labelTipo : ''} · ${mudanceroNombre}`;

    const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
    const preference = new Preference(client);
    const siteUrl = process.env.SITE_URL || 'https://mudateya.vercel.app';

    const result = await preference.create({ body: {
      items: [{
        id:          `mudanza-${mudanzaId||Date.now()}-${tipoPago||'unico'}`,
        title:       tituloItem,
        description: `${desde} → ${hasta} · ${ambientes}`,
        quantity:    1,
        unit_price:  Number(montoFinal),
        currency_id: 'ARS',
      }],
      back_urls: {
        success: `${siteUrl}/pago-exitoso?monto=${montoFinal}&mudancero=${encodeURIComponent(mudanceroNombre)}&mudanzaId=${mudanzaId||''}&cotizacionId=${cotizacionId||''}&tipoPago=${tipoPago||'unico'}`,
        failure: `${siteUrl}?pago=error`,
        pending: `${siteUrl}?pago=pendiente`,
      },
      auto_return:          'approved',
      statement_descriptor: 'MUDATEYA',
      external_reference:   `${mudanzaId||'MYA'}-${tipoPago||'unico'}-${cotizacionId||Date.now()}`,
      metadata:             { mudancero: mudanceroNombre, desde, hasta, ambientes, mudanzaId, cotizacionId, tipoPago },
      notification_url:     `${siteUrl}/api/webhook-mp`,
    }});

    return res.status(200).json({
      id:          result.id,
      init_point:  result.init_point  || result.initPoint,
      sandbox_url: result.sandbox_init_point || result.sandboxInitPoint,
      montoFinal,
      tipoPago: tipoPago || 'unico',
    });

  } catch (error) {
    console.error('Error creando preferencia MP:', error);
    return res.status(500).json({ error: 'Error al crear el pago', detalle: error.message });
  }
};
