// api/_mudanceros-pendientes.js
// Mutación con LOCK del índice mudanceros:pendientes — mismo problema y misma
// solución que _mudanzas-activas.js. Vercel ignora los archivos que empiezan
// con "_": no se deploya como función propia.
//
// PROBLEMA QUE RESUELVE (2026-08-07): cron-revisar-mudanceros.js toma un
// snapshot de `mudanceros:pendientes` al principio, itera secuencialmente
// (puede tardar, manda mails) y al FINAL sobreescribe el índice ENTERO con lo
// que calculó. Si en el medio se registra un mudancero nuevo (que hace su
// propio GET+push+SET sobre esta misma clave), esa alta podía desaparecer del
// índice sin que nadie se enterara: el mudancero quedaba con estado
// "pendiente_revision" en su perfil pero invisible para el admin y para el
// propio cron al día siguiente (ya no estaba en la lista que recorre).
//
// Con el lock, cada mutación relee el valor ACTUAL justo antes de escribir.

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
async function setJSON(key, value) {
  await redisCall('SET', key, JSON.stringify(value));
}

const KEY = 'mudanceros:pendientes';
const LOCK_KEY = 'lock:mudanceros-pendientes';

// Mismo criterio que _mudanzas-activas.js: reintenta unas pocas veces con
// backoff corto, y si no consigue el lock sigue igual SIN él (fail-open) —
// preferible el riesgo chico de una carrera ocasional a que un alta falle
// por completo si Redis está lento.
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

// Agrega un email al índice (sin duplicar). Devuelve la lista resultante.
async function agregarAMudancerosPendientes(email) {
  return conLock(async () => {
    const actual = (await getJSON(KEY)) || [];
    if (!actual.includes(email)) {
      actual.push(email);
      await setJSON(KEY, actual);
    }
    return actual;
  });
}

// Saca uno o más emails del índice. Devuelve la lista resultante.
async function sacarDeMudancerosPendientes(emails) {
  const lista = Array.isArray(emails) ? emails : [emails];
  return conLock(async () => {
    const actual = (await getJSON(KEY)) || [];
    const nuevo = actual.filter((e) => !lista.includes(e));
    if (nuevo.length !== actual.length) await setJSON(KEY, nuevo);
    return nuevo;
  });
}

module.exports = { agregarAMudancerosPendientes, sacarDeMudancerosPendientes };
