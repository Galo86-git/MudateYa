// api/_ia.js
// Helpers compartidos de IA (Claude) + Redis para los módulos nuevos:
//   parsear-cotizacion, estimar-mudanza, sugerir-precio, match-mudanceros,
//   confianza-mudancero.
//
// Sigue las MISMAS convenciones que el resto de /api:
//   - CommonJS. Vercel ignora los archivos que empiezan con "_" (no se deployan).
//   - Redis por REST estilo path (igual que _talo.js / _seguridad.js / whatsapp.js).
//   - Salida estructurada de Claude con output_config.json_schema (igual que
//     analizar-foto.js): la API GARANTIZA un JSON válido contra el schema.
//
// VARIABLES DE ENTORNO:
//   ANTHROPIC_API_KEY                         -> API key de Claude
//   UPSTASH_REDIS_REST_URL / _TOKEN           -> Redis (ya cargadas)
//   CLAUDE_MODEL_LIGHT (opcional)             -> extracción barata (default haiku 4.5)
//   CLAUDE_MODEL_SMART (opcional)             -> razonamiento/visión (default sonnet 4.5)

const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Modelos por tipo de tarea (overridables por env).
const MODEL_LIGHT = process.env.CLAUDE_MODEL_LIGHT || 'claude-haiku-4-5';
const MODEL_SMART = process.env.CLAUDE_MODEL_SMART || 'claude-sonnet-4-5';

// ------------------------------------------------------------------
// Redis (Upstash REST, estilo path)
// ------------------------------------------------------------------
async function redisCall(method, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  const r = await fetch(`${url}/${[method, ...args].map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
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

// Pipeline de Upstash: varios comandos en UNA sola llamada REST (evita N GET).
async function redisPipeline(commands) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  const r = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  const data = await r.json();
  return Array.isArray(data) ? data.map((d) => d.result) : [];
}

// ------------------------------------------------------------------
// Claude
// ------------------------------------------------------------------
function requireKey() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY no configurada');
}

async function callAnthropic(payload) {
  requireKey();
  const res = await fetch(ANTHROPIC, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('Anthropic error:', res.status, err);
    throw new Error('Anthropic ' + res.status);
  }
  return res.json();
}

function textoDe(data) {
  return (data.content || []).map((b) => b.text || '').join('').trim();
}

// Respuesta estructurada garantizada contra un JSON schema.
// content: string (prompt de texto) o array de bloques (para incluir imágenes).
// Devuelve el objeto ya parseado, o lanza si el modelo se rehúsa/corta.
async function claudeJSON({ model, system, content, schema, maxTokens = 700 }) {
  const messages = [
    { role: 'user', content: typeof content === 'string' ? content : content },
  ];
  const data = await callAnthropic({
    model: model || MODEL_LIGHT,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages,
    output_config: { format: { type: 'json_schema', schema } },
  });
  const text = textoDe(data);
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error('claudeJSON no parseó:', data.stop_reason, text.slice(0, 300));
    throw new Error('La IA no devolvió un JSON válido (stop_reason: ' + data.stop_reason + ')');
  }
}

// Respuesta de texto libre (sin schema).
async function claudeText({ model, system, content, maxTokens = 500 }) {
  const data = await callAnthropic({
    model: model || MODEL_LIGHT,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content }],
  });
  return textoDe(data);
}

// Bloque de imagen base64 para el content de Claude.
function bloqueImagen(img) {
  return {
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType || img.tipo || 'image/jpeg', data: img.data },
  };
}

module.exports = {
  MODEL_LIGHT,
  MODEL_SMART,
  redisCall,
  getJSON,
  setJSON,
  redisPipeline,
  claudeJSON,
  claudeText,
  bloqueImagen,
};
