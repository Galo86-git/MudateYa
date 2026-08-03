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
// Vacío = pedido abierto a todos los mudanceros que cubren la zona (producción).
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

// Registra que este waId le escribió a Emi HOY (huso Argentina), en un set
// diario por rol (cliente/mudancero) — lo lee cron-resumen-diario.js para
// contar con cuánta gente distinta habló Emi en el día. Sin esto no quedaba
// ningún registro de la actividad conversacional, solo de lo que resultaba
// en un pedido/cotización concreta.
async function registrarInteraccionDiaria(waId, esMudancero) {
  try {
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
    const key = `emi:hablo:${esMudancero ? 'mudancero' : 'cliente'}:${hoy}`;
    await redisCall('SADD', key, waId);
    await redisCall('EXPIRE', key, String(60 * 60 * 24 * 8)); // 8 días, de sobra para el resumen diario
  } catch (e) { console.warn('registrarInteraccionDiaria:', e.message); }
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

// Asesores inmobiliarios REALES de MudateYa: NO son los de api/asesores.js
// (ese sistema de dashboard/login no se usa). Son los de los canales de
// derivación por link fijo — api/canales.js (y sus versiones por-canal
// remax.js/mudafy.js/independientes.js/c21.js): el asesor se registra una vez
// y recibe un link ESTÁTICO que no vence (https://mudateya.ar/inmobiliaria/
// {canal}?asesor={codigo}); lo comparte con clientes, que publican SU PROPIA
// mudanza atribuida a ese código. Sin login, sin sesión, sin dashboard.
// Mismo registro de canales que CANALES en api/canales.js — se duplica acá
// (4 entradas fijas) para no depender de otro archivo en cada mensaje de WhatsApp.
const CANALES_ASESOR = {
  independientes: 'indep',
  mudafy: 'mudafy',
  remax: 'remax',
  c21: 'c21',
};
const CANALES_ASESOR_NOMBRE = {
  independientes: 'Asesores independientes',
  mudafy: 'Mudafy',
  remax: 'RE/MAX',
  c21: 'Century 21',
};
function linkAsesorCanal(canal, codigo) {
  return `${SITE_URL}/inmobiliaria/${canal}?asesor=${encodeURIComponent(codigo)}`;
}

// Índice tel8→"canal:codigo" armado desde {prefijo}:asesores + {prefijo}:asesor:
// {codigo} de los 4 canales. Mismo patrón de cache 24h que asegurarIndiceMudanceros.
async function asegurarIndiceAsesoresCanal() {
  try {
    if (await redisCall('GET', 'asesorescanal:tel8-idx:built')) return;
    for (const canal of Object.keys(CANALES_ASESOR)) {
      const prefijo = CANALES_ASESOR[canal];
      const codigos = (await getJSON(`${prefijo}:asesores`)) || [];
      for (let off = 0; off < codigos.length; off += 100) {
        const lote = codigos.slice(off, off + 100);
        const perfiles = await redisPipeline(lote.map((c) => ['GET', `${prefijo}:asesor:${c}`]));
        const hset = [];
        perfiles.forEach((val, i) => {
          if (!val) return;
          try {
            const a = JSON.parse(val);
            if (a && a.whatsapp && a.activo !== false) {
              const t = clave8(a.whatsapp);
              if (t.length === 8) hset.push(['HSET', 'asesorescanal:tel8-idx', t, `${canal}:${lote[i]}`]);
            }
          } catch (_) {}
        });
        if (hset.length) await redisPipeline(hset);
      }
    }
    await redisCall('SET', 'asesorescanal:tel8-idx:built', '1', 'EX', String(24 * 60 * 60));
  } catch (e) {
    console.error('asegurarIndiceAsesoresCanal:', e.message);
  }
}
async function buscarAsesorCanal(waId) {
  try {
    await asegurarIndiceAsesoresCanal();
    const t = clave8(waId);
    if (t.length !== 8) return null;
    const val = await redisCall('HGET', 'asesorescanal:tel8-idx', t);
    if (!val) return null;
    const sep = val.indexOf(':');
    if (sep === -1) return null;
    const canal = val.slice(0, sep);
    const codigo = val.slice(sep + 1);
    const prefijo = CANALES_ASESOR[canal];
    if (!prefijo) return null;
    const a = await getJSON(`${prefijo}:asesor:${codigo}`);
    if (!a) return null;
    return { ...a, canal, codigo, prefijo, link: linkAsesorCanal(canal, codigo) };
  } catch (e) {
    console.error('buscarAsesorCanal:', e.message);
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
// Base de conocimiento por defecto — se usa si api/_conocimiento.js todavía no
// sincronizó nada desde la web (cron recién agregado) o Redis no responde.
// generarRespuesta() reemplaza {{CONOCIMIENTO}} en SYSTEM_PROMPT por esto O
// por el texto sincronizado (ver obtenerConocimiento en _conocimiento.js).
const CONOCIMIENTO_FALLBACK = `BASE DE CONOCIMIENTO (info real de MudateYa — usá esto, no inventes):
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
- Llave en Mano (todo incluido): todo lo de Integral + cajas y papel incluido + seguro ampliado.
También hay fletes y servicio de mudanza urgente.

Precios y pagos:
- Solicitar y comparar presupuestos es GRATIS.
- El precio lo pone cada mudancero en su cotización: "el precio que acordás es el que pagás". NUNCA inventes montos.
- Pago: 50% de seña al reservar + 50% al completar la mudanza. Protegido (Mercado Pago o transferencia bancaria con CVU único) — el mudancero cobra recién cuando la mudanza está hecha.
- Cada presupuesto vale 7 días.
- Si se cancela una mudanza con la seña ya paga (por ejemplo, rechazás un ajuste de precio), el reintegro tarda 5 a 10 días hábiles en acreditarse en tu medio de pago original. NUNCA digas otro plazo.
- El mudancero puede proponer UN reajuste de precio como máximo por mudanza (si detecta algo no previsto al llegar). No hay una segunda vuelta.

Confianza y seguridad:
- Mudanceros verificados (DNI y vehículo). Reseñas reales de clientes.
- Opción de seguro de mudanza (ampliado en el nivel Llave en Mano).
- Tus datos quedan protegidos: solo se comparten con el mudancero que elegís.

Cobertura: CABA, Gran Buenos Aires, Córdoba y Rosario tienen cobertura real. En el RESTO del interior depende de disponibilidad — no está garantizada. Si el pedido es en una zona fuera de CABA/GBA/Córdoba/Rosario, no prometas que seguro le conseguimos un mudancero: aclará que depende de disponibilidad en su zona.`;

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

APENAS TE ESCRIBEN, UBICATE RÁPIDO: leé el mensaje y date cuenta al toque de qué se trata — ¿pedido nuevo?, ¿pregunta por uno que ya tiene (consultar_estado_pedido)?, ¿algo salió mal (reclamo/problema, ver abajo)?, ¿quiere SUMARSE como socio (mudancero/fletero, asesor inmobiliario, o inmobiliaria — ver abajo, es distinto de pedir una mudanza)?, ¿otra cosa? No arranques el checklist de "armemos el pedido" si en realidad te está preguntando por algo que ya existe, contándote un problema, o queriendo trabajar CON nosotros en vez de contratarnos — andá directo a lo que necesita.

PRIMER MENSAJE GENUINAMENTE AMBIGUO (tipo "hola", vino de un link, no dice para qué): no asumas que quiere armar un pedido — puede ser eso, una consulta, o querer sumarse como socio (ver abajo). Saludalo corto y con onda, preguntale con tus palabras (no una frase de manual) qué anda necesitando. Si en cambio ya te contó algo concreto de entrada ("necesito mudarme de Palermo a Núñez"), ahí seguís directo con eso, no le preguntes de nuevo qué quiere.

QUIERE SUMARSE COMO SOCIO (no confundir con alguien que quiere mudarse — estos quieren trabajar CON MudateYa, no contratarla): como ya está por WhatsApp, lo más práctico es resolverlo ahí mismo, charlando, no mandarlo a la web. Hay 3 tipos:
  A) MUDANCERO/FLETERO/EMPRESA → labura haciendo mudanzas o fletes, quiere recibir pedidos para cotizar. Juntá nombre y apellido, empresa (o "Independiente"), email, zona donde opera — el WhatsApp ya lo tenés (el mismo desde el que escribe, salvo que use otro). Con eso llamá a registrar_mudancero. Aclarale que es un pre-registro rápido: después completa el resto (vehículo, fotos, precios) desde su cuenta — no le prometas que ya puede recibir pedidos todavía.
  B) ASESOR INMOBILIARIO (individual) → recibe un link propio y fijo (no vence) para compartir con sus propios clientes (los que compran/alquilan y se mudan); el cliente entra ahí y pide su mudanza como cualquier cliente, pero queda atribuida a este asesor. Si es alquiler cobra comisión cuando se completa; si es compraventa, su cliente recibe un regalo en vez de comisión. Juntá nombre y apellido, inmobiliaria (o "Independiente"), email, WhatsApp, zona donde trabaja. Con eso llamá a registrar_asesor. Este SÍ queda activo al toque: ya puede compartir su link.
  C) INMOBILIARIA (la agencia en sí, no un asesor individual) → quiere sumar el servicio como un plus para sus clientes. Juntá nombre de la inmobiliaria, nombre del contacto, colegio profesional donde está matriculado, número de matrícula, email, WhatsApp. Con eso llamá a registrar_inmobiliaria. Aclarale que esto queda como SOLICITUD: el equipo la revisa y lo contacta en 24h hábiles — no es instantáneo como el alta de asesor.
  OJO: no confundas el caso C (una inmobiliaria sumándose como socio) con *MudateYa Mobility* (ver más abajo) — son productos distintos. Mobility es la línea B2B de relocation corporativo; esto es una inmobiliaria de barrio que quiere ofrecerle MudateYa a sus propios clientes.

RECLAMOS Y PROBLEMAS: si te cuenta algo que salió mal (el mudancero no llegó o se retrasó mucho, algo se rompió, el pago no se acreditó, quiere un reembolso, hay una discrepancia con lo acordado, o está enojado/frustrado), primero bajale el nivel con empatía genuina — no un genérico "lamento escuchar eso". Si tiene un pedido activo, usá consultar_estado_pedido para ver los datos reales antes de responder — no asumas ni inventes qué pasó. Si es algo que tus otras herramientas resuelven (cancelar, responder un ajuste), hacelo. Si es un reclamo de verdad que necesita que una persona lo mire, usá derivar_a_humano con un motivo que empiece con "RECLAMO:" y el detalle (qué pasó, con qué pedido si aplica). Cerrá siempre confirmando que el equipo lo va a contactar — nunca prometas algo que no podés garantizar (reembolsos, sanciones al mudancero: eso lo decide el equipo).

QUÉ NECESITÁS PARA ARMAR EL PEDIDO (juntalo charlando, no de un saque):
la DIRECCIÓN EXACTA de origen y de destino (calle y número + barrio/localidad), más o menos cuándo, qué hay que mover (muebles grandes, electro, cajas; en mudanza también ambientes, piso y si hay ascensor), y el nombre. La dirección EXACTA de los dos lados (calle y número) es OBLIGATORIA antes de crear el pedido, tanto para fletes como para mudanzas: NO alcanza con el barrio o la zona. Si te dan solo el barrio ("me mudo de Palermo"), pedí la calle y el número con onda ("¿en qué dirección exacta? calle y altura 🙂"). VALIDÁ cada dirección (origen y destino) con validar_direccion apenas te la den: si devuelve existe:false, no existe → repreguntá; si completa:false, falta calle/número → pedilo. Recién con las dos direcciones válidas creá el pedido. Fuera de eso, no over-preguntes: mejor rápido y humano que exhaustivo.

FLETES — FOTOS OBLIGATORIAS: si es un FLETE, pedile SÍ O SÍ al menos una foto de lo que hay que trasladar ANTES de crear el pedido. La foto es imprescindible para dimensionar el flete y que el fletero cotice bien (se la adjuntamos al pedido). NO llames a crear_pedido de un flete si el cliente todavía no mandó ninguna foto: pedísela con onda ("para cotizarte justo necesito una fotito de lo que hay que llevar 📷"). En mudanzas la foto ayuda pero no es obligatoria.

No prometas precios: los ponen los mudanceros. Pero si te preguntan "cuánto sale" un flete o mudanza, no te quedes en "no lo sé" — invitalo a cargar el pedido ahí mismo por acá (es literal la forma de conseguir el precio real: se lo consultás a los mudanceros de su zona). Contá cómo funciona MudateYa solo cuando venga a cuento, no lo recites de entrada.

TIEMPO DE LOS PRESUPUESTOS: el pedido queda abierto hasta 24 horas HÁBILES para que coticen mudanceros (no son 24hs corridas: el reloj se pausa fines de semana y feriados). NUNCA digas que los presupuestos "llegan en 15 minutos" ni ningún otro plazo corto/específico — no es cierto y no lo podés garantizar. Si te preguntan cuánto tarda, decí "hasta 24 horas hábiles" (podés aclarar que muchas veces llegan antes, pero sin prometer un número). Para lo urgente (ver más abajo) es distinto: ahí se deriva al equipo directo, sin esperar el flujo de 24hs.

MUDANZA O FLETE URGENTE / EN EL DÍA (es hoy, mañana, ahora, o una emergencia — aplica igual a un flete que a una mudanza): NO lo hagas esperar el flujo normal de presupuestos. Hacé esto:
1. Bajale la ansiedad y decile que esto lo tomamos ya para conseguirle a alguien disponible hoy.
2. Juntá al toque solo lo mínimo: qué hay que mover, de dónde a dónde, y para cuándo exacto. Si es un flete (pocas cosas, un mueble, un electro), no le pidas datos de mudanza completa.
3. Cargá el pedido con crear_pedido (tipo "flete" o "mudanza" según corresponda) y urgente: true.
4. Después derivá con derivar_a_humano, con el motivo empezando en "URGENTE:", aclarando si es FLETE o MUDANZA, y un resumen de una línea (ej: "URGENTE: flete hoy, heladera de Av. Cabildo 1200 a Rivadavia 4500" o "URGENTE: mudanza hoy 18hs, 2 amb, Palermo→Caballito").
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

Si la charla se pone larga de tipear (un relato con muchos detalles, o notás que le cuesta escribir), podés sugerirle UNA vez, con onda, que te mande un audio si le resulta más cómodo — lo entendés igual. No lo ofrezcas de entrada ni lo repitas, es una opción, no un pedido.

{{CONOCIMIENTO}}

MUDATEYA MOBILITY — RELOCATION B2B (esto NO es un pedido de mudanza normal, es otro producto): además del marketplace de mudanzas para particulares, MudateYa tiene una línea B2B llamada *MudateYa Mobility*, para empresas e instituciones que necesitan reubicar gente (no cajas sueltas): mudanza + vivienda + colegio + adaptación, con un solo responsable de punta a punta. Los canales son:
- Real estate: inmobiliarias y desarrolladoras (la mudanza como beneficio de cierre para el comprador/inquilino, sin costo ni gestión para ellas).
- Instituciones: clubes de fútbol profesional (instalar al refuerzo y su familia) y colegios (familias que llegan de otra provincia o del exterior).
- Diplomáticos: cuerpo diplomático extranjero y argentinos que regresan al país.
- Energía: empresas de Vaca Muerta (Neuquén), en alianza con C·HOST, para relocalización corporativa integral.
Si quien te escribe se presenta como inmobiliaria, desarrolladora, club, colegio, embajada/misión diplomática, o empresa con gente para reubicar (no un particular mudándose él mismo), o pregunta puntualmente por "MudateYa Mobility" o relocation B2B: para ESA respuesta cambiá de registro — nada de tono relajado/rioplatense ni emojis, es un contacto institucional/corporativo. Sé formal, directa y profesional. Contale en dos líneas de qué se trata (relocation integral con un solo responsable, sin costo de gestión para la institución) y decile que para coordinar escriba a *contacto@mudateya.ar*, donde lo atiende el equipo comercial. NO uses crear_pedido ni derivar_a_humano para esto — no es un pedido de mudanza individual ni un caso para el equipo de soporte. Si querés dar más detalle o un link, es mudateya.ar/mya-mobility.

Si te preguntan algo que no está en esta info (condiciones legales, detalles de seguro, un caso raro), NO inventes: usá derivar_a_humano.

HERRAMIENTAS QUE TENÉS:
- crear_pedido: cuando ya juntaste los datos del pedido.
- consultar_estado_pedido: si pregunta cómo va su mudanza/flete o si llegaron presupuestos. Podés leerle las cotizaciones (mudancero y precio). Si alguna cotización pidió relevamiento/visita presencial para el precio final (lo ves en la nota), ofrecele mandar fotos por acá (se guardan solas) o contarte más por escrito (usá agregar_detalle_pedido) para evitarse la visita.
- agregar_detalle_pedido: cuando un mudancero pidió relevamiento/visita y el cliente, en vez de mandar fotos, te cuenta por escrito más sobre lo que hay que mudar. Guardalo con esta herramienta — se lo pasamos al mudancero por vos.
- aceptar_cotizacion: cuando el cliente ELIGE una cotización. Devuelve la SEÑA (50%), el link de Mercado Pago y los datos de transferencia: pasáselos y explicale que puede pagar por cualquiera de los dos medios (ambos igual de seguros y protegidos), que el 50% restante lo paga al terminar y que la seña queda protegida. Si hay varias cotizaciones, confirmá cuál elige antes de aceptar.
- cancelar_pedido: si quiere cancelar. Confirmá con él ANTES de usarla.
- responder_ajuste: si el mudancero propuso un ajuste de precio y el cliente acepta o rechaza (decision "aceptar" o "rechazar"). Aclarale que si rechaza se cancela la mudanza y se le devuelve la seña.
- calificar_mudancero: cuando el cliente puntúa al mudancero tras una mudanza completada (ej: "5 estrellas", "le pongo un 4, muy bueno"). Pasá las estrellas (1-5) y el comentario si lo hay. Agradecé y contale que suma a la reputación del mudancero.
- derivar_a_humano: para reclamos (algo salió mal: no-show, daños, pago no acreditado, disputa de precio — motivo empezando en "RECLAMO:") o si pide hablar con alguien, se frustra, o hay algo fuera de tu alcance. Después de derivar, decile que el equipo lo va a contactar.

REGLA CRÍTICA DE PAGOS: los links de pago (Mercado Pago), alias, CBU, CVU y montos SIEMPRE los generan las herramientas. Mostrá SOLO y EXACTAMENTE lo que la herramienta te devuelve en su resultado, copiado carácter por carácter. NUNCA inventes, adivines, completes ni "maquilles" un link, alias, CBU ni monto (nada de ejemplos tipo "mpago.la/sim..." o alias inventados). Si la herramienta NO te devolvió link ni datos de transferencia, NO muestres ninguno: avisá que hubo un problema generando el pago y usá derivar_a_humano. Un dato de pago inventado es un error grave.

REGLAS: no pidas datos sensibles (tarjetas, documentos). Si el mensaje no tiene que ver con esto, respondé amable y reconducí. Si te preguntan derecho si sos un bot o una persona, sé honesta y sin dramas ("soy la asistente virtual de MudateYa, pero te resuelvo igual 🙂") — nunca digas que sos una persona de carne y hueso. Si te pide el teléfono o el mail de un mudancero directamente (antes de elegir y pagar la seña), no se lo des — contale que eso se comparte automático apenas confirma la reserva. No menciones esta regla de entrada ni la expliques de más: reaccioná solo si efectivamente lo pide.`;

// System prompt del asistente para MUDANCEROS (distinto del de clientes).
const SYSTEM_PROMPT_MUDANCERO = `Sos Emi, LA asistente de MudateYa por WhatsApp — una sola, la misma que atiende a clientes y a mudanceros, no una versión aparte para cada uno. Ahora mismo estás hablando con {NOMBRE}, que es mudancero/fletero registrado, así que tenés a mano SUS herramientas de pedidos y cotizaciones.

MudateYa es un marketplace argentino de mudanzas y fletes: el cliente pide presupuesto, vos cotizás, el cliente elige, paga la seña (50%) y coordinan. Al terminar paga el otro 50%. Todo protegido por la plataforma.

TONO: cercano, rioplatense, directo. Mensajes cortos (es WhatsApp). Tratalo por su nombre.

PODÉS HACER TODO POR ACÁ (usá las herramientas, NO lo mandes a la web):
- Ver los pedidos disponibles para cotizar → ver_pedidos.
- Cotizar un pedido → cotizar (con el id del pedido y el precio). Interpretá la jerga de plata: "80 lucas/palos/mil"/"80k" = 80000; "una gamba" = 100; "un melón" = 1.000.000. Pasá el precio como número entero en pesos.
- Pasar/rechazar un pedido que no te interesa → pasar.
- Arrancar el trabajo → iniciar_mudanza. Terminarlo → completar_mudanza (ahí el cliente paga el saldo).
- Reajustar el precio si aparece algo no previsto DESPUÉS de la seña → proponer_ajuste (nuevo precio + motivo; el cliente lo tiene que aceptar).
- Ver el estado de tus pedidos/cotizaciones → mis_pedidos.
- Reclamos o lo que no puedas resolver con lo de arriba → derivar_a_humano.

APENAS TE ESCRIBE, UBICATE RÁPIDO: ¿quiere ver pedidos?, ¿cotizar?, ¿le pasa algo con uno en curso?, ¿tiene un reclamo/problema (ver abajo)? Andá directo a eso, no lo hagas repetir ni le preguntes cosas que ya te dijo.

PRIMER MENSAJE O ALGO AMBIGUO (ej: "hola", "quiero info", vino de un link): no tires un párrafo largo explicándole quién sos ni metas de arranque el mail del equipo — eso suena a bot leyendo un speech. Saludalo corto por su nombre, con onda, y dejá que te diga qué necesita — no asumas que quiere ver pedidos ni se los muestres sin que te lo pida (puede querer otra cosa, o ni saber bien para qué es esto). Una sola línea de intro alcanza; recién ahí seguís por donde él te lleve.

RECLAMOS Y PROBLEMAS: si te cuenta que el cliente no le paga el saldo, canceló sin avisar, hay una discrepancia con lo acordado, o cualquier lío que tus herramientas de arriba no resuelven, NO lo dejes solo con un "escribile a hola@mudateya.ar" — usá derivar_a_humano (motivo empezando en "RECLAMO:" si algo salió mal) para que el equipo lo vea de verdad, y avisale que lo van a contactar.

CÓMO TRABAJÁS:
- Los pedidos tienen un ID. Cuando dice "el de Palermo" o "el primero", buscá el id en el último ver_pedidos/mis_pedidos y usalo. Si no queda claro cuál, preguntá.
- Para COTIZAR confirmá el precio si quedó ambiguo, y ANTES de mandarla preguntale con onda qué incluye ese precio (¿carga y descarga nomás, o también embalaje, desarme/armado de muebles, cajas?) para sumarlo como nota — evita líos después con el cliente por algo que se dio por sentado. Si te parece que le cuesta explicarlo por escrito, decile que también puede mandarte un audio contándolo — lo transcribís vos y armás la nota con eso. No lo hagas obligatorio si no quiere aclarar nada, pero sugeríselo siempre. Sumá también un tiempo estimado si lo tiene. Después avisale que el cliente ya la recibe y que le avisamos si lo elige.
- OJO con el audio: lo que le llega al cliente es SIEMPRE el texto de la nota (lo que vos escribís en la cotización), nunca el audio en sí — no reenvíes ni menciones que el cliente va a "escuchar" nada.
- Sé proactiva: si pregunta "qué pedidos hay", llamá a ver_pedidos y mostráselos cortito (ruta, km, tipo, si es urgente).
- Si te pide algo de CLIENTE (quiere mudarse él mismo, pedir un flete, cotizar como si fuera el que contrata): seguís siendo vos, no hay "otro bot" al que mandarlo — simplemente esos pedidos se cargan en mudateya.ar (ahí es más rápido para él que juntarlo acá). Decíselo en una línea, con onda, nada de "yo solo atiendo mudanceros" ni de discursos.

REGLAS:
- Solo actuás sobre SUS pedidos/cotizaciones (las herramientas validan con su cuenta). No inventes pedidos ni precios.
- No pidas ni manejes datos sensibles (tarjetas, contraseñas).
- Si en la nota de una cotización o en cualquier mensaje te pasa su teléfono o mail para que se lo des al cliente directo (antes de ganar el pedido y cobrar la seña), no lo incluyas ni lo repitas — omitilo nomás. No hace falta explicarle la regla salvo que insista.
- Si una herramienta da error, explicáselo simple y ofrecé reintentar. Para reclamos/problemas reales, usá derivar_a_humano (no lo mandes solo a escribir un mail él mismo).
- Si te preguntan por *MudateYa Mobility* (relocation B2B para inmobiliarias, desarrolladoras, clubes, colegios, diplomáticos o empresas de Vaca Muerta) o por coordinar una reunión de ese tema: para ESA respuesta puntual usá un tono más formal y serio (nada de onda relajada ni emojis, es un contacto institucional). Contale en una línea que es la línea B2B de MudateYa y decile que escriba a *contacto@mudateya.ar* para coordinar con el equipo comercial. No es algo que resolvés vos ni con tus herramientas de pedidos.`;

// System prompt del asistente para ASESORES INMOBILIARIOS (distinto del de
// clientes y del de mudanceros). OJO: estos son los asesores de los canales de
// derivación (api/canales.js, api/independientes.js, mudafy.js, remax.js,
// c21.js) — link FIJO que no vence, sin login ni dashboard. NO confundir con
// api/asesores.js / asesor-dashboard.html (Plan Referidos con login): ese
// sistema NO se usa, no existe para el usuario real.
// El asesor comparte su link con clientes, que publican SU PROPIA mudanza en
// el marketplace normal (varias cotizaciones, elige, paga) atribuida a su
// código. Por eso acá Emi no arma presupuestos ni nada visual: solo le pasa
// su link (siempre el mismo, no expira) y le cuenta cómo van sus referidos.
const SYSTEM_PROMPT_ASESOR = `Sos Emi, LA asistente de MudateYa por WhatsApp — una sola, la misma que atiende a clientes, mudanceros y asesores, no una versión aparte para cada uno. Ahora mismo estás hablando con {NOMBRE}, que es Asesor Inmobiliario aliado de MudateYa (canal {CANAL}).

MudateYa es un marketplace argentino de mudanzas y fletes. Los asesores como {NOMBRE} tienen un link propio y fijo que comparten con sus clientes (los que compran/alquilan y se mudan); el cliente entra por ahí, publica su mudanza y recibe presupuestos de mudanceros verificados como cualquier cliente — pero queda atribuida a {NOMBRE}. Si es un ALQUILER, {NOMBRE} cobra comisión cuando se completa; si es COMPRAVENTA, no hay comisión pero su cliente recibe un regalo (limpieza, Big Box, etc. según el valor de la mudanza).

TONO: cercano, rioplatense, directo. Mensajes cortos (es WhatsApp). Tratalo por su nombre.

PODÉS HACER ESTO POR ACÁ:
- Pasarle su link (siempre el mismo, no vence nunca) → mi_link. Por defecto lo pasás VOS ACÁ MISMO por WhatsApp (canal "whatsapp", es lo más rápido); solo lo mandás por mail (canal "mail") si te lo pide explícitamente él.
- Contarle cómo van los clientes que le llegaron por su link (si ya publicaron la mudanza, si tienen cotizaciones, si ya eligieron, si pagaron la seña, si está en curso o completada) → ver_mis_pedidos_referidos.
- Reclamos o lo que no puedas resolver con lo de arriba → derivar_a_humano.

APENAS TE ESCRIBE, UBICATE RÁPIDO: ¿quiere su link?, ¿quiere saber cómo van sus clientes?, ¿tiene un reclamo/problema? Andá directo a eso.

PRIMER MENSAJE O ALGO AMBIGUO (ej: "hola"): no asumas qué quiere — saludalo corto por su nombre, con onda, y dejá que te diga qué necesita. Si ya te contó algo concreto de entrada, seguís directo con eso.

GLOSARIO PARA CONTAR EL ESTADO DE UN PEDIDO REFERIDO (traducilo siempre a lenguaje natural, nunca repitas estas palabras técnicas tal cual):
- buscando: el cliente publicó la mudanza, buscando presupuestos de mudanceros.
- cotizando / cotizaciones_completas: ya le llegaron cotizaciones, todavía no eligió.
- cotizacion_aceptada + seña sin pagar: eligió una cotización, falta que pague la seña para confirmar.
- cotizacion_aceptada + seña pagada (sin estar en_curso): seña pagada, esperando la fecha de la mudanza.
- en_curso: la mudanza está pasando ahora.
- completada + saldo pagado: mudanza terminada y cobrada del todo (acá ya se sabe si {NOMBRE} cobra comisión o si es el regalo de compraventa).
- cancelado / cancelada_por_ajuste: se canceló.

RECLAMOS Y PROBLEMAS: si te cuenta que un cliente suyo tuvo un problema con la mudanza (no le cotizaron, algo salió mal, tarda en pagarle la comisión, etc.), no lo dejes con un "escribile a hola@mudateya.ar" — usá derivar_a_humano (motivo empezando en "RECLAMO:" si algo salió mal) para que el equipo lo vea, y avisale que lo van a contactar.

REGLA CRÍTICA DEL LINK: cuando mi_link te devuelva un link (canal whatsapp), pasáselo EXACTO, carácter por carácter, tal cual te lo dio la herramienta — nunca lo inventes, completes ni "arregles" de memoria. Si no te devolvió link, no muestres ninguno: avisá que hubo un problema y ofrecé reintentar.

REGLAS:
- Solo actuás sobre SUS pedidos referidos (las herramientas ya vienen filtradas a su cuenta). No inventes pedidos, clientes ni comisiones.
- No pidas ni manejes datos sensibles (tarjetas, contraseñas).
- Si una herramienta da error, explicáselo simple y ofrecé reintentar.
- Si te preguntan por *MudateYa Mobility* (relocation B2B): contale en una línea que es la línea B2B de MudateYa y decile que escriba a *contacto@mudateya.ar* para coordinar con el equipo comercial — no es algo que resolvés vos.`;

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
    name: 'agregar_detalle_pedido',
    description:
      'Agregá información en TEXTO al pedido activo del cliente (las fotos se guardan solas, no hace falta esta herramienta para fotos). Usala cuando un mudancero pidió una visita/relevamiento para dar el precio final y el cliente, en vez de mandar fotos, te cuenta por escrito más detalle de lo que hay que mudar. Se lo pasamos por mail al mudancero para que pueda ajustar el precio sin necesidad de ir.',
    input_schema: {
      type: 'object',
      properties: {
        detalle: { type: 'string', description: 'El texto con el detalle que dio el cliente' },
      },
      required: ['detalle'],
    },
  },
  {
    name: 'cancelar_pedido',
    description:
      'Cancelá el pedido activo del cliente. IMPORTANTE: confirmá con el cliente ANTES de llamar a esta herramienta. Si ya había pagado la seña, la herramienta intenta el reembolso automático y te avisa si salió bien o si el equipo lo va a procesar a mano — contale EXACTAMENTE lo que te devuelve, no asumas que siempre se reintegra al toque. Si la mudanza YA ESTÁ EN CURSO (el mudancero ya arrancó), la herramienta va a rechazar la cancelación automática: en ese caso es un problema/reclamo, no una cancelación normal — usá derivar_a_humano.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID del pedido a cancelar. Si no lo sabés, dejalo vacío y se cancela el más reciente activo.' },
      },
      required: [],
    },
  },
  {
    name: 'validar_direccion',
    description:
      'Valida una dirección contra Google Maps: confirma si EXISTE, la normaliza y da coordenadas. Usala para el origen y el destino cuando el cliente te los da, ANTES de crear el pedido. Si devuelve existe:false, la dirección no existe (repreguntá). Si completa:false, le falta la calle o el número (pedíselos).',
    input_schema: {
      type: 'object',
      properties: {
        direccion: { type: 'string', description: 'Dirección a validar (calle, número, localidad)' },
      },
      required: ['direccion'],
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
    name: 'responder_ajuste',
    description:
      'El cliente responde a un AJUSTE DE PRECIO que propuso el mudancero: lo acepta o lo rechaza. Si rechaza, la mudanza se cancela y se le devuelve la seña. Usalo cuando el cliente diga que acepta o rechaza el nuevo precio.',
    input_schema: {
      type: 'object',
      properties: { decision: { type: 'string', enum: ['aceptar', 'rechazar'] } },
      required: ['decision'],
    },
  },
  {
    name: 'calificar_mudancero',
    description:
      'Registrá la calificación del cliente al mudancero después de una mudanza COMPLETADA y pagada. Estrellas de 1 a 5 + comentario opcional. Se integra con la reputación del mudancero en la plataforma. Usala cuando el cliente puntúe (ej: "5 estrellas, excelente", "le pongo un 4", "muy buena").',
    input_schema: {
      type: 'object',
      properties: {
        estrellas: { type: 'integer', description: 'Puntaje de 1 a 5' },
        comentario: { type: 'string', description: 'Comentario opcional del cliente' },
      },
      required: ['estrellas'],
    },
  },
  {
    name: 'derivar_a_humano',
    description:
      'Derivá la conversación a una persona del equipo: para RECLAMOS (algo salió mal — no se presentó el mudancero, daños, pago no acreditado, disputa de precio) o cuando el cliente lo pide, está frustrado/enojado, o hay algo que no podés resolver. Avisa al equipo por email con el motivo y el historial reciente.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Motivo breve. Para un reclamo (algo salió mal), que empiece con "RECLAMO:" seguido del detalle.' },
      },
      required: ['motivo'],
    },
  },
  {
    name: 'registrar_mudancero',
    description:
      "Pre-registra como MUDANCERO/FLETERO a alguien que te escribe pidiendo sumarse (no es un pedido de mudanza) — así lo resuelve por acá mismo, sin mandarlo a la web. Después completa vehículo/fotos/precios desde su cuenta. Llamala SOLO con los 5 datos: nombre y apellido, empresa (o 'Independiente'), WhatsApp, email, zona donde opera.",
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'nombre y apellido' },
        empresa: { type: 'string', description: "nombre de la empresa, o 'Independiente'" },
        whatsapp: { type: 'string', description: 'número de WhatsApp / teléfono de contacto (si no lo da, usá el mismo número desde el que escribe)' },
        email: { type: 'string' },
        zona: { type: 'string', description: 'zona donde opera (ej: CABA, zona norte, zona sur, Rosario, Córdoba, Mendoza, u otra)' },
      },
      required: ['nombre', 'empresa', 'whatsapp', 'email', 'zona'],
    },
  },
  {
    name: 'registrar_asesor',
    description:
      "Registra a un ASESOR INMOBILIARIO individual en MudateYa: le genera un link propio y fijo (no vence) para compartir con sus clientes, queda activo al toque. Llamala SOLO con los 5 datos: nombre y apellido, inmobiliaria (o 'Independiente'), email, WhatsApp, zona donde trabaja.",
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'nombre y apellido del asesor' },
        inmobiliaria: { type: 'string', description: "nombre de la inmobiliaria, o 'Independiente'" },
        email: { type: 'string' },
        whatsapp: { type: 'string', description: 'número de WhatsApp / teléfono de contacto (si no lo da, usá el mismo número desde el que escribe)' },
        zona: { type: 'string', description: 'zona donde trabaja (ej: CABA, zona norte, zona sur, Rosario, Córdoba, Mendoza, u otra)' },
      },
      required: ['nombre', 'inmobiliaria', 'email', 'whatsapp', 'zona'],
    },
  },
  {
    name: 'registrar_inmobiliaria',
    description:
      "Manda la SOLICITUD de alta de una INMOBILIARIA (la agencia, no un asesor individual). Queda pendiente de revisión, NO es instantáneo. Llamala SOLO con los 6 datos: nombre de la inmobiliaria, nombre del contacto, colegio profesional, matrícula, email, WhatsApp.",
    input_schema: {
      type: 'object',
      properties: {
        nombreInmobiliaria: { type: 'string', description: 'nombre de la inmobiliaria' },
        contacto: { type: 'string', description: 'nombre y apellido de la persona de contacto' },
        colegio: { type: 'string', description: 'colegio profesional donde está matriculado el contacto (ej: CUCICBA — CABA, San Isidro, La Plata, etc.)' },
        matricula: { type: 'string', description: 'número de matrícula' },
        email: { type: 'string' },
        whatsapp: { type: 'string', description: 'número de WhatsApp / teléfono de contacto (si no lo da, usá el mismo número desde el que escribe)' },
      },
      required: ['nombreInmobiliaria', 'contacto', 'colegio', 'matricula', 'email', 'whatsapp'],
    },
  },
];

// Herramienta EXTRA que solo se suma cuando escribe alguien del equipo
// fundador (reconocido por EQUIPO_TELEFONOS/quienEscribe) — cuenta rápida de
// lo que hoy se ve en el admin (pedidos, mudanceros, asesores). No expone
// datos sensibles (nombres/emails/plata), solo totales.
const RESUMEN_MUDATEYA_TOOL = {
  name: 'resumen_mudateya',
  description: 'SOLO para el equipo fundador. Da un pantallazo numérico de MudateYa ahora mismo: pedidos activos y totales, mudanceros y clientes registrados, y asesores por canal (independientes, Mudafy, RE/MAX, C21). Para preguntas tipo "qué pedidos hay", "cuántos asesores tenemos", "cómo estamos".',
  input_schema: { type: 'object', properties: {}, required: [] },
};

// Cuenta rápida y barata: son todos largos de listas ya indexadas (sin leer
// cada perfil/mudanza individual), para no pagar N reads por pregunta.
async function resumenMudateYa() {
  const [activas, todas, mudanceros, clientes, idxIndep, idxMudafy, idxRemax, idxC21] = await Promise.all([
    getJSON('mudanzas:activas'),
    getJSON('mudanzas:todos'),
    getJSON('mudanceros:todos'),
    getJSON('clientes:todos'),
    getJSON('indep:asesores'),
    getJSON('mudafy:asesores'),
    getJSON('remax:asesores'),
    getJSON('c21:asesores'),
  ]);
  const asesores = {
    independientes: (idxIndep || []).length,
    mudafy: (idxMudafy || []).length,
    remax: (idxRemax || []).length,
    c21: (idxC21 || []).length,
  };
  asesores.total = asesores.independientes + asesores.mudafy + asesores.remax + asesores.c21;
  return {
    pedidosActivos: (activas || []).length,
    pedidosHistoricos: (todas || []).length,
    mudancerosRegistrados: (mudanceros || []).length,
    clientesRegistrados: (clientes || []).length,
    asesores,
    nota: 'Son totales rápidos (listas indexadas). Para desglose fino (por estado, por zona, montos) hay que mirar el admin.',
  };
}

// ------------------------------------------------------------------
// Herramientas del asistente MUDANCERO (flujo completo por WhatsApp).
// Cada una reusa un endpoint del web (una sola fuente de verdad).
// ------------------------------------------------------------------
const mudanceroTools = [
  {
    name: 'ver_pedidos',
    description: 'Lista los pedidos disponibles para que el mudancero cotice (su zona). Devuelve id, ruta, km, tipo y si es urgente.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'cotizar',
    description: 'Envía la cotización del mudancero para un pedido. Interpretá la jerga de plata y pasá el precio como entero en pesos.',
    input_schema: {
      type: 'object',
      properties: {
        pedidoId: { type: 'string', description: 'ID del pedido a cotizar (de ver_pedidos)' },
        precio: { type: 'integer', description: 'Precio en pesos (entero). Ej "80 lucas" = 80000' },
        nota: { type: 'string', description: 'Qué incluye / aclaraciones (opcional)' },
        tiempo: { type: 'string', description: 'Tiempo estimado, ej "3 horas" (opcional)' },
      },
      required: ['pedidoId', 'precio'],
    },
  },
  {
    name: 'pasar',
    description: 'Rechaza/pasa un pedido que no le interesa al mudancero (no se lo muestra más).',
    input_schema: { type: 'object', properties: { pedidoId: { type: 'string' } }, required: ['pedidoId'] },
  },
  {
    name: 'iniciar_mudanza',
    description: 'Marca la mudanza/flete como EN CURSO (el mudancero arrancó el trabajo). Requiere que el cliente haya pagado la seña.',
    input_schema: { type: 'object', properties: { pedidoId: { type: 'string' } }, required: ['pedidoId'] },
  },
  {
    name: 'completar_mudanza',
    description: 'Marca la mudanza/flete como COMPLETADA. Dispara el aviso al cliente para pagar el saldo (50% restante).',
    input_schema: { type: 'object', properties: { pedidoId: { type: 'string' } }, required: ['pedidoId'] },
  },
  {
    name: 'proponer_ajuste',
    description: 'Propone un reajuste de precio DESPUÉS de la seña (por algo no previsto). El cliente lo tiene que aceptar. Se permite una vez.',
    input_schema: {
      type: 'object',
      properties: {
        pedidoId: { type: 'string' },
        nuevoPrecio: { type: 'integer', description: 'Nuevo precio total en pesos (entero)' },
        motivo: { type: 'string', description: 'Motivo del ajuste (mínimo unas palabras)' },
      },
      required: ['pedidoId', 'nuevoPrecio', 'motivo'],
    },
  },
  {
    name: 'mis_pedidos',
    description: 'Muestra el estado de los pedidos/cotizaciones del mudancero (enviados, aceptados, en curso, completados).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'derivar_a_humano',
    description:
      'Derivá al equipo un RECLAMO o problema que tus otras herramientas no resuelven (el cliente no paga el saldo, canceló sin avisar, una discrepancia con lo acordado, etc.) o cuando el mudancero pide hablar con una persona. Avisa al equipo por email con el motivo y el historial reciente.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Motivo breve. Para un reclamo (algo salió mal), que empiece con "RECLAMO:" seguido del detalle.' },
      },
      required: ['motivo'],
    },
  },
];

// Ejecuta una herramienta del MUDANCERO llamando al endpoint web correspondiente.
async function ejecutarToolMudancero(name, input, mudancero, waId, conv) {
  const email = mudancero && mudancero.email;
  const nombre = mudancero && mudancero.nombre;
  const tel = mudancero && mudancero.telefono;
  if (!email) return JSON.stringify({ error: 'No pude identificar tu cuenta de mudancero.' });
  const base = SITE_URL;
  input = input || {};
  const postJSON = async (action, body) => {
    const r = await fetch(`${base}/api/cotizaciones?action=${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok && d.ok !== false, status: r.status, d };
  };
  try {
    if (name === 'ver_pedidos') {
      const r = await fetch(`${base}/api/cotizaciones?action=por-zona&email=${encodeURIComponent(email)}`);
      const d = await r.json().catch(() => ({}));
      const pedidos = (d.mudanzas || []).map((m) => ({
        id: m.id, tipo: m.tipo, ruta: `${m.desde || ''} → ${m.hasta || ''}`,
        km: m.km || null, ambientes: m.ambientes || '', fecha: m.fecha || '', urgente: !!m.urgente,
      }));
      return JSON.stringify({ pedidos, nota: pedidos.length ? 'Pedidos disponibles para cotizar. Para cotizar uno, usá cotizar con su id.' : 'No hay pedidos disponibles en tu zona ahora.' });
    }
    if (name === 'cotizar') {
      const { ok, d } = await postJSON('cotizar', {
        mudanzaId: input.pedidoId, mudanceroEmail: email, mudanceroNombre: nombre, mudanceroTel: tel,
        precio: input.precio, nota: input.nota || '', tiempoEstimado: input.tiempo || '',
      });
      return JSON.stringify(ok ? { ok: true, nota: 'Cotización enviada. El cliente ya la recibe; te avisamos si te elige.' } : { ok: false, error: d.error || 'No se pudo cotizar.' });
    }
    if (name === 'pasar') {
      const { ok, d } = await postJSON('rechazar', { mudanzaId: input.pedidoId, mudanceroEmail: email });
      return JSON.stringify(ok ? { ok: true, nota: 'Listo, pasaste ese pedido. No te lo mostramos más.' } : { ok: false, error: d.error });
    }
    if (name === 'iniciar_mudanza' || name === 'completar_mudanza') {
      const estado = name === 'iniciar_mudanza' ? 'en_curso' : 'completada';
      const { ok, d } = await postJSON('cambiar-estado', { mudanzaId: input.pedidoId, estado, mudanceroEmail: email });
      if (!ok) return JSON.stringify({ ok: false, error: d.error || 'No se pudo actualizar el estado.' });
      return JSON.stringify({ ok: true, nota: estado === 'en_curso' ? 'Marcado EN CURSO. Avisamos al cliente.' : 'Marcado COMPLETADA. Avisamos al cliente para que pague el saldo.' });
    }
    if (name === 'proponer_ajuste') {
      const { ok, d } = await postJSON('proponer-ajuste', { mudanzaId: input.pedidoId, mudanceroEmail: email, nuevoPrecio: input.nuevoPrecio, motivo: input.motivo });
      return JSON.stringify(ok ? { ok: true, nota: 'Ajuste propuesto. El cliente lo tiene que aceptar.' } : { ok: false, error: d.error || 'No se pudo proponer el ajuste.' });
    }
    if (name === 'mis_pedidos') {
      const r = await fetch(`${base}/api/cotizaciones?action=mis-cotizaciones&email=${encodeURIComponent(email)}`);
      const d = await r.json().catch(() => ({}));
      const pedidos = (d.mudanzas || []).map((m) => ({
        id: m.id, tipo: m.tipo, ruta: `${m.desde || ''} → ${m.hasta || ''}`, estado: m.estado,
        miPrecio: (m.miCotizacion && m.miCotizacion.precio) || (m.cotizacionAceptada && m.cotizacionAceptada.precio) || null,
      }));
      return JSON.stringify({ pedidos });
    }
    if (name === 'derivar_a_humano') {
      return JSON.stringify(await derivarHumano(waId, input && input.motivo, conv, { rol: 'mudancero', nombre }));
    }
    return JSON.stringify({ error: 'herramienta desconocida' });
  } catch (e) {
    console.error('ejecutarToolMudancero', name, e.message);
    return JSON.stringify({ error: 'Tuve un problema con esa acción, probá de nuevo.' });
  }
}

const asesorTools = [
  {
    name: 'mi_link',
    description: 'Le pasa al asesor su link fijo de derivación (siempre el mismo, no vence nunca). Por defecto usá canal "whatsapp" (te devuelve el link y se lo pegás vos mismo en el chat, es lo más rápido). Solo usá canal "mail" si el asesor pide específicamente que se lo mandes por mail.',
    input_schema: {
      type: 'object',
      properties: {
        canal: { type: 'string', enum: ['whatsapp', 'mail'], description: 'Por defecto "whatsapp". Usá "mail" solo si el asesor lo pide explícitamente.' },
      },
      required: [],
    },
  },
  {
    name: 'ver_mis_pedidos_referidos',
    description: 'Muestra las mudanzas que le llegaron al asesor por su link: cliente, ruta, si ya tiene cotizaciones, si eligió una, si pagó la seña, si está en curso o completada.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'derivar_a_humano',
    description: 'Derivá al equipo un RECLAMO o problema que tus otras herramientas no resuelven, o cuando el asesor pide hablar con una persona.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Motivo breve. Para un reclamo (algo salió mal), que empiece con "RECLAMO:" seguido del detalle.' },
      },
      required: ['motivo'],
    },
  },
];

// Mudanzas que le llegaron a un asesor por su link (mudanza.partnerAsesor ===
// codigo). Lee el índice {prefijo}:asesor:{codigo}:mudanzas que arma
// api/cotizaciones.js al publicarse cada mudanza (junto al aviso por mail que
// ya le manda notificarAsesorPedidoPublicado/resolverAsesor).
async function pedidosReferidosDelAsesor(prefijo, codigo) {
  const ids = (await getJSON(`${prefijo}:asesor:${codigo}:mudanzas`)) || [];
  const pedidos = [];
  for (const id of ids.slice(-15)) {
    const m = await getJSON(`mudanza:${id}`);
    if (!m) continue;
    pedidos.push({
      id: m.id,
      cliente: m.clienteNombre || '',
      ruta: `${m.desde || ''} → ${m.hasta || ''}`,
      estado: m.estado, // buscando | cotizando | cotizaciones_completas | cotizacion_aceptada | en_curso | completada | cancelado...
      anticipoPagado: !!m.anticipoPagado,
      saldoPagado: !!m.saldoPagado,
      tipoOperacion: m.tipoOperacion || '', // alquiler | compraventa (define si cobra comisión o si el cliente recibe un regalo)
      montoTotal: m.montoTotal || m.precio_estimado || null,
      cantCotizaciones: (m.cotizaciones || []).length,
      fechaPublicacion: m.fechaPublicacion,
    });
  }
  pedidos.sort((a, b) => String(b.fechaPublicacion || '').localeCompare(String(a.fechaPublicacion || '')));
  return pedidos;
}

// Ejecuta una herramienta del ASESOR.
async function ejecutarToolAsesor(name, input, asesor, waId, conv) {
  const nombre = asesor && asesor.nombre;
  const email = asesor && asesor.email;
  const link = asesor && asesor.link;
  if (!asesor || !link) return JSON.stringify({ error: 'No pude identificar tu cuenta de asesor.' });
  try {
    if (name === 'mi_link') {
      const porMail = input && input.canal === 'mail';
      if (porMail) {
        if (!email) return JSON.stringify({ ok: false, error: 'No tengo un mail cargado para vos.' });
        try {
          const { Resend } = require('resend');
          const resend = new Resend(process.env.RESEND_API_KEY);
          const primerNombre = (nombre || '').split(' ')[0] || '';
          await resend.emails.send({
            from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
            to: email,
            subject: 'Tu link de asesor MudateYa',
            html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0F1923"><p>¡Hola ${primerNombre}! Este es tu link fijo de MudateYa, para compartir con tus clientes:</p><p style="margin:20px 0"><a href="${link}" style="color:#003580;font-weight:700">${link}</a></p><p style="color:#94A3B8;font-size:12px">MudateYa · mudateya.ar</p></div>`,
          });
          return JSON.stringify({ ok: true, nota: `Te mandé un mail a ${email} con tu link.` });
        } catch (e) {
          console.error('mail link asesor:', e.message);
          return JSON.stringify({ ok: false, error: 'No se pudo mandar el mail. Ofrecele pasárselo acá mismo por WhatsApp.' });
        }
      }
      return JSON.stringify({ ok: true, link, nota: `Pasále este link EXACTO tal cual, sin cambiarle nada: ${link}` });
    }
    if (name === 'ver_mis_pedidos_referidos') {
      const pedidos = await pedidosReferidosDelAsesor(asesor.prefijo, asesor.codigo);
      return JSON.stringify({ pedidos, nota: pedidos.length ? undefined : 'Todavía no te llegó ningún cliente por tu link.' });
    }
    if (name === 'derivar_a_humano') {
      return JSON.stringify(await derivarHumano(waId, input && input.motivo, conv, { rol: 'asesor', nombre }));
    }
    return JSON.stringify({ error: 'herramienta desconocida' });
  } catch (e) {
    console.error('ejecutarToolAsesor', name, e.message);
    return JSON.stringify({ error: 'Tuve un problema con esa acción, probá de nuevo.' });
  }
}

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

// MODO PRUEBA: avisar SOLO al mudancero de test (nunca a reales). Le manda el
// pedido por MAIL y por WhatsApp CON LAS FOTOS (para que dimensione y cotice).
// Solo corre si TEST_MUDANCERO_EMAIL está seteada. Fail-soft.
async function notificarMudanceroTest(pedido) {
  if (!TEST_MUDANCERO_EMAIL) return;

  // 1) Email
  if (process.env.RESEND_API_KEY) {
    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      const fotosHtml = (Array.isArray(pedido.fotos) ? pedido.fotos.slice(0, 6) : [])
        .map((u) => `<img src="${u}" style="width:120px;height:120px;object-fit:cover;border-radius:8px;margin:4px">`).join('');
      // PDF de detalles del pedido — MISMA función que la web (Detalles-{id}.pdf).
      // Si el pedido no tiene detalles suficientes puede devolver null: va sin adjunto.
      let pdfBase64 = null;
      try {
        const { generarPDFDetallesBase64 } = require('./cotizaciones');
        if (typeof generarPDFDetallesBase64 === 'function') pdfBase64 = await generarPDFDetallesBase64(pedido);
      } catch (e) { console.warn('PDF detalles (bot):', e.message); }
      const params = {
        from: 'MudateYa <noreply@mudateya.ar>',
        reply_to: 'hola@mudateya.ar',
        to: TEST_MUDANCERO_EMAIL,
        subject: `🧪 Pedido para cotizar — ${pedido.origen} → ${pedido.destino}`,
        html:
          `<p>Entró un pedido para cotizar (modo prueba).</p>` +
          `<p><b>${escapeXml(pedido.tipo)}</b>: ${escapeXml(pedido.origen)} → ${escapeXml(pedido.destino)}<br>` +
          `Fecha: ${escapeXml(pedido.fecha || '—')}<br>` +
          `Detalles: ${escapeXml(pedido.detalles || '—')}</p>` +
          (fotosHtml ? `<p>${fotosHtml}</p>` : '') +
          (pdfBase64 ? `<p>📎 Detalles completos en el PDF adjunto.</p>` : '') +
          `<p><a href="https://mudateya.ar/mi-cuenta">Entrá a tu cuenta para cotizar →</a></p>`,
      };
      if (pdfBase64) {
        params.attachments = [{ filename: `Detalles-${pedido.id || 'pedido'}.pdf`, content: pdfBase64 }];
      }
      await resend.emails.send(params);
    } catch (e) { console.warn('notificarMudanceroTest email:', e.message); }
  }

  // 2) WhatsApp al mudancero de test: resumen + cada foto como adjunto. Requiere
  //    que el mudancero haya escrito al bot en las últimas 24h (texto libre).
  try {
    const perfil = await getJSON(`mudancero:perfil:${TEST_MUDANCERO_EMAIL}`);
    const tel = perfil && perfil.telefono;
    if (tel) {
      const { enviarWhatsAppTexto } = require('./_whatsapp');
      const { enviarPlantilla } = require('./_plantillas');
      const nomMud = (perfil.nombre || '').split(' ')[0] || 'Hola';
      const resumen =
        `🆕 Nuevo pedido para cotizar (${pedido.tipo}):\n` +
        `${pedido.origen} → ${pedido.destino}${pedido.fecha ? ' · ' + pedido.fecha : ''}\n` +
        (pedido.km ? `📏 Distancia: ${pedido.km} km aprox.\n` : '') +
        (pedido.detalles ? pedido.detalles + '\n' : '') +
        `Entrá a mudateya.ar/mi-cuenta para cotizar.`;
      // Plantilla nuevo_pedido_mudancero si está aprobada (fuera de 24h); si no, texto libre.
      await enviarPlantilla(tel, 'nuevo_pedido_mudancero', { 1: nomMud, 2: pedido.origen, 3: pedido.destino, 4: pedido.fecha || 'a coordinar' }, resumen);
      // PDF "Detalles del pedido" como adjunto (Twilio lo baja del endpoint público).
      try {
        const pdfUrl = `${SITE_URL}/api/cotizaciones?action=pedido-pdf&mudanzaId=${encodeURIComponent(pedido.id)}`;
        await enviarWhatsAppTexto(tel, '📄 Detalle del pedido (PDF):', pdfUrl);
      } catch (_) {}
      const fotos = Array.isArray(pedido.fotos) ? pedido.fotos.slice(0, 6) : [];
      for (const url of fotos) {
        try { await enviarWhatsAppTexto(tel, '📷 Foto del pedido:', url); } catch (_) {}
      }
    }
  } catch (e) { console.warn('notificarMudanceroTest WhatsApp:', e.message); }
}

// Sube una foto (base64) a Vercel Blob y devuelve su URL pública, para adjuntarla
// al pedido (que el mudancero/fletero la vea y dimensione). Igual que subir-foto.js.
async function subirFotoBlob(base64, tipo) {
  try {
    const { put } = require('@vercel/blob');
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > 6 * 1024 * 1024) return null; // tope defensivo
    const ext = (tipo && tipo.split('/')[1]) || 'jpg';
    const filename = `mudateya/pedido-wa/${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
    // Mismo token que upload-foto.js: las fotos usan el store BLOB_FOTO_*.
    const token = process.env.BLOB_FOTO_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;
    const blob = await put(filename, buffer, { access: 'public', contentType: tipo || 'image/jpeg', token });
    return blob.url;
  } catch (e) { console.warn('subirFotoBlob:', e.message); return null; }
}

// Chequea con Claude si una foto (base64) muestra un teléfono o email visible —
// mismo criterio que las fotos de perfil/vehículo de los mudanceros (ver
// api/moderar-fotos-mudanceros.js). Acá aplica a fotos que MANDA EL CLIENTE
// para un relevamiento remoto: tampoco pueden llevar contacto directo, porque
// el mudancero las ve al cotizar y el punto es que sigan contactándose por acá.
// Falla ABIERTO: si el chequeo no responde, no bloquea (defensa extra, no el único control).
async function chequearContactoEnFoto(base64, tipo) {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: tipo || 'image/jpeg', data: base64 } },
            { type: 'text', text: '¿Aparece escrito o visible en esta imagen un número de teléfono o una dirección de email (cartel, adhesivo, remera, escrito a mano, etc.)? No cuentes patentes de vehículos ni numeración de calle/piso. Respondé SOLO con JSON válido: {"tieneContacto": true|false, "detalle": "el texto visto, o vacío si no hay"}' },
          ],
        }],
        output_config: {
          format: {
            type: 'json_schema',
            schema: {
              type: 'object', additionalProperties: false,
              required: ['tieneContacto', 'detalle'],
              properties: { tieneContacto: { type: 'boolean' }, detalle: { type: 'string' } },
            },
          },
        },
      }),
    });
    if (!r.ok) return { tieneContacto: false };
    const data = await r.json();
    const texto = (data.content || []).map((b) => b.text || '').join('');
    const analisis = JSON.parse(texto.trim());
    return { tieneContacto: !!analisis.tieneContacto, detalle: analisis.detalle || '' };
  } catch (e) {
    console.warn('chequearContactoEnFoto:', e.message);
    return { tieneContacto: false };
  }
}

// Mismo detector que cotizaciones.js (pideVisitaPresencial) — si cambia ahí,
// actualizar acá también. Duplicado a propósito: este archivo no importa
// cotizaciones.js para evitar dependencias circulares.
function pedidoPideVisita(nota) {
  return /relevamiento|visitar|visita\s+(presencial|domiciliaria)|recorrer\s+el\s+(lugar|domicilio)|pasar\s+a\s+ver|ir\s+a\s+ver\s+(el|la)|necesita(mos)?\s+ver\s+el\s+lugar/i.test(String(nota || ''));
}

// Mismo helper que cotizaciones.js (sinContacto) — redacta teléfonos y emails
// de un texto libre. Acá hacía falta para el detalle que el cliente escribe
// en agregar_detalle_pedido: ese texto queda guardado en el pedido y lo ve el
// mudancero, así que no puede llevar contacto directo (mismo criterio que las
// fotos, que ya se moderan).
function sinContactoWA(texto) {
  if (!texto) return texto;
  let t = String(texto);
  t = t.replace(/\+?\d[\d\s.()-]{6,}\d/g, (m) => ((m.match(/\d/g) || []).length >= 8 ? '[contacto oculto]' : m));
  t = t.replace(/[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}/g, '[contacto oculto]');
  return t;
}

// Avisa al/los mudancero(s) que pidieron relevamiento/visita en su cotización
// de que el cliente mandó fotos o más detalle en vez de la visita — sin esto,
// quedaban guardadas en el pedido pero nadie del lado del mudancero se
// enteraba. WhatsApp primero (mismo canal donde ya interactúa con Emi); el
// mail es un respaldo SOLO si el WhatsApp no se pudo entregar (sin teléfono,
// fuera de ventana y la plantilla sin aprobar todavía).
async function avisarMudanceroFotosOTexto(pedido, motivo) {
  const cots = Array.isArray(pedido.cotizaciones) ? pedido.cotizaciones : [];
  const matches = cots.filter((c) => c && pedidoPideVisita(c.nota));
  if (!matches.length) return;
  const { enviarPlantilla } = require('./_plantillas');
  for (const c of matches) {
    const nomMud = (c.mudanceroNombre || '').split(' ')[0] || '';
    let entregado = false;
    if (c.mudanceroTel) {
      try {
        const textoWA = `¡Hola${nomMud ? ', ' + nomMud : ''}! El cliente del pedido ${pedido.id} (${pedido.desde || pedido.origen || ''} → ${pedido.hasta || pedido.destino || ''}) te mandó ${motivo} en vez de la visita — entrá a tu cuenta para verlo y ajustar el precio si hace falta.`;
        const r = await enviarPlantilla(c.mudanceroTel, 'fotos_relevamiento_mudancero',
          { 1: nomMud, 2: pedido.id, 3: pedido.desde || pedido.origen || '', 4: pedido.hasta || pedido.destino || '', 5: motivo }, textoWA);
        entregado = !!(r && r.enviado);
      } catch (e) { console.warn('avisarMudanceroFotosOTexto WhatsApp:', c.mudanceroTel, e.message); }
    }
    if (!entregado && c.mudanceroEmail && process.env.RESEND_API_KEY) {
      try {
        const { Resend } = require('resend');
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
          to: c.mudanceroEmail,
          subject: `El cliente te mandó ${motivo} para tu cotización — pedido ${pedido.id}`,
          html:
            `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">` +
            `<div style="background:#003580;padding:20px 28px"><span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#22C36A">Ya</span></div>` +
            `<div style="padding:28px">` +
              `<p style="color:#0F1923;font-size:16px;line-height:1.7;margin:0 0 16px">Hola${nomMud ? ', ' + nomMud : ''}!</p>` +
              `<p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 20px">El cliente de tu cotización para el pedido <b>${pedido.id}</b> (${pedido.desde || pedido.origen || ''} → ${pedido.hasta || pedido.destino || ''}) te mandó ${motivo} en vez de coordinar la visita que pediste. Entrá a revisarlo para ajustar el precio si hace falta.</p>` +
              `<div style="text-align:center;margin:20px 0"><a href="https://mudateya.ar/mi-cuenta" style="display:inline-block;background:#22C36A;color:#003580;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:14px">Ver el pedido →</a></div>` +
            `</div>` +
            `</div>`,
        });
      } catch (e) { console.warn('avisarMudanceroFotosOTexto mail:', c.mudanceroEmail, e.message); }
    }
  }
}

async function crearPedido(input, waId, ubicaciones, fotos) {
  const id = nuevoId();
  const ahora = new Date();
  const nombre = input.nombre || '';

  // Geocodificar origen/destino con Google (best-effort): coords para geo-match y
  // km por ruta para mostrar en el PDF. Si falta la key o falla, sigue sin ello.
  let origenCoords = null, destinoCoords = null, kmCalc = 0;
  try {
    const { geocodificar, distanciaKm, haversineKm } = require('./_geo');
    const [go, gd] = await Promise.all([geocodificar(input.origen), geocodificar(input.destino)]);
    if (go && go.ok) origenCoords = { lat: go.lat, lng: go.lng };
    if (gd && gd.ok) destinoCoords = { lat: gd.lat, lng: gd.lng };
    kmCalc = (await distanciaKm(input.origen, input.destino))
             || haversineKm(origenCoords, destinoCoords) || 0;
  } catch (_) {}

  // Pedido UNIFICADO: un solo objeto que sirve a los dos sistemas.
  //   - Bot (WhatsApp): origen/destino/vence/detalles → consultar_estado y cancelar.
  //   - Marketplace web: desde/hasta/expira/zonaBase/estado 'buscando' + índice
  //     mudanzas:activas → el mudancero lo ve y cotiza desde su cuenta (por-zona).
  // Con TEST_MUDANCERO_EMAIL el pedido va en modo "dirigido" solo a ese mudancero,
  // así ningún mudancero real lo ve mientras se prueba.
  // Ventana para cotizar: si es URGENTE, corta (3hs, lo necesitan ya); si no, 24hs hábiles.
  const expiraISO = input.urgente
    ? new Date(ahora.getTime() + 3 * 60 * 60 * 1000).toISOString()
    : vencimientoHabilISO(24);
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
    vence: expiraISO,
    // — vista web (marketplace / cotización del mudancero) —
    clienteNombre: nombre,
    clienteWA: waId,
    clienteEmail: `wa-${String(waId).replace(/\D/g, '')}@wa.mudateya.ar`, // sintético: el cliente WA no tiene email
    desde: input.origen,
    hasta: input.destino,
    zonaBase: input.origen,
    ambientes: parseAmbientes(input.detalles),
    km: kmCalc || 0, // distancia por ruta (Google) — se muestra en el PDF
    origenCoords: origenCoords,
    destinoCoords: destinoCoords,
    nivel: input.tipo === 'flete' ? 'flete' : null,
    servicios: [],
    extras: [],
    fotos: Array.isArray(fotos) ? fotos.slice(0, 6) : [], // URLs de las fotos que mandó el cliente (para dimensionar)
    detallesAdicionales: (input.detalles || (Array.isArray(fotos) && fotos.length))
      ? { comentario: input.detalles ? String(input.detalles).slice(0, 500) : '', fotos: Array.isArray(fotos) ? fotos.slice(0, 6) : [] }
      : null,
    modoCotizacion: dirigido ? 'dirigido' : 'abierto',
    mudancerosInvitados: dirigido ? [TEST_MUDANCERO_EMAIL] : [],
    maxCotizaciones: 50,
    fechaPublicacion: ahora.toISOString(),
    expira: expiraISO,
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
  // Aviso al mudancero de test (mail con PDF adjunto + WhatsApp con fotos). Sale
  // directo a mudatest, SIN exigir que el perfil esté 'aprobado'. El barrido real a
  // TODOS los mudanceros (con notificarMudanceros de la web, que sí exige aprobado)
  // se prende aparte cuando vayas a vivo.
  await notificarMudanceroTest(pedido);
  return pedido;
}

// ------------------------------------------------------------------
// Herramientas del agente (además de crear_pedido)
// ------------------------------------------------------------------
// Pedidos de un cliente por su WhatsApp — junta DOS orígenes:
//  1) Pedidos creados por el bot: quedan indexados directo en cliente:pedidos:{waId}.
//  2) Pedidos creados por la WEB donde el cliente dejó su WhatsApp: se indexan
//     por los últimos 8 dígitos (clientes:tel8-idx → email), igual que ya se
//     hace con mudanceros, porque un número puede llegar tipeado de mil formas
//     (54/9/15/0 celular) y así matchea sin importar cómo lo haya escrito.
//     Sin esto, un cliente de la web que responde "acepto"/"rechazo" un ajuste
//     de precio, o califica con estrellas, se encontraba con que el bot no
//     tenía ningún pedido suyo para relacionar esa respuesta.
async function pedidosDelCliente(waId) {
  const idsBot = (await getJSON(`cliente:pedidos:${waId}`)) || [];

  let idsWeb = [];
  try {
    const t8 = clave8(waId);
    if (t8.length === 8) {
      const email = await redisCall('HGET', 'clientes:tel8-idx', t8);
      if (email) idsWeb = (await getJSON(`cliente:${email}`)) || [];
    }
  } catch (e) { console.warn('pedidosDelCliente tel8:', e.message); }

  const ids = Array.from(new Set([...idsBot, ...idsWeb]));
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
    // Pedido unificado: el bot guarda origen/destino/vence, la web guarda
    // desde/hasta/expira (ver comentario en crearPedido). pedidosDelCliente()
    // devuelve pedidos de AMBOS orígenes, así que sin este fallback un pedido
    // publicado por la web le llegaba a Emi sin dirección ni vencimiento.
    origen: p.origen || p.desde,
    destino: p.destino || p.hasta,
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
    vence: p.vence || p.expira,
  };
}
// Agrega un detalle en TEXTO al pedido abierto del cliente (contraparte de las
// fotos: cuando el cliente responde con más info escrita en vez de una foto,
// por ejemplo porque un mudancero pidió relevamiento). Avisa por mail al
// mudancero que lo pidió, mismo mecanismo que las fotos.
async function agregarDetallePedidoCliente(waId, detalle) {
  const texto = String(detalle || '').trim();
  if (!texto) return { ok: false, mensaje: 'No me llegó ningún detalle para agregar.' };

  const pedidos = await pedidosDelCliente(waId);
  const abiertos = pedidos.filter((p) => p && (p.estado === 'buscando' || p.estado === 'cotizando'));
  if (!abiertos.length) return { ok: false, mensaje: 'No encontré un pedido tuyo abierto para agregarle esto.' };
  const pedido = abiertos[abiertos.length - 1]; // el más reciente

  const textoLimpio = sinContactoWA(texto.slice(0, 500));
  pedido.detallesAdicionales = pedido.detallesAdicionales || {};
  pedido.detallesAdicionales.comentario = pedido.detallesAdicionales.comentario
    ? pedido.detallesAdicionales.comentario + '\n' + textoLimpio
    : textoLimpio;
  try { await setJSON(`mudanza:${pedido.id}`, pedido); } catch (e) { console.warn('guardar detalle pedido:', e.message); }
  try { await avisarMudanceroFotosOTexto(pedido, 'más información'); } catch (e) { console.warn('avisar mudancero detalle:', e.message); }

  return { ok: true, id: pedido.id, mensaje: 'Listo, lo agregué a tu pedido y se lo paso al mudancero.' };
}
async function cancelarPedidoCliente(waId, id) {
  const pedidos = await pedidosDelCliente(waId);
  let target = id ? pedidos.find((p) => p.id === id) : null;
  if (!target) {
    target = pedidos.reverse().find((p) => p.estado && p.estado !== 'cancelado' && p.estado !== 'completado');
  }
  if (!target) return { ok: false, mensaje: 'No encontré un pedido activo para cancelar.' };

  // Delegado a cotizaciones.js (una sola fuente de verdad): si ya había
  // pagado la seña, esa acción intenta el refund en MP y avisa al admin si
  // no se puede automático — antes esta función solo cambiaba el estado acá
  // mismo y, si había plata pagada, quedaba sin reintegrar y sin que nadie
  // se enterara.
  try {
    const r = await fetch(`${SITE_URL}/api/cotizaciones?action=cancelar-pedido`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mudanzaId: target.id, clienteEmail: target.clienteEmail }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) return { ok: false, mensaje: (d && d.error) || 'No pude cancelar el pedido.' };
    const mensaje = !d.teniaSeñaPagada
      ? 'Pedido cancelado.'
      : d.refundOk
        ? 'Pedido cancelado. Te devolvemos la seña — la vas a ver acreditada en unos días.'
        : 'Pedido cancelado. Ya habías pagado la seña, así que el equipo te va a contactar para coordinar la devolución.';
    return { ok: true, id: target.id, mensaje };
  } catch (e) {
    console.warn('cancelarPedidoCliente:', e.message);
    return { ok: false, mensaje: 'Tuve un problema cancelando el pedido. Probá de nuevo en un momento.' };
  }
}
async function derivarHumano(waId, motivo, conv, opts) {
  opts = opts || {};
  const esMudancero = opts.rol === 'mudancero';
  const ROL_LABELS = { mudancero: 'mudancero/fletero', asesor: 'asesor inmobiliario' };
  const quienLabel = ROL_LABELS[opts.rol] || 'cliente';
  const quienConNombre = opts.nombre ? `${quienLabel} ${opts.nombre}` : quienLabel;
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
      // "RECLAMO:" al arranque del motivo = algo salió mal (no-show, daños, pago
      // no acreditado, disputa) — se marca distinto para que el equipo lo triage
      // más rápido que un "quiere hablar con alguien" genérico.
      const esReclamo = !esUrgente && /^reclamo/i.test(String(motivo || '').trim());
      const esFlete = /\bflete/i.test(motivo || '');
      const tipoUrg = esFlete ? 'FLETE' : 'MUDANZA';
      const artUrg = esFlete ? 'un' : 'una';
      const subject = esUrgente
        ? `🚨 ${tipoUrg} URGENTE — ${waId}`
        : esReclamo
        ? `⚠️ Reclamo de ${quienLabel} — ${waId}`
        : `🙋 ${opts.rol === 'mudancero' ? 'Mudancero' : opts.rol === 'asesor' ? 'Asesor' : 'Cliente'} pide atención humana — ${waId}`;
      const intro = esUrgente
        ? `tiene ${artUrg} <b>${tipoUrg.toLowerCase()} URGENTE</b> y necesita que el equipo lo tome ya`
        : esReclamo
        ? 'tiene un <b>reclamo</b>'
        : 'pidió hablar con una persona';
      await resend.emails.send({
        from: 'MudateYa <noreply@mudateya.ar>',
        reply_to: 'hola@mudateya.ar',
        to: adminMail,
        subject,
        html:
          `<p>El ${quienConNombre} <b>${escapeXml(waId)}</b> ${intro} por WhatsApp.</p>` +
          `<p><b>Motivo:</b> ${escapeXml(motivo || '-')}</p>` +
          `<pre style="background:#f5f5f5;padding:10px;border-radius:8px;white-space:pre-wrap">${escapeXml(ultimos)}</pre>` +
          `<p><a href="https://wa.me/${String(waId).replace(/\D/g, '')}">Abrir WhatsApp del ${quienLabel} →</a></p>`,
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

  // Avisar a los OTROS mudanceros que cotizaron que el cliente eligió a otro (best-effort).
  try {
    await fetch(`${SITE_URL}/api/cotizaciones?action=avisar-no-elegidos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mudanzaId: pedido.id }),
    });
  } catch (_) {}

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

  const hayPago = !!link || !!(transf && (transf.checkoutUrl || transf.cbu || transf.alias));
  const nota = hayPago
    ? 'Cotización aceptada. Mostrá SOLO los datos de pago que están en ESTE resultado (link_pago_mp y/o transferencia), copiados EXACTAMENTE como vienen. NO inventes, completes ni cambies ningún link, alias, CBU ni monto. Si viene transferencia.checkoutUrl es un link de Talo con el monto ya cargado: ofrecelo como la mejor opción ("así no te equivocás"). Si no, pasá el CBU/alias tal cual y decile que transfiera EXACTAMENTE la seña. Aclarale que el 50% restante se paga al completar y que la seña queda protegida.'
    : 'Cotización aceptada, PERO no se pudo generar el pago (no hay link_pago_mp ni transferencia en este resultado). NO inventes NI muestres ningún link, alias, CBU ni monto: sería falso. Decile al cliente que hubo un problema generando el pago y que el equipo se lo pasa enseguida, y usá derivar_a_humano.';
  return {
    ok: true,
    mudancero: cot.mudanceroNombre,
    precio_total: cot.precio,
    sena,
    link_pago_mp: link || null,
    transferencia: transf || null,
    pago_disponible: hayPago,
    nota,
  };
}

// El cliente acepta/rechaza el ajuste de precio propuesto por el mudancero.
// Reusa aceptar-ajuste / rechazar-ajuste del web.
async function responderAjusteCliente(waId, decision) {
  const dec = decision === 'rechazar' ? 'rechazar' : (decision === 'aceptar' ? 'aceptar' : null);
  if (!dec) return { ok: false, mensaje: 'Decime si aceptás o rechazás el nuevo precio.' };
  const pedidos = await pedidosDelCliente(waId);
  const m = pedidos.slice().reverse().find((p) => p.ajustePrecio && p.ajustePrecio.estado === 'pendiente_aprobacion');
  if (!m) return { ok: false, mensaje: 'No tenés ningún ajuste de precio pendiente para responder.' };
  try {
    const action = dec === 'aceptar' ? 'aceptar-ajuste' : 'rechazar-ajuste';
    const r = await fetch(`${SITE_URL}/api/cotizaciones?action=${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mudanzaId: m.id, clienteEmail: m.clienteEmail }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) return { ok: false, mensaje: (d && d.error) || 'No pude registrar tu respuesta.' };
    if (dec === 'aceptar') {
      const nuevo = m.ajustePrecio.montoNuevo || 0;
      return { ok: true, mensaje: `¡Listo! Aceptaste el nuevo precio ($${Number(nuevo).toLocaleString('es-AR')}). El mudancero sigue adelante con tu ${m.tipo || 'mudanza'}.` };
    }
    return { ok: true, mensaje: 'Listo, rechazaste el ajuste. La mudanza se cancela y te devolvemos la seña. Lamentamos que no haya salido.' };
  } catch (e) {
    console.warn('responderAjusteCliente:', e.message);
    return { ok: false, mensaje: 'Tuve un problema registrando tu respuesta, probá de nuevo.' };
  }
}

// El cliente califica al mudancero tras una mudanza completada+pagada. Reusa el
// endpoint 'calificar', que guarda la reseña en el perfil del mudancero y
// recalcula su reputación (promedioEstrellas / calificacion / nroResenas).
async function calificarMudanceroCliente(waId, estrellas, comentario) {
  const n = parseInt(estrellas, 10);
  if (!(n >= 1 && n <= 5)) return { ok: false, mensaje: 'La calificación tiene que ser de 1 a 5 estrellas.' };
  const pedidos = await pedidosDelCliente(waId);
  // Mudanza completada + pagada + sin calificar, más reciente.
  const m = pedidos.slice().reverse().find((p) => p.estado === 'completada' && p.saldoPagado && !p.calificado);
  if (!m) {
    if (pedidos.some((p) => p.calificado)) return { ok: false, mensaje: 'Ya dejaste tu calificación. ¡Gracias!' };
    return { ok: false, mensaje: 'Para calificar, la mudanza tiene que estar completada y con el saldo pagado.' };
  }
  try {
    const r = await fetch(`${SITE_URL}/api/cotizaciones?action=calificar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mudanzaId: m.id, estrellas: n, comentario: comentario || '', clienteEmail: m.clienteEmail }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) return { ok: false, mensaje: (d && d.error) || 'No pude registrar la calificación.' };
    const mud = (m.cotizacionAceptada || {}).mudanceroNombre || 'el mudancero';
    return { ok: true, estrellas: n, mudancero: mud, mensaje: `¡Gracias! Registré tu calificación de ${n}⭐ para ${mud}. Suma a su reputación en MudateYa.` };
  } catch (e) {
    console.warn('calificarMudanceroCliente:', e.message);
    return { ok: false, mensaje: 'Tuve un problemita registrando la calificación, probá en un ratito.' };
  }
}

// Ejecuta una herramienta y devuelve el resultado (string) que Claude interpreta.
async function ejecutarTool(name, input, waId, conv) {
  try {
    if (name === 'crear_pedido') {
      const pedido = await crearPedido(input, waId, conv.ubicaciones, conv.fotos);
      // Limpiar fotos/ubicaciones para que el PRÓXIMO pedido no arrastre las de este.
      conv.fotos = [];
      conv.ubicaciones = [];
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
    if (name === 'agregar_detalle_pedido') {
      return JSON.stringify(await agregarDetallePedidoCliente(waId, input && input.detalle));
    }
    if (name === 'cancelar_pedido') {
      return JSON.stringify(await cancelarPedidoCliente(waId, input && input.id));
    }
    if (name === 'validar_direccion') {
      const { geocodificar } = require('./_geo');
      const g = await geocodificar(input && input.direccion);
      if (g.ok) {
        return JSON.stringify({
          existe: true, completa: g.completa, normalizada: g.formatted,
          calle: g.calle, numero: g.numero, localidad: g.localidad,
          nota: g.completa
            ? 'Dirección válida y completa. Podés usar la versión normalizada.'
            : 'La dirección existe pero le falta la calle o el número exacto: pedíselo al cliente.',
        });
      }
      if (g.existe === false) {
        return JSON.stringify({ existe: false, nota: 'No encontré esa dirección en el mapa. Pedile al cliente que la confirme (calle y número).' });
      }
      // Sin key de Google o error → no bloquear: seguir con lo que dio el cliente.
      return JSON.stringify({ existe: null, nota: 'No pude validar la dirección ahora; seguí con la que dio el cliente.' });
    }
    if (name === 'aceptar_cotizacion') {
      return JSON.stringify(await aceptarCotizacionCliente(waId, input && input.mudancero, input && input.pedidoId));
    }
    if (name === 'responder_ajuste') {
      return JSON.stringify(await responderAjusteCliente(waId, input && input.decision));
    }
    if (name === 'calificar_mudancero') {
      return JSON.stringify(await calificarMudanceroCliente(waId, input && input.estrellas, input && input.comentario));
    }
    if (name === 'derivar_a_humano') {
      return JSON.stringify(await derivarHumano(waId, input && input.motivo, conv));
    }
    if (name === 'registrar_mudancero') {
      return JSON.stringify(await registrarMudanceroCliente(waId, input));
    }
    if (name === 'registrar_asesor') {
      return JSON.stringify(await registrarAsesorCliente(waId, input));
    }
    if (name === 'registrar_inmobiliaria') {
      return JSON.stringify(await registrarInmobiliariaCliente(input));
    }
    if (name === 'resumen_mudateya') {
      // Defensa en profundidad: aunque esta tool solo se agrega a toolsUsados
      // para el equipo, se re-chequea acá por si algún día se llama distinto.
      if (!quienEscribe(waId)) return JSON.stringify({ error: 'No autorizado.' });
      return JSON.stringify(await resumenMudateYa());
    }
    return JSON.stringify({ error: 'herramienta desconocida' });
  } catch (e) {
    console.error('ejecutarTool', name, e.message);
    return JSON.stringify({ error: 'Ocurrió un error ejecutando ' + name });
  }
}

// Pre-registro de mudancero/fletero directo por WhatsApp — mismo endpoint
// REAL que usa mudanceros.html y el bot de Instagram (api/registrar-mudancero.js,
// tipoRegistro:'corto'), para que quede 100% igual que un alta hecha por la
// web: mismo esquema en Redis, mismo mail, mismo panel. Evita mandar a la
// persona a la web cuando ya está resolviendo todo por acá.
async function registrarMudanceroCliente(waId, input) {
  input = input || {};
  const telefono = input.whatsapp || waId;
  try {
    const r = await fetch(`${SITE_URL}/api/registrar-mudancero`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipoRegistro: 'corto',
        nombre: input.nombre,
        empresa: input.empresa,
        telefono,
        email: input.email,
        zonaBase: input.zona,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (data.estado) {
        return { ok: true, existente: true, nota: 'Ya tenía un perfil con ese email (estado: ' + data.estado + '). Le llega un mail para entrar a completarlo.' };
      }
      return { ok: false, error: data.error || 'No se pudo registrar. Revisá los datos.' };
    }
    return { ok: true, existente: false, nota: 'Pre-registrado con éxito. Le llega un mail para completar vehículo, fotos y precios desde su cuenta — recién ahí queda listo para recibir pedidos.' };
  } catch (e) {
    return { ok: false, error: 'No pudimos completar el registro ahora. Probá de nuevo en un rato.' };
  }
}

// Alta de asesor inmobiliario directo por WhatsApp — mismo endpoint REAL que
// usan las landings de derivación (api/canales.js?action=registrar). Se da de
// alta en el canal "independientes" (el genérico, para asesores que no son de
// Mudafy/RE-MAX/C21): recibe un link FIJO que no vence, sin login ni
// dashboard — es el único sistema de asesores que se usa de verdad hoy.
async function registrarAsesorCliente(waId, input) {
  input = input || {};
  const whatsapp = input.whatsapp || waId;
  try {
    const r = await fetch(`${SITE_URL}/api/canales?action=registrar&canal=independientes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nombre: input.nombre,
        email: input.email,
        whatsapp,
        inmobiliaria: input.inmobiliaria,
        zona: input.zona,
        origen: 'whatsapp-emi',
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, error: data.error || 'No se pudo registrar. Revisá los datos.' };
    }
    if (data.yaExistia) {
      return { ok: true, existente: true, link: data.link, nota: `Ya estaba registrado con ese email. Este es su link fijo (no vence): ${data.link}` };
    }
    return { ok: true, existente: false, link: data.link, nota: `Registrado con éxito. Le llega un mail de bienvenida con su link y QR. Este es su link fijo (no vence, pasáselo tal cual): ${data.link}` };
  } catch (e) {
    return { ok: false, error: 'No pudimos completar el registro ahora. Probá de nuevo en un rato.' };
  }
}

// Solicitud de alta de inmobiliaria directo por WhatsApp — mismo endpoint REAL
// que usa inmobiliarias-registro.html y el bot de Instagram
// (api/inmobiliarias.js?action=solicitar-alta). Queda pendiente de revisión.
async function registrarInmobiliariaCliente(input) {
  input = input || {};
  try {
    const r = await fetch(`${SITE_URL}/api/inmobiliarias?action=solicitar-alta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nombre: input.nombreInmobiliaria,
        contacto: input.contacto,
        colegio: input.colegio,
        matricula: input.matricula,
        email: input.email,
        whatsapp: input.whatsapp,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, error: data.error || 'No se pudo enviar la solicitud. Revisá los datos.' };
    }
    if (data.existente) {
      return { ok: true, existente: true, nota: data.mensaje || 'Ese email ya está registrado.' };
    }
    return { ok: true, existente: false, nota: 'Solicitud recibida. El equipo la revisa y lo contacta en 24h hábiles para coordinar la activación.' };
  } catch (e) {
    return { ok: false, error: 'No pudimos enviar la solicitud ahora. Probá de nuevo en un rato.' };
  }
}

// Base del barrido saliente a mudanceros. INTENCIONALMENTE deshabilitado: enviar
// WhatsApp a fleteros reales cuesta plata y les llega a personas reales, así que
// no se dispara solo. Cuando quieras activarlo, reutilizá enviarWhatsApp() de
// _whatsapp.js con una plantilla aprobada. Por ahora solo deja el pedido cargado.
// Barrido a mudanceros REALES. Apagado por defecto: solo se activa con
// BARRIDO_ACTIVO=1 (así, mientras probás, ningún mudancero real recibe nada).
// Cuando lo prendas y saques TEST_MUDANCERO_EMAIL, un pedido nuevo dispara:
//   1) Email + push + PDF a todos los aprobados (reusa notificarMudanceros de la web).
//   2) WhatsApp: plantilla nuevo_pedido_mudancero a los aprobados con teléfono.
// Respeta el modo 'dirigido' (si el pedido tiene mudancerosInvitados, solo a ellos).
async function iniciarBarridoMudanceros(pedido) {
  const ACTIVO = process.env.BARRIDO_ACTIVO === '1' || process.env.BARRIDO_ACTIVO === 'true';
  if (!ACTIVO) {
    console.log(`[barrido] APAGADO — pedido ${pedido.id} (${pedido.tipo}) ${pedido.origen} -> ${pedido.destino}. Prendé BARRIDO_ACTIVO=1 para avisar a mudanceros reales.`);
    return;
  }
  console.log(`[barrido] ACTIVO — pedido ${pedido.id}: notificando mudanceros reales`);

  // 1) Email + push + PDF a los aprobados (misma lógica que el marketplace web).
  try {
    const { notificarMudanceros } = require('./cotizaciones');
    await notificarMudanceros(pedido);
  } catch (e) { console.error('[barrido] notificarMudanceros:', e.message); }

  // 2) WhatsApp a los aprobados con teléfono.
  try {
    await barridoWhatsApp(pedido);
  } catch (e) { console.error('[barrido] whatsapp:', e.message); }
}

async function barridoWhatsApp(pedido) {
  const { enviarPlantilla } = require('./_plantillas');
  const { coincideZona, palabrasZona } = require('./match-mudanceros');
  const todos = (await getJSON('mudanceros:todos')) || [];
  const dirigido = pedido.modoCotizacion === 'dirigido';
  const invitados = pedido.mudancerosInvitados || [];
  // Pedido del bot en modo abierto: avisar a TODOS los que cubren la zona del
  // pedido, no a cualquier aprobado sin importar dónde esté (mismo criterio
  // de zona que usa match-mudanceros.js).
  const palabrasZonaPedido = palabrasZona(`${pedido.origen || ''} ${pedido.destino || ''}`);
  let enviados = 0;
  for (const email of todos) {
    if (enviados >= 60) break; // tope defensivo por corrida
    const p = await getJSON(`mudancero:perfil:${email}`);
    if (!p || p.estado !== 'aprobado' || !p.telefono) continue;
    if (dirigido) {
      if (!invitados.includes(email)) continue;
    } else {
      const cobertura = `${p.zonaBase || ''} ${p.zonasExtra || ''}`;
      if (!coincideZona(cobertura, palabrasZonaPedido)) continue;
    }
    const nom = (p.nombre || '').split(' ')[0] || 'Hola';
    const resumen =
      `🆕 Nuevo pedido para cotizar (${pedido.tipo}):\n` +
      `📍 ${pedido.origen}\n🏁 ${pedido.destino}\n📅 ${pedido.fecha || 'a coordinar'}` +
      `${pedido.km ? `\n📏 ${parseInt(pedido.km)} km` : ''}\n\n` +
      `Entrá a cotizar: https://mudateya.ar/mi-cuenta`;
    try {
      await enviarPlantilla(
        p.telefono, 'nuevo_pedido_mudancero',
        { 1: nom, 2: pedido.origen, 3: pedido.destino, 4: pedido.fecha || 'a coordinar' },
        resumen
      );
      enviados++;
    } catch (e) { console.warn('[barrido] wa', email, e.message); }
  }
  console.log(`[barrido] whatsapp enviados: ${enviados}`);
}

// ------------------------------------------------------------------
// Genera la respuesta del agente (texto) para un mensaje entrante
// ------------------------------------------------------------------
async function generarRespuesta(waId, texto, imagenes, ubicacion, mudancero, asesor) {
  // El equipo fundador (persona) gana SIEMPRE sobre mudancero/asesor, aunque
  // el número también esté de alta como tal (ej: cuentas de prueba) — si no,
  // Emi le contesta con el prompt de mudancero/asesor, que explícitamente no
  // da datos internos del negocio.
  const persona = quienEscribe(waId);
  const key = mudancero && !persona ? `wa:conv:mud:${waId}` : asesor && !persona ? `wa:conv:ase:${waId}` : `wa:conv:${waId}`;
  const conv = (await getJSON(key)) || { messages: [] };

  // ── Fotos para un pedido YA ABIERTO (relevamiento remoto) ──────────────────
  // Si el cliente (no mudancero) manda fotos y ya tiene un pedido buscando/
  // cotizando, se las adjuntamos DIRECTO a ese pedido (así el mudancero que
  // pidió "relevamiento" puede ajustar el precio sin visita) en vez de tratarlas
  // como fotos para un pedido nuevo. Cada foto se modera antes de guardarse:
  // no puede mostrar teléfono ni email (mismo criterio que las fotos de
  // mudanceros) — el contacto siempre tiene que ser a través de MudateYa.
  if ((!mudancero || persona) && (!asesor || persona) && imagenes && imagenes.length) {
    try {
      const pedidos = await pedidosDelCliente(waId);
      const abiertos = pedidos.filter((p) => p && (p.estado === 'buscando' || p.estado === 'cotizando'));
      if (abiertos.length) {
        const pedido = abiertos[abiertos.length - 1]; // el más reciente
        const fotosActuales = (pedido.detallesAdicionales && Array.isArray(pedido.detallesAdicionales.fotos))
          ? pedido.detallesAdicionales.fotos.slice() : [];
        let agregadas = 0, rechazadasPorContacto = 0;
        for (const img of imagenes) {
          if (fotosActuales.length >= 5) break; // mismo tope que usa cotizaciones.js
          const data = await descargarMediaBase64(img.url);
          if (!data) continue;
          const chequeo = await chequearContactoEnFoto(data, img.tipo);
          if (chequeo.tieneContacto) { rechazadasPorContacto++; continue; }
          const url = await subirFotoBlob(data, img.tipo);
          if (url) { fotosActuales.push(url); agregadas++; }
        }
        if (agregadas > 0 || rechazadasPorContacto > 0) {
          pedido.detallesAdicionales = pedido.detallesAdicionales || {};
          pedido.detallesAdicionales.fotos = fotosActuales;
          try { await setJSON(`mudanza:${pedido.id}`, pedido); } catch (e) { console.warn('guardar fotos pedido:', e.message); }
          if (agregadas > 0) {
            try { await avisarMudanceroFotosOTexto(pedido, 'fotos'); } catch (e) { console.warn('avisar mudancero fotos:', e.message); }
          }

          if (agregadas > 0 && !rechazadasPorContacto) {
            return `¡Gracias! Agregué ${agregadas} foto${agregadas > 1 ? 's' : ''} a tu pedido — el mudancero ya las va a ver para ajustarte el precio sin necesidad de visitarte. 📷`;
          }
          if (agregadas > 0 && rechazadasPorContacto) {
            return `Agregué ${agregadas} foto${agregadas > 1 ? 's' : ''} a tu pedido, pero ${rechazadasPorContacto === 1 ? 'una mostraba' : rechazadasPorContacto + ' mostraban'} un teléfono o email — esa${rechazadasPorContacto > 1 ? 's' : ''} no la${rechazadasPorContacto > 1 ? 's' : ''} guardé. El contacto con el mudancero siempre es a través de MudateYa. Si querés, mandame otra sin esos datos.`;
          }
          return `Esa foto mostraba un teléfono o email de contacto, así que no la guardé — el mudancero te tiene que contactar siempre a través de MudateYa. Mandame otra sin esos datos y la agrego a tu pedido. 📷`;
        }
        // Si ninguna foto se pudo bajar/procesar, seguimos al flujo normal abajo.
      }
    } catch (e) { console.warn('fotos relevamiento pedido abierto:', e.message); }
  }

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
    conv.fotos = Array.isArray(conv.fotos) ? conv.fotos : [];
    for (const img of imagenes) {
      const data = await descargarMediaBase64(img.url);
      if (data) {
        bloques.push({ type: 'image', source: { type: 'base64', media_type: img.tipo, data } });
        // Persistimos la foto (Blob público) para adjuntarla al pedido: el fletero/
        // mudancero la ve y dimensiona. Cap 6 fotos por pedido.
        if (conv.fotos.length < 6) {
          const url = await subirFotoBlob(data, img.tipo);
          if (url) conv.fotos.push(url);
        }
      }
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

  // Elegimos system + herramientas según sea mudancero, asesor, equipo o
  // cliente. El equipo fundador (persona) gana SIEMPRE, aunque el número
  // también esté de alta como mudancero o asesor (ej: cuentas de prueba):
  // si no, quienEscribe() nunca se llega a chequear y Emi les contesta con
  // el prompt de mudancero/asesor, que explícitamente no da datos internos.
  let system, toolsUsados;
  if (mudancero && !persona) {
    const nombre = (mudancero.nombre || '').split(' ')[0] || 'colega';
    system = SYSTEM_PROMPT_MUDANCERO.replace('{NOMBRE}', nombre);
    toolsUsados = mudanceroTools; // flujo completo del mudancero por WhatsApp

    // AUTO-CONTEXTO: cargamos sus cotizaciones/pedidos actuales SIEMPRE, no
    // solo si decide llamar a mis_pedidos. Es un snapshot al arranque del
    // turno — si necesita algo más fresco a mitad de charla (recién cotizó
    // otro), igual puede llamar a mis_pedidos/ver_pedidos.
    try {
      const rMis = await fetch(`${SITE_URL}/api/cotizaciones?action=mis-cotizaciones&email=${encodeURIComponent(mudancero.email)}`);
      const dMis = await rMis.json().catch(() => ({}));
      const misPedidos = (dMis.mudanzas || []).map((m) => ({
        id: m.id, tipo: m.tipo, ruta: `${m.desde || ''} → ${m.hasta || ''}`, estado: m.estado,
        miPrecio: (m.miCotizacion && m.miCotizacion.precio) || (m.cotizacionAceptada && m.cotizacionAceptada.precio) || null,
      }));
      const resumenMud = misPedidos.length
        ? misPedidos.map((p) => `- ${p.id} (${p.tipo}, ${p.ruta}), estado: ${p.estado}${p.miPrecio ? `, tu precio: $${p.miPrecio}` : ''}`).join('\n')
        : 'No tenés pedidos/cotizaciones activos ahora mismo.';
      system += `\n\nTUS PEDIDOS/COTIZACIONES (snapshot de referencia rápida — no hace falta llamar a mis_pedidos si ya está acá; para pedidos NUEVOS disponibles en tu zona usá ver_pedidos):\n${resumenMud}`;
    } catch (e) { console.warn('auto-contexto mudancero:', e.message); }
  } else if (asesor && !persona) {
    const nombre = (asesor.nombre || '').split(' ')[0] || 'colega';
    const canalNombre = CANALES_ASESOR_NOMBRE[asesor.canal] || asesor.canal;
    system = SYSTEM_PROMPT_ASESOR.split('{NOMBRE}').join(nombre).split('{CANAL}').join(canalNombre);
    toolsUsados = asesorTools;

    // AUTO-CONTEXTO: mismo criterio que con mudanceros — snapshot de sus
    // pedidos referidos al arranque del turno, sin esperar a que llame a
    // ver_mis_pedidos_referidos.
    try {
      const misPedidos = await pedidosReferidosDelAsesor(asesor.prefijo, asesor.codigo);
      const resumenAse = misPedidos.length
        ? misPedidos.map((p) => `- ${p.id} (cliente: ${p.cliente || '?'}, ${p.ruta}), estado: ${p.estado}${p.anticipoPagado ? ', seña pagada' : ''}${p.saldoPagado ? ', saldo pagado' : ''}${p.tipoOperacion ? `, operación: ${p.tipoOperacion}` : ''}`).join('\n')
        : 'Todavía no le llegó ningún cliente por su link.';
      system += `\n\nTUS PEDIDOS REFERIDOS (snapshot de referencia rápida — no hace falta llamar a ver_mis_pedidos_referidos si ya está acá):\n${resumenAse}`;
    } catch (e) { console.warn('auto-contexto asesor:', e.message); }
  } else {
    // persona ya está calculado arriba (gana sobre mudancero/asesor).
    // Base de conocimiento sincronizada de la web (ver _conocimiento.js) — si
    // todavía no corrió el cron o Redis falla, usa el fallback fijo de acá.
    // Nunca bloquea: si algo falla, sigue con el fallback sin cortar el flujo.
    let conocimiento = null;
    try { conocimiento = await require('./_conocimiento').obtenerConocimiento(); } catch (e) {}
    const bloqueConocimiento = (conocimiento && conocimiento.texto) || CONOCIMIENTO_FALLBACK;
    // split/join en vez de .replace(): el bloque tiene precios con "$" y
    // .replace() interpreta patrones especiales ($&, $', etc.) en el reemplazo.
    const promptCliente = SYSTEM_PROMPT.split('{{CONOCIMIENTO}}').join(bloqueConocimiento);
    system = persona
      ? `${promptCliente}\n\nCONTEXTO: quien te escribe es ${persona}, del equipo fundador de MudateYa. Tratalo por su nombre, con confianza y cercanía; no le expliques qué es MudateYa como si fuera un cliente nuevo. Tenés una herramienta extra, resumen_mudateya, para cuando te pregunte números del negocio (pedidos, mudanceros, asesores) — no existe para clientes comunes.`
      : promptCliente;
    toolsUsados = persona ? tools.concat([RESUMEN_MUDATEYA_TOOL]) : tools;

    // AUTO-CONTEXTO: cargamos los pedidos/cotizaciones del cliente SIEMPRE, no
    // solo si Emi decide llamar a consultar_estado_pedido. Es un snapshot al
    // arranque del turno — si necesita algo más fresco (recién llegó una
    // cotización nueva), igual puede llamar a consultar_estado_pedido.
    if (!persona) {
      try {
        const pedidosCliente = await pedidosDelCliente(waId);
        const resumenCliente = pedidosCliente.length
          ? pedidosCliente.map((p) => {
              const r = resumenPedido(p);
              const cots = r.cotizaciones.length
                ? r.cotizaciones.map((c) => `${c.mudancero || 'un mudancero'}: $${c.precio}${c.nota ? ` ("${c.nota}")` : ''}`).join('; ')
                : 'sin cotizaciones todavía';
              return `- ${r.id} (${r.tipo}, ${r.origen || ''} → ${r.destino || ''}, estado: ${r.estado}${r.vence ? `, vence: ${r.vence}` : ''}): ${cots}`;
            }).join('\n')
          : 'El cliente no tiene pedidos activos ahora mismo.';
        system += `\n\nPEDIDOS/COTIZACIONES ACTUALES DE ESTE CLIENTE (snapshot de referencia rápida — no hace falta llamar a consultar_estado_pedido si ya está acá):\n${resumenCliente}`;
      } catch (e) { console.warn('auto-contexto cliente:', e.message); }
    }
  }

  // Contexto temporal: Claude NO sabe qué día ni hora es. Se lo damos (hora de
  // Argentina) para que interprete "hoy", "mañana", "a la tarde", y se dé cuenta
  // cuando un horario pedido ya pasó.
  const ahoraAR = new Date().toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  system += `\n\nAHORA (hora de Argentina): ${ahoraAR}. Usá esto para interpretar "hoy", "mañana", "en un rato", "a la tarde", etc. Si el cliente pide un horario que YA PASÓ hoy, avisale con onda y preguntale si lo quiere más tarde hoy o para otro día. Cuando anotes la fecha/hora del pedido, dejala clara (ej: "hoy 13:00").`;

  // Loop agéntico: Claude puede encadenar herramientas hasta dar la respuesta final.
  let resp = await askClaude(trabajo, system, toolsUsados);
  let vueltas = 0;
  while (resp.stop_reason === 'tool_use' && vueltas < 5) {
    vueltas++;
    trabajo = trabajo.concat([{ role: 'assistant', content: resp.content }]);
    const resultados = [];
    for (const block of resp.content || []) {
      if (block.type === 'tool_use') {
        const r = mudancero && !persona
          ? await ejecutarToolMudancero(block.name, block.input, mudancero, waId, conv)
          : asesor && !persona
          ? await ejecutarToolAsesor(block.name, block.input, asesor, waId, conv)
          : await ejecutarTool(block.name, block.input, waId, conv);
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

    // ¿Quien escribe es un mudancero o un asesor registrado? (por teléfono) →
    // asistente aparte. Se chequea mudancero primero (ya existía); asesor solo
    // si no es mudancero, para no pagar el lookup de más en el caso común.
    const mud = await buscarMudancero(waId);
    const ase = mud ? null : await buscarAsesorCanal(waId);
    if (waId) await registrarInteraccionDiaria(waId, !!mud);

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

    const respuesta = await generarRespuesta(waId, textoFinal, imagenes, ubicacion, mud, ase);
    return res.status(200).send(twiml(respuesta));
  } catch (e) {
    console.error('Error webhook Twilio WhatsApp:', e);
    return res.status(200).send(twiml('Uy, tuve un problemita. Probá de nuevo en un momento 🙏'));
  }
};
