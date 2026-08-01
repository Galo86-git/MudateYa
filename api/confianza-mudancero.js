// api/confianza-mudancero.js
// #5 — Score de CONFIANZA y señales de ALERTA de un mudancero.
//
// Junta las señales que ya existen en su perfil (verificación de DNI, perfil
// completo, precios cargados, antigüedad) + las reseñas (si hay), y con Claude
// produce: un score 0-100, un nivel, un resumen de reputación en lenguaje
// natural, señales positivas, señales de alerta (posible fraude/inconsistencias)
// y una recomendación para el equipo.
//
// Pensado para el panel de admin (admin.html) y para calibrar el matching.
//
// ── USO ──────────────────────────────────────────────────────────────────────
//   POST /api/confianza-mudancero
//   { "email": "juan@...", "reseñas": [ { "estrellas": 5, "texto": "..." } ] }
//     ("reseñas" es opcional; si no viene se intenta leer de Redis)
//   → { confianza: { score, nivel, resumen_reputacion, señales_positivas[],
//                    señales_alerta[], riesgo_fraude, recomendacion } }
// ─────────────────────────────────────────────────────────────────────────────

const { cors, limitarPorIP } = require('./_seguridad');
const { esAdmin } = require('./_auth');
const { claudeJSON, getJSON, MODEL_SMART } = require('./_ia');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'score', 'nivel', 'resumen_reputacion', 'señales_positivas',
    'señales_alerta', 'riesgo_fraude', 'recomendacion',
  ],
  properties: {
    score:              { type: 'integer' },   // 0..100
    nivel:              { type: 'string', enum: ['alto', 'medio', 'bajo', 'sin_datos'] },
    resumen_reputacion: { type: 'string' },     // 1-2 líneas
    señales_positivas:  { type: 'array', items: { type: 'string' } },
    señales_alerta:     { type: 'array', items: { type: 'string' } },
    riesgo_fraude:      { type: 'string', enum: ['bajo', 'medio', 'alto'] },
    recomendacion:      { type: 'string' },     // acción sugerida para el equipo
  },
};

const SYSTEM = `Sos el analista de confianza de MudateYa (marketplace de mudanzas AR). Evaluás a un mudancero a partir de las señales de su perfil y sus reseñas, y devolvés un score de confianza con señales positivas y de alerta.

CÓMO PUNTUÁS (0-100):
- Verificación de identidad (DNI verificado) y datos completos suman fuerte.
- Reseñas: muchas y buenas suben; pocas o malas bajan; sin reseñas = incierto (no asumas malo, marcá nivel "sin_datos" si casi no hay señales).
- Perfil completo (vehículo, zona, servicios, precios cargados) suma; perfil vacío o contradictorio baja.

RIESGO DE FRAUDE (buscá inconsistencias):
- Datos incoherentes (teléfono/zona/nombre que no cierran), texto de reseñas que parece plantado (todas idénticas, genéricas, en ráfaga), promesas de precio fuera de rango, pedir pagos por fuera de la plataforma.
- Si ves patrones así, subí riesgo_fraude y detallalo en señales_alerta con la evidencia concreta.

REGLAS:
- Basá todo SOLO en los datos provistos. No inventes reseñas ni verificaciones que no estén.
- Si hay muy pocos datos, nivel="sin_datos", score conservador (~50) y recomendá "pedir más info / operación supervisada".
- resumen_reputacion y recomendacion: claros y accionables para el equipo, en español rioplatense.`;

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (await limitarPorIP(req, 'confianza-mudancero', 15)) {
    return res.status(429).json({ error: 'Demasiadas solicitudes. Esperá un momento.' });
  }
  // Datos reputacionales de un mudancero → solo admin.
  if (!esAdmin(req)) return res.status(403).json({ error: 'No autorizado' });

  try {
    const { email, reseñas, resenas } = req.body || {};
    let perfil = req.body && req.body.perfil;

    if (!perfil && email) {
      try { perfil = await getJSON(`mudancero:perfil:${email}`); } catch (_) {}
    }
    if (!perfil) {
      return res.status(400).json({ error: 'Falta el mudancero (mandá "email" válido o "perfil")' });
    }

    // Reseñas: del body (acepta "reseñas" o "resenas") o, si no, intentamos Redis
    // en un par de claves posibles (fail-open: si no hay, seguimos sin ellas).
    let listaReseñas = reseñas || resenas || null;
    if (!Array.isArray(listaReseñas) && email) {
      for (const k of [`mudancero:reseñas:${email}`, `mudancero:resenas:${email}`, `reseñas:mudancero:${email}`]) {
        try {
          const r = await getJSON(k);
          if (Array.isArray(r) && r.length) { listaReseñas = r; break; }
        } catch (_) {}
      }
    }
    if (!Array.isArray(listaReseñas)) listaReseñas = [];

    // Señales objetivas (las contamos en JS y se las damos ya masticadas a la IA).
    const precios = perfil.precios || {};
    const señalesObjetivas = {
      dni_verificado: !!(perfil.dniVerificado || perfil.verificado),
      tiene_vehiculo: !!perfil.vehiculo,
      tiene_zona: !!perfil.zonaBase,
      tiene_servicios: !!perfil.servicios,
      precios_cargados: !!(precios.amb1 || precios.amb2 || precios.amb3 || precios.flete),
      tiene_fotos: !!(perfil.fotos && (Array.isArray(perfil.fotos) ? perfil.fotos.length : Object.keys(perfil.fotos).length)),
      estado: perfil.estado || 'desconocido',
      alta: perfil.creado || perfil.alta || perfil.fecha || null,
      cantidad_reseñas: listaReseñas.length,
    };

    const payload = {
      perfil_resumen: {
        nombre: perfil.nombre, empresa: perfil.empresa, telefono: perfil.telefono,
        zonaBase: perfil.zonaBase, zonasExtra: perfil.zonasExtra, vehiculo: perfil.vehiculo,
        servicios: perfil.servicios, precios,
      },
      señales_objetivas: señalesObjetivas,
      reseñas: listaReseñas.slice(0, 30),
    };

    const confianza = await claudeJSON({
      model: MODEL_SMART,
      system: SYSTEM,
      content: `DATOS DEL MUDANCERO:\n${JSON.stringify(payload).slice(0, 4500)}\n\nEvaluá su confianza.`,
      schema: SCHEMA,
      maxTokens: 900,
    });

    return res.status(200).json({ confianza, señales_objetivas: señalesObjetivas });
  } catch (error) {
    console.error('Error en confianza-mudancero:', error.message);
    return res.status(500).json({ error: error.message });
  }
};
