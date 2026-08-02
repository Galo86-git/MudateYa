// api/instagram.js
// Agente que RESPONDE los DMs de Instagram de MudateYa.
// Objetivo: captar asesores inmobiliarios como socios referidores y darlos de alta.
//
// IMPORTANTE: el alta NO se hace acá — se llama al endpoint real de asesores
// (api/asesores.js?action=register), el mismo que usa el form de la web
// (asesor-registro.html). Así el asesor que se registra por Instagram queda
// 100% igual que uno que se registra por la web: mismo esquema en Redis
// (asesor:{email} + índice asesores:todos), mismo mail de bienvenida, mismo
// panel (/asesor-login). Si el día de mañana cambia el flujo de alta, este
// bot lo hereda solo, sin tocar nada acá.
//
// Variables de entorno necesarias (Vercel → Settings → Environment Variables):
//   IG_VERIFY_TOKEN         -> token que vos inventás y también ponés en el panel de Meta
//   IG_ACCESS_TOKEN         -> Instagram User access token (cuenta professional; permiso instagram_business_manage_messages)
//   ANTHROPIC_API_KEY       -> ya la tenés en MudateYa (la usa Emi)
//   UPSTASH_REDIS_REST_URL  -> ya la tenés en MudateYa
//   UPSTASH_REDIS_REST_TOKEN-> ya la tenés en MudateYa
//   SITE_URL (opcional)     -> default https://mudateya.ar
//   CLAUDE_MODEL (opcional) -> ID del modelo; default claude-sonnet-4-5

const GRAPH = 'https://graph.instagram.com/v21.0'; // Instagram API con Instagram Login
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
const SITE_URL = process.env.SITE_URL || 'https://mudateya.ar';

// ------------------------------------------------------------------
// Redis (Upstash REST, estilo path) — mismo patrón que el resto de /api.
// ------------------------------------------------------------------
async function redisCall(method, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const r = await fetch(`${url}/${[method, ...args].map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await r.json();
  return data.result;
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
// System prompt del agente
// ------------------------------------------------------------------
const SYSTEM_PROMPT = `Sos el asistente de MudateYa en Instagram. MudateYa es un marketplace argentino de mudanzas y fletes que conecta clientes con mudanceros/fleteros verificados.

Tu único objetivo en este chat: sumar ASESORES INMOBILIARIOS al programa de Asesores MudateYa. Un asesor arma presupuestos de mudanza gratis para sus clientes (que acaban de comprar o alquilar y se tienen que mudar) desde su panel — un servicio que suma valor a su propuesta, y cobra una comisión cuando esa mudanza se concreta y se paga.

TONO: cercano, rioplatense, directo. Mensajes CORTOS, es un DM de Instagram. Nada de párrafos largos ni formal. Un emoji cada tanto está bien, no más.

CÓMO TRABAJÁS:
1. Si saludan o preguntan por el programa, explicá en 1-2 líneas y arrancá a pedir datos.
2. Necesitás juntar 5 datos, de a uno o dos por mensaje (no los pidas todos de golpe):
   - nombre y apellido
   - inmobiliaria (o "Independiente")
   - email
   - WhatsApp
   - zona donde trabaja (ej: CABA, zona norte, zona sur, Rosario, Córdoba, Mendoza, u otra ciudad)
3. Cuando tengas los 5 datos, llamá a la herramienta registrar_asesor. Si te devuelve un error (dato inválido), pedile amablemente que te lo corrija y volvé a intentar — NO inventes datos para completar.
4. Si preguntan por la plata: la comisión se acredita cuando la mudanza que armó desde su panel se completa y se paga. NO prometas montos exactos si no los sabés.
5. Después de un alta exitosa, contale que le mandamos un mail con el link a su panel para empezar a armar presupuestos.

REGLAS: no pidas datos sensibles, no prometas lo que no podés cumplir, y si el mensaje no tiene que ver con esto respondé amable y reconducí al programa.

IMPORTANTE — NUNCA escribas en este chat ningún link, URL ni dominio (ni "mudateya.ar", ni "http...", nada). Instagram bloquea el envío de mensajes con links desde esta cuenta. El link de verdad SIEMPRE le llega por mail — acá solo decile "te lo mandamos por mail" o "revisá tu casilla", sin repetir la dirección.`;

const tools = [
  {
    name: 'registrar_asesor',
    description:
      "Registra a un asesor inmobiliario en el programa de Asesores MudateYa. Llamala SOLO cuando ya tengas los 5 datos: nombre y apellido, inmobiliaria (o 'Independiente'), email, WhatsApp y zona donde trabaja.",
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'nombre y apellido del asesor' },
        inmobiliaria: { type: 'string', description: "nombre de la inmobiliaria, o 'Independiente'" },
        email: { type: 'string' },
        whatsapp: { type: 'string', description: 'número de WhatsApp / teléfono de contacto' },
        zona: { type: 'string', description: 'zona donde trabaja (ej: CABA, zona norte, zona sur, Rosario, Córdoba, Mendoza, u otra)' },
      },
      required: ['nombre', 'inmobiliaria', 'email', 'whatsapp', 'zona'],
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
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    }),
  });
  return res.json();
}

// ------------------------------------------------------------------
// Alta del asesor: delega en el endpoint REAL (api/asesores.js), el mismo
// que usa asesor-registro.html. No reinventamos el esquema acá.
// ------------------------------------------------------------------
async function registrarAsesor(input) {
  try {
    const r = await fetch(`${SITE_URL}/api/asesores?action=register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nombre: input.nombre,
        email: input.email,
        telefono: input.whatsapp,
        inmobiliaria: input.inmobiliaria,
        zona: input.zona,
      }),
    });
    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      // Error de validación del endpoint real (email inválido, tel corto, etc.)
      return JSON.stringify({ ok: false, error: data.error || 'No se pudo registrar. Revisá los datos.' });
    }
    if (data.existente) {
      return JSON.stringify({ ok: true, existente: true, nota: 'Ya estaba registrado con ese email. Le mandamos un mail con el link a su panel.' });
    }
    return JSON.stringify({ ok: true, existente: false, nota: 'Registrado con éxito. Le llega un mail de bienvenida con el link a su panel de Asesor MudateYa.' });
  } catch (e) {
    return JSON.stringify({ ok: false, error: 'No pudimos completar el registro ahora. Probá de nuevo en un rato.' });
  }
}

// ------------------------------------------------------------------
// Enviar mensaje por Instagram
// ------------------------------------------------------------------
// CRÍTICO: si no revisamos la respuesta, un rechazo de Meta (token sin
// permiso, fuera de la ventana de 24hs, app no aprobada aún, etc.) queda
// completamente en silencio — el bot "no contesta más" y nunca hay ningún
// error en los logs para saber por qué. Acá SIEMPRE logueamos el motivo.
// Red de seguridad además de la instrucción en el system prompt: si Claude
// igual menciona un link/dominio, lo cortamos ANTES de mandarlo. Instagram
// puede rechazar el mensaje entero si detecta un link (ver nota abajo).
function sinLinks(texto) {
  const original = String(texto || '');
  const limpio = original
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/www\.\S+/gi, '')
    .replace(/\b[a-z0-9-]+\.(ar|com|com\.ar|net|org|io|co|app)\b(\/\S*)?/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (limpio !== original.trim()) {
    console.warn('[instagram] Le saqué un link a la respuesta antes de enviar:', original);
  }
  return limpio || 'Dale, seguimos por acá 🙂';
}

async function enviarIG(igsid, texto) {
  try {
    const r = await fetch(`${GRAPH}/me/messages?access_token=${process.env.IG_ACCESS_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: igsid }, message: { text: texto } }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[instagram] Meta RECHAZÓ el envío del mensaje:', JSON.stringify(data));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[instagram] Error de red enviando a Instagram:', e.message);
    return false;
  }
}

// ------------------------------------------------------------------
// Procesar un mensaje entrante — loop agéntico (Claude puede llamar la
// herramienta, ver el resultado, y responder en base a eso). Mismo patrón
// que el bot de WhatsApp (api/whatsapp.js).
// ------------------------------------------------------------------
async function procesarMensaje(igsid, texto) {
  try {
    const key = `ig:conv:${igsid}`;
    const conv = (await getJSON(key)) || { messages: [] };

    conv.messages.push({ role: 'user', content: texto });
    if (conv.messages.length > 20) conv.messages = conv.messages.slice(-20); // acota el historial

    let trabajo = conv.messages;
    let resp = await askClaude(trabajo);
    if (resp.type === 'error' || !resp.content) {
      // Error de la API de Claude (key inválida, rate limit, modelo caído, etc.)
      console.error('[instagram] Claude devolvió error:', JSON.stringify(resp).slice(0, 500));
    }
    let vueltas = 0;
    while (resp.stop_reason === 'tool_use' && vueltas < 5) {
      vueltas++;
      trabajo = trabajo.concat([{ role: 'assistant', content: resp.content }]);
      const resultados = [];
      for (const block of resp.content || []) {
        if (block.type === 'tool_use' && block.name === 'registrar_asesor') {
          const r = await registrarAsesor(block.input);
          resultados.push({ type: 'tool_result', tool_use_id: block.id, content: r });
        }
      }
      trabajo = trabajo.concat([{ role: 'user', content: resultados }]);
      resp = await askClaude(trabajo);
    }

    const textoResp =
      (resp.content || [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n')
        .trim() || 'Perdón, no te entendí bien. ¿Me lo repetís?';

    conv.messages = trabajo.concat([{ role: 'assistant', content: resp.content || [] }]);
    if (conv.messages.length > 20) conv.messages = conv.messages.slice(-20);
    await setJSON(key, conv, 60 * 60 * 24 * 30);

    let enviado = await enviarIG(igsid, sinLinks(textoResp));
    if (!enviado) {
      // Reintento con un mensaje mínimo, sin nada que pueda volver a disparar
      // el filtro de Meta — mejor que le llegue algo genérico a que quede mudo.
      console.error('[instagram] Falló el envío a', igsid, '- reintentando con mensaje mínimo.');
      enviado = await enviarIG(igsid, 'Hola! 👋 Contame de nuevo en qué te puedo ayudar.');
      if (!enviado) console.error('[instagram] También falló el reintento a', igsid, '- Meta está bloqueando esta cuenta por completo. Revisar Account Status.');
    }
  } catch (e) {
    // Red de seguridad: cualquier falla imprevista (Redis, Claude, lo que sea)
    // queda LOGUEADA con el igsid y el mensaje que la disparó, en vez de morir
    // en silencio. Intentamos, best-effort, avisarle al usuario igual.
    console.error('[instagram] Error procesando mensaje de', igsid, '— texto:', texto, '— error:', e.message, e.stack);
    try { await enviarIG(igsid, 'Uy, tuve un problema técnico. ¿Me escribís de nuevo en un rato?'); } catch (e2) {}
  }
}

// ------------------------------------------------------------------
// Handler principal (Vercel Function)
// ------------------------------------------------------------------
module.exports = async function handler(req, res) {
  // 1) Verificación del webhook (Meta pega un GET al configurarlo)
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.IG_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  if (req.method !== 'POST') return res.status(405).end();

  // 2) Mensajes entrantes
  try {
    const body = req.body;
    if (body && body.object === 'instagram') {
      for (const entry of body.entry || []) {
        for (const event of entry.messaging || []) {
          if (!event.message || event.message.is_echo || !event.message.text) continue;

          // Dedup: Meta puede reintentar el mismo mensaje
          const mid = event.message.mid;
          if (mid) {
            const nuevo = await redisCall('SET', `ig:mid:${mid}`, '1', 'EX', '600', 'NX');
            if (nuevo !== 'OK') continue; // ya lo procesamos
          }

          await procesarMensaje(event.sender.id, event.message.text);
        }
      }
    }
  } catch (e) {
    console.error('Error procesando webhook IG:', e.message);
  }

  // Respondemos 200 al final para que Meta no reintente
  return res.status(200).send('EVENT_RECEIVED');
};
