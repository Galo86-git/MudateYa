// api/sugerir-precio.js
// #3 — Asistente de cotización para el MUDANCERO.
//
// Dado un pedido (origen/destino, pisos, ascensor, inventario) y —opcional— el
// perfil del mudancero (su lista de precios, vehículo, zona), sugiere un precio
// con DESGLOSE (mano de obra + traslado + peajes + embalaje) para que cotice en
// segundos y no pierda el pedido por lentitud.
//
// Es una SUGERENCIA orientativa: el precio final lo decide el mudancero.
//
// ── USO ──────────────────────────────────────────────────────────────────────
//   POST /api/sugerir-precio
//   { "pedidoId": "abc123" }                       // toma el pedido de Redis
//     ó
//   { "pedido": { tipo, origen, destino, fecha, detalles, pisos, ascensor, inventario },
//     "mudanceroEmail": "..." }                     // perfil opcional para calibrar
//   → { sugerencia: { precio_sugerido, rango{min,max}, desglose{...}, ... } }
// ─────────────────────────────────────────────────────────────────────────────

const { cors, limitarPorIP } = require('./_seguridad');
const { claudeJSON, getJSON, MODEL_SMART } = require('./_ia');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'precio_sugerido', 'rango', 'moneda', 'desglose', 'km_estimados',
    'tiempo_estimado_hs', 'personas', 'factores', 'justificacion', 'mensaje_sugerido',
  ],
  properties: {
    precio_sugerido:    { type: 'number' },
    rango: {
      type: 'object',
      additionalProperties: false,
      required: ['min', 'max'],
      properties: { min: { type: 'number' }, max: { type: 'number' } },
    },
    moneda:             { type: 'string', enum: ['ARS'] },
    desglose: {
      type: 'object',
      additionalProperties: false,
      required: ['mano_obra', 'traslado', 'peajes', 'embalaje', 'otros'],
      properties: {
        mano_obra: { type: 'number' },
        traslado:  { type: 'number' },   // combustible + km
        peajes:    { type: 'number' },
        embalaje:  { type: 'number' },
        otros:     { type: 'number' },   // desarme, escalera, seguro, etc.
      },
    },
    km_estimados:       { type: 'number' },
    tiempo_estimado_hs: { type: 'number' },
    personas:           { type: 'integer' },
    factores:           { type: 'array', items: { type: 'string' } }, // qué encarece/abarata
    justificacion:      { type: 'string' },   // por qué ese número (para el mudancero)
    mensaje_sugerido:   { type: 'string' },   // texto listo para pegar y mandarle al cliente
  },
};

const SYSTEM = `Sos un asistente de pricing para MUDANCEROS/FLETEROS de MudateYa (Argentina). Dado un pedido, sugerís un precio con desglose para que el mudancero cotice rápido.

REGLAS:
- Todo en ARS, pensado para Argentina actual (con inflación). Ante la duda, ensanchá el rango.
- Desglosá: mano_obra (personas x horas), traslado (km x combustible + amortización), peajes (según recorrido, 0 si es dentro de la misma ciudad sin autopista), embalaje (solo si el pedido lo pide), otros (desarme de muebles, escalera/piso alto sin ascensor, seguro).
- Si te dan el perfil del mudancero (su lista de precios por ambientes / flete), USALO como ancla y ajustá por distancia, piso y volumen. Si no, estimá con valores de mercado.
- Piso alto SIN ascensor encarece bastante (más gente, más tiempo). Ascensor chico también suma.
- precio_sugerido = valor central razonable; rango = min/max defendible.
- factores: bullets cortos de lo que sube o baja el precio en este caso puntual. Si la fecha del pedido cae en día de semana (lunes a viernes), sumá como último factor esta línea EXACTA (reemplazando {DIA} por el día real, ej. "martes"): "🗓️ Es {DIA} — día de baja demanda. Cotizar competitivo hoy te puede hacer ganar el pedido más rápido." Si cae sábado/domingo, o no podés determinar el día con la fecha que te dieron, NO agregues esta línea.
- justificacion: 2-3 líneas explicándole al mudancero cómo salió el número (es interno, para él).
- mensaje_sugerido: un texto corto, cordial y rioplatense, listo para que el mudancero se lo mande al cliente con el precio (sin desglose interno). No prometas nada que el pedido no aclare.
- Es una sugerencia orientativa; el mudancero decide.`;

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (await limitarPorIP(req, 'sugerir-precio', 15)) {
    return res.status(429).json({ error: 'Demasiadas solicitudes. Esperá un momento.' });
  }

  try {
    let { pedido, pedidoId, mudanceroEmail } = req.body || {};

    // Si mandan pedidoId, traemos el pedido de Redis.
    if (!pedido && pedidoId) {
      try { pedido = await getJSON(`mudanza:${pedidoId}`); } catch (_) {}
    }
    if (!pedido || typeof pedido !== 'object') {
      return res.status(400).json({ error: 'Falta el pedido (mandá "pedido" o un "pedidoId" válido)' });
    }

    // Perfil del mudancero (opcional) para anclar la sugerencia a SUS precios.
    let perfil = null;
    if (mudanceroEmail) {
      try { perfil = await getJSON(`mudancero:perfil:${mudanceroEmail}`); } catch (_) {}
    }
    const perfilTxt = perfil
      ? `\n\nPERFIL DEL MUDANCERO (usalo como ancla de precios):\n${JSON.stringify({
          vehiculo: perfil.vehiculo, zonaBase: perfil.zonaBase, servicios: perfil.servicios,
          precios: perfil.precios,
        }).slice(0, 700)}`
      : '';

    const pedidoTxt = JSON.stringify({
      tipo: pedido.tipo, origen: pedido.origen, destino: pedido.destino, fecha: pedido.fecha,
      detalles: pedido.detalles, pisos: pedido.pisos, ascensor: pedido.ascensor,
      inventario: pedido.inventario, ubicaciones: pedido.ubicaciones,
    }).slice(0, 1200);

    // Referencia de fecha para que el modelo pueda resolver "el día que cae" a
    // partir de texto relativo ("mañana", "el jueves que viene") o una fecha
    // concreta, y así saber si corresponde el factor de día de baja demanda.
    const hoyAR = new Date().toLocaleDateString('es-AR', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      timeZone: 'America/Argentina/Buenos_Aires',
    });

    const sugerencia = await claudeJSON({
      model: MODEL_SMART,
      system: SYSTEM,
      content: `Hoy es ${hoyAR} (hora Argentina).\n\nPEDIDO A COTIZAR:\n${pedidoTxt}${perfilTxt}\n\nSugerí el precio con desglose.`,
      schema: SCHEMA,
      maxTokens: 1000,
    });

    return res.status(200).json({ sugerencia });
  } catch (error) {
    console.error('Error en sugerir-precio:', error.message);
    return res.status(500).json({ error: error.message });
  }
};
