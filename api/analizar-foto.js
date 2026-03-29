// api/analizar-foto.js
// Proxy seguro para la API de Claude — evita exponer la API key en el frontend
// y resuelve el problema de CORS al llamar desde el browser

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
    const { images } = req.body;
    if (!images || !images.length) return res.status(400).json({ error: 'Faltan imágenes' });

    // Armar el contenido: imágenes + prompt
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
        text: `Analizá este objeto que necesita ser flete/mudado en Argentina.
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
}`
      }
    ];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 400,
        messages: [{ role: 'user', content }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic error:', err);
      return res.status(502).json({ error: 'Error en la API de IA' });
    }

    const data = await response.json();
    const text = (data.content || []).map(b => b.text || '').join('');

    // Parsear y validar el JSON
    let analisis;
    try {
      analisis = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch(e) {
      console.error('Error parseando respuesta IA:', text);
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
