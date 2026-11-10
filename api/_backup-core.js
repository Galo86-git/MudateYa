// api/_backup-core.js
//
// Lógica del backup de Redis, usada por api/cron-backup.js. Mismo formato de archivo
// que scripts/backup-redis.mjs (así scripts/restaurar-backup.mjs abre los dos):
//   "MYAB1" | iv (12) | tag GCM (16) | AES-256-GCM( gzip( NDJSON ) )
// NDJSON: 1ª línea {"meta":true,"fecha","generado","total"}, después {"k","t","ttl","v"}.
//
// Vercel ignora los archivos de /api que empiezan con "_".

const crypto = require('crypto');
const zlib = require('zlib');

const MAGIC = Buffer.from('MYAB1');

function parseClave(texto) {
  const t = String(texto || '').trim();
  if (!t) throw new Error('Falta BACKUP_ENCRYPTION_KEY');
  const buf = /^[0-9a-fA-F]{64}$/.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64');
  if (buf.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY debe ser de 32 bytes (base64 o hex)');
  return buf;
}

function cifrar(buffer, clave) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', clave, iv);
  const ct = Buffer.concat([c.update(zlib.gzipSync(buffer)), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
}

function descifrar(archivo, clave) {
  if (archivo.length < MAGIC.length + 28 || !archivo.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('El archivo no es un backup de MudateYa (formato desconocido)');
  }
  const d = crypto.createDecipheriv('aes-256-gcm', clave, archivo.subarray(5, 17));
  d.setAuthTag(archivo.subarray(17, 33));
  try {
    return zlib.gunzipSync(Buffer.concat([d.update(archivo.subarray(33)), d.final()]));
  } catch (e) {
    throw new Error('No se pudo descifrar: clave incorrecta o archivo dañado');
  }
}

// Fecha en Argentina (UTC-3), no la del servidor.
function fechaAR(ahora) {
  return new Date((ahora || new Date()).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function crearRedis(url, token) {
  async function pipeline(comandos) {
    if (!comandos.length) return [];
    const r = await fetch(url.replace(/\/$/, '') + '/pipeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(comandos),
    });
    if (!r.ok) throw new Error('Redis respondió ' + r.status);
    const d = await r.json();
    return d.map(function (x) {
      if (x && x.error) throw new Error('Redis: ' + x.error);
      return x.result;
    });
  }
  return { pipeline: pipeline, cmd: async function () { return (await pipeline([Array.prototype.slice.call(arguments)]))[0]; } };
}

function comandoDeLectura(tipo, k) {
  switch (tipo) {
    case 'string': return ['GET', k];
    case 'hash': return ['HGETALL', k];
    case 'list': return ['LRANGE', k, '0', '-1'];
    case 'set': return ['SMEMBERS', k];
    case 'zset': return ['ZRANGE', k, '0', '-1', 'WITHSCORES'];
    default: return null;
  }
}

// Lee TODO Redis y devuelve { plano: Buffer NDJSON, total, omitidas }.
// `saltear`: prefijos de claves que no hace falta respaldar.
async function volcarRedis(redis, saltear) {
  saltear = saltear || [];
  let cursor = '0';
  let todas = [];
  do {
    const r = await redis.cmd('SCAN', cursor, 'COUNT', '1000');
    cursor = String(r[0]);
    todas = todas.concat(r[1]);
  } while (cursor !== '0');
  const claves = Array.from(new Set(todas)).filter(function (k) {
    return !saltear.some(function (p) { return k.indexOf(p) === 0; });
  });

  const lineas = [];
  const omitidas = [];
  const LOTE = 150;
  for (let i = 0; i < claves.length; i += LOTE) {
    const lote = claves.slice(i, i + LOTE);
    const comandosMeta = [];
    lote.forEach(function (k) { comandosMeta.push(['TYPE', k], ['PTTL', k]); });
    const meta = await redis.pipeline(comandosMeta);
    const lecturas = [];
    const idx = [];
    lote.forEach(function (k, j) {
      const tipo = meta[j * 2];
      const c = comandoDeLectura(tipo, k);
      if (c) { lecturas.push(c); idx.push(j); } else if (tipo !== 'none') omitidas.push(k + ' (' + tipo + ')');
    });
    const valores = await redis.pipeline(lecturas);
    valores.forEach(function (v, n) {
      const j = idx[n];
      if (v === null || v === undefined) return; // venció entre TYPE y la lectura
      const ttl = Number(meta[j * 2 + 1]);
      lineas.push(JSON.stringify({ k: lote[j], t: meta[j * 2], ttl: ttl > 0 ? ttl : -1, v: v }));
    });
  }
  return { lineas: lineas, total: lineas.length, omitidas: omitidas };
}

function armarArchivo(lineas, fecha, clave) {
  const cabecera = JSON.stringify({ meta: true, fecha: fecha, generado: new Date().toISOString(), total: lineas.length });
  const plano = Buffer.from([cabecera].concat(lineas).join('\n') + '\n', 'utf8');
  return { archivo: cifrar(plano, clave), bytesPlano: plano.length };
}

function verificar(buf, esperadas, clave) {
  const txt = descifrar(buf, clave).toString('utf8').trim().split('\n');
  const m = JSON.parse(txt[0]);
  if (!m.meta || txt.length - 1 !== esperadas || m.total !== esperadas) {
    throw new Error('Verificación fallida: esperaba ' + esperadas + ' claves y el archivo trae ' + (txt.length - 1));
  }
}

// Qué backups conservar: los últimos `diarios` + el del día 1 de los últimos `mensuales` meses.
function aBorrar(nombres, diarios, mensuales) {
  const fechaDe = function (n) { const m = String(n).match(/(\d{4}-\d{2}-\d{2})\.mya$/); return m ? m[1] : null; };
  const ordenados = nombres.filter(fechaDe).sort(function (a, b) { return fechaDe(b).localeCompare(fechaDe(a)); });
  const guardar = new Set(ordenados.slice(0, diarios));
  ordenados.filter(function (n) { return fechaDe(n).slice(-2) === '01'; }).slice(0, mensuales).forEach(function (n) { guardar.add(n); });
  return ordenados.filter(function (n) { return !guardar.has(n); });
}

module.exports = { parseClave, cifrar, descifrar, fechaAR, crearRedis, comandoDeLectura, volcarRedis, armarArchivo, verificar, aBorrar };
