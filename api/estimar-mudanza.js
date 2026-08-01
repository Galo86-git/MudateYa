// api/estimar-mudanza.js
// #2 — Estima una MUDANZA COMPLETA a partir de varias fotos (o un ambiente).
//
// Hermano de analizar-foto.js, pero un nivel arriba: en vez de mirar UN objeto,
// mira 1..6 fotos de una casa/ambiente y devuelve volumen en m³, cantidad de
// bultos, inventario, camión sugerido, personas y un RANGO de precio de
// referencia (nunca un precio cerrado: eso lo pone el mudancero).
//
// Le baja la fricción al cliente (saca fotos en vez de describir todo) y le
// entrega al mudancero un pedido mucho mejor descripto.
//
// ── USO ──────────────────────────────────────────────────────────────────────
//   POST /api/estimar-mudanza
//   { "images": [{ "data": "<base64>", "mediaType": "image/jpeg" }, ...],
//     "contexto": { "ambientes": 2, "piso": 3, "ascensor": false,
//                   "origen": "Palermo", "destino": "Tigre" } }   // todo opcional
//   → { estimacion: { volumen_m3, bultos, inventario[], camion_sugerido,
//                     personas, rango_precio{min,max,moneda}, confianza, supuestos[] } }
// ─────────────────────────────────────────────────────────────────────────────

const { cors, limitarPorIP } = require('./_seguridad');
const { claudeJSON, bloqueImagen, MODEL_SMART } = require('./_ia');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'volumen_m3', 'bultos', 'inventario', 'ambientes_detectados', 'camion_sugerido',
    'personas', 'rango_precio', 'requiere_desarme', 'items_delicados', 'confianza', 'supuestos', 'resumen',
  ],
  properties: {
    volumen_m3:           { type: 'number' },   // volumen total estimado a transportar
    bultos:               { type: 'integer' },  // cajas + muebles aprox
    inventario: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'cantidad', 'volumen_m3'],
        properties: {
          item:       { type: 'string' },
          cantidad:   { type: 'integer' },
          volumen_m3: { type: 'number' },
        },
      },
    },
    ambientes_detectados: { type: 'integer' },
    camion_sugerido:      { type: 'string', enum: ['utilitario', 'camioneta', 'camion_chico', 'camion_mediano', 'camion_grande'] },
    personas:             { type: 'integer' },  // cuántas personas para cargar
    rango_precio: {
      type: 'object',
      additionalProperties: false,
      required: ['min', 'max', 'moneda'],
      properties: {
        min:    { type: 'number' },
        max:    { type: 'number' },
        moneda: { type: 'string', enum: ['ARS'] },
      },
    },
    requiere_desarme:     { type: 'boolean' },
    items_delicados:      { type: 'array', items: { type: 'string' } }, // TV, vidrios, piano, heladera...
    confianza:            { type: 'string', enum: ['alta', 'media', 'baja'] },
    supuestos:            { type: 'array', items: { type: 'string' } }, // qué asumió al estimar
    resumen:              { type: 'string' },   // 1-2 líneas para el cliente
  },
};

const SYSTEM = `Sos un tasador de mudanzas de MudateYa (Argentina). A partir de fotos de una casa/ambiente estimás el volumen a transportar y un RANGO de precio de referencia.

REGLAS CLAVE:
- Estimá SOLO en base a lo que realmente ves en las fotos + el contexto dado. NO inventes ambientes ni objetos que no aparecen. Si ves poco, bajá la confianza y aclaralo en supuestos.
- volumen_m3: sumá muebles grandes y cajas visibles. Referencias: monoambiente ~8-12 m³, 2 ambientes ~15-22 m³, 3 ambientes ~25-35 m³.
- camion_sugerido según volumen: <6 utilitario, 6-12 camioneta, 12-20 camion_chico, 20-30 camion_mediano, >30 camion_grande.
- personas: 2 por defecto; 3-4 si hay piso alto sin ascensor, piano, o mucho volumen.
- rango_precio: SIEMPRE en ARS y SIEMPRE un rango amplio (min/max), es solo orientativo. Considerá volumen, distancia si la sabés, piso/ascensor y desarme. NUNCA des un precio cerrado.
- items_delicados: TV/monitores, vidrios/espejos, electrodomésticos de línea blanca, plantas, obras de arte, instrumentos.
- supuestos: listá lo que asumiste (ej: "asumo que las cajas ya están armadas", "no veo la cocina, la estimo estándar").
- resumen: 1-2 líneas amables para el cliente, sin prometer el precio final.
- Es Argentina 2025+: pensá los precios en pesos actuales, con inflación. Ante la duda, ensanchá el rango.`;

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (await limitarPorIP(req, 'estimar-mudanza', 5)) {
    return res.status(429).json({ error: 'Demasiadas solicitudes. Esperá un momento.' });
  }

  try {
    const { images, contexto } = req.body || {};
    if (!Array.isArray(images) || !images.length) {
      return res.status(400).json({ error: 'Faltan imágenes' });
    }

    // Hasta 6 fotos (tope de costo/latencia). El resto se ignora.
    const bloques = images.slice(0, 6).map(bloqueImagen);
    const ctxTxt = contexto
      ? `\n\nCONTEXTO (dato del cliente, úsalo para ajustar la estimación):\n${JSON.stringify(contexto).slice(0, 600)}`
      : '\n\n(Sin contexto adicional: estimá solo por las fotos.)';
    bloques.push({
      type: 'text',
      text: `Estas son ${Math.min(images.length, 6)} foto(s) de la mudanza a estimar.${ctxTxt}\nDevolvé la estimación estructurada.`,
    });

    const estimacion = await claudeJSON({
      model: MODEL_SMART,
      system: SYSTEM,
      content: bloques,
      schema: SCHEMA,
      maxTokens: 1100,
    });

    return res.status(200).json({ estimacion });
  } catch (error) {
    console.error('Error en estimar-mudanza:', error.message);
    return res.status(500).json({ error: error.message });
  }
};
