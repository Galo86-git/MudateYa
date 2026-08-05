// api/_perfil-mudancero.js
// Actualización SEGURA (con lock) del perfil de un mudancero en Redis.
//
// Por qué existe: 11 endpoints/crons distintos hacen GET → modificar en
// memoria → SET sobre la misma clave mudancero:perfil:{email} (guardar
// perfil, cotizar, calificar, aprobar, moderar fotos, cron semanal, etc.).
// Sin ninguna protección, dos escrituras casi simultáneas pueden pisarse:
// si A guarda precios nuevos y, casi al mismo tiempo, B guarda solo un
// flag (ej. "última actividad") pero partió de una copia del perfil
// leída ANTES de que A guardara, el SET de B (que llega después) borra
// los precios de A sin ningún error visible — un "lost update" clásico.
// Esto es la causa más probable de que un mudancero cargue un precio y
// "a veces" lo vea desaparecer.
//
// Uso: en vez de getJSON/mutar/setJSON manual, todos los escritores de
// mudancero:perfil:{email} deberían usar actualizarPerfilMudancero():
//
//   const { actualizarPerfilMudancero } = require('./_perfil-mudancero');
//   const perfil = await actualizarPerfilMudancero(email, function(p) {
//     p.ultimaActividad = new Date().toISOString();
//   });
//   // perfil ya viene con los cambios aplicados y guardado (o null si no existía)
//
// mutar puede ser async. Devuelve el perfil YA actualizado (o null si el
// perfil no existía — no se creó nada).

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
async function getJSON(k) { const v = await redisCall('GET', k); return v ? JSON.parse(v) : null; }
async function setJSON(k, v) { await redisCall('SET', k, JSON.stringify(v)); }

async function adquirirLock(key, ttlSeg) {
  try { return (await redisCall('SET', key, '1', 'EX', String(ttlSeg || 8), 'NX')) === 'OK'; }
  catch (e) { return true; } // Redis con hiccup: no bloqueamos la escritura por eso
}
async function liberarLock(key) {
  try { await redisCall('DEL', key); } catch (e) {}
}

// Reintenta tomar el lock con pequeño backoff — estas escrituras son
// rapidísimas (un GET + un SET), así que esperar un puñado de cientos de ms
// alcanza para no pisar a la otra escritura en curso.
async function actualizarPerfilMudancero(email, mutar, intentos) {
  intentos = intentos || 8;
  const lockKey = `lock:perfil:${email}`;
  let tomado = false;
  for (let i = 0; i < intentos; i++) {
    tomado = await adquirirLock(lockKey, 8);
    if (tomado) break;
    await new Promise((res) => setTimeout(res, 120 + Math.random() * 180));
  }
  try {
    const perfil = await getJSON(`mudancero:perfil:${email}`);
    if (!perfil) return null;
    await mutar(perfil);
    await setJSON(`mudancero:perfil:${email}`, perfil);
    return perfil;
  } finally {
    if (tomado) await liberarLock(lockKey);
  }
}

module.exports = { actualizarPerfilMudancero, getJSON, setJSON };
