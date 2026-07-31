// api/whatsapp.js — Webhook de Twilio para WhatsApp (Sandbox y producción)
// Recibe el POST de Twilio (form-urlencoded), corre el agente cliente con Claude,
// guarda el pedido en Redis (Upstash), y responde con TwiML (sin llamada saliente).
//
// Convenciones de este proyecto:
//   - CommonJS (module.exports), igual que el resto de /api.
//   - Redis por REST estilo path, igual que _talo.js / _seguridad.js / cotizaciones.js.
//   - El envío saliente a mudanceros reutiliza enviarWhatsApp() de _whatsapp.js.
//
// VARIABLES DE ENTORNO (Vercel → Settings → Environment Variables):
//   ANTHROPIC_API_KEY         -> API key de Claude
//   UPSTASH_REDIS_REST_URL    -> ya lo tenés en MudateYa
//   UPSTASH_REDIS_REST_TOKEN  -> ya lo tenés en MudateYa
//   TWILIO_AUTH_TOKEN         -> se usa para VALIDAR la firma de cada webhook
//   CLAUDE_MODEL (opcional)   -> ID del modelo (default: claude-sonnet-4-5)
//   SKIP_TWILIO_VALIDATION    -> "1" solo para debug; en prod dejar sin setear

const crypto = require('crypto');

const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';

// ------------------------------------------------------------------
// Redis (Upstash REST, estilo path — mismo patrón que _talo.js)
// ------------------------------------------------------------------
async function redisCall(method, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  const r = await fetch(`${url}/${[method, ...args].map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}
async function getJSON(key) {
  const v = await redisCall('GET', key);
  return v ? JSON.parse(v) : null;
}
async function setJSON(key, value, ttlSeconds) {
  const args = ['SET', key, JSON.stringify(value)];
  if (ttlSeconds) args.push('EX', String(ttlSeconds));
  return redisCall(...args);
}

// ------------------------------------------------------------------
// Validación de firma de Twilio (X-Twilio-Signature)
// Sin esto, cualquiera que conozca la URL podría crear pedidos falsos y
// gastar tokens de Claude. Mismo criterio que usa _talo.js con sus webhooks.
// ------------------------------------------------------------------
function urlPublica(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}${req.url}`;
}
function firmaValida(req) {
  if (process.env.SKIP_TWILIO_VALIDATION === '1') return true; // solo debug
  const token = process.env.TWILIO_AUTH_TOKEN;
  const firma = req.headers['x-twilio-signature'];
  if (!token || !firma) return false;

  const params = req.body || {};
  let data = urlPublica(req);
  Object.keys(params).sort().forEach((k) => { data += k + params[k]; });

  const esperada = crypto
    .createHmac('sha1', token)
    .update(Buffer.from(data, 'utf-8'))
    .digest('base64');

  const a = Buffer.from(firma);
  const b = Buffer.from(esperada);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ------------------------------------------------------------------
// System prompt del agente cliente
// ------------------------------------------------------------------
const SYSTEM_PROMPT = `Sos el asistente de MudateYa por WhatsApp. MudateYa es un marketplace argentino de mudanzas y fletes que le consigue presupuestos al cliente contactando mudanceros/fleteros cercanos.

Tu objetivo: atender a un cliente que quiere mudarse o hacer un flete, juntar los datos del pedido, y crearlo para que MudateYa salga a buscarle presupuestos.

TONO: cercano, rioplatense, claro. Mensajes cortos (es WhatsApp). Un emoji cada tanto está bien.

CÓMO TRABAJÁS:
1. Saludá y preguntá si es una mudanza o un flete.
2. Juntá los datos, de a uno o dos por mensaje (no todos juntos):
   - tipo: "mudanza" o "flete"
   - origen: dirección o zona de donde sale
   - destino: dirección o zona a donde va
   - fecha aproximada
   - detalles: qué mover (ambientes, muebles grandes, electrodomésticos), piso y si hay ascensor
   - contacto: nombre del cliente
3. Cuando tengas los datos, llamá a la herramienta crear_pedido.
4. Explicá el modelo cuando venga al caso: MudateYa le consigue hasta 5 presupuestos de mudanceros cercanos, el pedido vale 24hs, y el pago es 50% al reservar + 50% al completar.
5. No prometas precios exactos: los ponen los mudanceros.

REGLAS: no pidas datos sensibles (tarjetas, documentos). Si el mensaje no tiene que ver con esto, respondé amable y reconducí.`;

const tools = [
  {
    name: 'crear_pedido',
    description:
      'Crea el pedido de mudanza/flete cuando ya tenés los datos: tipo, origen, destino, fecha y detalles.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['mudanza', 'flete'] },
        origen: { type: 'string' },
        destino: { type: 'string' },
        fecha: { type: 'string' },
        detalles: { type: 'string' },
        nombre: { type: 'string' },
      },
      required: ['tipo', 'origen', 'destino', 'fecha', 'detalles'],
    },
  },
];

// ------------------------------------------------------------------
// Claude
// ------------------------------------------------------------------
async function askClaude(messages) {
  const res = await fetch(ANTHROPIC, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 500, system: SYSTEM_PROMPT, tools, messages }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('Anthropic error:', res.status, err);
    throw new Error('Anthropic ' + res.status);
  }
  return res.json();
}

// ------------------------------------------------------------------
// Crear pedido en Redis (mudanza:{id})
// ------------------------------------------------------------------
function nuevoId() {
  return `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}
async function crearPedido(input, waId) {
  const id = nuevoId();
  const ahora = new Date();
  const pedido = {
    id,
    tipo: input.tipo,
    origen: input.origen,
    destino: input.destino,
    fecha: input.fecha,
    detalles: input.detalles,
    cliente: { nombre: input.nombre || '', whatsapp: waId },
    canal: 'whatsapp',
    estado: 'buscando_presupuestos',
    cotizaciones: [],
    creado: ahora.toISOString(),
    vence: new Date(ahora.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
  await setJSON(`mudanza:${id}`, pedido, 60 * 60 * 24 * 3);
  await iniciarBarridoMudanceros(pedido);
  return pedido;
}

// Base del barrido saliente a mudanceros. INTENCIONALMENTE deshabilitado: enviar
// WhatsApp a fleteros reales cuesta plata y les llega a personas reales, así que
// no se dispara solo. Cuando quieras activarlo, reutilizá enviarWhatsApp() de
// _whatsapp.js con una plantilla aprobada. Por ahora solo deja el pedido cargado.
async function iniciarBarridoMudanceros(pedido) {
  console.log(`[barrido] pedido ${pedido.id} (${pedido.tipo}) listo:`, pedido.origen, '->', pedido.destino);
  // const { enviarWhatsApp } = require('./_whatsapp');
  // ... buscar mudanceros cercanos y enviarles la plantilla ...
}

// ------------------------------------------------------------------
// Genera la respuesta del agente (texto) para un mensaje entrante
// ------------------------------------------------------------------
async function generarRespuesta(waId, texto) {
  const key = `wa:conv:${waId}`;
  const conv = (await getJSON(key)) || { messages: [] };
  conv.messages.push({ role: 'user', content: texto });
  if (conv.messages.length > 20) conv.messages = conv.messages.slice(-20);

  const resp = await askClaude(conv.messages);

  const toolUse = (resp.content || []).find((c) => c.type === 'tool_use' && c.name === 'crear_pedido');
  let salida;
  if (toolUse) {
    const pedido = await crearPedido(toolUse.input, waId);
    salida =
      `¡Listo${pedido.cliente.nombre ? ', ' + pedido.cliente.nombre : ''}! Ya cargué tu ${pedido.tipo} 🚚\n` +
      `Salgo a buscarte presupuestos de mudanceros cercanos. Te van a llegar acá, hasta 5, y el pedido vale por 24hs.`;
  } else {
    salida =
      (resp.content || [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n')
        .trim() || 'Perdón, no te entendí bien. ¿Me lo repetís?';
  }

  conv.messages.push({ role: 'assistant', content: salida });
  await setJSON(key, conv, 60 * 60 * 24 * 30);
  return salida;
}

// ------------------------------------------------------------------
// TwiML helpers
// ------------------------------------------------------------------
function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
function twiml(mensaje) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(mensaje)}</Message></Response>`;
}

// ------------------------------------------------------------------
// Handler (Vercel Function) — webhook de Twilio
// ------------------------------------------------------------------
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  // 1) Validar que el POST viene realmente de Twilio.
  if (!firmaValida(req)) {
    console.warn('Firma de Twilio inválida — rechazado');
    return res.status(403).send('Firma inválida');
  }

  res.setHeader('Content-Type', 'text/xml');
  try {
    const body = req.body || {};
    const from = body.From || ''; // ej: "whatsapp:+5491179038453"
    const texto = (body.Body || '').trim();
    const waId = from.replace('whatsapp:', '');

    if (!texto) return res.status(200).send(twiml('Perdón, no te entendí. ¿Me lo repetís?'));

    const respuesta = await generarRespuesta(waId, texto);
    return res.status(200).send(twiml(respuesta));
  } catch (e) {
    console.error('Error webhook Twilio WhatsApp:', e);
    return res.status(200).send(twiml('Uy, tuve un problemita. Probá de nuevo en un momento 🙏'));
  }
};
