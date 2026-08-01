// api/pagar.js — Redirección de pago para el botón de las plantillas de WhatsApp.
// URL pública: /pagar/{mudanzaId}  (rewrite en vercel.json → /api/pagar?token=)
//
// Detecta SOLO qué tramo falta pagar (seña o saldo) según el estado del pedido,
// genera la preferencia de Mercado Pago (misma config que crear-preferencia.js,
// para que webhook-mp la procese) y hace un 302 al checkout. Así un único botón
// "Pagar" sirve tanto para la seña como para el saldo.

const { MercadoPagoConfig, Preference } = require('mercadopago');

async function redisGet(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/GET/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d = await r.json();
  return d.result || null;
}

function redir(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

module.exports = async function handler(req, res) {
  const site = process.env.SITE_URL || 'https://mudateya.ar';
  const id = (req.query && (req.query.token || req.query.m || req.query.mudanzaId)) || '';
  if (!id) return redir(res, site);

  try {
    const raw = await redisGet(`mudanza:${id}`);
    const m = raw ? JSON.parse(raw) : null;
    if (!m) return redir(res, site);

    // ¿Qué tramo falta pagar?
    let tipoPago = null;
    if (!m.anticipoPagado) tipoPago = 'anticipo';
    else if (!m.saldoPagado) tipoPago = 'saldo';
    if (!tipoPago) return redir(res, `${site}/pago-exitoso?ya=1`); // ya está todo pago

    // Monto del tramo.
    const cot = m.cotizacionAceptada || {};
    const total = parseInt(cot.precio || m.montoTotal || 0) || 0;
    let monto;
    if (tipoPago === 'anticipo') {
      monto = Math.round(total * 0.5);
    } else {
      const ant = parseInt(m.anticipoMonto || Math.round(total * 0.5)) || 0;
      monto = Math.max(0, total - ant);
    }
    if (!monto || monto <= 0) return redir(res, `${site}/mi-mudanza`);

    if (!process.env.MP_ACCESS_TOKEN) return redir(res, `${site}/mi-mudanza`);

    const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
    const preference = new Preference(client);
    const labelTipo = tipoPago === 'anticipo' ? 'Seña' : 'Saldo final';
    const result = await preference.create({ body: {
      items: [{
        id: `mudanza-${id}-${tipoPago}`,
        title: `MudateYa — ${labelTipo} · ${cot.mudanceroNombre || ''}`.trim(),
        description: `${m.desde || ''} → ${m.hasta || ''}`,
        quantity: 1,
        unit_price: Number(monto),
        currency_id: 'ARS',
      }],
      back_urls: {
        success: `${site}/pago-exitoso?monto=${monto}&mudancero=${encodeURIComponent(cot.mudanceroNombre || '')}&mudanzaId=${id}&tipoPago=${tipoPago}`,
        failure: `${site}?pago=error`,
        pending: `${site}?pago=pendiente`,
      },
      auto_return: 'approved',
      statement_descriptor: 'MUDATEYA',
      external_reference: `${id}-${tipoPago}-${cot.id || ''}`,
      metadata: { mudancero: cot.mudanceroNombre, desde: m.desde, hasta: m.hasta, mudanzaId: id, cotizacionId: cot.id, tipoPago },
      notification_url: `${site}/api/webhook-mp`,
    }});

    const initPoint = result.init_point || result.sandbox_init_point;
    if (!initPoint) return redir(res, `${site}/mi-mudanza`);
    return redir(res, initPoint);
  } catch (e) {
    console.error('pagar:', e.message);
    return redir(res, `${site}/mi-mudanza`);
  }
};
