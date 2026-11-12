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
  const { conTimeout } = require('./_dni-privado');
  await conTimeout(blob.put(nombre, arch.archivo, { access: 'private', token: token, allowOverwrite: true, addRandomSuffix: false, contentType: 'application/octet-stream' }), 90000, 'guardar el backup');

  // Verificación: bajarlo de nuevo, descifrar y contar.
  const r = await conTimeout(blob.get(nombre, { access: 'private', token: token, useCache: false }), 60000, 'releer el backup');
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

// Restaura UN pedido (`mudanza:{id}`) desde los backups diarios, todo del lado del
// servidor (usa el store privado por OIDC, la clave de cifrado y Redis que ya están
// en Vercel: no hace falta ninguna clave en la compu). Caso Pollice (2026-11-12): el
// pedido expiró de Redis por un TTL de 7 días y había que traerlo de vuelta.
//  - Solo restaura ESE pedido y solo si NO existe ahora (no pisa nada).
//  - Prueba los backups de las fechas pedidas (por defecto, los últimos 7 días).
//  - Lo deja con 180 días de vida y se asegura de que figure en la lista de pedidos
//    del mudancero ganador (`mudancero:{email}`), que es de donde sale su panel.
//  - Con { "soloVer": true } no escribe nada: solo dice qué encontró.
async function restaurarPedido(body) {
  const id = String((body && body.mudanzaId) || '').trim();
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(id)) throw new Error('mudanzaId inválido');
  const soloVer = !!(body && body.soloVer);
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const tk = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tk) throw new Error('Redis no configurado');
  const redis = core.crearRedis(url, tk);
  const clave = core.parseClave(process.env.BACKUP_ENCRYPTION_KEY);
  const key = 'mudanza:' + id;
  const TTL = 60 * 60 * 24 * 180;
  const informe = { mudanzaId: id, yaExistia: false, fechaBackup: null, restaurado: false, indiceMudancero: null };

  let valor = await redis.cmd('GET', key);
  if (valor) {
    informe.yaExistia = true;
  } else {
    const blob = require('@vercel/blob');
    const token = tokenBlob();
    let fechas = Array.isArray(body && body.fechas) && body.fechas.length ? body.fechas.map(String) : null;
    if (!fechas) {
      fechas = [];
      for (let d = 0; d < 7; d++) fechas.push(core.fechaAR(new Date(Date.now() - d * 86400000)));
    }
    informe.fechasProbadas = [];
    for (const fecha of fechas) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue;
      informe.fechasProbadas.push(fecha);
      let r;
      try { r = await blob.get(PREFIJO + fecha + '.mya', { access: 'private', token: token, useCache: false }); } catch (e) { r = null; }
      if (!r || r.statusCode !== 200) continue;
      const chunks = [];
      const reader = r.stream.getReader();
      for (;;) { const x = await reader.read(); if (x.done) break; chunks.push(Buffer.from(x.value)); }
      const lineas = core.descifrar(Buffer.concat(chunks), clave).toString('utf8').split('\n');
      for (const ln of lineas) {
        if (!ln || ln.indexOf('"' + key + '"') === -1) continue;
        let e; try { e = JSON.parse(ln); } catch (_) { continue; }
        if (e && e.k === key && e.t === 'string' && e.v) { valor = e.v; informe.fechaBackup = fecha; break; }
      }
      if (valor) break;
    }
    if (!valor) { informe.ok = false; informe.motivo = 'No está en ninguno de los backups probados'; return informe; }
    if (!soloVer) {
      await redis.cmd('SET', key, valor, 'EX', String(TTL), 'NX');
      informe.restaurado = true;
    }
  }

  let m = null; try { m = JSON.parse(valor); } catch (_) {}
  if (m) {
    informe.estado = m.estado; informe.anticipoPagado = !!m.anticipoPagado; informe.saldoPagado = !!m.saldoPagado;
    informe.mudancero = m.cotizacionAceptada && m.cotizacionAceptada.mudanceroEmail || null;
  }
  if (!soloVer) {
    if (informe.yaExistia) await redis.cmd('EXPIRE', key, String(TTL));
    const email = informe.mudancero;
    if (email) {
      const rawIdx = await redis.cmd('GET', 'mudancero:' + email);
      let idx = []; try { idx = rawIdx ? JSON.parse(rawIdx) : []; } catch (_) {}
      if (!Array.isArray(idx)) idx = [];
      informe.indiceMudancero = idx.includes(id) ? 'ya estaba' : 'agregado';
      if (!idx.includes(id)) { idx.push(id); await redis.cmd('SET', 'mudancero:' + email, JSON.stringify(idx), 'EX', '2592000'); }
    }
  }
  informe.ok = true;
  return informe;
}

// Auditoría (SOLO LECTURA): qué pedidos del índice permanente `mudanzas:todos` ya no
// existen en Redis y, de esos, cuáles estaban PAGADOS en algún backup. Bug 2026-11-12:
// varios crons guardaban el pedido con 7 días de vida, así que un pedido pagado podía
// desaparecer una semana después del aviso de víspera, antes de liquidarle al mudancero.
// Recorre los backups del más nuevo al más viejo y se queda con la versión más reciente
// de cada pedido faltante. Con presupuesto de tiempo: si no alcanza, devuelve lo
// hallado y `completo:false`. Con { "backups": N } limita cuántos backups mira.
async function auditarPerdidos(body) {
  const t0 = Date.now();
  const PRESUPUESTO_MS = 240000;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const tk = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tk) throw new Error('Redis no configurado');
  const redis = core.crearRedis(url, tk);
  const clave = core.parseClave(process.env.BACKUP_ENCRYPTION_KEY);
  const blob = require('@vercel/blob');
  const token = tokenBlob();

  const rawTodos = await redis.cmd('GET', 'mudanzas:todos');
  let todos = []; try { todos = rawTodos ? JSON.parse(rawTodos) : []; } catch (_) {}
  if (!Array.isArray(todos)) todos = [];
  const faltantes = new Set();
  for (let i = 0; i < todos.length; i += 200) {
    const lote = todos.slice(i, i + 200);
    const ex = await redis.pipeline(lote.map(function (id) { return ['EXISTS', 'mudanza:' + id]; }));
    lote.forEach(function (id, j) { if (!Number(ex[j])) faltantes.add(String(id)); });
  }

  const lista = (await listarBackups(blob, token))
    .map(function (b) { return b.pathname; })
    .filter(function (n) { return /\d{4}-\d{2}-\d{2}\.mya$/.test(n); })
    .sort(function (a, b) { return String(b).localeCompare(String(a)); });
  const limite = Math.max(1, Math.min(lista.length, parseInt(body && body.backups, 10) || lista.length));

  const hallados = {}; // id -> { fechaBackup, m }
  let revisados = 0, completo = true, ultimaFecha = null;
  for (let i = 0; i < limite; i++) {
    if (Date.now() - t0 > PRESUPUESTO_MS) { completo = false; break; }
    if (Object.keys(hallados).length >= faltantes.size) break;
    let r;
    try { r = await blob.get(lista[i], { access: 'private', token: token, useCache: false }); } catch (e) { r = null; }
    if (!r || r.statusCode !== 200) continue;
    const chunks = [];
    const reader = r.stream.getReader();
    for (;;) { const x = await reader.read(); if (x.done) break; chunks.push(Buffer.from(x.value)); }
    const fecha = (lista[i].match(/(\d{4}-\d{2}-\d{2})\.mya$/) || [])[1];
    let texto;
    try { texto = core.descifrar(Buffer.concat(chunks), clave).toString('utf8'); } catch (e) { continue; }
    revisados++; ultimaFecha = fecha;
    const lineas = texto.split('\n');
    for (const ln of lineas) {
      if (ln.indexOf('{"k":"mudanza:') !== 0) continue;
      const mk = ln.match(/^\{"k":"mudanza:([^"]+)"/);
      if (!mk || !faltantes.has(mk[1]) || hallados[mk[1]]) continue;
      let e; try { e = JSON.parse(ln); } catch (_) { continue; }
      if (!e || e.t !== 'string' || !e.v) continue;
      let m; try { m = JSON.parse(e.v); } catch (_) { continue; }
      hallados[mk[1]] = { fechaBackup: fecha, m: m };
    }
  }

  const pagados = [];
  Object.keys(hallados).forEach(function (id) {
    const m = hallados[id].m || {};
    if (!(m.anticipoPagado || m.saldoPagado)) return;
    const ca = m.cotizacionAceptada || {};
    pagados.push({
      id: id, estado: m.estado || null, fechaMudanza: m.fecha || null,
      anticipoPagado: !!m.anticipoPagado, saldoPagado: !!m.saldoPagado, completada: !!m.fechaCompletada,
      precio: ca.precio || m.montoTotal || null, mudancero: ca.mudanceroNombre || null, mudanceroEmail: ca.mudanceroEmail || null,
      canal: m.canal || null, clienteWA: m.clienteWA ? String(m.clienteWA).replace(/\d(?=\d{3})/g, '*') : null,
      ultimoBackup: hallados[id].fechaBackup,
    });
  });
  pagados.sort(function (a, b) { return String(b.fechaMudanza || '').localeCompare(String(a.fechaMudanza || '')); });
  return {
    ok: true, completo: completo,
    indice: todos.length, faltantes: faltantes.size,
    backups: { disponibles: lista.length, revisados: revisados, masNuevo: lista[0] || null, masViejo: lista[lista.length - 1] || null, ultimaFechaRevisada: ultimaFecha },
    hallados: Object.keys(hallados).length, noEstanEnNingunBackup: faltantes.size - Object.keys(hallados).length,
    pagadosPerdidos: pagados.length, detalle: pagados,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const cron = esCronVercel(req);
  const admin = !cron && esAdmin(req);
  if (!cron && !admin) return res.status(401).json({ error: 'no autorizado' });

  try {
    if ((req.method === 'POST' || req.method === 'GET') && req.query && req.query.accion === 'auditar-perdidos') {
      if (!admin) return res.status(403).json({ error: 'solo admin' });
      return res.status(200).json(await auditarPerdidos(req.body || {}));
    }
    if (req.method === 'POST' && req.query && req.query.accion === 'restaurar-pedido') {
      if (!admin) return res.status(403).json({ error: 'solo admin' });
      const inf = await restaurarPedido(req.body || {});
      return res.status(inf.ok ? 200 : 404).json(inf);
    }
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
