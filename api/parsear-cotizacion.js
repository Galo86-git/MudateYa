// api/parsear-cotizacion.js
// #1 — Convierte la respuesta en lenguaje natural de un mudancero en una
// cotización ESTRUCTURADA.
//
// El mudancero contesta como habla: "lo hago x 80 lucas, mañana a la tarde,
// incluye embalaje pero la escalera va aparte". Este endpoint lo transforma en
// { cotiza, precio_total, moneda, fecha, incluye[], ... } con salida
// estructurada de Claude (JSON garantizado), y —si le pasás pedidoId— lo agrega
// a mudanza:{id}.cotizaciones en Redis.
//
// Es el eslabón que faltaba para las fases "cotizar por WhatsApp → presupuestos
// al cliente" del flujo mudancero.
//
// ── USO ──────────────────────────────────────────────────────────────────────
//   POST /api/parsear-cotizacion
//   { "texto": "lo hago 80 lucas, mañana a la tarde, embalaje incluido",
//     "pedidoId": "abc123",              // opcional: si está, guarda la cotización
//     "mudancero": { "email": "...", "nombre": "..." } }  // opcional
//   → { cotizacion: { cotiza, precio_total, moneda, fecha_disponible, ... },
//       guardada: true|false }
// ─────────────────────────────────────────────────────────────────────────────

const { cors, limitarPorIP } = require('./_seguridad');
const { claudeJSON, getJSON, setJSON, MODEL_LIGHT } = require('./_ia');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'cotiza', 'precio_total', 'moneda', 'sena_pct', 'fecha_disponible',
    'incluye', 'no_incluye', 'validez_dias', 'condiciones', 'falta', 'confianza', 'resumen',
  ],
  properties: {
    // ¿El mensaje es realmente una cotización con precio? Si es una pregunta, un
    // "dejame ver" o un rechazo, cotiza=false y el resto queda en vacío/0.
    cotiza:          { type: 'boolean' },
    precio_total:    { type: 'number' },                 // 0 si no dio precio
    moneda:          { type: 'string', enum: ['ARS', 'USD', 'desconocida'] },
    sena_pct:        { type: 'integer' },                // % de seña si lo menciona; 0 si no
    fecha_disponible:{ type: 'string' },                 // texto tal como lo dijo ("mañana a la tarde")
    incluye:         { type: 'array', items: { type: 'string' } }, // embalaje, desarme, escalera, etc.
    no_incluye:      { type: 'array', items: { type: 'string' } },
    validez_dias:    { type: 'integer' },                // 0 si no lo aclara
    condiciones:     { type: 'string' },                 // seña, forma de pago, aclaraciones
    falta:           { type: 'array', items: { type: 'string' } }, // datos que convendría repreguntar
    confianza:       { type: 'string', enum: ['alta', 'media', 'baja'] }, // qué tan clara fue la cotización
    resumen:         { type: 'string' },                 // 1 línea para mostrarle al cliente
  },
};

const SYSTEM = `Sos un extractor de cotizaciones para MudateYa (mudanzas y fletes en Argentina).
Recibís lo que un mudancero/fletero escribió por WhatsApp respondiendo a un pedido, y devolvés SOLO la cotización estructurada.

REGLAS:
- Interpretá jerga argentina de plata: "80 lucas"/"80 palos"/"80 mil"/"80k" = 80000; "una gamba" = 100; "un melón" = 1.000.000. "$" o "pesos" = ARS. "verdes"/"dólares"/"USD" = USD.
- Si el mensaje NO es una cotización con precio (una pregunta, "lo veo y te digo", un "no puedo", un saludo), poné cotiza=false, precio_total=0, moneda="desconocida" y explicá en resumen.
- No inventes datos que el mudancero no dijo: si no aclaró la seña, sena_pct=0; si no aclaró validez, validez_dias=0; fecha_disponible="" si no dio fecha.
- "incluye"/"no_incluye": normalizá a ítems cortos (ej: "embalaje", "desarme de muebles", "ayudante", "escalera/piso alto", "peajes", "seguro").
- "falta": listá lo que convendría repreguntarle para cerrar (ej: "¿la seña es 50%?", "¿incluye IVA?", "¿qué día exacto?").
- resumen: una sola línea clara para mostrarle al cliente, ej: "Cotiza $80.000, disponible mañana a la tarde, incluye embalaje".
- confianza: "alta" si precio y condiciones quedan claros; "baja" si es ambiguo o hay que repreguntar mucho.`;

// Núcleo reutilizable (lo puede llamar también el bot de WhatsApp).
async function parsearCotizacion(texto, contexto) {
  const ctx = contexto
    ? `\n\nCONTEXTO DEL PEDIDO (para desambiguar):\n${JSON.stringify(contexto).slice(0, 800)}`
    : '';
  return claudeJSON({
    model: MODEL_LIGHT,
    system: SYSTEM,
    content: `Mensaje del mudancero:\n"""${String(texto).slice(0, 2000)}"""${ctx}`,
    schema: SCHEMA,
    maxTokens: 700,
  });
}

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (await limitarPorIP(req, 'parsear-cotizacion', 20)) {
    return res.status(429).json({ error: 'Demasiadas solicitudes. Esperá un momento.' });
  }

  try {
    const { texto, pedidoId, mudancero } = req.body || {};
    if (!texto || !String(texto).trim()) {
      return res.status(400).json({ error: 'Falta el texto de la cotización' });
    }

    // Si hay pedido, lo cargamos para darle contexto a la IA (origen/destino/detalles).
    let pedido = null;
    if (pedidoId) {
      try { pedido = await getJSON(`mudanza:${pedidoId}`); } catch (_) {}
    }
    const contexto = pedido
      ? { tipo: pedido.tipo, origen: pedido.origen, destino: pedido.destino, fecha: pedido.fecha, detalles: pedido.detalles }
      : null;

    const cotizacion = await parsearCotizacion(texto, contexto);

    // Guardar la cotización en el pedido (solo si es una cotización real con precio).
    let guardada = false;
    if (pedido && cotizacion.cotiza && cotizacion.precio_total > 0) {
      pedido.cotizaciones = Array.isArray(pedido.cotizaciones) ? pedido.cotizaciones : [];
      pedido.cotizaciones.push({
        ...cotizacion,
        mudancero: mudancero || null,
        origen_texto: String(texto).slice(0, 500),
        creado: new Date().toISOString(),
      });
      // Respetamos el TTL restante del pedido (por defecto se guarda a 3 días).
      await setJSON(`mudanza:${pedidoId}`, pedido, 60 * 60 * 24 * 3);
      guardada = true;
    }

    return res.status(200).json({ cotizacion, guardada });
  } catch (error) {
    console.error('Error en parsear-cotizacion:', error.message);
    return res.status(500).json({ error: error.message });
  }
};

// Exponemos el núcleo para reutilizarlo desde el bot de WhatsApp (fase cotizar).
module.exports.parsearCotizacion = parsearCotizacion;
