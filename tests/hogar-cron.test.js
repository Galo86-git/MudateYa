// Proceso por minuto de MYA Hogar (api/_hogar-cron.js, api/cron-hogar.js) y su vigilancia en cron-healthcheck.
const test = require('node:test');
const assert = require('node:assert');
const { crearMock } = require('./_redis-mock');

const { crearCliente } = require('../api/_redis');
const cron = require('../api/_hogar-cron');
const pagos = require('../api/_hogar-pagos');
const libro = require('../api/_hogar-libro');
const datos = require('../api/_hogar-datos');

const D = (iso) => new Date(iso);
const AHORA = D('2026-11-10T15:00:00Z'); // minuto 0 → corren TODAS las tareas periódicas

async function conEntorno(fn) {
  const m = crearMock();
  await new Promise((r) => m.server.listen(0, '127.0.0.1', r));
  const redis = crearCliente({ url: 'http://127.0.0.1:' + m.server.address().port, token: 'x', esperaMs: 5 });
  const talo = {
    pagos: {}, reembolsos: [], transacciones: [], falla: false,
    async consultarPagoCompleto(id) { if (talo.falla) throw new Error('Talo caído'); const p = talo.pagos[id]; if (!p) throw new Error('no existe ' + id); return JSON.parse(JSON.stringify(p)); },
    async reembolsar(id, o) { talo.reembolsos.push({ id, monto: o && o.monto }); const p = talo.pagos[id]; p.refunds = p.refunds || []; p.refunds.push({ n: p.refunds.length, estado: 'PENDING', monto: (o && o.monto) || p.montoPagado }); return { ok: true, yaPendiente: false }; },
    async listarTransaccionesRecientes() { if (talo.falla) throw new Error('Talo caído'); return { transacciones: talo.transacciones, hayMas: false }; },
  };
  const mails = [];
  const enviarEquipo = async (asunto, resumen, datosMail) => { if (mails.falla) return false; mails.push({ asunto, resumen, datos: datosMail }); return true; };
  const deps = { redis, talo, ahora: AHORA, enviarEquipo };
  const nuevoPago = (id, extra) => { talo.pagos[id] = Object.assign({ paymentId: id, estado: 'PENDING', externalId: '', montoPedido: 0, montoPagado: 0, acreditado: 0, comision: 0, transferencias: [], reembolsado: 0, refunds: [], expira: '2026-11-15T15:00:00Z' }, extra); return talo.pagos[id]; };
  try { await fn({ redis, talo, deps, mails, nuevoPago, m }); } finally { await new Promise((r) => m.server.close(r)); }
}
const solicitud = (deps, id, extra) => datos.crear('solicitud', id, Object.assign({ modo: 'directo', estado: 'esperando_pago', clienteId: 'cli-1', cobro: { monto: 4500, clase: 'contactos' }, vigenteHasta: null }, extra), deps);
const REMITENTE = { cuit: '27767826051', titular: 'Patricia Fernández', cbu: '0270000068177940014287' };

test('ciclo: vacía el buzón de Talo, concilia plata sin asociar, sigue devoluciones y manda UN mail agrupado', async () => {
  await conEntorno(async ({ redis, deps, talo, mails, nuevoPago }) => {
    // 1) un pago que Talo avisó y quedó en el buzón
    await solicitud(deps, 'sol-1');
    nuevoPago('VAR-1', { estado: 'SUCCESS', externalId: 'hogar~contactos~sol-1', montoPedido: 4500, montoPagado: 4500, acreditado: 4455 });
    await pagos.anotarAviso(deps, 'VAR-1');
    // 2) una transferencia grande que Talo no asoció
    await solicitud(deps, 'sol-2');
    nuevoPago('VAR-2', { estado: 'PENDING', externalId: 'hogar~contactos~sol-2', montoPedido: 4500, montoPagado: 0 });
    talo.transacciones = [{ id: 'TX#2', tipo: 'INBOUND', bruto: 5000, neto: 4950, pagoId: null, clienteId: null, intentoPagoId: 'VAR-2', remitente: REMITENTE, cuando: AHORA.toISOString() }];
    // 3) una devolución automática en proceso que Talo ya terminó
    await solicitud(deps, 'sol-3');
    nuevoPago('VAR-3', { estado: 'OVERPAID', externalId: 'hogar~contactos~sol-3', montoPedido: 4500, montoPagado: 5000, acreditado: 4950 });
    await pagos.procesarPago('VAR-3', deps);
    await pagos.ejecutarReembolso('VAR-3.excedente', deps);
    talo.pagos['VAR-3'].refunds[0].estado = 'SUCCESS';

    const r = await cron.cicloConLock(deps, {});
    assert.deepStrictEqual(r.errores, []);
    assert.strictEqual(r.buzon.procesados, 1);
    assert.strictEqual(r.sinAsociar.conciliadas, 1);
    assert.strictEqual(r.reembolsos.completados, 1);
    assert.strictEqual((await datos.leer('solicitud', 'sol-1', { redis })).estado, 'pagada');
    assert.strictEqual((await datos.leer('solicitud', 'sol-2', { redis })).estado, 'pagada');
    assert.strictEqual((await datos.leer('reembolso', 'VAR-3.excedente', { redis })).estado, 'completado');

    // un solo mail, con la devolución manual de la transferencia suelta (a quién devolver)
    assert.strictEqual(mails.length, 1);
    const lineas = Object.values(mails[0].datos).join('\n');
    assert.match(lineas, /MANUAL desde el panel de Talo/);
    assert.match(lineas, /Patricia Fernández/);
    assert.match(lineas, /CUIT 27767826051/);
    assert.ok(r.efectos.mailEnviado);
    // los avisos a clientes (sin canal todavía) NO se pierden
    assert.ok(r.efectos.sinCanal >= 2, JSON.stringify(r.efectos));
    const pend = await pagos.efectosPendientes(deps);
    assert.ok(pend.every((e) => e.tipo.indexOf('cliente_') === 0), 'solo quedan los de clientes');
    assert.ok(pend.some((e) => e.tipo === 'cliente_entregar_contactos'));
  });
});

test('ciclo: un segundo ciclo no repite nada (mails, cobros ni devoluciones)', async () => {
  await conEntorno(async ({ redis, deps, talo, mails, nuevoPago }) => {
    await solicitud(deps, 'sol-4');
    nuevoPago('VAR-4', { estado: 'PENDING', externalId: 'hogar~contactos~sol-4', montoPedido: 4500, montoPagado: 0 });
    talo.transacciones = [{ id: 'TX#4', tipo: 'INBOUND', bruto: 5000, neto: 4950, pagoId: null, clienteId: null, intentoPagoId: 'VAR-4', remitente: REMITENTE, cuando: AHORA.toISOString() }];
    await cron.cicloConLock(deps, {});
    const mailsAntes = mails.length;
    const r2 = await cron.cicloConLock(deps, {});
    assert.strictEqual(mails.length, mailsAntes, 'no vuelve a mandar el mismo aviso');
    assert.strictEqual(r2.sinAsociar.conciliadas, 0);
    assert.strictEqual((await libro.entradasDeCliente('cli-1', { redis })).filter((e) => e.tipo === 'cobro_contactos').length, 1);
  });
});

test('mail del equipo falla: los avisos quedan pendientes y salen en el ciclo siguiente', async () => {
  await conEntorno(async ({ redis, deps, mails, talo }) => {
    talo.transacciones = [{ id: 'TX#9', tipo: 'INBOUND', bruto: 300, neto: 296, pagoId: null, clienteId: null, intentoPagoId: null, remitente: REMITENTE, cuando: AHORA.toISOString() }];
    mails.falla = true;
    const a = await cron.cicloConLock(deps, {});
    assert.strictEqual(a.efectos.mailEnviado, false);
    assert.strictEqual((await pagos.efectosPendientes(deps)).length, 1);
    mails.falla = false;
    const b = await cron.cicloConLock(deps, {});
    assert.strictEqual(b.efectos.mailEnviado, true);
    assert.strictEqual((await pagos.efectosPendientes(deps)).length, 0);
    assert.strictEqual(mails.length, 1);
  });
});

test('si una tarea falla (Talo caído) las otras siguen y el error queda registrado', async () => {
  await conEntorno(async ({ redis, deps, talo, mails }) => {
    await pagos.anotarAviso(deps, 'VAR-X');
    talo.falla = true;
    const r = await cron.cicloConLock(deps, {});
    assert.strictEqual(r.ok, false);
    assert.ok(r.errores.some((e) => /sinAsociar/.test(e)), JSON.stringify(r.errores));
    assert.ok(r.efectos, 'la tarea de avisos igual corrió');
    assert.strictEqual(r.buzon.fallidos, 1);
    assert.ok(await redis.getJSON('hogar:cron:latido'), 'deja latido aunque haya errores');
  });
});

test('plata sin asociar solo cada 2 minutos (salvo forzar); vencidas cada 10', async () => {
  await conEntorno(async ({ deps, talo }) => {
    let llamadas = 0;
    talo.listarTransaccionesRecientes = async () => { llamadas++; return { transacciones: [], hayMas: false }; };
    const min = (n) => Object.assign({}, deps, { ahora: new Date(Date.UTC(2026, 10, 10, 15, n, 0)) });
    assert.ok((await cron.ciclo(min(1), {})).sinAsociar === undefined, 'minuto 1: no');
    assert.ok((await cron.ciclo(min(2), {})).sinAsociar !== undefined, 'minuto 2: sí');
    assert.ok((await cron.ciclo(min(3), {})).vencidos === undefined);
    assert.ok((await cron.ciclo(min(10), {})).vencidos !== undefined);
    assert.ok((await cron.ciclo(min(3), { forzar: true })).sinAsociar !== undefined, 'forzar corre todo');
    assert.strictEqual(llamadas, 3);
  });
});

test('devoluciones vencidas: una alerta por día por devolución', async () => {
  await conEntorno(async ({ redis, deps, nuevoPago, mails }) => {
    await solicitud(deps, 'sol-5');
    nuevoPago('VAR-5', { estado: 'OVERPAID', externalId: 'hogar~contactos~sol-5', montoPedido: 4500, montoPagado: 5000, acreditado: 4950 });
    await pagos.procesarPago('VAR-5', deps);
    const manana = Object.assign({}, deps, { ahora: new Date(AHORA.getTime() + 25 * 3600 * 1000) });
    const a = await pagos.alertarReembolsosVencidos(manana, '2026-11-11');
    const b = await pagos.alertarReembolsosVencidos(manana, '2026-11-11');
    const c = await pagos.alertarReembolsosVencidos(manana, '2026-11-12');
    assert.deepStrictEqual([a.nuevas, b.nuevas, c.nuevas], [1, 0, 1]);
    await cron.ejecutarEfectos(manana, { enviarEquipo: async (asunto, resumen, datosMail) => { mails.push({ datos: datosMail }); return true; } });
    assert.match(Object.values(mails.at(-1).datos).join(' '), /DEVOLUCIÓN VENCIDA/);
  });
});

test('dos ciclos a la vez: uno corre y el otro se saltea', async () => {
  await conEntorno(async ({ deps, talo }) => {
    talo.listarTransaccionesRecientes = async () => { await new Promise((r) => setTimeout(r, 150)); return { transacciones: [], hayMas: false }; };
    const [a, b] = await Promise.all([cron.cicloConLock(deps, { forzar: true }), cron.cicloConLock(deps, { forzar: true })]);
    const omitidos = [a, b].filter((x) => x.omitido).length;
    assert.strictEqual(omitidos, 1, JSON.stringify([a, b]));
  });
});

test('latido: ok si es reciente, vencido si pasaron más de 5 minutos', async () => {
  await conEntorno(async ({ redis, deps }) => {
    assert.strictEqual((await cron.estadoLatido(deps)).ok, false, 'sin latido');
    await cron.ciclo(deps, {});
    const ok = await cron.estadoLatido(deps);
    assert.strictEqual(ok.ok, true); assert.strictEqual(ok.minutos, 0);
    const tarde = Object.assign({}, deps, { ahora: new Date(AHORA.getTime() + 6 * 60000) });
    assert.strictEqual((await cron.estadoLatido(tarde)).ok, false);
    const r = await cron.resumenEstado(deps);
    assert.strictEqual(typeof r.avisosPendientes, 'number');
  });
});

test('describirEfecto: devolución manual indica a quién; sin datos no rompe', () => {
  const t = cron.describirEfecto({ tipo: 'equipo_reembolso_pendiente', monto: 500, motivo: 'excedente', venceEn: 'mañana', manual: true, remitente: REMITENTE });
  assert.match(t, /\$500/); assert.match(t, /MANUAL/); assert.match(t, /CBU 0270000068177940014287/);
  assert.match(cron.describirEfecto({ tipo: 'equipo_reembolso_pendiente', monto: 100, motivo: 'excedente', manual: false }), /se ejecuta desde el admin/);
  assert.match(cron.describirEfecto({ tipo: 'equipo_alerta', motivo: 'transferencia_sin_asociar', bruto: 300, remitente: null }), /no indica a qué pago iba/);
  assert.ok(cron.describirEfecto({ tipo: 'equipo_alerta', motivo: 'otra_cosa_nueva' }).length > 0);
});

function resFalso() {
  const r = { code: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

test('endpoint: sin credenciales 401; apagado por defecto (no toca Redis ni Talo)', async () => {
  const handler = require('../api/cron-hogar');
  delete process.env.CRON_SECRET; delete process.env.ADMIN_TOKEN; delete process.env.HOGAR_PAGOS_ACTIVO;
  delete process.env.UPSTASH_REDIS_REST_URL; // si intentara usar Redis, fallaría
  let r = resFalso(); await handler({ method: 'GET', headers: {}, query: {} }, r);
  assert.strictEqual(r.code, 401);
  process.env.CRON_SECRET = 'secreto-test';
  try {
    r = resFalso(); await handler({ method: 'GET', headers: { authorization: 'Bearer secreto-test' }, query: {} }, r);
    assert.deepStrictEqual(r.body, { ok: true, inactivo: true });
  } finally { delete process.env.CRON_SECRET; }
});

test('cron-healthcheck: vigila el proceso por minuto solo si Hogar está activo', async () => {
  const { _chequearHogarCron } = require('../api/cron-healthcheck');
  delete process.env.HOGAR_PAGOS_ACTIVO;
  assert.deepStrictEqual(await _chequearHogarCron(), { ok: null, detalle: 'Hogar apagado' });
  process.env.HOGAR_PAGOS_ACTIVO = '1';
  delete process.env.UPSTASH_REDIS_REST_URL;
  try {
    const r = await _chequearHogarCron();
    assert.strictEqual(r.ok, false, 'sin latido / sin Redis no se da por sano');
  } finally { delete process.env.HOGAR_PAGOS_ACTIVO; }
});
