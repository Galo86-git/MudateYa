// api/_mudanzas-activas.js
// Mutación con LOCK del índice mudanzas:activas — evita que un escritor
// concurrente (publicar un pedido, borrarlo, el cron de cierre) pise el
// trabajo de otro por partir de una lectura vieja. Vercel ignora los
// archivos que empiezan con "_": no se deploya como función propia.
//
// PROBLEMA QUE RESUELVE (2026-08-07): cada uno de los ~6 lugares que tocan
// este índice hacía su propio GET + modificar en memoria + SET, sin
// coordinarse entre sí. El caso real más grave: cron-cerrar-pedidos.js
// itera secuencialmente sobre un snapshot tomado al principio (puede tardar
// varios segundos con la base creciendo) y al FINAL sobreescribe el índice
// ENTERO con lo que calculó — si en el medio alguien publicó un pedido
// nuevo, esa alta desaparecía del índice sin que nadie se enterara (el
// pedido quedaba huérfano: ningún mudancero lo veía en "por-zona", y como ya
// no estaba en el índice, ningún cron futuro lo volvía a tocar tampoco).
//
// Con el lock, cada mutación relee el valor ACTUAL justo antes de escribir
// (no un snapshot de hace varios segundos), así que una alta/baja que pasó
// en el medio nunca se pierde.

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
async function setJSON(key, value, exSeconds) {
  const s = JSON.stringify(value);
  if (exSeconds) await redisCall('SET', key, s, 'EX', String(exSeconds));
  else await redisCall('SET', key, s);
}

const KEY = 'mudanzas:activas';
const TTL_INDICE = 60 * 60 * 24 * 7;
const LOCK_KEY = 'lock:mudanzas-activas';

// Reintenta adquirir el lock unas pocas veces (con reintentos cortos): un
// barrido puede tocar el índice muchas veces seguidas y no queremos que la
// primera colisión tire abajo toda la operación. Si después de reintentar
// sigue sin conseguirlo, sigue igual SIN lock (fail-open) — mismo criterio
// que el resto del repo: preferible el riesgo chico de una carrera ocasional
// a que publicar un pedido falle por completo si Redis está lento.
async function conLock(fn) {
  let tengoLock = false;
  for (let i = 0; i < 6 && !tengoLock; i++) {
    try {
      tengoLock = (await redisCall('SET', LOCK_KEY, '1', 'EX', '8', 'NX')) === 'OK';
    } catch (e) { tengoLock = false; }
    if (!tengoLock) await new Promise((r) => setTimeout(r, 120 + Math.random() * 150));
  }
  return fn();
}

// Agrega uno o más ids al índice (sin duplicar). Devuelve la lista resultante.
async function agregarAMudanzasActivas(ids) {
  const lista = Array.isArray(ids) ? ids : [ids];
  return conLock(async () => {
    const actual = (await getJSON(KEY)) || [];
    let cambio = false;
    for (const id of lista) {
      if (!actual.includes(id)) { actual.push(id); cambio = true; }
    }
    if (cambio) await setJSON(KEY, actual, TTL_INDICE);
    return actual;
  });
}

// Saca uno o más ids del índice. Devuelve la lista resultante.
async function sacarDeMudanzasActivas(ids) {
  const lista = Array.isArray(ids) ? ids : [ids];
  return conLock(async () => {
    const actual = (await getJSON(KEY)) || [];
    const nuevo = actual.filter((id) => !lista.includes(id));
    if (nuevo.length !== actual.length) await setJSON(KEY, nuevo, TTL_INDICE);
    return nuevo;
  });
}

module.exports = { agregarAMudanzasActivas, sacarDeMudanzasActivas };
