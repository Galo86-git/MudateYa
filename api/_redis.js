// api/_redis.js
//
// Cliente de Redis (Upstash REST) compartido. Hoy ~80 archivos de /api tienen su propia copia de
// getJSON/setJSON/redisCall; este es el reemplazo para código nuevo (MYA Hogar lo usa desde el día 1).
// No se migra el código viejo todavía: se hace de a poco, con tests.
//
// Qué resuelve respecto de las copias sueltas:
//   - Tiempo límite por pedido (nunca se cuelga esperando) y reintentos con espera creciente,
//     SOLO para comandos seguros de repetir. Un RPUSH/INCR no se reintenta: podría duplicarse.
//   - Los comandos viajan en el cuerpo (POST), no en la URL (no se filtran en logs ni tienen tope de largo).
//   - setJSON obliga a decidir el vencimiento: ttlSeg o permanente:true. Antes los pedidos vencían a los
//     180 días sin que nadie lo hubiera decidido, y los registros de plata se perdían.
//   - withLock FALLA CERRADO: si Redis no responde, NO ejecuta la sección crítica (las copias viejas
//     seguían como si el lock estuviera tomado).
//   - idempotente(): el mismo evento (por ejemplo, un webhook repetido) se ejecuta una sola vez.
//
// Vercel ignora los archivos de /api que empiezan con "_".

const crypto = require('crypto');

class RedisError extends Error {
  constructor(msg, opts) { super(msg); this.name = 'RedisError'; this.transitorio = !!(opts && opts.transitorio); }
}
class LockOcupado extends Error {
  constructor(key) { super('Lock ocupado: ' + key); this.name = 'LockOcupado'; this.key = key; }
}
class IdempotenciaEnCurso extends Error {
  constructor(clave) { super('Ya hay una ejecución en curso para: ' + clave); this.name = 'IdempotenciaEnCurso'; this.clave = clave; }
}

// Comandos que se pueden repetir sin cambiar el resultado final (lecturas y escrituras "de estado").
// Nunca RPUSH / LPUSH / INCR / ZINCRBY / EVAL: repetirlos podría duplicar o descontar dos veces.
const REINTENTABLES = new Set([
  'GET', 'MGET', 'EXISTS', 'SCAN', 'TYPE', 'PTTL', 'TTL', 'HGET', 'HGETALL', 'LRANGE', 'LLEN', 'SMEMBERS',
  'SISMEMBER', 'ZRANGE', 'ZRANGEBYSCORE', 'ZSCORE', 'ZCARD', 'SCARD',
  'SET', 'DEL', 'SADD', 'SREM', 'HSET', 'HDEL', 'ZADD', 'ZREM', 'EXPIRE', 'PEXPIRE',
]);

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Comandos cuya clave es el 1er argumento (para prefijoClaves).
const UNA_CLAVE = new Set(['GET', 'SET', 'DEL', 'EXISTS', 'SADD', 'SREM', 'SMEMBERS', 'ZADD', 'ZREM', 'ZRANGE', 'ZSCORE', 'ZCARD',
  'HSET', 'HGETALL', 'LRANGE', 'LLEN', 'RPUSH', 'EXPIRE', 'PEXPIRE', 'TYPE', 'PTTL', 'TTL']);

function crearCliente(opts) {
  opts = opts || {};
  const url = opts.url || process.env.UPSTASH_REDIS_REST_URL;
  const token = opts.token || process.env.UPSTASH_REDIS_REST_TOKEN;
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 5000;
  const intentos = opts.intentos != null ? opts.intentos : 3;
  const esperaMs = opts.esperaMs != null ? opts.esperaMs : 150;
  // prefijoClaves: todo lo que escribe/lee este cliente vive bajo ese prefijo (ej. 'sandbox:'). Se usa para el modo
  // de pruebas: los datos de prueba NO se mezclan con los reales (ni con el libro de cargos). Si aparece un comando
  // que no sabe prefijar, falla en vez de tocar claves reales.
  const prefijo = opts.prefijoClaves || '';
  function prefijar(c) {
    if (!prefijo) return c;
    const op = String(c[0]).toUpperCase(); const x = c.slice();
    if (UNA_CLAVE.has(op)) { x[1] = prefijo + x[1]; return x; }
    if (op === 'EVAL') { x[3] = prefijo + x[3]; return x; }
    if (op === 'SCAN') {
      const i = x.findIndex((a) => String(a).toUpperCase() === 'MATCH');
      if (i >= 0) x[i + 1] = prefijo + x[i + 1]; else x.push('MATCH', prefijo + '*');
      return x;
    }
    throw new Error('Comando no soportado con prefijoClaves: ' + op);
  }
  function sacarPrefijo(c, resultado) {
    if (prefijo && String(c[0]).toUpperCase() === 'SCAN' && Array.isArray(resultado) && Array.isArray(resultado[1])) {
      return [resultado[0], resultado[1].map((k) => (String(k).indexOf(prefijo) === 0 ? String(k).slice(prefijo.length) : k))];
    }
    return resultado;
  }

  async function enviar(comandosOriginales, reintentable) {
    if (!url || !token) throw new RedisError('Redis no configurado');
    const comandos = comandosOriginales.map(prefijar);
    let ultimo;
    const max = reintentable ? intentos : 1;
    for (let i = 0; i < max; i++) {
      try {
        const r = await fetch(url.replace(/\/$/, '') + '/pipeline', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify(comandos),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (r.status === 429 || r.status >= 500) throw new RedisError('Redis respondió ' + r.status, { transitorio: true });
        if (!r.ok) throw new RedisError('Redis respondió ' + r.status);
        const d = await r.json();
        return d.map(function (x, i) {
          if (x && x.error) throw new RedisError('Redis: ' + x.error);
          return sacarPrefijo(comandosOriginales[i], x.result);
        });
      } catch (e) {
        const transitorio = e instanceof RedisError ? e.transitorio : true; // red, timeout, JSON roto
        ultimo = e instanceof RedisError ? e : new RedisError('Redis no respondió: ' + e.message, { transitorio: true });
        if (!transitorio || i === max - 1) break;
        await dormir(esperaMs * Math.pow(2, i) + Math.random() * esperaMs);
      }
    }
    throw ultimo;
  }

  const esReintentable = (c) => REINTENTABLES.has(String(c[0]).toUpperCase());

  async function pipeline(comandos) {
    if (!comandos.length) return [];
    return enviar(comandos, comandos.every(esReintentable));
  }
  async function cmd() {
    const c = Array.prototype.slice.call(arguments).map(String);
    return (await enviar([c], esReintentable(c)))[0];
  }

  // ── JSON con vencimiento explícito ──
  async function getJSON(key) {
    const v = await cmd('GET', key);
    if (v == null) return null;
    try { return JSON.parse(v); } catch (e) { throw new RedisError('Valor no es JSON: ' + key); }
  }
  // opts: { ttlSeg } o { permanente: true } (obligatorio uno de los dos); { nx: true } solo si no existe.
  // Con nx devuelve true/false; sin nx devuelve true.
  async function setJSON(key, value, o) {
    o = o || {};
    if (!(o.ttlSeg > 0) && o.permanente !== true) throw new Error('setJSON(' + key + '): indicá ttlSeg o permanente:true');
    const args = ['SET', key, JSON.stringify(value)];
    if (o.ttlSeg > 0) args.push('EX', String(Math.ceil(o.ttlSeg)));
    if (o.nx) args.push('NX');
    const r = await cmd.apply(null, args);
    return o.nx ? r === 'OK' : true;
  }

  async function scanAll(patron) {
    let cursor = '0'; let out = [];
    do {
      const r = await cmd('SCAN', cursor, 'MATCH', patron, 'COUNT', '500');
      cursor = String(r[0]); out = out.concat(r[1]);
    } while (cursor !== '0');
    return Array.from(new Set(out));
  }

  // ── Lock que falla cerrado ──
  // ttlSeg tiene que ser MAYOR que lo que tarda fn: si vence antes, otro proceso podría entrar.
  const LUA_UNLOCK = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
  async function withLock(key, ttlSeg, fn, o) {
    o = o || {};
    const esperaMax = o.esperaMs != null ? o.esperaMs : 3000;
    const paso = o.pasoMs || 100;
    const token = crypto.randomBytes(12).toString('hex');
    const fin = Date.now() + esperaMax;
    for (;;) {
      let tomado = false;
      try {
        tomado = (await cmd('SET', key, token, 'NX', 'EX', String(ttlSeg))) === 'OK';
        // Un SET reintentado puede haber entrado la primera vez y haber perdido la respuesta.
        if (!tomado) tomado = (await cmd('GET', key)) === token;
      } catch (e) {
        throw new RedisError('No se pudo tomar el lock "' + key + '" (no se ejecuta la operación): ' + e.message, { transitorio: !!e.transitorio });
      }
      if (tomado) break;
      if (Date.now() >= fin) throw new LockOcupado(key);
      await dormir(paso + Math.random() * paso);
    }
    try {
      return await fn();
    } finally {
      try { await cmd('EVAL', LUA_UNLOCK, '1', key, token); } catch (e) { /* vence solo por TTL */ }
    }
  }

  // ── Idempotencia: el mismo evento se procesa una sola vez ──
  // Devuelve { repetido: false, resultado } la primera vez y { repetido: true, resultado } las siguientes
  // (con el resultado de la primera). Si la primera falló, se libera la clave para poder reintentar.
  async function idempotente(clave, ttlSeg, fn) {
    const k = 'hogar:idem:' + clave;
    const marca = 'pend:' + crypto.randomBytes(8).toString('hex');
    const ok = (await cmd('SET', k, marca, 'NX', 'EX', String(ttlSeg))) === 'OK';
    if (!ok) {
      const actual = await cmd('GET', k);
      if (actual === marca) { /* reintento propio que perdió la respuesta: seguir */ }
      else if (actual == null) throw new RedisError('La clave de idempotencia desapareció: ' + clave, { transitorio: true });
      else if (String(actual).indexOf('pend:') === 0) throw new IdempotenciaEnCurso(clave);
      else return { repetido: true, resultado: JSON.parse(actual) };
    }
    let resultado;
    try {
      resultado = await fn();
    } catch (e) {
      try { await cmd('EVAL', LUA_UNLOCK, '1', k, marca); } catch (x) { /* vence por TTL */ }
      throw e;
    }
    await cmd('SET', k, JSON.stringify(resultado === undefined ? null : resultado), 'EX', String(ttlSeg));
    return { repetido: false, resultado };
  }

  return { cmd, pipeline, getJSON, setJSON, scanAll, withLock, idempotente };
}

let porDefecto = null;
function cliente() { if (!porDefecto) porDefecto = crearCliente(); return porDefecto; }

module.exports = { crearCliente, cliente, RedisError, LockOcupado, IdempotenciaEnCurso, REINTENTABLES };
