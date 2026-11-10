// api/admin-dni-migrar.js
//
// Migra las fotos de DNI que están en el store PÚBLICO de Blob al store PRIVADO
// (ver api/_dni-privado.js) y actualiza el perfil de cada mudancero. Solo admin.
// Lo usa admin-seguridad.html (botones). Es el mismo trabajo que scripts/migrar-dni-a-privado.mjs.
//
//   GET  ?accion=contar            → cuántas fotos hay públicas / ya privadas / pendientes de borrar
//   POST accion=aplicar            → copia al privado (de a tandas; repetir hasta que "quedan" sea 0)
//   POST accion=borrar-publicas    → borra del público las que ya se copiaron y se verificaron
//                                    (requiere confirmar:true). Sin vuelta atrás.
//
// Cada foto se copia, se vuelve a leer del store privado para comprobar que se ve, y recién
// después se cambia el perfil. La URL vieja queda anotada en Redis (dni:migracion-pendiente-borrar)
// para poder borrarla más tarde, una vez que verificaste en el admin.

const { esAdmin } = require('./_auth');
const { crearRedis } = require('./_backup-core');
const { actualizarPerfilMudancero } = require('./_perfil-mudancero');
const dniPriv = require('./_dni-privado');

const LOG_KEY = 'dni:migracion-pendiente-borrar';
const PRESUPUESTO_MS = 20 * 1000; // por tanda: la función de Vercel tiene tope de tiempo
const RE_URL_PUBLICA = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i;

function redis() {
  return crearRedis(process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function perfilesConDni(r) {
  let cursor = '0'; let keys = [];
  do {
    const x = await r.cmd('SCAN', cursor, 'MATCH', 'mudancero:perfil:*', 'COUNT', '500');
    cursor = String(x[0]); keys = keys.concat(x[1]);
  } while (cursor !== '0');
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    const lote = keys.slice(i, i + 100);
    const vals = await r.pipeline(lote.map(function (k) { return ['GET', k]; }));
    vals.forEach(function (v, j) {
      if (!v) return;
      let p; try { p = JSON.parse(v); } catch (e) { return; }
      if (!p || (!p.dniFrente && !p.dniDorso)) return;
      out.push({ email: lote[j].replace('mudancero:perfil:', ''), emailPerfil: p.email || '', dniFrente: p.dniFrente || '', dniDorso: p.dniDorso || '' });
    });
  }
  return out;
}

const esHttp = function (v) { return typeof v === 'string' && /^https?:\/\//i.test(v); };

function resumen(perfiles) {
  const detalle = [];
  let publicas = 0; let privadas = 0; let raras = 0; let conDni = 0;
  perfiles.forEach(function (p) {
    conDni++;
    [p.dniFrente, p.dniDorso].forEach(function (v) {
      if (!v) return;
      if (dniPriv.esPathnameDni(v)) privadas++;
      else if (esHttp(v) && RE_URL_PUBLICA.test(v)) { publicas++; if (detalle.length < 10) detalle.push({ clave: p.email, emailPerfil: p.emailPerfil, url: v.slice(0, 48) + '…' + v.slice(-18) }); }
      else raras++;
    });
  });
  return { perfilesConDni: conDni, fotosPublicas: publicas, fotosYaPrivadas: privadas, fotosConUrlRara: raras, detallePublicas: detalle };
}

async function aplicar(r) {
  const t0 = Date.now();
  const perfiles = await perfilesConDni(r);
  let migradas = 0; let fallaron = 0; let quedan = 0; let candidatas = 0; const errores = [];
  for (let i = 0; i < perfiles.length; i++) {
    const p = perfiles[i];
    for (const par of [['dniFrente', 'frente'], ['dniDorso', 'dorso']]) {
      const campo = par[0]; const lado = par[1]; const vieja = p[campo];
      if (!esHttp(vieja)) continue;
      candidatas++;
      if (!RE_URL_PUBLICA.test(vieja)) { fallaron++; errores.push(p.email + ' ' + campo + ': URL que no es del store público de Blob'); continue; }
      if (Date.now() - t0 > PRESUPUESTO_MS) { quedan++; continue; }
      try {
        const resp = await fetch(vieja, { signal: AbortSignal.timeout(10000) });
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' al bajar la foto');
        const buf = Buffer.from(await resp.arrayBuffer());
        const pathname = await dniPriv.subirDni(buf, p.email, lado);
        await dniPriv.leerDni(pathname); // comprobar que se puede leer del privado antes de cambiar nada
        let cambio = false;
        // El email de la CLAVE de Redis (no el del perfil, que puede diferir en mayúsculas).
        const actualizado = await actualizarPerfilMudancero(p.email, function (perfil) {
          if (perfil[campo] === vieja) { perfil[campo] = pathname; cambio = true; }
        });
        if (!actualizado) throw new Error('no se encontró el perfil para actualizarlo');
        if (!cambio) throw new Error('el perfil cambió mientras se migraba; volver a intentar');
        {
          await r.cmd('RPUSH', LOG_KEY, JSON.stringify({ email: p.email, campo: campo, vieja: vieja, nueva: pathname, fecha: new Date().toISOString() }));
          migradas++;
        }
      } catch (e) {
        fallaron++; errores.push(p.email + ' ' + campo + ': ' + e.message);
      }
    }
  }
  return { perfilesLeidos: perfiles.length, candidatas: candidatas, migradas: migradas, fallaron: fallaron, quedan: quedan, errores: errores.slice(0, 10) };
}

// Diagnóstico: guarda, lee y borra un archivo de prueba en el store privado, midiendo cada paso.
async function probarStore() {
  const blob = require('@vercel/blob');
  const token = dniPriv.tokenPrivado();
  const t = { hayStorePrivado: dniPriv.hayStorePrivado(), conToken: !!token, conBlobStoreId: !!process.env.BLOB_STORE_ID };
  if (!t.hayStorePrivado) return { ...t, error: dniPriv.MSG_SIN_STORE };
  const nombre = 'prueba/ping-' + Date.now() + '.txt';
  let paso = 'guardar'; let t0 = Date.now();
  try {
    await dniPriv.conTimeout(blob.put(nombre, Buffer.from('ok'), { access: 'private', token: token, addRandomSuffix: false, contentType: 'text/plain' }), 15000, 'guardar');
    t.msGuardar = Date.now() - t0; paso = 'leer'; t0 = Date.now();
    const g = await dniPriv.conTimeout(blob.get(nombre, { access: 'private', token: token, useCache: false }), 15000, 'leer');
    t.msLeer = Date.now() - t0; t.statusLeer = g && g.statusCode; paso = 'borrar'; t0 = Date.now();
    await dniPriv.conTimeout(blob.del(nombre, { token: token }), 15000, 'borrar');
    t.msBorrar = Date.now() - t0; t.ok = true;
  } catch (e) { t.error = 'Falló al ' + paso + ': ' + e.message; }
  return t;
}

async function borrarPublicas(r) {
  const blob = require('@vercel/blob');
  const tokens = [process.env.BLOB_FOTO_READ_WRITE_TOKEN, process.env.BLOB_READ_WRITE_TOKEN].filter(Boolean);
  const items = (await r.cmd('LRANGE', LOG_KEY, '0', '-1')) || [];
  let borradas = 0; let fallaron = 0; const restantes = [];
  for (let i = 0; i < items.length; i++) {
    let e; try { e = JSON.parse(items[i]); } catch (x) { continue; }
    if (!RE_URL_PUBLICA.test(e.vieja || '')) { restantes.push(items[i]); fallaron++; continue; }
    let ok = false;
    for (let t = 0; t < tokens.length && !ok; t++) {
      try { await blob.del(e.vieja, { token: tokens[t] }); ok = true; } catch (err) { /* probar el otro token */ }
    }
    if (ok) borradas++; else { restantes.push(items[i]); fallaron++; }
  }
  await r.pipeline([['DEL', LOG_KEY]].concat(restantes.length ? [['RPUSH', LOG_KEY].concat(restantes)] : []));
  return { borradas: borradas, fallaron: fallaron };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!esAdmin(req)) return res.status(401).json({ error: 'no autorizado' });
  if (!process.env.UPSTASH_REDIS_REST_URL) return res.status(500).json({ error: 'Redis no configurado' });
  const r = redis();
  const accion = (req.query && req.query.accion) || (req.body && req.body.accion);
  try {
    if (req.method === 'GET' && accion === 'contar') {
      const s = resumen(await perfilesConDni(r));
      s.pendientesDeBorrar = Number(await r.cmd('LLEN', LOG_KEY)) || 0;
      return res.status(200).json({ ok: true, ...s });
    }
    if (req.method === 'GET' && accion === 'probar') return res.status(200).json(await probarStore());
    if (req.method === 'POST' && accion === 'aplicar') {
      if (!dniPriv.hayStorePrivado()) return res.status(400).json({ error: dniPriv.MSG_SIN_STORE });
      return res.status(200).json({ ok: true, ...(await aplicar(r)) });
    }
    if (req.method === 'POST' && accion === 'borrar-publicas') {
      if (!(req.body && req.body.confirmar === true)) return res.status(400).json({ error: 'Falta confirmar:true' });
      return res.status(200).json({ ok: true, ...(await borrarPublicas(r)) });
    }
    return res.status(400).json({ error: 'accion inválida' });
  } catch (e) {
    console.error('admin-dni-migrar:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

module.exports._resumen = resumen;
