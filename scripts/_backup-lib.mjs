// Piezas compartidas del backup y la restauración de Redis (Upstash).
//
// Formato del archivo de backup (.mya):
//   "MYAB1" | iv (12 bytes) | tag GCM (16 bytes) | ciphertext
//   donde ciphertext = AES-256-GCM( gzip( NDJSON ) ).
// NDJSON: 1ª línea {"meta":true,"fecha":...,"total":N}; después {"k","t","ttl","v"} por clave.
//   t = string | hash | list | set | zset ; ttl = milisegundos restantes o -1.

import crypto from 'node:crypto';
import zlib from 'node:zlib';

const MAGIC = Buffer.from('MYAB1');

// La clave puede venir en base64 (44 chars) o hex (64 chars): 32 bytes.
export function parseClave(texto) {
  const t = String(texto || '').trim();
  if (!t) throw new Error('Falta BACKUP_ENCRYPTION_KEY');
  let buf = /^[0-9a-fA-F]{64}$/.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64');
  if (buf.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY debe ser de 32 bytes (base64 o hex)');
  return buf;
}

export function cifrar(buffer, clave) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', clave, iv);
  const ct = Buffer.concat([c.update(zlib.gzipSync(buffer)), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
}

export function descifrar(archivo, clave) {
  if (archivo.length < MAGIC.length + 28 || !archivo.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('El archivo no es un backup de MudateYa (formato desconocido)');
  }
  const iv = archivo.subarray(5, 17);
  const tag = archivo.subarray(17, 33);
  const ct = archivo.subarray(33);
  const d = crypto.createDecipheriv('aes-256-gcm', clave, iv);
  d.setAuthTag(tag);
  try {
    return zlib.gunzipSync(Buffer.concat([d.update(ct), d.final()]));
  } catch (e) {
    throw new Error('No se pudo descifrar: clave incorrecta o archivo dañado');
  }
}

// Fecha en Argentina (UTC-3), no la del servidor.
export function fechaAR(ahora = new Date()) {
  return new Date(ahora.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

export function crearRedis(url, token) {
  async function pipeline(comandos) {
    if (!comandos.length) return [];
    const r = await fetch(url.replace(/\/$/, '') + '/pipeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(comandos),
    });
    if (!r.ok) throw new Error('Redis respondió ' + r.status);
    const d = await r.json();
    return d.map((x) => {
      if (x && x.error) throw new Error('Redis: ' + x.error);
      return x.result;
    });
  }
  async function cmd(...args) { return (await pipeline([args]))[0]; }
  return { pipeline, cmd };
}

// Comandos para volver a escribir una entrada del backup. `prefijo` permite
// restaurar en un espacio aparte para probar sin tocar nada real.
export function comandosDeRestauracion(e, prefijo = '') {
  const k = prefijo + e.k;
  const out = [['DEL', k]];
  if (e.t === 'string') {
    out.push(e.ttl > 0 ? ['SET', k, e.v, 'PX', String(e.ttl)] : ['SET', k, e.v]);
    return out;
  }
  if (e.t === 'hash') {
    const flat = [];
    for (let i = 0; i < e.v.length; i++) flat.push(e.v[i]);
    if (flat.length) out.push(['HSET', k, ...flat]);
  } else if (e.t === 'list') {
    if (e.v.length) out.push(['RPUSH', k, ...e.v]);
  } else if (e.t === 'set') {
    if (e.v.length) out.push(['SADD', k, ...e.v]);
  } else if (e.t === 'zset') {
    const args = [];
    for (let i = 0; i < e.v.length; i += 2) args.push(e.v[i + 1], e.v[i]); // score, miembro
    if (args.length) out.push(['ZADD', k, ...args]);
  } else {
    return [];
  }
  if (e.ttl > 0) out.push(['PEXPIRE', k, String(e.ttl)]);
  return out;
}

// Comando de lectura según el tipo.
export function comandoDeLectura(tipo, k) {
  switch (tipo) {
    case 'string': return ['GET', k];
    case 'hash': return ['HGETALL', k];
    case 'list': return ['LRANGE', k, '0', '-1'];
    case 'set': return ['SMEMBERS', k];
    case 'zset': return ['ZRANGE', k, '0', '-1', 'WITHSCORES'];
    default: return null;
  }
}
