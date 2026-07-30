// api/analizar-foto.js
// Proxy seguro para la API de Claude
// Detecta automáticamente si las imágenes son un DNI o un objeto de flete/mudanza
// y responde con el schema correspondiente

const { cors, limitarPorIP } = require('./_seguridad');

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;  // CORS + responde el preflight OPTIONS
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  // Rate limit: máximo 5 análisis de foto por minuto por IP.
  if (await limitarPorIP(req, 'analizar-foto', 5)) {
    return res.status(429).json({ error: 'Demasiadas solicitudes. Esperá un momento.' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API key no configurada' });
  }

  try {
    const { images, prompt } = req.body;
    if (!images || !images.length) return res.status(400).json({ error: 'Faltan imágenes' });

    // ── DETECTAR MODO ────────────────────────────────────────────────────
    // Si el frontend manda un prompt custom (ej: DNI), lo usamos directamente.
    // Si no, usamos el prompt de análisis de objeto (modo flete).
    const esDNI = prompt && (
      prompt.includes('DNI') ||
      prompt.includes('documento') ||
      prompt.includes('numero_dni')
    );

    const promptFinal = prompt || PROMPT_OBJETO;

    // ── ELEGIR MODELO SEGÚN EL CASO ──────────────────────────────────────
    // DNI: precisión legal → Sonnet 5 (más exacto leyendo documentos).
    // Objeto/flete: estimación simple → Haiku 4.5 (rápido y ~5x más barato).
    // Antes usábamos Opus 4.5 para todo, que era caro y sobredimensionado.
    const modelo = esDNI ? 'claude-sonnet-5' : 'claude-haiku-4-5';

    // ── ARMAR CONTENIDO PARA CLAUDE ──────────────────────────────────────
    const content = [
      ...images.slice(0, 2).map(img => ({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mediaType || 'image/jpeg',
          data: img.data,
        }
      })),
      {
        type: 'text',
        text: promptFinal
      }
    ];

    // ── LLAMAR A CLAUDE ──────────────────────────────────────────────────
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: modelo,
        max_tokens: esDNI ? 600 : 400,
        messages: [{ role: 'user', content }],
        // Salida estructurada: la API GARANTIZA un JSON válido con este schema,
        // así se terminan los errores de "no se pudo analizar la imagen".
        output_config: {
          format: {
            type: 'json_schema',
            schema: esDNI ? SCHEMA_DNI : SCHEMA_OBJETO,
          },
        },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic error:', err);
      return res.status(502).json({ error: 'Error en la API de IA' });
    }

    const data = await response.json();
    const text = (data.content || []).map(b => b.text || '').join('');

    // ── PARSEAR JSON ─────────────────────────────────────────────────────
    // Con output_config el texto ya es JSON válido garantizado. El try/catch
    // queda solo como red de seguridad (ej: si el modelo se rehúsa o se corta).
    let analisis;
    try {
      analisis = JSON.parse(text.trim());
    } catch(e) {
      console.error('Error parseando respuesta IA:', data.stop_reason, text);
      return res.status(200).json({
        analisis: null,
        error: 'No se pudo analizar la imagen automáticamente'
      });
    }

    return res.status(200).json({ analisis });

  } catch (error) {
    console.error('Error en analizar-foto:', error.message);
    return res.status(500).json({ error: error.message });
  }
};

// ── PROMPTS ──────────────────────────────────────────────────────────────

const PROMPT_OBJETO = `Analizá este objeto que necesita ser flete/mudado en Argentina.
Respondé SOLO con JSON válido (sin markdown, sin explicaciones) con exactamente estos campos:
{
  "tipo": "nombre descriptivo del objeto",
  "peso_kg": número estimado,
  "dimensiones": "ancho x alto x profundidad en cm aproximado",
  "dificultad": "baja" | "media" | "alta",
  "fragil": true | false,
  "requiere_desmontaje": true | false,
  "personas_necesarias": número (1 o 2),
  "notas": "observación breve sobre el objeto o su manipulación"
}`;

// ── SCHEMAS DE SALIDA ESTRUCTURADA ────────────────────────────────────────
// La API valida la respuesta contra estos schemas y garantiza JSON válido.
// Requisito de la API: additionalProperties:false y todos los campos en required.

const SCHEMA_OBJETO = {
  type: 'object',
  additionalProperties: false,
  required: ['tipo','peso_kg','dimensiones','dificultad','fragil','requiere_desmontaje','personas_necesarias','notas'],
  properties: {
    tipo:                { type: 'string' },
    peso_kg:             { type: 'number' },
    dimensiones:         { type: 'string' },
    dificultad:          { type: 'string', enum: ['baja','media','alta'] },
    fragil:              { type: 'boolean' },
    requiere_desmontaje: { type: 'boolean' },
    personas_necesarias: { type: 'integer', enum: [1, 2] },
    notas:               { type: 'string' },
  },
};

// El prompt de DNI lo manda el frontend (mudanceros.html → analizarDNI()),
// pero el schema de salida lo fijamos acá para garantizar JSON válido.
const SCHEMA_DNI = {
  type: 'object',
  additionalProperties: false,
  required: ['tipo_documento','numero_dni','apellido','nombres','fecha_nacimiento','fecha_vencimiento','cuil','sexo','nacionalidad','legible','advertencias'],
  properties: {
    tipo_documento:    { type: 'string' },
    numero_dni:        { type: 'string' },
    apellido:          { type: 'string' },
    nombres:           { type: 'string' },
    fecha_nacimiento:  { type: 'string' },
    fecha_vencimiento: { type: 'string' },
    cuil:              { type: 'string' },
    sexo:              { type: 'string' },
    nacionalidad:      { type: 'string' },
    legible:           { type: 'boolean' },
    advertencias:      { type: 'array', items: { type: 'string' } },
  },
};
