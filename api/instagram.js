// api/instagram.js
// Agente que RESPONDE los DMs de Instagram de MudateYa.
// Objetivo: captar asesores inmobiliarios como socios referidores y darlos de alta.
//
// Variables de entorno necesarias (Vercel → Settings → Environment Variables):
//   IG_VERIFY_TOKEN         -> token que vos inventás y también ponés en el panel de Meta
//   IG_ACCESS_TOKEN         -> Instagram User access token (cuenta professional; permiso instagram_business_manage_messages)
//   ANTHROPIC_API_KEY       -> tu API key de Claude
//   UPSTASH_REDIS_REST_URL  -> ya lo tenés en MudateYa
//   UPSTASH_REDIS_REST_TOKEN-> ya lo tenés en MudateYa
//   CLAUDE_MODEL (opcional) -> ID del modelo; ver docs.claude.com para el vigente

const GRAPH = "https://graph.instagram.com/v21.0"; // Instagram API con Instagram Login
const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5"; // verificá el ID actual en docs.claude.com

// ------------------------------------------------------------------
// Redis (Upstash REST). Si ya tenés tus wrappers setJSON/getJSON en un
// módulo compartido, importalos y borrá estos.
// ------------------------------------------------------------------
async function redisCmd(args) {
  const res = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const data = await res.json();
  return data.result;
}
async function getJSON(key) {
  const v = await redisCmd(["GET", key]);
  return v ? JSON.parse(v) : null;
}
async function setJSON(key, value, ttlSeconds) {
  const args = ["SET", key, JSON.stringify(value)];
  if (ttlSeconds) args.push("EX", String(ttlSeconds));
  return redisCmd(args);
}

// ------------------------------------------------------------------
// System prompt del agente
// ------------------------------------------------------------------
const SYSTEM_PROMPT = `Sos el asistente de MudateYa en Instagram. MudateYa es un marketplace argentino de mudanzas y fletes que conecta clientes con mudanceros/fleteros.

Tu único objetivo en este chat: sumar ASESORES INMOBILIARIOS como socios referidores. Un asesor le pasa a su cliente (que acaba de comprar o alquilar y se tiene que mudar) su código de referido; cuando esa mudanza se concreta y se paga, el asesor cobra una comisión.

TONO: cercano, rioplatense, directo. Mensajes CORTOS, es un DM de Instagram. Nada de párrafos largos ni formal. Un emoji cada tanto está bien, no más.

CÓMO TRABAJÁS:
1. Si saludan o escriben "SOCIO", explicá el programa en 1-2 líneas y arrancá a pedir datos.
2. Necesitás juntar 4 datos, de a uno o dos por mensaje (no los pidas todos de golpe):
   - nombre y apellido
   - inmobiliaria (o "Independiente")
   - email
   - WhatsApp
3. Cuando tengas los 4 datos, llamá a la herramienta registrar_asesor. NO inventes el código de referido: lo genera el sistema y se lo mandamos nosotros.
4. Si preguntan por la plata: la comisión de referido se acredita cuando la mudanza referida se completa y se paga. NO prometas montos exactos si no los sabés.

REGLAS: no pidas datos sensibles, no prometas lo que no podés cumplir, y si el mensaje no tiene que ver con esto respondé amable y reconducí al programa.`;

const tools = [
  {
    name: "registrar_asesor",
    description:
      "Registra a un asesor inmobiliario como referidor. Llamala SOLO cuando ya tengas los 4 datos: nombre y apellido, inmobiliaria (o 'Independiente'), email y WhatsApp.",
    input_schema: {
      type: "object",
      properties: {
        nombre: { type: "string", description: "nombre y apellido del asesor" },
        inmobiliaria: { type: "string", description: "nombre de la inmobiliaria, o 'Independiente'" },
        email: { type: "string" },
        whatsapp: { type: "string", description: "número de WhatsApp" },
      },
      required: ["nombre", "inmobiliaria", "email", "whatsapp"],
    },
  },
];

// ------------------------------------------------------------------
// Claude
// ------------------------------------------------------------------
async function askClaude(messages) {
  const res = await fetch(ANTHROPIC, {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
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
// Alta del asesor
// ------------------------------------------------------------------
function generarCodigo(nombre) {
  const base = (nombre || "asesor").toLowerCase().replace(/[^a-z]/g, "").slice(0, 6) || "asesor";
  const suf = Math.random().toString(36).slice(2, 6);
  return `${base}-${suf}`;
}

async function registrarAsesor(input) {
  const codigo = generarCodigo(input.nombre);
  const asesor = {
    codigo,
    nombre: input.nombre,
    inmobiliaria: input.inmobiliaria, // nombre de la inmobiliaria o "Independiente"
    email: input.email,
    whatsapp: input.whatsapp,
    canal: "instagram",
    referidos: [],
    balance: 0,
    creado: new Date().toISOString(),
  };
  await setJSON(`asesor:${codigo}`, asesor);
  return codigo;
}

// ------------------------------------------------------------------
// Enviar mensaje por Instagram
// ------------------------------------------------------------------
async function enviarIG(igsid, texto) {
  await fetch(`${GRAPH}/me/messages?access_token=${process.env.IG_ACCESS_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: igsid }, message: { text: texto } }),
  });
}

// ------------------------------------------------------------------
// Procesar un mensaje entrante
// ------------------------------------------------------------------
async function procesarMensaje(igsid, texto) {
  const key = `ig:conv:${igsid}`;
  const conv = (await getJSON(key)) || { messages: [] };

  conv.messages.push({ role: "user", content: texto });
  if (conv.messages.length > 20) conv.messages = conv.messages.slice(-20); // acota el historial

  const resp = await askClaude(conv.messages);

  // ¿Claude decidió registrar al asesor?
  const toolUse = (resp.content || []).find((c) => c.type === "tool_use" && c.name === "registrar_asesor");
  if (toolUse) {
    const codigo = await registrarAsesor(toolUse.input);
    const confirmacion =
      `¡Listo, ${toolUse.input.nombre}! Ya sos socio de MudateYa 🙌\n` +
      `Tu código de referido es: ${codigo}\n` +
      `Pasáselo a tus clientes que se mudan. Cuando contraten con ese código y se concrete la mudanza, cobrás tu comisión. ` +
      `Cualquier duda, escribime por acá.`;
    conv.messages.push({ role: "assistant", content: confirmacion });
    await setJSON(key, conv, 60 * 60 * 24 * 30);
    await enviarIG(igsid, confirmacion);
    return;
  }

  // Respuesta de texto normal
  const textoResp =
    (resp.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim() || "Perdón, no te entendí bien. ¿Me lo repetís?";

  conv.messages.push({ role: "assistant", content: textoResp });
  await setJSON(key, conv, 60 * 60 * 24 * 30);
  await enviarIG(igsid, textoResp);
}

// ------------------------------------------------------------------
// Handler principal (Vercel Function)
// ------------------------------------------------------------------
export default async function handler(req, res) {
  // 1) Verificación del webhook (Meta pega un GET al configurarlo)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.IG_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  if (req.method !== "POST") return res.status(405).end();

  // 2) Mensajes entrantes
  try {
    const body = req.body;
    if (body.object === "instagram") {
      for (const entry of body.entry || []) {
        for (const event of entry.messaging || []) {
          if (!event.message || event.message.is_echo || !event.message.text) continue;

          // Dedup: Meta puede reintentar el mismo mensaje
          const mid = event.message.mid;
          if (mid) {
            const nuevo = await redisCmd(["SET", `ig:mid:${mid}`, "1", "NX", "EX", "600"]);
            if (nuevo === null) continue; // ya lo procesamos
          }

          await procesarMensaje(event.sender.id, event.message.text);
        }
      }
    }
  } catch (e) {
    console.error("Error procesando webhook IG:", e);
  }

  // Respondemos 200 al final para que Meta no reintente
  return res.status(200).send("EVENT_RECEIVED");
}
