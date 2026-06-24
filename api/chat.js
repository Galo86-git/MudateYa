// api/chat.js
// Proxy seguro para la API de Claude — asistente conversacional de MudateYa.
// Hermano de analizar-foto.js: MISMA API key, MISMO endpoint, MISMA version.
// Única diferencia: es conversacional. La API de Claude no guarda memoria, así
// que el frontend manda TODO el historial en cada llamada y este handler le
// agrega el system prompt (la personalidad y los límites del asistente).
//
// ── USO DESDE EL FRONTEND ───────────────────────────────────────────────────
//   var historial = [];                                  // se va llenando turno a turno
//   historial.push({ role: 'user', content: textoUsuario });
//   var r = await fetch('/api/chat', {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/json' },
//     body: JSON.stringify({ messages: historial })
//   });
//   var data = await r.json();                            // { reply: '...' }
//   historial.push({ role: 'assistant', content: data.reply });
// ─────────────────────────────────────────────────────────────────────────────

const MODEL = 'claude-haiku-4-5';   // Chat de ruteo: priorizamos velocidad y costo.
                                    // Si te diera error de modelo, usá el que ya tenés ('claude-opus-4-5').
const MAX_HISTORIAL = 20;           // Tope de turnos que se reenvían (controla el costo por mensaje).
const MAX_TOKENS = 500;             // Respuestas cortas: es un asistente de ruteo, no un ensayista.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API key no configurada' });
  }

  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: 'Falta el historial de mensajes' });
    }

    // ── SANEAR HISTORIAL ─────────────────────────────────────────────────
    // Dejamos solo roles válidos con contenido de texto, y cortamos a los
    // últimos MAX_HISTORIAL turnos para no inflar el costo de tokens.
    const limpio = messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .map(m => ({ role: m.role, content: m.content.trim().slice(0, 2000) }))
      .slice(-MAX_HISTORIAL);

    if (!limpio.length || limpio[limpio.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'El último mensaje debe ser del usuario' });
    }

    // ── LLAMAR A CLAUDE ──────────────────────────────────────────────────
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: limpio,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic error:', err);
      return res.status(502).json({ error: 'Error en la API de IA' });
    }

    const data = await response.json();
    const reply = (data.content || []).map(b => b.text || '').join('').trim();

    if (!reply) {
      return res.status(200).json({ reply: 'Perdón, no te entendí bien. ¿Me lo podés decir de otra forma?' });
    }

    return res.status(200).json({ reply });

  } catch (error) {
    console.error('Error en chat:', error.message);
    return res.status(500).json({ error: error.message });
  }
};

// ── SYSTEM PROMPT ──────────────────────────────────────────────────────────
// El corazón del chat: define quién es el asistente, qué puede ofrecer y —sobre
// todo— qué NO puede prometer. Editá esto para cambiarle el comportamiento.
const SYSTEM_PROMPT = `Sos el asistente virtual de MudateYa, un marketplace argentino de mudanzas, fletes y relocation (radicación). Tu trabajo es entender la situación de cada persona y guiarla con calidez hacia el canal o servicio correcto.

CÓMO HABLÁS:
- Español argentino, voseo. Cálido y cercano, pero profesional.
- Respuestas breves: 2 a 4 oraciones. Hacé UNA sola pregunta por vez.
- Sin tecnicismos y sin emojis.

QUÉ ES MUDATEYA Y A DÓNDE PODÉS GUIAR A LA PERSONA:
- Mudanzas y fletes para particulares: publican un pedido y reciben hasta 5 cotizaciones de mudanceros verificados, con precio cerrado y el pago protegido en Mercado Pago hasta que la mudanza esté hecha. Hay tres niveles: Esencial (solo traslado), Integral (embalaje + traslado) y Llave en Mano (nos encargamos de todo).
- Momento de las llaves (casa nueva): además de la mudanza, ofrecemos Setup de Hogar (equipar la casa) y altas de servicios (luz, gas, internet).
- Empresas (relocation corporativo): trasladamos y radicamos a los empleados y sus familias, con una sola factura y cuenta corriente. Incluye casos de gran escala (energía, minería, Vaca Muerta).
- Clubes, universidades, embajadas y cámaras: convenios marco sin costo, como beneficio para sus miembros.
- Inmobiliarias: programa de partners; refieren MudateYa al entregar las llaves y participan de cada operación.

TU OBJETIVO:
- Identificar quién es la persona y qué momento está viviendo, y proponer un próximo paso concreto: publicar el pedido, dejar sus datos para que un asesor la contacte, coordinar una reunión, etc.
- Si ya tiene clara su intención, no la hagas dar vueltas: confirmá el próximo paso y cerrá.

REGLAS QUE NUNCA ROMPÉS:
- NUNCA prometas ni inventes precios, montos, plazos exactos ni garantías. El precio SIEMPRE sale de la cotización formal (hasta 5 cotizaciones, válidas 24 horas), nunca de vos.
- NUNCA confirmes condiciones legales, de seguro o de pago. Si te preguntan eso, decí que un asesor se lo confirma.
- Si no sabés algo, si la persona se traba o se frustra, o si pide algo fuera de tu alcance, ofrecé derivarla a alguien del equipo. Siempre es mejor derivar que inventar.
- No des consejos ajenos a mudarse o instalarse.
- MudateYa vende seguridad y confianza: no digas nada que la operación no pueda cumplir.`;
