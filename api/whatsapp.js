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
// Reconocimiento del equipo fundador por teléfono.
// Los números NO van en el código (repo público): se cargan en la variable
// de entorno EQUIPO_TELEFONOS (Vercel) como JSON con los últimos 10 dígitos:
//   {"1177182305":"Juan","1150595122":"Nano","1133364677":"Galo"}
// Si la variable no está seteada, el bot funciona normal para todos.
// ------------------------------------------------------------------
function cargarEquipo() {
  try { return JSON.parse(process.env.EQUIPO_TELEFONOS || '{}'); }
  catch { return {}; }
}
const EQUIPO = cargarEquipo();
function ultimos10(waId) {
  return String(waId || '').replace(/\D/g, '').slice(-10);
}
// Para mudanceros usamos los últimos 8 dígitos (número de abonado): es la parte
// estable del celular argentino, más allá de 54 / 9 / 15 / código de área.
function clave8(tel) {
  return String(tel || '').replace(/\D/g, '').slice(-8);
}
function quienEscribe(waId) {
  return EQUIPO[ultimos10(waId)] || null;
}

// ------------------------------------------------------------------
// Descarga de imágenes que manda el cliente por WhatsApp.
// Twilio entrega la media en una URL protegida (auth básica con las
// credenciales de la cuenta). Claude entiende imágenes, así que la bajamos y
// la pasamos en base64. (Audio NO: Claude no transcribe audio.)
// ------------------------------------------------------------------
const TIPOS_IMG = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

async function descargarMediaBase64(url) {
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
    const r = await fetch(url, { headers: { Authorization: auth } });
    if (!r.ok) { console.error('Descarga de media falló:', r.status); return null; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) { console.warn('Imagen > 5MB, se ignora'); return null; }
    return buf.toString('base64');
  } catch (e) {
    console.error('Error bajando media:', e);
    return null;
  }
}

// ------------------------------------------------------------------
// Transcripción de audios (notas de voz) con OpenAI Whisper.
// Claude no transcribe audio, así que se usa un servicio aparte. Se activa solo
// si está seteada OPENAI_API_KEY (Vercel). Si no, devuelve null y el bot le pide
// al cliente que escriba o mande una foto.
// ------------------------------------------------------------------
function extAudio(tipo) {
  const t = (tipo || '').toLowerCase();
  if (t.includes('ogg') || t.includes('opus')) return 'ogg';
  if (t.includes('mpeg') || t.includes('mp3')) return 'mp3';
  if (t.includes('mp4') || t.includes('m4a') || t.includes('aac')) return 'm4a';
  if (t.includes('wav')) return 'wav';
  if (t.includes('webm')) return 'webm';
  return 'ogg';
}

// Diagnóstico temporal: corre el circuito de transcripción y devuelve texto
// legible con lo que pasó (descarga + respuesta de OpenAI). Para debug puntual.
async function diagTranscribir(url, tipo) {
  const out = [];
  const apiKey = process.env.OPENAI_API_KEY;
  out.push('OPENAI_API_KEY: ' + (apiKey ? ('presente, largo ' + apiKey.length) : 'AUSENTE'));
  out.push('TWILIO_ACCOUNT_SID: ' + (process.env.TWILIO_ACCOUNT_SID ? 'presente' : 'AUSENTE'));
  if (!url) { out.push('Sin MediaUrl0'); return out.join('\n'); }
  try {
    const auth = 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const r = await fetch(url, { headers: { Authorization: auth } });
    out.push('Descarga: HTTP ' + r.status + ' | ' + (r.headers.get('content-type') || ''));
    if (!r.ok) return out.join('\n');
    const buf = Buffer.from(await r.arrayBuffer());
    out.push('Bytes: ' + buf.length + ' | ext: ' + extAudio(tipo));
    if (!apiKey) return out.join('\n');
    const form = new FormData();
    form.append('file', new Blob([buf], { type: tipo || 'audio/ogg' }), `audio.${extAudio(tipo)}`);
    form.append('model', 'whisper-1');
    form.append('language', 'es');
    const or = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form,
    });
    const otext = await or.text();
    out.push('OpenAI: HTTP ' + or.status);
    out.push('OpenAI body: ' + otext.slice(0, 500));
  } catch (e) {
    out.push('EXCEPCION: ' + (e && e.message ? e.message : String(e)));
  }
  return out.join('\n');
}

async function transcribirAudio(url, tipo) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null; // sin servicio de transcripción configurado
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
    const r = await fetch(url, { headers: { Authorization: auth } });
    if (!r.ok) { console.error('Descarga de audio falló:', r.status); return null; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 20 * 1024 * 1024) { console.warn('Audio > 20MB, se ignora'); return null; }

    const ext = extAudio(tipo);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: tipo || 'audio/ogg' }), `audio.${ext}`);
    form.append('model', 'whisper-1');
    form.append('language', 'es');

    const or = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!or.ok) { console.error('OpenAI transcripción falló:', or.status, await or.text()); return null; }
    const d = await or.json();
    return (d.text || '').trim() || null;
  } catch (e) {
    console.error('Error transcribiendo audio:', e);
    return null;
  }
}

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

// Anti-abuso: tope de mensajes por número por minuto (mismo patrón INCR+EXPIRE
// que _seguridad.js). Fail-open: si Redis falla, no bloquea el servicio.
async function superaLimite(waId, maxPorMinuto) {
  try {
    const k = `wa:rl:${waId}`;
    const n = parseInt(await redisCall('INCR', k), 10);
    if (n === 1) await redisCall('EXPIRE', k, '60');
    return n > maxPorMinuto;
  } catch (e) {
    console.warn('Rate limit falló (fail-open):', e.message);
    return false;
  }
}

// ------------------------------------------------------------------
// Reconocimiento de MUDANCEROS por teléfono.
// Los perfiles están en mudancero:perfil:{email} (indexados por email, no por
// teléfono). Construimos un índice teléfono→email en `mudanceros:tel-index`
// que se autoconstruye y refresca cada 6h (así no tocamos el alta/edición).
// Los mudanceros nuevos quedan reconocidos dentro de ~6h.
// ------------------------------------------------------------------
// Pipeline de Upstash: varios comandos en UNA sola llamada REST.
async function redisPipeline(commands) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const r = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  const data = await r.json();
  return Array.isArray(data) ? data.map((d) => d.result) : [];
}

// Backfill del índice teléfono→email (hash Redis `mudanceros:tel-idx`).
// Corre una vez y se rearma cada 24h (para tomar mudanceros nuevos). Con muchos
// mudanceros usa pipelines por lotes de 100 (una llamada por lote), no N GET.
async function asegurarIndiceMudanceros() {
  try {
    if (await redisCall('GET', 'mudanceros:tel8-idx:built')) return;
    const emails = (await getJSON('mudanceros:todos')) || [];
    for (let off = 0; off < emails.length; off += 100) {
      const lote = emails.slice(off, off + 100);
      const perfiles = await redisPipeline(lote.map((e) => ['GET', `mudancero:perfil:${e}`]));
      const hset = [];
      perfiles.forEach((val, i) => {
        if (!val) return;
        try {
          const p = JSON.parse(val);
          if (p && p.telefono && p.estado !== 'rechazado') {
            const t = clave8(p.telefono);
            if (t.length === 8) hset.push(['HSET', 'mudanceros:tel8-idx', t, lote[i]]);
          }
        } catch (_) {}
      });
      if (hset.length) await redisPipeline(hset);
    }
    await redisCall('SET', 'mudanceros:tel8-idx:built', '1', 'EX', String(24 * 60 * 60));
  } catch (e) {
    console.error('asegurarIndiceMudanceros:', e.message);
  }
}
async function buscarMudancero(waId) {
  try {
    await asegurarIndiceMudanceros();
    const t = clave8(waId);
    if (t.length !== 8) return null;
    const email = await redisCall('HGET', 'mudanceros:tel8-idx', t);
    if (!email) return null;
    return await getJSON(`mudancero:perfil:${email}`);
  } catch (e) {
    console.error('buscarMudancero:', e.message);
    return null; // ante error, se trata como cliente (seguro)
  }
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
   - detalles: qué mover (ambientes, muebles grandes, electrodomésticos), piso y si hay ascensor. Si te ayuda a estimar, podés pedirle una foto de lo que hay que mover.
   - contacto: nombre del cliente
3. Cuando tengas los datos, llamá a la herramienta crear_pedido.
4. Explicá el modelo cuando venga al caso: MudateYa le consigue hasta 5 presupuestos de mudanceros cercanos, el pedido vale 24hs, y el pago es 50% al reservar + 50% al completar.
5. No prometas precios exactos: los ponen los mudanceros.

REGLAS: no pidas datos sensibles (tarjetas, documentos). Si el mensaje no tiene que ver con esto, respondé amable y reconducí.`;

// System prompt del asistente para MUDANCEROS (distinto del de clientes).
const SYSTEM_PROMPT_MUDANCERO = `Sos el asistente de MudateYa para MUDANCEROS/FLETEROS por WhatsApp. Estás hablando con {NOMBRE}, un mudancero registrado en la plataforma.

MudateYa es un marketplace argentino de mudanzas y fletes: los clientes piden presupuesto y vos (junto con otros mudanceros de la zona) cotizan. El cliente elige, paga una seña, y coordinan.

TONO: cercano, rioplatense, directo. Mensajes cortos (es WhatsApp). Tratalo por su nombre.

QUÉ PODÉS HACER HOY:
- Responder dudas sobre cómo funciona MudateYa para mudanceros (cómo llegan los pedidos, cómo cotizar, cómo se cobra).
- Explicar el modelo: cuando entra un pedido en tu zona te vamos a avisar por acá; respondés con tu precio para cotizar; si el cliente te elige y paga la seña, te pasamos su contacto para coordinar. El pago es 50% seña + 50% al completar, protegido.
- Orientarlo y contenerlo con buena onda.

QUÉ TODAVÍA NO:
- Todavía NO estás recibiendo pedidos para cotizar por acá (lo estamos activando). Si te pregunta por un pedido puntual o quiere cotizar ahora, decile que en breve va a poder cotizar directo por WhatsApp, y que por ahora gestione desde su cuenta en mudateya.ar/mi-cuenta.

REGLAS:
- No inventes datos de su cuenta, pagos ni pedidos concretos. Si pregunta algo específico de su perfil, cobros o estado, derivalo a mudateya.ar/mi-cuenta o a hola@mudateya.ar.
- No pidas ni manejes datos sensibles (tarjetas, contraseñas).`;

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
async function askClaude(messages, system, toolsArg) {
  const res = await fetch(ANTHROPIC, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 500, system: system || SYSTEM_PROMPT, tools: toolsArg || tools, messages }),
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
async function crearPedido(input, waId, ubicaciones) {
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
    ubicaciones: Array.isArray(ubicaciones) ? ubicaciones : [], // coords compartidas (geo-match)
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
async function generarRespuesta(waId, texto, imagenes, ubicacion, mudancero) {
  const key = mudancero ? `wa:conv:mud:${waId}` : `wa:conv:${waId}`;
  const conv = (await getJSON(key)) || { messages: [] };

  // Ubicación compartida por WhatsApp: se la contamos al agente (como texto) y
  // guardamos las coordenadas para poder hacer geo-match de mudanceros después.
  let texto2 = texto;
  if (ubicacion) {
    conv.ubicaciones = conv.ubicaciones || [];
    conv.ubicaciones.push({ ...ubicacion, cuando: new Date().toISOString() });
    const nota = `[📍 El cliente compartió una ubicación${ubicacion.direccion ? ' ("' + ubicacion.direccion + '")' : ''}: ${ubicacion.lat},${ubicacion.lng} — https://maps.google.com/?q=${ubicacion.lat},${ubicacion.lng}. Usala como origen o destino según lo que estén conversando; si no está claro cuál es, preguntale.]`;
    texto2 = (texto2 ? texto2 + ' ' : '') + nota;
  }

  // Turno actual del cliente. Si mandó fotos, van como bloques (imagen + texto)
  // SOLO para esta llamada a Claude; en el historial guardamos un placeholder de
  // texto para no persistir el base64 (pesa y re-enviarlo cada turno cuesta tokens).
  let contenidoActual;
  let contenidoHistorial;
  if (imagenes && imagenes.length) {
    const bloques = [];
    for (const img of imagenes) {
      const data = await descargarMediaBase64(img.url);
      if (data) bloques.push({ type: 'image', source: { type: 'base64', media_type: img.tipo, data } });
    }
    bloques.push({
      type: 'text',
      text:
        texto2 ||
        'El cliente te mandó una foto (sin texto). Describí SOLO lo que realmente ves en la imagen; NO inventes objetos que no estén. Si son cosas para mudar (muebles, cajas, electrodomésticos, un ambiente), usalo para entender el pedido. Si la foto no tiene que ver con una mudanza o flete, decíselo con amabilidad y pedile una foto de lo que hay que mover.',
    });
    contenidoActual = bloques;
    contenidoHistorial = (texto2 ? texto2 + ' ' : '') + `[📷 foto${imagenes.length > 1 ? ' x' + imagenes.length : ''} enviada]`;
  } else {
    contenidoActual = texto2;
    contenidoHistorial = texto2;
  }

  // Mensajes para Claude: historial (solo texto) recortado + turno actual.
  const historial = conv.messages.slice(-20);
  const messages = historial.concat([{ role: 'user', content: contenidoActual }]);

  // Si quien escribe es del equipo fundador, se lo decimos al agente.
  let system, toolsUsados;
  if (mudancero) {
    const nombre = (mudancero.nombre || '').split(' ')[0] || 'colega';
    system = SYSTEM_PROMPT_MUDANCERO.replace('{NOMBRE}', nombre);
    toolsUsados = []; // el mudancero NO crea pedidos de cliente
  } else {
    const persona = quienEscribe(waId);
    system = persona
      ? `${SYSTEM_PROMPT}\n\nCONTEXTO: quien te escribe es ${persona}, del equipo fundador de MudateYa. Tratalo por su nombre, con confianza y cercanía; no le expliques qué es MudateYa como si fuera un cliente nuevo.`
      : SYSTEM_PROMPT;
    toolsUsados = tools;
  }

  const resp = await askClaude(messages, system, toolsUsados);

  const toolUse = (resp.content || []).find((c) => c.type === 'tool_use' && c.name === 'crear_pedido');
  let salida;
  if (toolUse) {
    const pedido = await crearPedido(toolUse.input, waId, conv.ubicaciones);
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

  // Persistimos historial en texto (turno del cliente + respuesta del bot).
  conv.messages.push({ role: 'user', content: contenidoHistorial });
  conv.messages.push({ role: 'assistant', content: salida });
  if (conv.messages.length > 20) conv.messages = conv.messages.slice(-20);
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

    // Diagnóstico temporal de transcripción (protegido por la firma de Twilio).
    if (texto === 'DIAGSTT') {
      const salida = await diagTranscribir(body.MediaUrl0, body.MediaContentType0 || 'audio/ogg');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(salida);
    }

    // Anti-abuso: tope de 12 mensajes por número por minuto.
    if (waId && (await superaLimite(waId, 12))) {
      return res
        .status(200)
        .send(twiml('¡Pará un toque! 😅 Estás mandando muchos mensajes muy seguido. Esperá un minuto y seguimos.'));
    }

    // ¿Quien escribe es un mudancero registrado? (por teléfono) → asistente aparte.
    const mud = await buscarMudancero(waId);

    // Ubicación compartida (Twilio manda Latitude/Longitude, y a veces Address/Label).
    const lat = body.Latitude;
    const lng = body.Longitude;
    const ubicacion = lat && lng ? { lat, lng, direccion: body.Address || body.Label || '' } : null;

    // Recolectar adjuntos (Twilio manda NumMedia + MediaUrlN / MediaContentTypeN).
    const numMedia = parseInt(body.NumMedia || '0', 10) || 0;
    const imagenes = [];
    const audios = [];
    let hayOtro = false; // video u otro adjunto no soportado
    for (let i = 0; i < numMedia; i++) {
      const url = body[`MediaUrl${i}`];
      const tipo = body[`MediaContentType${i}`] || '';
      if (url && TIPOS_IMG.includes(tipo)) imagenes.push({ url, tipo });
      else if (url && tipo.startsWith('audio/')) audios.push({ url, tipo });
      else if (url) hayOtro = true;
    }

    // Transcribir audios (si hay servicio configurado) y sumarlos al texto.
    let textoFinal = texto;
    if (audios.length) {
      const partes = [];
      for (const a of audios) {
        const t = await transcribirAudio(a.url, a.tipo);
        if (t) partes.push(t);
      }
      if (partes.length) textoFinal = (textoFinal ? textoFinal + ' ' : '') + partes.join(' ');
    }

    if (!textoFinal && imagenes.length === 0 && !ubicacion) {
      if (audios.length) {
        // Había audio pero no se pudo transcribir (sin key o falló)
        return res
          .status(200)
          .send(twiml('Recibí tu audio 🎧, pero por ahora se me hace más fácil por escrito. ¿Me lo escribís, o me mandás una foto de lo que hay que mudar?'));
      }
      if (numMedia > 0 || hayOtro) {
        return res
          .status(200)
          .send(twiml('Por ahora puedo leer texto y fotos 📷. ¿Me lo contás por escrito o me mandás una foto de lo que hay que mover?'));
      }
      return res.status(200).send(twiml('Perdón, no te entendí. ¿Me lo repetís?'));
    }

    const respuesta = await generarRespuesta(waId, textoFinal, imagenes, ubicacion, mud);
    return res.status(200).send(twiml(respuesta));
  } catch (e) {
    console.error('Error webhook Twilio WhatsApp:', e);
    return res.status(200).send(twiml('Uy, tuve un problemita. Probá de nuevo en un momento 🙏'));
  }
};
