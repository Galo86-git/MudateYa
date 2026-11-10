// api/_hogar-libro.js
//
// Libro de cargos de MYA Hogar. SOLO SE AGREGA: una entrada nunca se edita ni se borra. Si hubo un
// error, se corrige con otra entrada (ajuste o reversa), y queda el rastro de las dos.
//
// Por qué así (hallazgos de la auditoría de pagos): los registros de plata de Mudanza son JSON
// mutable, vencen a los 180 días y se escanean linealmente. Acá:
//   - cada movimiento es una clave propia `hogar:libro:e:{id}` SIN vencimiento;
//   - el id lo da quien registra y sale del EVENTO de negocio (ej. `cargo_gestion:{trabajoId}`,
//     `pago_proveedor:{operacionTalo}`). Registrar dos veces el mismo id no duplica nada: un webhook
//     repetido o un reintento no pueden cargar dos veces;
//   - el punto de confirmación es un único SET NX (atómico). Los índices se escriben después y son
//     idempotentes: si se corta justo en el medio, repetir el registro los completa;
//   - si el mismo id llega con datos distintos, se rechaza (ConflictoLibro): es un bug o un intento de pisar.
//
// Montos: pesos enteros, siempre positivos. El signo lo da el tipo de movimiento.

const crypto = require('crypto');
const { cliente } = require('./_redis');

// efecto sobre el saldo que el PROVEEDOR le debe a MYA: +1 aumenta la deuda, -1 la reduce.
const TIPOS = {
  cargo_gestion:        { parte: 'proveedor', efectoSaldo: +1, descripcion: 'Gestión por trabajo gestionado' },
  condonacion_gestion:  { parte: 'proveedor', efectoSaldo: -1, descripcion: 'Primer trabajo gratis' },
  pago_proveedor:       { parte: 'proveedor', efectoSaldo: -1, descripcion: 'Pago del proveedor a MYA' },
  reversa_cargo:        { parte: 'proveedor', efectoSaldo: -1, descripcion: 'Reversa de un cargo (reclamo/error)', requiereNota: true },
  ajuste_debito:        { parte: 'proveedor', efectoSaldo: +1, descripcion: 'Ajuste manual a favor de MYA', requiereNota: true },
  ajuste_credito:       { parte: 'proveedor', efectoSaldo: -1, descripcion: 'Ajuste manual a favor del proveedor', requiereNota: true },
  cobro_contactos:      { parte: 'cliente', efectoSaldo: 0, descripcion: 'Cliente pagó por contactos (modo directo)' },
  cobro_gestion:        { parte: 'cliente', efectoSaldo: 0, descripcion: 'Cliente pagó la gestión (modo abierto)' },
  reembolso_cliente:    { parte: 'cliente', efectoSaldo: 0, descripcion: 'Reembolso al cliente', requiereNota: true },
};

class ConflictoLibro extends Error {
  constructor(id, motivo) { super('Conflicto en el libro (' + id + '): ' + motivo); this.name = 'ConflictoLibro'; this.id = id; }
}
class EntradaInvalida extends Error {
  constructor(motivo) { super('Entrada inválida: ' + motivo); this.name = 'EntradaInvalida'; }
}

const RE_ID = /^[A-Za-z0-9:_.-]{6,120}$/;
const RE_REF = /^[A-Za-z0-9:_.-]{1,120}$/;
const MAX_MONTO = 10000000; // tope de cordura: $10.000.000 por movimiento

const K = {
  entrada: (id) => 'hogar:libro:e:' + id,
  idxTodos: 'hogar:libro:idx:todos',
  idxProv: (p) => 'hogar:libro:idx:prov:' + p,
  idxCli: (c) => 'hogar:libro:idx:cli:' + c,
  idxJob: (j) => 'hogar:libro:idx:job:' + j,
};

function validar(e) {
  if (!e || typeof e !== 'object') throw new EntradaInvalida('falta el objeto');
  if (!RE_ID.test(String(e.id || ''))) throw new EntradaInvalida('id inválido (6-120 caracteres: letras, números y : _ . -)');
  const t = TIPOS[e.tipo];
  if (!t) throw new EntradaInvalida('tipo desconocido: ' + e.tipo);
  if (!Number.isInteger(e.monto) || e.monto <= 0 || e.monto > MAX_MONTO) throw new EntradaInvalida('monto debe ser un entero de pesos entre 1 y ' + MAX_MONTO);
  if (!RE_REF.test(String(e.parteId || ''))) throw new EntradaInvalida('falta parteId');
  if (e.trabajoId != null && !RE_REF.test(String(e.trabajoId))) throw new EntradaInvalida('trabajoId inválido');
  if (e.refExterna != null && !RE_REF.test(String(e.refExterna))) throw new EntradaInvalida('refExterna inválida');
  if (t.requiereNota && !(typeof e.nota === 'string' && e.nota.trim().length >= 5)) throw new EntradaInvalida('el tipo ' + e.tipo + ' requiere una nota (mínimo 5 caracteres)');
  if (e.nota != null && String(e.nota).length > 500) throw new EntradaInvalida('nota demasiado larga');
  if (e.neto != null && (!Number.isInteger(e.neto) || e.neto < 0 || e.neto > e.monto)) throw new EntradaInvalida('neto debe ser un entero entre 0 y el monto');
  return t;
}

// Lo que identifica al evento: si el mismo id llega con esto distinto, es un conflicto.
function huella(e) {
  return JSON.stringify([e.tipo, e.parteId, e.monto, e.trabajoId || null, e.refExterna || null]);
}

async function indexar(r, ent) {
  const cmds = [['ZADD', K.idxTodos, String(ent.ts), ent.id]];
  if (ent.parte === 'proveedor') cmds.push(['ZADD', K.idxProv(ent.parteId), String(ent.ts), ent.id]);
  if (ent.parte === 'cliente') cmds.push(['ZADD', K.idxCli(ent.parteId), String(ent.ts), ent.id]);
  if (ent.trabajoId) cmds.push(['ZADD', K.idxJob(ent.trabajoId), String(ent.ts), ent.id]);
  await r.pipeline(cmds);
}

// Registra un movimiento. Devuelve { entrada, nuevo }: nuevo=false si ese id ya estaba (no se duplica).
// opts.ahora permite fijar la hora en tests.
async function registrar(e, opts) {
  opts = opts || {};
  const r = opts.redis || cliente();
  const t = validar(e);
  const ts = (opts.ahora instanceof Date ? opts.ahora : new Date()).getTime();
  const ent = {
    id: e.id, ts, creado: new Date(ts).toISOString(),
    tipo: e.tipo, parte: t.parte, parteId: String(e.parteId), monto: e.monto,
    efectoSaldo: t.efectoSaldo,
    neto: e.neto != null ? e.neto : null, // lo que efectivamente entró (después de comisión e impuestos de la pasarela)
    trabajoId: e.trabajoId != null ? String(e.trabajoId) : null,
    refExterna: e.refExterna != null ? String(e.refExterna) : null,
    nota: e.nota != null ? String(e.nota).trim() : null,
    por: e.por ? String(e.por) : 'sistema',
  };
  const puesto = await r.setJSON(K.entrada(ent.id), ent, { permanente: true, nx: true });
  if (puesto) { await indexar(r, ent); return { entrada: ent, nuevo: true }; }

  // Ya existía (o un reintento propio perdió la respuesta): comparar y completar índices.
  const previa = await r.getJSON(K.entrada(ent.id));
  if (!previa) throw new ConflictoLibro(ent.id, 'la entrada no se pudo leer después de existir');
  if (huella(previa) !== huella(ent)) throw new ConflictoLibro(ent.id, 'el mismo id llegó con datos distintos (' + huella(previa) + ' vs ' + huella(ent) + ')');
  await indexar(r, previa);
  return { entrada: previa, nuevo: false };
}

async function leerEntradas(r, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const vals = await r.pipeline(ids.slice(i, i + 100).map((id) => ['GET', K.entrada(id)]));
    vals.forEach((v) => { if (v) out.push(JSON.parse(v)); });
  }
  return out;
}

async function entradasDe(indice, opts) {
  const r = (opts && opts.redis) || cliente();
  const ids = (await r.cmd('ZRANGE', indice, '0', '-1')) || [];
  return leerEntradas(r, ids);
}

const entradasDeProveedor = (provId, o) => entradasDe(K.idxProv(provId), o);
const entradasDeCliente = (cliId, o) => entradasDe(K.idxCli(cliId), o);
const entradasDeTrabajo = (jobId, o) => entradasDe(K.idxJob(jobId), o);

// Cuánto le debe el proveedor a MYA (positivo = debe; negativo = tiene saldo a favor).
function saldoDe(entradas) {
  return entradas.reduce((s, e) => s + e.efectoSaldo * e.monto, 0);
}

async function saldoProveedor(provId, o) {
  return saldoDe(await entradasDeProveedor(provId, o));
}

// Total por tipo en un rango [desde, hasta) — para el cierre y los informes.
function totalesPorTipo(entradas, desdeMs, hastaMs) {
  const out = {};
  entradas.forEach((e) => {
    if (desdeMs != null && e.ts < desdeMs) return;
    if (hastaMs != null && e.ts >= hastaMs) return;
    out[e.tipo] = (out[e.tipo] || 0) + e.monto;
  });
  return out;
}

// Control de integridad: ¿toda entrada está en los índices? ¿todo índice apunta a una entrada?
// repararIndices:true agrega los índices que falten (nunca borra ni modifica entradas).
async function verificarIntegridad(opts) {
  opts = opts || {};
  const r = opts.redis || cliente();
  const claves = await r.scanAll('hogar:libro:e:*');
  const ids = claves.map((k) => k.slice('hogar:libro:e:'.length));
  const enIndice = new Set((await r.cmd('ZRANGE', K.idxTodos, '0', '-1')) || []);
  const sinIndice = ids.filter((id) => !enIndice.has(id));
  const huerfanos = Array.from(enIndice).filter((id) => ids.indexOf(id) === -1);
  let reparadas = 0;
  if (opts.repararIndices && sinIndice.length) {
    const ents = await leerEntradas(r, sinIndice);
    for (const ent of ents) { await indexar(r, ent); reparadas++; }
  }
  return { entradas: ids.length, sinIndice: sinIndice.length, indicesHuerfanos: huerfanos.length, reparadas, ok: sinIndice.length === 0 && huerfanos.length === 0 };
}

function nuevoId(prefijo) { return prefijo + ':' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex'); }

module.exports = { TIPOS, K, ConflictoLibro, EntradaInvalida, registrar, entradasDeProveedor, entradasDeCliente, entradasDeTrabajo, saldoDe, saldoProveedor, totalesPorTipo, verificarIntegridad, nuevoId, MAX_MONTO };
