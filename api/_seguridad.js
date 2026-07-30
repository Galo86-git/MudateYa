// api/_seguridad.js
//
// Helpers de seguridad para los endpoints públicos que consumen la API de Claude
// (chat.js y analizar-foto.js). Antes estaban abiertos con CORS '*' y sin límite
// de uso, lo que permitía que cualquier web usara nuestra API key de Anthropic.
//
// Reutiliza el MISMO patrón que ya usa cotizaciones.js: allowlist de origins y
// rate limiting por IP con Upstash Redis (UPSTASH_REDIS_REST_URL / _TOKEN).
//
// Vercel ignora los archivos de /api que empiezan con "_": no se deploya como función.

// Llama a Upstash Redis por su API REST (igual que _talo.js / cotizaciones.js).
async function redisCall(method, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  const r = await fetch(`${url}/${[method, ...args].map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

// CORS: solo acepta requests desde mudateya.ar (mismo allowlist que cotizaciones.js).
// Setea los headers y, si es un preflight OPTIONS, responde y devuelve true para
// que el handler corte ahí. Devuelve false si el request debe seguir procesándose.
function cors(req, res) {
  const permitidos = [
    'https://mudateya.ar',
    'https://www.mudateya.ar',
    process.env.ALLOWED_ORIGIN || '', // para staging/dev
  ].filter(Boolean);
  const origin = req.headers.origin || '';
  if (permitidos.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    // Request sin Origin (ej: curl desde el servidor mismo, Vercel cron)
    res.setHeader('Access-Control-Allow-Origin', 'https://mudateya.ar');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
  return false;
}

// Rate limit por IP con Redis (mismo patrón que cotizaciones.js): INCR + EXPIRE 60s.
// Devuelve true si el request supera el tope y debe rechazarse con 429.
// Si Redis falla, NO bloquea (fail-open) para no cortar el servicio por un error de infra.
async function limitarPorIP(req, accion, maxPorMinuto) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
           || req.socket?.remoteAddress || 'unknown';
  const rlKey = `ratelimit:${accion}:${ip}`;
  try {
    const current = await redisCall('INCR', rlKey);
    if (parseInt(current) === 1) await redisCall('EXPIRE', rlKey, '60');
    return parseInt(current) > maxPorMinuto;
  } catch (e) {
    console.warn('Rate limit falló:', e.message);
    return false; // no bloquear si Redis falla
  }
}

module.exports = { cors, limitarPorIP };
