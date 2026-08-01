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
const { vencimientoHabilISO } = require('./_habiles'); // vencimiento en horas hábiles (igual que el web)

// Modo prueba: si está seteada, los pedidos del bot se publican SOLO para este
// mudancero (modo "dirigido"), así ningún mudancero real los ve mientras testeás.
// Vacío = pedido abierto a todos (comportamiento de producción).
const TEST_MUDANCERO_EMAIL = (process.env.TEST_MUDANCERO_EMAIL || '').toLowerCase().trim();
const SITE_URL = process.env.SITE_URL || 'https://mudateya.ar'; // para generar el link de pago (MP)

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
const SYSTEM_PROMPT = `Sos Emi, la asistente de MudateYa por WhatsApp. MudateYa es un marketplace argentino de mudanzas y fletes que le consigue presupuestos al cliente contactando mudanceros/fleteros verificados de su zona.

Del otro lado hay alguien que está por mudarse o necesita un flete. Mudarse estresa y muchos llegan medio perdidos o apurados: tu trabajo es hacérselo fácil, entender qué necesita y armar el pedido para que MudateYa le busque presupuestos. Que sienta que lo atiende alguien que sabe y le da bola, no un formulario.

CÓMO HABLÁS (esto es lo más importante):
- Rioplatense, natural, de vos. Como le escribís a un conocido: relajado pero prolijo.
- Mensajes cortos, de WhatsApp. A veces una sola línea. Nada de párrafos largos ni listas numeradas.
- CONVERSÁ, no interrogues. Primero reaccioná a lo que te dijo y recién después pedí lo que falta ("Uy, de Palermo a Tigre, buen viaje 🙂 ¿Para cuándo sería?"). Un dato por mensaje, como en una charla, no como un checklist.
- Enganchá lo que ya te contó: si arrancó con "me mudo el sábado de un 2 ambientes", no le vuelvas a preguntar eso.
- Variá. No repitas siempre las mismas frases y no saludes dos veces. Prohibido sonar armado: nada de "¿En qué puedo ayudarte hoy?", "Perfecto, procedo a…", "Entendido.".
- Un emoji de vez en cuando si pega, no en cada mensaje. Sin tono de folleto.
- Seguile la energía: si está apurado o cortante, al grano; si está perdido, guialo con paciencia; si está estresado, bajale un cambio ("tranqui, lo vemos juntos y en un rato lo dejás resuelto").

QUÉ NECESITÁS PARA ARMAR EL PEDIDO (juntalo charlando, no de un saque):
si es mudanza o flete, de dónde sale, a dónde va, más o menos cuándo, y qué hay que mover (ambientes, muebles grandes, electro, piso y si hay ascensor). Si te sirve para dimensionar, pedile una foto de lo que hay que mudar. Y el nombre. Con lo básico ya podés usar crear_pedido: no hace falta el detalle perfecto, mejor rápido y humano que exhaustivo.

No prometas precios: los ponen los mudanceros. Contá cómo funciona MudateYa solo cuando venga a cuento, no lo recites de entrada.

MUDANZA URGENTE (es hoy, mañana, o una emergencia): NO la hagas esperar el flujo normal de presupuestos. Hacé esto:
1. Bajale la ansiedad y decile que esto lo toma el equipo de MudateYa en persona para resolverlo rápido.
2. Juntá al toque solo lo mínimo: qué hay que mover, de dónde a dónde, y para cuándo exacto.
3. Cargá el pedido con crear_pedido y urgente: true.
4. Después derivá con derivar_a_humano, con el motivo empezando en "URGENTE:" y un resumen de una línea (ej: "URGENTE: mudanza hoy 18hs, Palermo→Caballito, 2 amb con heladera").
5. Cerrá avisando que alguien del equipo lo contacta a la brevedad por acá. No prometas horario ni precio.

EJEMPLOS DE TONO (son guía, NO los copies literal):
Cliente: "hola necesito mudarme"
Vos: "¡Hola! Dale, te doy una mano con eso 🙂 ¿De dónde a dónde sería?"
—
Cliente: "de caballito a villa urquiza el finde que viene, un 2 ambientes"
Vos: "Genial, anotado 👌 ¿Tenés muebles grandes o electro pesado tipo heladera/lavarropas? ¿Y de qué piso salís, hay ascensor?"
—
Cliente: "uf esto es un quilombo, no sé por dónde empezar"
Vos: "Tranqui, para eso estoy 🙌 Lo vamos viendo de a poco. ¿Arrancamos por a dónde te estás yendo a vivir?"

BASE DE CONOCIMIENTO (info real de MudateYa — usá esto, no inventes):
Qué es: marketplace argentino que conecta clientes con mudanceros y fleteros verificados. Comparás presupuestos gratis y sin compromiso.

Cómo funciona:
1. Cargás el pedido (origen, destino, fecha, ambientes/detalles; podés mandar fotos).
2. Va a mudanceros verificados de tu zona.
3. Recibís hasta 5 presupuestos por acá.
4. Elegís el que más te convenga y pagás la seña para reservar.
5. Coordinás con el mudancero.

Los 3 niveles de mudanza:
- Esencial: vehículo + chofer, carga y descarga. El embalaje lo hace el cliente.
- Integral (el más elegido): vehículo + chofer, embalaje básico incluido, desarmado y armado de muebles.
- Llave en Mano (todo incluido): todo lo de Integral + cajas y papel incluido + seguro ampliado + limpieza post-mudanza.
También hay fletes y servicio de mudanza urgente.

Precios y pagos:
- Solicitar y comparar presupuestos es GRATIS.
- El precio lo pone cada mudancero en su cotización: "el precio que acordás es el que pagás". NUNCA inventes montos.
- Pago: 50% de seña al reservar + 50% al completar la mudanza. Protegido por Mercado Pago (el mudancero cobra recién cuando la mudanza está hecha).
- Cada presupuesto vale 7 días.

Confianza y seguridad:
- Mudanceros verificados (DNI y vehículo). Reseñas reales de clientes.
- Opción de seguro de mudanza (ampliado en el nivel Llave en Mano).
- Tus datos quedan protegidos: solo se comparten con el mudancero que elegís.

Cobertura: CABA y Gran Buenos Aires; interior (Rosario, Córdoba, Mendoza) según disponibilidad.

Si te preguntan algo que no está en esta info (condiciones legales, detalles de seguro, un caso raro), NO inventes: usá derivar_a_humano.

HERRAMIENTAS QUE TENÉS:
- crear_pedido: cuando ya juntaste los datos del pedido.
- consultar_estado_pedido: si pregunta cómo va su mudanza/flete o si llegaron presupuestos. Podés leerle las cotizaciones (mudancero y precio).
- aceptar_cotizacion: cuando el cliente ELIGE una cotización. Devuelve la SEÑA (50%), el link de Mercado Pago y los datos de transferencia: pasáselos y explicale que el 50% restante lo paga al terminar y que la seña queda protegida. Si hay varias cotizaciones, confirmá cuál elige antes de aceptar.
- cancelar_pedido: si quiere cancelar. Confirmá con él ANTES de usarla.
- derivar_a_humano: si pide hablar con alguien, se frustra, o hay algo fuera de tu alcance. Después de derivar, decile que el equipo lo va a contactar.

REGLAS: no pidas datos sensibles (tarjetas, documentos). Si el mensaje no tiene que ver con esto, respondé amable y reconducí. Si te preguntan derecho si sos un bot o una persona, sé honesta y sin dramas ("soy la asistente virtual de MudateYa, pero te resuelvo igual 🙂") — nunca digas que sos una persona de carne y hueso.`;

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
      'Crea el pedido de mudanza/flete cuando ya tenés los datos: tipo, origen, destino, fecha y detalles. Marcá urgente=true si el cliente necesita mudarse hoy/mañana o es una emergencia.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['mudanza', 'flete'] },
        origen: { type: 'string' },
        destino: { type: 'string' },
        fecha: { type: 'string' },
        detalles: { type: 'string' },
        nombre: { type: 'string' },
        urgente: { type: 'boolean', description: 'true si es hoy/mañana o emergencia' },
      },
      required: ['tipo', 'origen', 'destino', 'fecha', 'detalles'],
    },
  },
  {
    name: 'consultar_estado_pedido',
    description:
      'Consultá el estado de los pedidos del cliente. Usala cuando pregunta cómo va su mudanza/flete, si llegaron presupuestos, o por un pedido anterior.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'cancelar_pedido',
    description:
      'Cancelá el pedido activo del cliente. IMPORTANTE: confirmá con el cliente ANTES de llamar a esta herramienta.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID del pedido a cancelar. Si no lo sabés, dejalo vacío y se cancela el más reciente activo.' },
      },
      required: [],
    },
  },
  {
    name: 'aceptar_cotizacion',
    description:
      'El cliente ELIGE y acepta una de las cotizaciones que recibió. Marca la mudanza como adjudicada y genera el pago de la SEÑA (50%): link de Mercado Pago + datos de transferencia. Usala cuando el cliente confirme a qué mudancero elige. Si hay varias cotizaciones y no queda claro cuál, preguntale antes de llamarla.',
    input_schema: {
      type: 'object',
      properties: {
        mudancero: { type: 'string', description: 'Nombre (o parte) del mudancero cuya cotización acepta. Si hay una sola cotización podés omitirlo.' },
        pedidoId: { type: 'string', description: 'ID del pedido; si no lo sabés, se usa el más reciente con cotizaciones.' },
      },
      required: [],
    },
  },
  {
    name: 'derivar_a_humano',
    description:
      'Derivá la conversación a una persona del equipo cuando el cliente lo pide, está frustrado/enojado, o hay algo que no podés resolver. Avisa al equipo.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Motivo breve de la derivación' },
      },
      required: ['motivo'],
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
// Intenta sacar la cantidad de ambientes del texto libre que junta Emi.
function parseAmbientes(detalles) {
  const t = String(detalles || '').toLowerCase();
  if (/monoambiente|mono ?ambiente|\b1 ?amb/.test(t)) return '1';
  const m = t.match(/(\d+)\s*(amb|ambiente|dorm|habitac)/);
  return m ? m[1] : '';
}

// MODO PRUEBA: avisar por mail SOLO al mudancero de test (nunca a reales).
// Solo corre si TEST_MUDANCERO_EMAIL está seteada. Fail-soft.
async function notificarMudanceroTest(pedido) {
  if (!TEST_MUDANCERO_EMAIL || !process.env.RESEND_API_KEY) return;
  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: 'MudateYa <noreply@mudateya.ar>',
      reply_to: 'hola@mudateya.ar',
      to: TEST_MUDANCERO_EMAIL,
      subject: `🧪 Pedido para cotizar — ${pedido.origen} → ${pedido.destino}`,
      html:
        `<p>Entró un pedido para cotizar (modo prueba).</p>` +
        `<p><b>${escapeXml(pedido.tipo)}</b>: ${escapeXml(pedido.origen)} → ${escapeXml(pedido.destino)}<br>` +
        `Fecha: ${escapeXml(pedido.fecha || '—')}<br>` +
        `Detalles: ${escapeXml(pedido.detalles || '—')}</p>` +
        `<p><a href="https://mudateya.ar/mi-cuenta">Entrá a tu cuenta para cotizar →</a></p>`,
    });
  } catch (e) { console.warn('notificarMudanceroTest:', e.message); }
}

async function crearPedido(input, waId, ubicaciones) {
  const id = nuevoId();
  const ahora = new Date();
  const nombre = input.nombre || '';

  // Pedido UNIFICADO: un solo objeto que sirve a los dos sistemas.
  //   - Bot (WhatsApp): origen/destino/vence/detalles → consultar_estado y cancelar.
  //   - Marketplace web: desde/hasta/expira/zonaBase/estado 'buscando' + índice
  //     mudanzas:activas → el mudancero lo ve y cotiza desde su cuenta (por-zona).
  // Con TEST_MUDANCERO_EMAIL el pedido va en modo "dirigido" solo a ese mudancero,
  // así ningún mudancero real lo ve mientras se prueba.
  const dirigido = !!TEST_MUDANCERO_EMAIL;
  const pedido = {
    id,
    // — vista bot —
    tipo: input.tipo,
    origen: input.origen,
    destino: input.destino,
    fecha: input.fecha,
    detalles: input.detalles,
    cliente: { nombre, whatsapp: waId },
    ubicaciones: Array.isArray(ubicaciones) ? ubicaciones : [], // coords compartidas (geo-match)
    canal: 'whatsapp',
    urgente: !!input.urgente, // mudanza urgente → la toma el equipo a mano
    vence: new Date(ahora.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    // — vista web (marketplace / cotización del mudancero) —
    clienteNombre: nombre,
    clienteWA: waId,
    clienteEmail: `wa-${String(waId).replace(/\D/g, '')}@wa.mudateya.ar`, // sintético: el cliente WA no tiene email
    desde: input.origen,
    hasta: input.destino,
    zonaBase: input.origen,
    ambientes: parseAmbientes(input.detalles),
    nivel: input.tipo === 'flete' ? 'flete' : null,
    servicios: [],
    extras: [],
    fotos: [],
    detallesAdicionales: input.detalles ? { comentario: String(input.detalles).slice(0, 500) } : null,
    modoCotizacion: dirigido ? 'dirigido' : 'abierto',
    mudancerosInvitados: dirigido ? [TEST_MUDANCERO_EMAIL] : [],
    maxCotizaciones: 50,
    fechaPublicacion: ahora.toISOString(),
    expira: vencimientoHabilISO(24),
    // — común —
    estado: 'buscando', // estado del marketplace web (lo que muestra por-zona)
    cotizaciones: [],
    creado: ahora.toISOString(),
  };
  await setJSON(`mudanza:${id}`, pedido, 60 * 60 * 24 * 7);

  // Índice de pedidos por cliente WA (para consultar_estado_pedido / cancelar_pedido).
  try {
    const ids = (await getJSON(`cliente:pedidos:${waId}`)) || [];
    ids.push(id);
    await setJSON(`cliente:pedidos:${waId}`, ids, 60 * 60 * 24 * 30);
  } catch (_) {}

  // Índices del marketplace web: mudanzas:activas (lo lee por-zona) + mudanzas:todos (admin).
  try {
    const activas = (await getJSON('mudanzas:activas')) || [];
    if (!activas.includes(id)) activas.push(id);
    await setJSON('mudanzas:activas', activas, 60 * 60 * 24 * 7);
    const todos = (await getJSON('mudanzas:todos')) || [];
    if (!todos.includes(id)) todos.push(id);
    await setJSON('mudanzas:todos', todos);
  } catch (e) { console.warn('índice marketplace:', e.message); }

  // Barrido a mudanceros reales: sigue APAGADO (no manda nada a nadie real).
  await iniciarBarridoMudanceros(pedido);
  // Solo en modo prueba: aviso por mail al mudancero de test (mudatest).
  await notificarMudanceroTest(pedido);
  return pedido;
}

// ------------------------------------------------------------------
// Herramientas del agente (además de crear_pedido)
// ------------------------------------------------------------------
async function pedidosDelCliente(waId) {
  const ids = (await getJSON(`cliente:pedidos:${waId}`)) || [];
  const pedidos = [];
  for (const id of ids.slice(-5)) {
    const p = await getJSON(`mudanza:${id}`);
    if (p) pedidos.push(p);
  }
  return pedidos;
}
function resumenPedido(p) {
  const cots = Array.isArray(p.cotizaciones) ? p.cotizaciones : [];
  return {
    id: p.id,
    tipo: p.tipo,
    origen: p.origen,
    destino: p.destino,
    fecha: p.fecha,
    estado: p.estado,
    // Detalle de las cotizaciones recibidas, para que Emi se las pueda leer al
    // cliente ("te cotizó Juan $80.000"). El precio sale del modelo nuevo
    // (propuestas[]) o del campo plano viejo.
    cotizaciones: cots.map((c) => ({
      mudancero: c.mudanceroNombre || '',
      precio: c.precio || (Array.isArray(c.propuestas) && c.propuestas[0] && c.propuestas[0].precio) || 0,
      tiempo: c.tiempoEstimado || '',
      nota: c.nota || '',
    })),
    vence: p.vence,
  };
}
async function cancelarPedidoCliente(waId, id) {
  const pedidos = await pedidosDelCliente(waId);
  let target = id ? pedidos.find((p) => p.id === id) : null;
  if (!target) {
    target = pedidos.reverse().find((p) => p.estado && p.estado !== 'cancelado' && p.estado !== 'completado');
  }
  if (!target) return { ok: false, mensaje: 'No encontré un pedido activo para cancelar.' };
  target.estado = 'cancelado';
  target.canceladoEn = new Date().toISOString();
  await setJSON(`mudanza:${target.id}`, target, 60 * 60 * 24 * 3);
  return { ok: true, id: target.id, mensaje: 'Pedido cancelado.' };
}
async function derivarHumano(waId, motivo, conv) {
  try {
    const { Resend } = require('resend');
    const adminMail = process.env.ADMIN_EMAIL;
    if (process.env.RESEND_API_KEY && adminMail) {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const ultimos = (conv.messages || [])
        .slice(-6)
        .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : '[media]'}`)
        .join('\n');
      const esUrgente = /urgente/i.test(motivo || '');
      await resend.emails.send({
        from: 'MudateYa <noreply@mudateya.ar>',
        reply_to: 'hola@mudateya.ar',
        to: adminMail,
        subject: esUrgente ? `🚨 MUDANZA URGENTE — ${waId}` : `🙋 Cliente pide atención humana — ${waId}`,
        html:
          `<p>El cliente <b>${escapeXml(waId)}</b> ${esUrgente ? 'tiene una <b>mudanza URGENTE</b> y necesita que el equipo lo tome ya' : 'pidió hablar con una persona'} por WhatsApp.</p>` +
          `<p><b>Motivo:</b> ${escapeXml(motivo || '-')}</p>` +
          `<pre style="background:#f5f5f5;padding:10px;border-radius:8px;white-space:pre-wrap">${escapeXml(ultimos)}</pre>` +
          `<p><a href="https://wa.me/${String(waId).replace(/\D/g, '')}">Abrir WhatsApp del cliente →</a></p>`,
      });
    }
  } catch (e) {
    console.warn('derivarHumano email:', e.message);
  }
  return { ok: true, mensaje: 'Avisé al equipo. Alguien te va a contactar a la brevedad.' };
}

// Datos bancarios FIJOS (fallback si el endpoint de transferencias no responde).
function datosTransferencia() {
  return {
    cbu: process.env.TRANSFER_CBU || '',
    alias: process.env.TRANSFER_ALIAS || '',
    titular: process.env.TRANSFER_TITULAR || 'MudateYa',
    cuit: process.env.TRANSFER_CUIT || '',
  };
}

// Datos de transferencia para la seña, reusando /api/transferencias?action=datos.
// Con Talo configurado devuelve un CVU/alias ÚNICO para esta operación (se
// concilia solo por webhook). Si Talo no está, ese endpoint cae al CBU fijo.
async function obtenerDatosTransferencia(mudanzaId) {
  try {
    const url = `${SITE_URL}/api/transferencias?action=datos&mudanzaId=${encodeURIComponent(mudanzaId)}&tipoPago=anticipo`;
    const r = await fetch(url);
    if (!r.ok) { console.warn('transferencias?datos', r.status); return null; }
    const d = await r.json();
    if (!d || !d.ok || !d.banco) return null;
    return {
      cbu: d.banco.cbu || '',
      alias: d.banco.alias || '',
      titular: d.banco.titular || 'MudateYa',
      cuit: d.banco.cuit || '',
      monto: d.monto,
      expira: d.expira || '',
      referencia: d.referencia || '',
      automatico: !!d.automatico, // true = CVU único de Talo (confirmación automática)
      checkoutUrl: d.checkoutUrl || '', // link/QR de Talo con el monto YA cargado
    };
  } catch (e) { console.warn('obtenerDatosTransferencia:', e.message); return null; }
}

// Genera el link de pago de Mercado Pago reusando el endpoint crear-preferencia.
async function generarLinkMP({ mudanceroNombre, monto, desde, hasta, ambientes, mudanzaId, cotizacionId }) {
  try {
    const r = await fetch(`${SITE_URL}/api/crear-preferencia`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mudanceroNombre, monto, desde, hasta, ambientes, mudanzaId, cotizacionId, tipoPago: 'anticipo' }),
    });
    if (!r.ok) { console.warn('crear-preferencia', r.status); return null; }
    const d = await r.json();
    return d.init_point || d.sandbox_url || null;
  } catch (e) { console.warn('generarLinkMP:', e.message); return null; }
}

// El cliente acepta una cotización → adjudica la mudanza y arma el pago de la seña (50%).
async function aceptarCotizacionCliente(waId, mudanceroNombre, pedidoId) {
  const pedidos = await pedidosDelCliente(waId);
  let pedido = pedidoId ? pedidos.find((p) => p.id === pedidoId) : null;
  if (!pedido) {
    pedido = pedidos.reverse().find(
      (p) => Array.isArray(p.cotizaciones) && p.cotizaciones.length &&
             ['buscando', 'cotizaciones_completas'].includes(p.estado)
    );
  }
  if (!pedido) return { ok: false, mensaje: 'No encontré un pedido tuyo con cotizaciones para aceptar.' };

  const cots = (pedido.cotizaciones || []).filter((c) => c && c.estado !== 'rechazada');
  if (!cots.length) return { ok: false, mensaje: 'Todavía no llegaron cotizaciones para ese pedido.' };

  // Elegir la cotización por nombre del mudancero, o la única que haya.
  let cot = null;
  if (mudanceroNombre) {
    const q = String(mudanceroNombre).toLowerCase();
    cot = cots.find((c) => (c.mudanceroNombre || '').toLowerCase().includes(q));
  }
  if (!cot && cots.length === 1) cot = cots[0];
  if (!cot) {
    return {
      ok: false,
      necesita_eleccion: true,
      opciones: cots.map((c) => ({ mudancero: c.mudanceroNombre, precio: c.precio })),
      mensaje: 'Hay varias cotizaciones. Preguntale al cliente cuál elige (por el nombre del mudancero) antes de aceptar.',
    };
  }

  // Adjudicar (misma lógica esencial que el "aceptar" del web).
  pedido.estado = 'cotizacion_aceptada';
  pedido.cotizacionAceptada = cot;
  pedido.mudanceroAceptado = cot.mudanceroEmail;
  pedido.montoTotal = cot.precio;
  cot.estado = 'aceptada';
  await setJSON(`mudanza:${pedido.id}`, pedido, 60 * 60 * 24 * 7);

  const sena = Math.round(Number(cot.precio || 0) * 0.5);
  const link = await generarLinkMP({
    mudanceroNombre: cot.mudanceroNombre,
    monto: sena,
    desde: pedido.desde || pedido.origen,
    hasta: pedido.hasta || pedido.destino,
    ambientes: pedido.ambientes || '',
    mudanzaId: pedido.id,
    cotizacionId: cot.id,
  });
  // Transferencia: con Talo, CVU/alias ÚNICO para esta seña (se concilia solo).
  let transf = await obtenerDatosTransferencia(pedido.id);
  if (!transf) {
    const b = datosTransferencia();
    if (b.cbu || b.alias) transf = { ...b, automatico: false };
  }

  return {
    ok: true,
    mudancero: cot.mudanceroNombre,
    precio_total: cot.precio,
    sena,
    link_pago_mp: link,
    transferencia: transf,
    nota: 'Cotización aceptada. Pasale al cliente el monto de la SEÑA (50%) y las formas de pago. Para transferencia, si transferencia.checkoutUrl viene, ese es un link de Talo con el MONTO YA CARGADO: ofrecelo como la mejor opción ("así no te equivocás con el importe"). Si no hay checkoutUrl, pasale el CBU/alias y decile que transfiera EXACTAMENTE ese monto. También está el link de Mercado Pago (monto fijo). Aclarale que el 50% restante se paga al completar y que la seña queda protegida. Si no vino ninguna forma de pago, decile que en un momento le pasás cómo pagar y usá derivar_a_humano.',
  };
}

// Ejecuta una herramienta y devuelve el resultado (string) que Claude interpreta.
async function ejecutarTool(name, input, waId, conv) {
  try {
    if (name === 'crear_pedido') {
      const pedido = await crearPedido(input, waId, conv.ubicaciones);
      const nota = pedido.urgente
        ? 'Pedido URGENTE creado. Ahora derivá al equipo con derivar_a_humano (motivo que empiece con "URGENTE:") para que lo tomen a mano ya. No prometas horario ni precio.'
        : 'Pedido creado; salimos a buscar hasta 5 presupuestos de mudanceros cercanos. Vale 24hs.';
      return JSON.stringify({ ok: true, id: pedido.id, tipo: pedido.tipo, estado: pedido.estado, urgente: pedido.urgente, nota });
    }
    if (name === 'consultar_estado_pedido') {
      const pedidos = await pedidosDelCliente(waId);
      if (!pedidos.length) return JSON.stringify({ pedidos: [], nota: 'El cliente no tiene pedidos cargados.' });
      return JSON.stringify({ pedidos: pedidos.map(resumenPedido) });
    }
    if (name === 'cancelar_pedido') {
      return JSON.stringify(await cancelarPedidoCliente(waId, input && input.id));
    }
    if (name === 'aceptar_cotizacion') {
      return JSON.stringify(await aceptarCotizacionCliente(waId, input && input.mudancero, input && input.pedidoId));
    }
    if (name === 'derivar_a_humano') {
      return JSON.stringify(await derivarHumano(waId, input && input.motivo, conv));
    }
    return JSON.stringify({ error: 'herramienta desconocida' });
  } catch (e) {
    console.error('ejecutarTool', name, e.message);
    return JSON.stringify({ error: 'Ocurrió un error ejecutando ' + name });
  }
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
  let trabajo = historial.concat([{ role: 'user', content: contenidoActual }]);

  // Elegimos system + herramientas según sea mudancero, equipo o cliente.
  let system, toolsUsados;
  if (mudancero) {
    const nombre = (mudancero.nombre || '').split(' ')[0] || 'colega';
    system = SYSTEM_PROMPT_MUDANCERO.replace('{NOMBRE}', nombre);
    toolsUsados = []; // el mudancero todavía no tiene herramientas
  } else {
    const persona = quienEscribe(waId);
    system = persona
      ? `${SYSTEM_PROMPT}\n\nCONTEXTO: quien te escribe es ${persona}, del equipo fundador de MudateYa. Tratalo por su nombre, con confianza y cercanía; no le expliques qué es MudateYa como si fuera un cliente nuevo.`
      : SYSTEM_PROMPT;
    toolsUsados = tools;
  }

  // Loop agéntico: Claude puede encadenar herramientas hasta dar la respuesta final.
  let resp = await askClaude(trabajo, system, toolsUsados);
  let vueltas = 0;
  while (resp.stop_reason === 'tool_use' && vueltas < 5) {
    vueltas++;
    trabajo = trabajo.concat([{ role: 'assistant', content: resp.content }]);
    const resultados = [];
    for (const block of resp.content || []) {
      if (block.type === 'tool_use') {
        const r = await ejecutarTool(block.name, block.input, waId, conv);
        resultados.push({ type: 'tool_result', tool_use_id: block.id, content: r });
      }
    }
    trabajo = trabajo.concat([{ role: 'user', content: resultados }]);
    resp = await askClaude(trabajo, system, toolsUsados);
  }
  const salida =
    (resp.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
      .trim() || 'Perdón, no te entendí bien. ¿Me lo repetís?';

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
