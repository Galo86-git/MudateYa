// Backup completo de Redis (Upstash) a un store PRIVADO y APARTE de Vercel Blob,
// cifrado (AES-256-GCM) y comprimido. Corre en GitHub Actions todas las noches
// (.github/workflows/backup-diario.yml): no depende de ninguna computadora.
//
//   Contar (no escribe nada):   node scripts/backup-redis.mjs --contar
//   Probar sin subir:           node scripts/backup-redis.mjs --local ./salida
//   Backup real:                node scripts/backup-redis.mjs
//
// Variables de entorno:
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN   base a respaldar
//   BACKUP_ENCRYPTION_KEY          32 bytes en base64 o hex. SI SE PIERDE, LOS BACKUPS NO SIRVEN:
//                                  guardala también en tu gestor de contraseñas.
//   BLOB_BACKUP_READ_WRITE_TOKEN   token del store privado SOLO para backups
//   BLOB_READ_WRITE_TOKEN, BLOB_FOTO_READ_WRITE_TOKEN   (opcionales) para armar el inventario
//                                  de archivos de los otros stores
//   BACKUP_SALTEAR_PREFIJOS        (opcional) prefijos a ignorar, separados por coma
//
// Al terminar baja el archivo, lo descifra y compara la cantidad de claves: si no
// coincide, falla (la corrida queda roja y llega un mail).

import fs from 'node:fs';
import path from 'node:path';
import { parseClave, cifrar, descifrar, fechaAR, crearRedis, comandoDeLectura } from './_backup-lib.mjs';

const ARGS = process.argv.slice(2);
const CONTAR = ARGS.includes('--contar');
const iLocal = ARGS.indexOf('--local');
const LOCAL = iLocal >= 0 ? ARGS[iLocal + 1] : null;
const RETENER_DIARIOS = 30;   // últimos 30 días
const RETENER_MENSUALES = 12; // + el del día 1 de cada mes, 12 meses

const URL_REDIS = process.env.UPSTASH_REDIS_REST_URL;
const TK_REDIS = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!URL_REDIS || !TK_REDIS) { console.error('Falta UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN'); process.exit(1); }
// En Windows process.exit() con conexiones abiertas puede abortar el proceso: se sale por return.
async function main() {
const redis = crearRedis(URL_REDIS, TK_REDIS);
const saltear = (process.env.BACKUP_SALTEAR_PREFIJOS || '').split(',').map((s) => s.trim()).filter(Boolean);

async function todasLasClaves() {
  let cursor = '0'; const out = [];
  do {
    const [sig, ks] = await redis.cmd('SCAN', cursor, 'COUNT', '1000');
    cursor = String(sig); out.push(...ks);
  } while (cursor !== '0');
  return [...new Set(out)].filter((k) => !saltear.some((p) => k.startsWith(p)));
}

const prefijoDe = (k) => k.split(':').slice(0, 2).join(':');

const claves = await todasLasClaves();
console.log(`Claves en Redis: ${claves.length}`);

if (CONTAR) {
  const por = {};
  for (const k of claves) por[prefijoDe(k)] = (por[prefijoDe(k)] || 0) + 1;
  const top = Object.entries(por).sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log('Por prefijo (top 25):'); top.forEach(([p, n]) => console.log(`  ${String(n).padStart(7)}  ${p}`));
  console.log(`\nComandos estimados por backup: ~${claves.length * 3} (TYPE + PTTL + lectura por clave).`);
  return;
}

const clave = parseClave(process.env.BACKUP_ENCRYPTION_KEY);
if (!LOCAL && !process.env.BLOB_BACKUP_READ_WRITE_TOKEN) { console.error('Falta BLOB_BACKUP_READ_WRITE_TOKEN'); process.exitCode = 1; return; }

// Lee todo de a lotes. Cada lote: TYPE+PTTL de cada clave, y después la lectura según el tipo.
const lineas = [];
const omitidas = [];
const LOTE = 150;
for (let i = 0; i < claves.length; i += LOTE) {
  const lote = claves.slice(i, i + LOTE);
  const meta = await redis.pipeline(lote.flatMap((k) => [['TYPE', k], ['PTTL', k]]));
  const tipos = lote.map((_, j) => meta[j * 2]);
  const ttls = lote.map((_, j) => Number(meta[j * 2 + 1]));
  const lecturas = [];
  const idx = [];
  lote.forEach((k, j) => {
    const c = comandoDeLectura(tipos[j], k);
    if (c) { lecturas.push(c); idx.push(j); } else if (tipos[j] !== 'none') omitidas.push(`${k} (${tipos[j]})`);
  });
  const valores = await redis.pipeline(lecturas);
  valores.forEach((v, n) => {
    const j = idx[n];
    if (v === null || v === undefined) return; // expiró entre la lectura del tipo y del valor
    lineas.push(JSON.stringify({ k: lote[j], t: tipos[j], ttl: ttls[j] > 0 ? ttls[j] : -1, v }));
  });
  process.stdout.write(`\r  leídas ${Math.min(i + LOTE, claves.length)}/${claves.length}`);
}
console.log('');
if (omitidas.length) console.warn(`Claves de tipo no soportado (no respaldadas): ${omitidas.length}`, omitidas.slice(0, 5));

const fecha = fechaAR();
const cabecera = JSON.stringify({ meta: true, fecha, generado: new Date().toISOString(), total: lineas.length });
const plano = Buffer.from([cabecera, ...lineas].join('\n') + '\n', 'utf8');
const archivo = cifrar(plano, clave);
console.log(`Backup: ${lineas.length} claves · ${(plano.length / 1024).toFixed(0)} KB sin comprimir · ${(archivo.length / 1024).toFixed(0)} KB cifrado`);

function verificar(buf, esperadas) {
  const txt = descifrar(buf, clave).toString('utf8').trim().split('\n');
  const m = JSON.parse(txt[0]);
  if (!m.meta || txt.length - 1 !== esperadas || m.total !== esperadas) {
    throw new Error(`Verificación fallida: esperaba ${esperadas} claves y el archivo trae ${txt.length - 1}`);
  }
}

if (LOCAL) {
  fs.mkdirSync(LOCAL, { recursive: true });
  const destino = path.join(LOCAL, `redis-${fecha}.mya`);
  fs.writeFileSync(destino, archivo);
  verificar(fs.readFileSync(destino), lineas.length);
  console.log(`Guardado y verificado en ${destino}`);
  return;
}

const blob = await import('@vercel/blob');
const token = process.env.BLOB_BACKUP_READ_WRITE_TOKEN;
const nombre = `redis/${fecha}.mya`;
await blob.put(nombre, archivo, { access: 'private', token, allowOverwrite: true, addRandomSuffix: false, contentType: 'application/octet-stream' });

// Verificación: bajarlo de nuevo, descifrar y contar.
const r = await blob.get(nombre, { access: 'private', token, useCache: false });
if (!r || r.statusCode !== 200) throw new Error('No se pudo releer el backup recién subido');
const chunks = []; for await (const c of r.stream) chunks.push(Buffer.from(c));
verificar(Buffer.concat(chunks), lineas.length);
console.log(`Subido y verificado: ${nombre}`);

// Inventario de archivos de los otros stores (solo nombres, para saber qué había).
async function inventario(tk) {
  const out = []; let cursor;
  do {
    const p = await blob.list({ token: tk, cursor, limit: 1000 });
    out.push(...p.blobs.map((b) => ({ p: b.pathname, s: b.size, f: b.uploadedAt })));
    cursor = p.hasMore ? p.cursor : undefined;
  } while (cursor);
  return out;
}
const inv = {};
for (const [etiqueta, tk] of [['principal', process.env.BLOB_READ_WRITE_TOKEN], ['fotos', process.env.BLOB_FOTO_READ_WRITE_TOKEN]]) {
  if (!tk) continue;
  try { inv[etiqueta] = await inventario(tk); console.log(`Inventario ${etiqueta}: ${inv[etiqueta].length} archivos`); }
  catch (e) { console.warn(`Inventario ${etiqueta} falló: ${e.message}`); }
}
if (Object.keys(inv).length) {
  await blob.put(`inventario/${fecha}.mya`, cifrar(Buffer.from(JSON.stringify(inv)), clave),
    { access: 'private', token, allowOverwrite: true, addRandomSuffix: false, contentType: 'application/octet-stream' });
}

// Retención: 30 diarios + el del día 1 de los últimos 12 meses.
async function limpiar(prefijo) {
  const todos = []; let cursor;
  do {
    const p = await blob.list({ token, prefix: prefijo, cursor, limit: 1000 });
    todos.push(...p.blobs); cursor = p.hasMore ? p.cursor : undefined;
  } while (cursor);
  const fechaDe = (b) => (b.pathname.match(/(\d{4}-\d{2}-\d{2})\.mya$/) || [])[1];
  const ordenados = todos.filter(fechaDe).sort((a, b) => fechaDe(b).localeCompare(fechaDe(a)));
  const diarios = new Set(ordenados.slice(0, RETENER_DIARIOS).map((b) => b.pathname));
  const mensuales = new Set(ordenados.filter((b) => fechaDe(b).endsWith('-01')).slice(0, RETENER_MENSUALES).map((b) => b.pathname));
  let borrados = 0;
  for (const b of ordenados) {
    if (diarios.has(b.pathname) || mensuales.has(b.pathname)) continue;
    await blob.del(b.url, { token }); borrados++;
  }
  console.log(`Retención ${prefijo}: ${ordenados.length - borrados} guardados, ${borrados} borrados`);
}
await limpiar('redis/');
await limpiar('inventario/');
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
