// Migra las fotos de DNI que hoy están en el store PÚBLICO de Vercel Blob al
// store PRIVADO (api/_dni-privado.js), y actualiza el perfil de cada mudancero
// para que apunte al pathname privado.
//
// Por defecto NO CAMBIA NADA (modo prueba): solo cuenta y muestra qué haría.
//
//   Prueba:            node scripts/migrar-dni-a-privado.mjs
//   Migrar:            node scripts/migrar-dni-a-privado.mjs --aplicar
//   Borrar públicas:   node scripts/migrar-dni-a-privado.mjs --aplicar --borrar-publicas
//                      (borra del store público las fotos ya copiadas y verificadas;
//                       corré primero --aplicar solo, comprobá en el admin que se ven,
//                       y recién después --borrar-publicas)
//
// Variables de entorno (las mismas de Vercel; NO las pegues en el chat):
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
//   BLOB_READ_WRITE_TOKEN        → store privado (destino)
//   BLOB_FOTO_READ_WRITE_TOKEN   → store público (origen, solo para --borrar-publicas;
//                                  si no existe se usa BLOB_READ_WRITE_TOKEN)
//
// Guarda un log con la URL vieja de cada foto en dni-migracion-log.json (está en
// .gitignore: contiene datos personales). Es idempotente: se puede correr de nuevo.

import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const dniPriv = require('../api/_dni-privado.js');

const APLICAR = process.argv.includes('--aplicar');
const BORRAR = process.argv.includes('--borrar-publicas');
const URL_REDIS = process.env.UPSTASH_REDIS_REST_URL;
const TK_REDIS = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!URL_REDIS || !TK_REDIS) { console.error('Falta UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN'); process.exit(1); }
if (APLICAR && !process.env.BLOB_READ_WRITE_TOKEN) { console.error('Falta BLOB_READ_WRITE_TOKEN (store privado)'); process.exit(1); }

async function redis(...cmd) {
  const r = await fetch(URL_REDIS, { method: 'POST', headers: { Authorization: 'Bearer ' + TK_REDIS, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

async function claves(patron) {
  let cursor = '0'; const out = [];
  do {
    const [sig, ks] = await redis('SCAN', cursor, 'MATCH', patron, 'COUNT', 500);
    cursor = sig; out.push(...ks);
  } while (cursor !== '0');
  return out;
}

const esUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v);
const logPath = 'dni-migracion-log.json';
const log = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : [];

const keys = await claves('mudancero:perfil:*');
let conDni = 0, aMigrar = 0, migradas = 0, fallaron = 0, borradas = 0;
console.log(`Perfiles: ${keys.length}. Modo: ${APLICAR ? (BORRAR ? 'APLICAR + BORRAR PÚBLICAS' : 'APLICAR') : 'PRUEBA (no cambia nada)'}`);

for (const key of keys) {
  const raw = await redis('GET', key);
  let perfil; try { perfil = JSON.parse(raw); } catch { continue; }
  if (!perfil || (!perfil.dniFrente && !perfil.dniDorso)) continue;
  conDni++;
  const email = perfil.email || key.replace('mudancero:perfil:', '');
  const cambios = {};
  for (const [campo, lado] of [['dniFrente', 'frente'], ['dniDorso', 'dorso']]) {
    const v = perfil[campo];
    if (!esUrl(v)) continue;
    aMigrar++;
    if (!APLICAR) { console.log(`  [prueba] ${email} ${campo}: ${v.slice(0, 70)}…`); continue; }
    try {
      const r = await fetch(v);
      if (!r.ok) throw new Error('HTTP ' + r.status + ' al bajar la foto');
      const buf = Buffer.from(await r.arrayBuffer());
      const pathname = await dniPriv.subirDni(buf, email, lado);
      cambios[campo] = { vieja: v, nueva: pathname };
    } catch (e) {
      fallaron++;
      console.error(`  ✗ ${email} ${campo}: ${e.message}`);
    }
  }
  if (!APLICAR || !Object.keys(cambios).length) continue;

  // Releer justo antes de escribir y tocar SOLO los campos del DNI (si el mudancero
  // guardó otra cosa mientras tanto, no la pisamos).
  const fresco = JSON.parse(await redis('GET', key));
  for (const [campo, c] of Object.entries(cambios)) {
    if (fresco[campo] === c.vieja) { fresco[campo] = c.nueva; migradas++; log.push({ email, campo, ...c, fecha: new Date().toISOString() }); }
  }
  await redis('SET', key, JSON.stringify(fresco));
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
}

if (APLICAR && BORRAR) {
  const { del } = await import('@vercel/blob');
  const tk = process.env.BLOB_FOTO_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;
  for (const e of log) {
    if (e.borrada || !esUrl(e.vieja)) continue;
    try { await del(e.vieja, { token: tk }); e.borrada = true; borradas++; }
    catch (err) { console.error('  ✗ no se pudo borrar ' + e.vieja.slice(0, 60) + '…: ' + err.message); }
  }
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
}

console.log(`\nPerfiles con DNI: ${conDni} · fotos con URL pública: ${aMigrar}` +
  (APLICAR ? ` · migradas: ${migradas} · fallaron: ${fallaron}${BORRAR ? ` · borradas del store público: ${borradas}` : ''}` : ' (modo prueba: no se cambió nada)'));
