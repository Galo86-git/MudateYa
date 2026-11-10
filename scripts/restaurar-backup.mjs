// Restaura un backup de Redis hecho por scripts/backup-redis.mjs.
//
// POR DEFECTO NO ESCRIBE NADA: descifra, cuenta y muestra qué haría.
//
//   Ver qué trae un backup:
//     node scripts/restaurar-backup.mjs --fecha 2026-11-10
//     node scripts/restaurar-backup.mjs --archivo ./redis-2026-11-10.mya
//   Probar la restauración en un espacio aparte (NO toca los datos reales):
//     node scripts/restaurar-backup.mjs --fecha 2026-11-10 --aplicar --prefijo restore-test:
//   Restaurar de verdad (pisa las claves que existan con el mismo nombre):
//     node scripts/restaurar-backup.mjs --fecha 2026-11-10 --aplicar --sobrescribir
//   Solo ciertas claves:  agregar  --solo "mudanza:,transferencia:"   (prefijos separados por coma)
//
// Variables: UPSTASH_REDIS_REST_URL/TOKEN, BACKUP_ENCRYPTION_KEY, y para --fecha
// BLOB_BACKUP_READ_WRITE_TOKEN.
//
// Sin --prefijo, si alguna clave ya existe el script se detiene (a menos que se
// pase --sobrescribir), para no pisar datos por accidente.

import fs from 'node:fs';
import { parseClave, descifrar, crearRedis, comandosDeRestauracion } from './_backup-lib.mjs';

const A = process.argv.slice(2);
const val = (f) => { const i = A.indexOf(f); return i >= 0 ? A[i + 1] : null; };
const APLICAR = A.includes('--aplicar');
const SOBRESCRIBIR = A.includes('--sobrescribir');
const PREFIJO = val('--prefijo') || '';
const SOLO = (val('--solo') || '').split(',').map((s) => s.trim()).filter(Boolean);

// En Windows process.exit() con conexiones abiertas puede abortar el proceso: se sale por return.
async function main() {
const clave = parseClave(process.env.BACKUP_ENCRYPTION_KEY);

let archivo;
if (val('--archivo')) {
  archivo = fs.readFileSync(val('--archivo'));
} else if (val('--fecha')) {
  const blob = await import('@vercel/blob');
  const r = await blob.get(`redis/${val('--fecha')}.mya`, { access: 'private', token: process.env.BLOB_BACKUP_READ_WRITE_TOKEN, useCache: false });
  if (!r || r.statusCode !== 200) { console.error('No existe un backup de esa fecha.'); process.exitCode = 1; return; }
  const chunks = []; for await (const c of r.stream) chunks.push(Buffer.from(c));
  archivo = Buffer.concat(chunks);
} else {
  console.error('Indicá --fecha AAAA-MM-DD o --archivo ruta'); process.exitCode = 1; return;
}

const lineas = descifrar(archivo, clave).toString('utf8').trim().split('\n');
const meta = JSON.parse(lineas[0]);
let entradas = lineas.slice(1).map((l) => JSON.parse(l));
if (entradas.length !== meta.total) { console.error(`Backup incompleto: dice ${meta.total} y trae ${entradas.length}`); process.exitCode = 1; return; }
if (SOLO.length) entradas = entradas.filter((e) => SOLO.some((p) => e.k.startsWith(p)));

const porTipo = entradas.reduce((a, e) => ((a[e.t] = (a[e.t] || 0) + 1), a), {});
console.log(`Backup del ${meta.fecha} (generado ${meta.generado}): ${meta.total} claves · a restaurar: ${entradas.length}`, porTipo);

if (!APLICAR) { console.log('\nModo prueba: no se escribió nada. Agregá --aplicar para restaurar.'); return; }

const redis = crearRedis(process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN);

if (!PREFIJO && !SOBRESCRIBIR) {
  let existentes = 0;
  for (let i = 0; i < entradas.length; i += 200) {
    const r = await redis.pipeline(entradas.slice(i, i + 200).map((e) => ['EXISTS', e.k]));
    existentes += r.reduce((s, x) => s + Number(x), 0);
  }
  if (existentes) {
    console.error(`${existentes} claves ya existen en Redis. Para pisarlas agregá --sobrescribir (o probá con --prefijo restore-test:).`);
    process.exitCode = 1; return;
  }
}

let n = 0;
for (let i = 0; i < entradas.length; i += 100) {
  await redis.pipeline(entradas.slice(i, i + 100).flatMap((e) => comandosDeRestauracion(e, PREFIJO)));
  n += Math.min(100, entradas.length - i);
  process.stdout.write(`\r  restauradas ${n}/${entradas.length}`);
}
console.log(`\nListo: ${entradas.length} claves restauradas${PREFIJO ? ` con prefijo "${PREFIJO}" (para borrarlas: claves que empiezan con ese prefijo)` : ''}.`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
