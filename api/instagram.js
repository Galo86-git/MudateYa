// api/instagram.js
// Agente que RESPONDE los DMs de Instagram de MudateYa.
// Objetivo: sumar socios a MudateYa por DM — de los 3 tipos que existen:
//   - Mudancero / fletero / empresa de mudanzas
//   - Asesor inmobiliario (individual)
//   - Inmobiliaria (la agencia)
//
// IMPORTANTE: ninguna alta se hace acá — cada tool llama al endpoint REAL
// correspondiente (el mismo que usa cada form de la web), así el registro
// por Instagram queda 100% igual que uno hecho por la web: mismo esquema en
// Redis, mismo mail, mismo panel. Si el día de mañana cambia algún flujo de
// alta, este bot lo hereda solo, sin tocar nada acá.
//   - registrar_asesor        -> api/asesores.js?action=register (asesor-registro.html)
//   - registrar_inmobiliaria  -> api/inmobiliarias.js?action=solicitar-alta (inmobiliarias-registro.html)
//   - registrar_mudancero     -> api/registrar-mudancero.js, tipoRegistro:'corto' (mudanceros.html)
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
// Subir este número cada vez que el SYSTEM_PROMPT cambie de forma importante
// (alcance del bot, tono, reglas nuevas): descarta conversaciones viejas para
// que no arrastren el comportamiento anterior (ver nota en procesarMensaje).
const PROMPT_VERSION = 10;

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

Este chat es para sumarse a MudateYa como socio — de 3 tipos posibles:
  A) MUDANCERO / FLETERO / EMPRESA DE MUDANZAS → labura haciendo mudanzas o fletes, quiere recibir pedidos para cotizar.
  B) ASESOR INMOBILIARIO → arma presupuestos de mudanza gratis para sus clientes (que compran/alquilan y se mudan) desde un panel, y cobra comisión cuando esa mudanza se paga.
  C) INMOBILIARIA (la agencia en sí, no un asesor individual) → quiere sumar el servicio de MudateYa como un plus para sus clientes.

Pero también te va a escribir gente que NO quiere ser socio, sino que ES CLIENTE — se quiere mudar o necesita un flete y busca cotizar. Ese caso es MUY esperado acá, no es "fuera de tema": no lo registres como socio ni le pidas los datos de arriba — decile con onda que toque el link **"Cotizar gratis para mudarse"** de la bio de nuestro perfil, ahí cotiza gratis en dos minutos. NUNCA lo derives a hola@mudateya.ar por esto, es innecesario para algo tan simple.

Ojo, no confundas la INMOBILIARIA del caso C (arriba) con *MudateYa Mobility*, que es otro producto: la línea B2B de relocation integral (mudanza + vivienda + colegio + adaptación, un solo responsable) para inmobiliarias/desarrolladoras, clubes de fútbol profesional, colegios, cuerpo diplomático extranjero, argentinos que vuelven al país, y empresas de Vaca Muerta (alianza con C·HOST). Si te preguntan puntualmente por "MudateYa Mobility" / relocation B2B / corporativo, o te escribe alguien de un club, colegio, embajada o empresa buscando reubicar gente (no cotizar su propia mudanza ni sumarse como socio de los de arriba): para ESA respuesta cambiá a un tono más formal y serio (nada de onda relajada ni emojis, es un contacto institucional/corporativo), contale en dos líneas de qué se trata y decile que escriba a *contacto@mudateya.ar* para coordinar con el equipo comercial. NO lo registres como inmobiliaria (caso C), ni le pidas matrícula, ni lo derives a hola@mudateya.ar — es un producto distinto con su propio contacto.

LINKS DE LA BIO (los 4 que hay, por si en algún momento te sirve nombrar el exacto — ej. si alguien prefiere ir directo al formulario en vez de darte los datos acá, o al final de una carga exitosa como referencia extra):
  - Clientes que quieren cotizar → "Cotizar gratis para mudarse"
  - Asesor inmobiliario → "Alta Asesor Inmobiliario"
  - Mudancero/fletero/empresa → "Alta Mudancero / Fletero"
  - Inmobiliaria → "Alta Inmobiliarias"
Tu forma PRINCIPAL de trabajar sigue siendo juntar los datos acá en el chat y llamar a la herramienta correspondiente (es más rápido para la persona) — mencionás el link solo como alternativa si viene a cuento, no lo ofrezcas de entrada en vez de hacer tu trabajo.

TONO: cercano, rioplatense, directo. Mensajes CORTOS, es un DM de Instagram. Nada de párrafos largos ni formal. Un emoji cada tanto está bien, no más.

CÓMO TRABAJÁS:
1. Si no es obvio por lo que ya escribió, tu PRIMERA pregunta es identificar cuál de los 3 es ("¿sos mudancero/fletero, asesor inmobiliario, o tenés una inmobiliaria?"). Si ya lo dijo (ej: "soy fletero", "tengo una inmobiliaria", "soy asesor"), no se lo vuelvas a preguntar — seguí directo con esos datos.
2. Según cuál sea, juntá estos datos (de a uno o dos por mensaje, no todos de golpe):

   A) MUDANCERO/FLETERO/EMPRESA: nombre y apellido, empresa (o "Independiente"), WhatsApp, email, zona donde opera (ej: CABA, zona norte, Rosario, etc.). Con eso llamá a registrar_mudancero. Aclarale que esto es un pre-registro rápido: después completa el resto (vehículo, fotos, precios) desde su cuenta — no le prometas que ya puede recibir pedidos todavía.

   B) ASESOR INMOBILIARIO: nombre y apellido, inmobiliaria (o "Independiente"), email, WhatsApp, zona donde trabaja. Con eso llamá a registrar_asesor. Este SÍ queda activo al toque: puede armar presupuestos ya mismo.

   C) INMOBILIARIA: nombre de la inmobiliaria, tu nombre (el contacto), colegio profesional donde está matriculado el contacto, número de matrícula, email, WhatsApp. Con eso llamá a registrar_inmobiliaria. Aclarale que esto queda como SOLICITUD: el equipo la revisa y lo contactan en 24h hábiles para coordinar la activación — no es instantáneo como el alta de asesor.

3. Si la herramienta te devuelve un error (dato inválido, ya registrado, etc.), pedile amablemente que lo corrija o contale lo que corresponda (ej. si ya existe, que va a recibir un mail) — NO inventes datos para completar ni festejes un alta que no pasó.
4. Si preguntan por la plata: la comisión/pago se define según cada caso, NO prometas montos exactos si no los sabés.
5. Después de un alta o solicitud exitosa, contale que le llega un mail con los próximos pasos.
6. Si el mensaje NO tiene que ver con sumarse a MudateYa NI con querer cotizar una mudanza como cliente (ej. un reclamo, una consulta de otro tema, algo que no entendés), o si ya lo intentaste un par de veces y no lográs entender o resolver lo que necesita, derivalo con onda a que le escriba a hola@mudateya.ar contándole el tema — NO lo registres como socio ni sigas insistiendo.

REGLAS: no pidas datos sensibles, no prometas lo que no podés cumplir.

IMPORTANTE — NUNCA escribas en este chat ningún link, URL ni dominio (ni "mudateya.ar", ni "http...", nada). Instagram bloquea el envío de mensajes con links desde esta cuenta. El link de verdad SIEMPRE le llega por mail — acá solo decile "te lo mandamos por mail" o "revisá tu casilla", sin repetir la dirección.`;

const tools = [
  {
    name: 'registrar_asesor',
    description:
      "Registra a un ASESOR INMOBILIARIO individual en el programa de Asesores MudateYa (queda activo al toque). Llamala SOLO cuando ya tengas los 5 datos: nombre y apellido, inmobiliaria (o 'Independiente'), email, WhatsApp y zona donde trabaja.",
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
  {
    name: 'registrar_inmobiliaria',
    description:
      "Manda la SOLICITUD de alta de una INMOBILIARIA (la agencia, no un asesor individual). Queda pendiente de revisión, NO es instantáneo. Llamala SOLO con los 6 datos: nombre de la inmobiliaria, tu nombre (contacto), colegio profesional, matrícula, email, WhatsApp.",
    input_schema: {
      type: 'object',
      properties: {
        nombreInmobiliaria: { type: 'string', description: 'nombre de la inmobiliaria' },
        contacto: { type: 'string', description: 'nombre y apellido de la persona de contacto' },
        colegio: { type: 'string', description: 'colegio profesional donde está matriculado el contacto (ej: CUCICBA — CABA, San Isidro, La Plata, etc.)' },
        matricula: { type: 'string', description: 'número de matrícula' },
        email: { type: 'string' },
        whatsapp: { type: 'string', description: 'número de WhatsApp / teléfono de contacto' },
      },
      required: ['nombreInmobiliaria', 'contacto', 'colegio', 'matricula', 'email', 'whatsapp'],
    },
  },
  {
    name: 'registrar_mudancero',
    description:
      "Pre-registra a un MUDANCERO, FLETERO o EMPRESA DE MUDANZAS (registro rápido — después completa vehículo/fotos/precios desde su cuenta). Llamala SOLO con los 5 datos: nombre y apellido, empresa (o 'Independiente'), WhatsApp, email, zona donde opera.",
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'nombre y apellido' },
        empresa: { type: 'string', description: "nombre de la empresa, o 'Independiente'" },
        whatsapp: { type: 'string', description: 'número de WhatsApp / teléfono de contacto' },
        email: { type: 'string' },
        zona: { type: 'string', description: 'zona donde opera (ej: CABA, zona norte, zona sur, Rosario, Córdoba, Mendoza, u otra)' },
      },
      required: ['nombre', 'empresa', 'whatsapp', 'email', 'zona'],
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
// Solicitud de alta de inmobiliaria: delega en el endpoint REAL
// (api/inmobiliarias.js?action=solicitar-alta), el mismo que usa
// inmobiliarias-registro.html. Queda como SOLICITUD pendiente de revisión
// del admin — no es alta instantánea como la de asesor.
// ------------------------------------------------------------------
async function registrarInmobiliaria(input) {
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
      return JSON.stringify({ ok: false, error: data.error || 'No se pudo enviar la solicitud. Revisá los datos.' });
    }
    if (data.existente) {
      return JSON.stringify({ ok: true, existente: true, nota: data.mensaje || 'Ese email ya está registrado.' });
    }
    return JSON.stringify({ ok: true, existente: false, nota: 'Solicitud recibida. El equipo la revisa y lo contacta en 24h hábiles para coordinar la activación.' });
  } catch (e) {
    return JSON.stringify({ ok: false, error: 'No pudimos enviar la solicitud ahora. Probá de nuevo en un rato.' });
  }
}

// ------------------------------------------------------------------
// Pre-registro de mudancero/fletero/empresa: delega en el endpoint REAL
// (api/registrar-mudancero.js, tipoRegistro:'corto' — mismo pre-registro
// rápido que existe en mudanceros.html). Después completa vehículo, fotos
// y precios desde su cuenta; esto NO lo deja listo para recibir pedidos.
// ------------------------------------------------------------------
async function registrarMudancero(input) {
  try {
    const r = await fetch(`${SITE_URL}/api/registrar-mudancero`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipoRegistro: 'corto',
        nombre: input.nombre,
        empresa: input.empresa,
        telefono: input.whatsapp,
        email: input.email,
        zonaBase: input.zona,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (data.estado) {
        return JSON.stringify({ ok: true, existente: true, nota: 'Ya tenía un perfil con ese email (estado: ' + data.estado + '). Le mandamos un mail para que entre a completarlo.' });
      }
      return JSON.stringify({ ok: false, error: data.error || 'No se pudo registrar. Revisá los datos.' });
    }
    return JSON.stringify({ ok: true, existente: false, nota: 'Pre-registrado con éxito. Le llega un mail para completar vehículo, fotos y precios desde su cuenta — recién ahí queda listo para recibir pedidos.' });
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
  // Protegemos los emails ANTES de cortar dominios (ej: hola@mudateya.ar es
  // el contacto que SÍ queremos que llegue — si no, el corte de dominio deja
  // "hola@" a secas). Instagram no rechaza mensajes por mencionar un email,
  // solo por links/URLs de navegación.
  const emails = [];
  const protegido = original.replace(/[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}/g, (m) => {
    emails.push(m);
    return `__EMAIL${emails.length - 1}__`;
  });
  let limpio = protegido
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/www\.\S+/gi, '')
    .replace(/\b[a-z0-9-]+\.(ar|com|com\.ar|net|org|io|co|app)\b(\/\S*)?/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  limpio = limpio.replace(/__EMAIL(\d+)__/g, (m, i) => emails[Number(i)]);
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
    let conv = (await getJSON(key)) || { messages: [] };

    // Si el SYSTEM_PROMPT cambió de forma importante (ej: se amplió el
    // alcance del bot), una conversación vieja puede tener mensajes previos
    // del bot reforzando la instrucción ANTERIOR ("esto es solo para
    // asesores"). Claude tiende a seguir el tono ya establecido en el
    // historial aunque el prompt haya cambiado. Para que eso NO quede pegado
    // para siempre, versionamos: si la conversación es de una versión vieja,
    // arrancamos el historial de cero (mismo igsid, charla nueva).
    if (conv.promptVersion !== PROMPT_VERSION) conv = { messages: [] };

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
        if (block.type !== 'tool_use') continue;
        let r;
        if (block.name === 'registrar_asesor') r = await registrarAsesor(block.input);
        else if (block.name === 'registrar_inmobiliaria') r = await registrarInmobiliaria(block.input);
        else if (block.name === 'registrar_mudancero') r = await registrarMudancero(block.input);
        else r = JSON.stringify({ ok: false, error: 'Herramienta desconocida.' });
        resultados.push({ type: 'tool_result', tool_use_id: block.id, content: r });
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
    conv.promptVersion = PROMPT_VERSION;
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
