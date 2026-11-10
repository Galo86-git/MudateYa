// api/_hogar-datos.js
//
// Datos de MYA Hogar en Redis, todo bajo el prefijo `hogar:`. Reglas:
//   - Las entidades (proveedor, cliente, trabajo...) NO vencen nunca. Lo efímero (locks, idempotencia,
//     timers) sí, pero con TTL explícito.
//   - Toda modificación pasa por actualizar(): toma un lock que FALLA CERRADO, relee dentro del lock,
//     aplica el cambio, sube la versión (_v) y guarda. Dos procesos no se pisan.
//   - Cada entidad se anota en un índice (SET) para poder listarlas sin escanear todo Redis.
//   - La plata NO vive acá: vive en el libro (api/_hogar-libro.js), que solo se agrega.
//
// Tipos: proveedor | cliente | trabajo | solicitud

const { cliente } = require('./_redis');
const { PRECIOS_DEFAULT, validarPrecios } = require('./_hogar-reglas');

const TIPOS = new Set(['proveedor', 'cliente', 'trabajo', 'solicitud']);
const RE_ID = /^[A-Za-z0-9:_.-]{3,100}$/;

const K = {
  entidad: (tipo, id) => 'hogar:' + tipo + ':' + id,
  indice: (tipo) => 'hogar:idx:' + tipo,
  lock: (tipo, id) => 'hogar:lock:' + tipo + ':' + id,
  precios: 'hogar:config:precios',
  gratisDni: (dniHash) => 'hogar:gratis:dni:' + dniHash,
};

class EntidadExistente extends Error { constructor(k) { super('Ya existe: ' + k); this.name = 'EntidadExistente'; } }
class EntidadInexistente extends Error { constructor(k) { super('No existe: ' + k); this.name = 'EntidadInexistente'; } }

function chequear(tipo, id) {
  if (!TIPOS.has(tipo)) throw new Error('Tipo de entidad desconocido: ' + tipo);
  if (!RE_ID.test(String(id || ''))) throw new Error('Id inválido para ' + tipo);
}

async function crear(tipo, id, datos, opts) {
  chequear(tipo, id);
  const r = (opts && opts.redis) || cliente();
  const ahora = ((opts && opts.ahora) || new Date()).toISOString();
  const ent = Object.assign({}, datos, { id: String(id), _v: 1, creado: ahora, actualizado: ahora });
  const puesto = await r.setJSON(K.entidad(tipo, id), ent, { permanente: true, nx: true });
  if (!puesto) throw new EntidadExistente(K.entidad(tipo, id));
  await r.cmd('SADD', K.indice(tipo), String(id)); // idempotente: si se corta acá, el chequeo de integridad lo detecta
  return ent;
}

async function leer(tipo, id, opts) {
  chequear(tipo, id);
  return ((opts && opts.redis) || cliente()).getJSON(K.entidad(tipo, id));
}

// mutar(entidad) puede modificarla en el lugar o devolver un objeto nuevo. Si lanza, no se guarda nada.
async function actualizar(tipo, id, mutar, opts) {
  chequear(tipo, id);
  const r = (opts && opts.redis) || cliente();
  return r.withLock(K.lock(tipo, id), 15, async () => {
    const actual = await r.getJSON(K.entidad(tipo, id));
    if (!actual) throw new EntidadInexistente(K.entidad(tipo, id));
    const copia = JSON.parse(JSON.stringify(actual));
    const resultado = await mutar(copia);
    const nueva = resultado && typeof resultado === 'object' ? resultado : copia;
    nueva.id = actual.id;
    nueva.creado = actual.creado;
    nueva._v = (actual._v || 1) + 1;
    nueva.actualizado = ((opts && opts.ahora) || new Date()).toISOString();
    await r.setJSON(K.entidad(tipo, id), nueva, { permanente: true });
    return nueva;
  }, { esperaMs: (opts && opts.esperaLockMs) != null ? opts.esperaLockMs : 4000 });
}

async function ids(tipo, opts) {
  if (!TIPOS.has(tipo)) throw new Error('Tipo de entidad desconocido: ' + tipo);
  return (((opts && opts.redis) || cliente()).cmd('SMEMBERS', K.indice(tipo))).then((x) => (x || []).sort());
}

// Precios vigentes (se actualizan mes a mes). Si no hay nada guardado, los de por defecto.
async function precios(opts) {
  const r = (opts && opts.redis) || cliente();
  const guardados = await r.getJSON(K.precios);
  return guardados ? validarPrecios(guardados) : PRECIOS_DEFAULT;
}
async function guardarPrecios(p, opts) {
  validarPrecios(p);
  const r = (opts && opts.redis) || cliente();
  await r.setJSON(K.precios, { contactoDirecto: p.contactoDirecto, gestionAbierto: p.gestionAbierto, vigenteDesde: p.vigenteDesde || new Date().toISOString().slice(0, 10) }, { permanente: true });
}

// "Primer trabajo gratis por DNI": SET NX atómico. true = esta es la primera vez (se concede);
// false = ya lo usó. El DNI se guarda hasheado (no queda el número en claro en esta clave).
async function reservarPrimerTrabajoGratis(dniHash, trabajoId, opts) {
  if (!/^[a-f0-9]{16,64}$/.test(String(dniHash || ''))) throw new Error('dniHash inválido (se espera un hash hex)');
  const r = (opts && opts.redis) || cliente();
  const k = K.gratisDni(dniHash);
  const puesto = await r.setJSON(k, { trabajoId: String(trabajoId), fecha: ((opts && opts.ahora) || new Date()).toISOString() }, { permanente: true, nx: true });
  if (puesto) return true;
  // Un reintento propio puede haber puesto la clave y perdido la respuesta: es "primera vez" si fue para este trabajo.
  const previo = await r.getJSON(k);
  return !!previo && previo.trabajoId === String(trabajoId);
}

// Control de integridad: entidades sin anotar en el índice, y anotadas que no existen.
async function verificarIntegridad(tipo, opts) {
  const r = (opts && opts.redis) || cliente();
  const claves = await r.scanAll('hogar:' + tipo + ':*');
  const ent = claves.map((k) => k.slice(('hogar:' + tipo + ':').length));
  const idx = new Set(await r.cmd('SMEMBERS', K.indice(tipo)) || []);
  const sinIndice = ent.filter((i) => !idx.has(i));
  const huerfanos = Array.from(idx).filter((i) => ent.indexOf(i) === -1);
  if (opts && opts.reparar && sinIndice.length) await r.cmd.apply(null, ['SADD', K.indice(tipo)].concat(sinIndice));
  return { entidades: ent.length, sinIndice: sinIndice.length, indicesHuerfanos: huerfanos.length, ok: !sinIndice.length && !huerfanos.length };
}

module.exports = { K, TIPOS, EntidadExistente, EntidadInexistente, crear, leer, actualizar, ids, precios, guardarPrecios, reservarPrimerTrabajoGratis, verificarIntegridad };
