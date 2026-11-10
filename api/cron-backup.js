// api/cron-backup.js
//
// Backup diario de Redis, cifrado, a un store PRIVADO de Vercel Blob.
//   - Cron de Vercel: todos los días 06:00 UTC (03:00 en Argentina).
//   - Manual (admin):  POST /api/cron-backup            → hace un backup ahora
//                      GET  /api/cron-backup?accion=estado → lista los backups guardados
//
// Variables: BACKUP_ENCRYPTION_KEY (32 bytes base64/hex; si se pierde, los backups no se
// pueden abrir), BLOB_PRIVADO_READ_WRITE_TOKEN (store privado de Blob; el mismo de los DNI).
// Los archivos se restauran con scripts/restaurar-backup.mjs.
//
// Si falla, avisa por mail a ADMIN_EMAIL. Después de subir, vuelve a bajar el archivo, lo
// descifra y compara la cantidad de claves.

const { esAdmin, esCronVercel } = require('./_auth');
const core = require('./_backup-core');
const { alertarEquipo } = require('./_alerta-equipo');

const PREFIJO = 'backups/redis/';
const RETENER_DIARIOS = 30;
const RETENER_MENSUALES = 12;

function tokenBlob() {
  return require('./_dni-privado').tokenPrivado();
}

async function listarBackups(blob, token) {
  let cursor; let todos = [];
  do {
    const p = await blob.list({ token: token, prefix: PREFIJO, cursor: cursor, limit: 1000 });
    todos = todos.concat(p.blobs);
    cursor = p.hasMore ? p.cursor : undefined;
  } while (cursor);
  return todos;
}

async function hacerBackup() {
  const blob = require('@vercel/blob');
  const token = tokenBlob();
  if (!require('./_dni-privado').hayStorePrivado()) throw new Error(require('./_dni-privado').MSG_SIN_STORE);
  const clave = core.parseClave(process.env.BACKUP_ENCRYPTION_KEY);
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const tk = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tk) throw new Error('Redis no configurado');
  const saltear = (process.env.BACKUP_SALTEAR_PREFIJOS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);

  const redis = core.crearRedis(url, tk);
  const vuelco = await core.volcarRedis(redis, saltear);
  const fecha = core.fechaAR();
  const arch = core.armarArchivo(vuelco.lineas, fecha, clave);

  const nombre = PREFIJO + fecha + '.mya';
  await blob.put(nombre, arch.archivo, { access: 'private', token: token, allowOverwrite: true, addRandomSuffix: false, contentType: 'application/octet-stream' });

  // Verificación: bajarlo de nuevo, descifrar y contar.
  const r = await blob.get(nombre, { access: 'private', token: token, useCache: false });
  if (!r || r.statusCode !== 200) throw new Error('No se pudo releer el backup recién subido');
  const chunks = [];
  const reader = r.stream.getReader();
  for (;;) { const x = await reader.read(); if (x.done) break; chunks.push(Buffer.from(x.value)); }
  core.verificar(Buffer.concat(chunks), vuelco.total, clave);

  // Retención.
  const todos = await listarBackups(blob, token);
  const borrar = core.aBorrar(todos.map(function (b) { return b.pathname; }), RETENER_DIARIOS, RETENER_MENSUALES);
  const porNombre = {}; todos.forEach(function (b) { porNombre[b.pathname] = b.url; });
  for (let i = 0; i < borrar.length; i++) await blob.del(porNombre[borrar[i]], { token: token });

  return { fecha: fecha, archivo: nombre, claves: vuelco.total, kb: Math.round(arch.archivo.length / 1024), omitidas: vuelco.omitidas.length, borrados: borrar.length };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const cron = esCronVercel(req);
  const admin = !cron && esAdmin(req);
  if (!cron && !admin) return res.status(401).json({ error: 'no autorizado' });

  try {
    if (req.method === 'GET' && req.query && req.query.accion === 'estado') {
      const blob = require('@vercel/blob');
      const lista = (await listarBackups(blob, tokenBlob())).map(function (b) {
        return { archivo: b.pathname, kb: Math.round(b.size / 1024), subido: b.uploadedAt };
      }).sort(function (a, b) { return String(b.archivo).localeCompare(String(a.archivo)); });
      return res.status(200).json({ ok: true, total: lista.length, ultimos: lista.slice(0, 10), claveConfigurada: !!process.env.BACKUP_ENCRYPTION_KEY });
    }
    const r = await hacerBackup();
    return res.status(200).json({ ok: true, ...r });
  } catch (e) {
    console.error('cron-backup:', e.message);
    await alertarEquipo('Falló el backup diario de MudateYa', 'Hoy no hay una copia nueva de la base de datos.', { error: e.message });
    return res.status(500).json({ ok: false, error: e.message });
  }
};

module.exports.hacerBackup = hacerBackup;
