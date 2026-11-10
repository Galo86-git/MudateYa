// Cobros y devoluciones de MYA Hogar con Talo (api/_hogar-pagos.js, api/hogar-talo-webhook.js).
const test = require('node:test');
const assert = require('node:assert');
const { crearMock } = require('./_redis-mock');

const { crearCliente } = require('../api/_redis');
const pagos = require('../api/_hogar-pagos');
const libro = require('../api/_hogar-libro');
const datos = require('../api/_hogar-datos');

const D = (iso) => new Date(iso);
const AHORA = D('2026-11-10T15:00:00Z');

async function conEntorno(fn) {
  const m = crearMock();
  await new Promise((r) => m.server.listen(0, '127.0.0.1', r));
  const redis = crearCliente({ url: 'http://127.0.0.1:' + m.server.address().port, token: 'x', esperaMs: 5 });
  // Talo simulado: pagos[id] es lo que "devuelve la API".
  const talo = {
    pagos: {}, reembolsos: [], falla: false,
    async consultarPagoCompleto(id) { if (talo.falla) throw new Error('Talo caído'); const p = talo.pagos[id]; if (!p) throw new Error('no existe ' + id); return JSON.parse(JSON.stringify(p)); },
    async reembolsar(id, o) { talo.reembolsos.push({ id, monto: o && o.monto }); const p = talo.pagos[id]; p.refunds = p.refunds || []; p.refunds.push({ n: p.refunds.length, estado: 'PENDING', monto: (o && o.monto) || p.montoPagado }); return { ok: true, yaPendiente: false }; },
  };
  const deps = { redis, talo, ahora: AHORA };
  const nuevoPago = (id, extra) => { talo.pagos[id] = Object.assign({ paymentId: id, estado: 'PENDING', externalId: '', montoPedido: 0, montoPagado: 0, acreditado: 0, comision: 0, transferencias: [], reembolsado: 0, refunds: [], expira: '2026-11-15T15:00:00Z' }, extra); return talo.pagos[id]; };
  try { await fn({ redis, talo, deps, nuevoPago, m }); } finally { await new Promise((r) => m.server.close(r)); }
}

async function solicitud(deps, id, extra) {
  return datos.crear('solicitud', id, Object.assign({ modo: 'directo', estado: 'esperando_pago', clienteId: 'cli-1', cobro: { monto: 4500, clase: 'contactos' }, vigenteHasta: null }, extra), deps);
}

// ───────────────────────── decidir() — función pura ─────────────────────────

test('decidir: tabla de casos', () => {
  const base = { clase: 'contactos', estadoTalo: 'SUCCESS', esperado: 4500, pagado: 4500, ahora: AHORA, cvuVencido: false, entidad: { estado: 'esperando_pago', vigenteHasta: null }, registrado: 0 };
  const d = (o) => pagos.decidir(Object.assign({}, base, o));

  assert.strictEqual(d({}).accion, 'acreditar');
  assert.strictEqual(d({}).aAcreditar, 4500);
  assert.strictEqual(d({ pagado: 4499 }).accion, 'acreditar', 'tolerancia de $1');
  assert.strictEqual(d({ pagado: 0, estadoTalo: 'PENDING' }).accion, 'esperar');
  assert.strictEqual(d({ pagado: 0, estadoTalo: 'EXPIRED' }).accion, 'ignorar');
  assert.strictEqual(d({ esperado: 0 }).accion, 'ignorar');

  // de más
  const mas = d({ pagado: 5000, estadoTalo: 'OVERPAID' });
  assert.strictEqual(mas.accion, 'acreditar'); assert.strictEqual(mas.excedente, 500);

  // de menos
  const menos = d({ pagado: 3000, estadoTalo: 'UNDERPAID' });
  assert.strictEqual(menos.accion, 'esperar'); assert.strictEqual(menos.falta, 1500);
  assert.strictEqual(d({ pagado: 3000, estadoTalo: 'UNDERPAID', entidad: { estado: 'cancelada' } }).accion, 'devolver_todo');
  assert.strictEqual(d({ pagado: 3000, estadoTalo: 'UNDERPAID', cvuVencido: true }).aDevolver, 3000);

  // tardío: directo se honra; abierto se devuelve
  const tardioDirecto = d({ entidad: { estado: 'cancelada' } });
  assert.strictEqual(tardioDirecto.accion, 'acreditar'); assert.strictEqual(tardioDirecto.motivo, 'tardio_honrado');
  const abierto = { clase: 'gestion', esperado: 5000, pagado: 5000 };
  assert.strictEqual(d(Object.assign({}, abierto, { entidad: { estado: 'esperando_pago', vigenteHasta: '2026-11-10T15:30:00Z' } })).accion, 'acreditar');
  const tardio = d(Object.assign({}, abierto, { entidad: { estado: 'esperando_pago', vigenteHasta: '2026-11-10T14:59:00Z' } }));
  assert.strictEqual(tardio.accion, 'devolver_todo'); assert.strictEqual(tardio.aDevolver, 5000);
  assert.strictEqual(d(Object.assign({}, abierto, { entidad: { estado: 'cancelada' } })).accion, 'devolver_todo');

  // ya acreditado: un aviso repetido no hace nada; plata extra se devuelve
  assert.strictEqual(d({ entidad: { estado: 'pagada' } }).accion, 'ignorar');
  assert.strictEqual(d({ entidad: { estado: 'pagada' }, pagado: 6000 }).excedente, 1500);

  // liquidación de proveedor: acredita lo que llegó, aunque sea parcial
  const liq = d({ clase: 'liq', esperado: 10000, pagado: 4000, entidad: { estado: 'pendiente' }, registrado: 0 });
  assert.strictEqual(liq.accion, 'acreditar'); assert.strictEqual(liq.aAcreditar, 4000); assert.strictEqual(liq.falta, 6000);
  const liq2 = d({ clase: 'liq', esperado: 10000, pagado: 10000, entidad: { estado: 'parcial' }, registrado: 4000 });
  assert.strictEqual(liq2.aAcreditar, 6000, 'solo la diferencia nueva');
  assert.strictEqual(d({ clase: 'liq', esperado: 10000, pagado: 4000, entidad: { estado: 'parcial' }, registrado: 4000 }).accion, 'ignorar');
});

test('external_id: ida y vuelta; los ajenos se rechazan', () => {
  const e = pagos.armarExternalId('contactos', 'sol-123');
  assert.strictEqual(e, 'hogar~contactos~sol-123');
  assert.deepStrictEqual(pagos.parsearExternalId(e), { clase: 'contactos', refId: 'sol-123', entidad: 'solicitud' });
  assert.strictEqual(pagos.parsearExternalId('liq~x')?.clase, undefined);
  for (const mal of ['MYA-123__anticipo', '', 'hogar~inventada~x1', 'hogar~liq', 'otro~liq~abc', null]) assert.strictEqual(pagos.parsearExternalId(mal), null, String(mal));
  assert.throws(() => pagos.armarExternalId('inventada', 'abc'), /inválida/);
});

// ───────────────────────── Cobros de clientes ─────────────────────────

test('pago exacto (modo directo): se asienta en el libro, la solicitud queda pagada y un aviso repetido no duplica', async () => {
  await conEntorno(async ({ redis, deps, nuevoPago }) => {
    await solicitud(deps, 'sol-1');
    nuevoPago('VAR-1', { estado: 'SUCCESS', externalId: 'hogar~contactos~sol-1', montoPedido: 4500, montoPagado: 4500, acreditado: 4455 });
    const a = await pagos.procesarPago('VAR-1', deps);
    assert.strictEqual(a.decision.accion, 'acreditar');
    const b = await pagos.procesarPago('VAR-1', deps); // Talo reenvía el aviso
    assert.strictEqual(b.decision.accion, 'ignorar');

    const ent = await libro.entradasDeCliente('cli-1', { redis });
    assert.strictEqual(ent.length, 1);
    assert.strictEqual(ent[0].tipo, 'cobro_contactos'); assert.strictEqual(ent[0].monto, 4500); assert.strictEqual(ent[0].neto, 4455);
    assert.strictEqual((await datos.leer('solicitud', 'sol-1', { redis })).estado, 'pagada');
    assert.strictEqual((await datos.leer('pago', 'VAR-1', { redis })).estado, 'acreditado');
    const ef = await pagos.efectosPendientes(deps);
    assert.deepStrictEqual(ef.map((x) => x.tipo), ['cliente_entregar_contactos'], 'un solo aviso');
  });
});

test('5 avisos simultáneos del mismo pago: una sola entrada en el libro', async () => {
  await conEntorno(async ({ redis, deps, nuevoPago }) => {
    await solicitud(deps, 'sol-2');
    nuevoPago('VAR-2', { estado: 'SUCCESS', externalId: 'hogar~contactos~sol-2', montoPagado: 4500, acreditado: 4455 });
    await Promise.all(Array.from({ length: 5 }, () => pagos.procesarPago('VAR-2', deps)));
    assert.strictEqual((await libro.entradasDeCliente('cli-1', { redis })).length, 1);
    assert.strictEqual((await pagos.efectosPendientes(deps)).length, 1);
  });
});

test('pagó DE MÁS: se acredita lo esperado y se pide devolver la diferencia en 24 h', async () => {
  await conEntorno(async ({ redis, deps, nuevoPago }) => {
    await solicitud(deps, 'sol-3');
    nuevoPago('VAR-3', { estado: 'OVERPAID', externalId: 'hogar~contactos~sol-3', montoPagado: 5000, acreditado: 4950 });
    await pagos.procesarPago('VAR-3', deps);
    const ent = await libro.entradasDeCliente('cli-1', { redis });
    assert.strictEqual(ent[0].monto, 4500, 'se asienta lo esperado, no lo recibido');
    const r = await datos.leer('reembolso', 'VAR-3.excedente', { redis });
    assert.strictEqual(r.monto, 500); assert.strictEqual(r.estado, 'solicitado');
    assert.strictEqual(new Date(r.venceEn).getTime() - AHORA.getTime(), pagos.PLAZO_REEMBOLSO_MS);
    await pagos.procesarPago('VAR-3', deps); // repetido: no crea otra devolución
    assert.deepStrictEqual(await datos.ids('reembolso', { redis }), ['VAR-3.excedente']);
  });
});

test('pagó DE MENOS con el pedido vigente: no se acredita, se avisa la diferencia; al completar sí', async () => {
  await conEntorno(async ({ redis, deps, nuevoPago, talo }) => {
    await solicitud(deps, 'sol-4', { modo: 'abierto', cobro: { monto: 5000, clase: 'gestion' }, vigenteHasta: '2026-11-10T15:30:00Z' });
    nuevoPago('VAR-4', { estado: 'UNDERPAID', externalId: 'hogar~gestion~sol-4', montoPagado: 3000, acreditado: 2970 });
    const a = await pagos.procesarPago('VAR-4', deps);
    assert.strictEqual(a.decision.accion, 'esperar');
    assert.strictEqual((await libro.entradasDeCliente('cli-1', { redis })).length, 0);
    assert.strictEqual((await datos.leer('solicitud', 'sol-4', { redis })).estado, 'esperando_pago');
    const ef = await pagos.efectosPendientes(deps);
    assert.strictEqual(ef[0].tipo, 'cliente_pago_insuficiente'); assert.strictEqual(ef[0].falta, 2000);

    // El cliente completa la diferencia (Talo suma las dos transferencias).
    Object.assign(talo.pagos['VAR-4'], { estado: 'SUCCESS', montoPagado: 5000, acreditado: 4950 });
    await pagos.procesarPago('VAR-4', deps);
    const ent = await libro.entradasDeCliente('cli-1', { redis });
    assert.strictEqual(ent.length, 1); assert.strictEqual(ent[0].tipo, 'cobro_gestion'); assert.strictEqual(ent[0].monto, 5000);
    assert.strictEqual((await datos.leer('solicitud', 'sol-4', { redis })).estado, 'pagada');
  });
});

test('pagó DE MENOS y el pedido ya venció: se devuelve lo que llegó', async () => {
  await conEntorno(async ({ redis, deps, nuevoPago }) => {
    await solicitud(deps, 'sol-5', { modo: 'abierto', cobro: { monto: 5000, clase: 'gestion' }, vigenteHasta: '2026-11-10T14:00:00Z' });
    nuevoPago('VAR-5', { estado: 'UNDERPAID', externalId: 'hogar~gestion~sol-5', montoPagado: 3000, acreditado: 2970 });
    const r = await pagos.procesarPago('VAR-5', deps);
    assert.strictEqual(r.decision.accion, 'devolver_todo');
    assert.strictEqual((await libro.entradasDeCliente('cli-1', { redis })).length, 0, 'nada acreditado');
    const dev = await datos.leer('reembolso', 'VAR-5.insuficiente_y_vencido', { redis });
    assert.strictEqual(dev.monto, 3000);
  });
});

test('pago TARDÍO: modo directo se honra; modo abierto se devuelve', async () => {
  await conEntorno(async ({ redis, deps, nuevoPago }) => {
    await solicitud(deps, 'sol-6', { estado: 'cancelada' });
    nuevoPago('VAR-6', { estado: 'SUCCESS', externalId: 'hogar~contactos~sol-6', montoPagado: 4500, acreditado: 4455 });
    assert.strictEqual((await pagos.procesarPago('VAR-6', deps)).decision.motivo, 'tardio_honrado');
    assert.strictEqual((await datos.leer('solicitud', 'sol-6', { redis })).estado, 'pagada');

    await solicitud(deps, 'sol-7', { modo: 'abierto', estado: 'cancelada', cobro: { monto: 5000, clase: 'gestion' } });
    nuevoPago('VAR-7', { estado: 'SUCCESS', externalId: 'hogar~gestion~sol-7', montoPagado: 5000, acreditado: 4950 });
    const r = await pagos.procesarPago('VAR-7', deps);
    assert.strictEqual(r.decision.accion, 'devolver_todo');
    assert.strictEqual((await datos.leer('solicitud', 'sol-7', { redis })).estado, 'cancelada', 'no se reactiva');
    assert.ok(await datos.leer('reembolso', 'VAR-7.tardio_pedido_caducado', { redis }));
  });
});

test('pagos ajenos o sin pedido: no se acredita nada', async () => {
  await conEntorno(async ({ redis, deps, nuevoPago }) => {
    nuevoPago('VAR-8', { estado: 'SUCCESS', externalId: 'MYA-1700000000000__anticipo', montoPagado: 50000 }); // Mudanza
    assert.ok((await pagos.procesarPago('VAR-8', deps)).ignorado);
    nuevoPago('VAR-9', { estado: 'SUCCESS', externalId: 'hogar~contactos~no-existe', montoPagado: 4500 });
    assert.strictEqual((await pagos.procesarPago('VAR-9', deps)).huerfano, true);
    const ef = await pagos.efectosPendientes(deps);
    assert.strictEqual(ef.length, 1); assert.strictEqual(ef[0].tipo, 'equipo_alerta'); assert.strictEqual(ef[0].motivo, 'pago_sin_pedido');
    assert.strictEqual((await libro.verificarIntegridad({ redis })).entradas, 0);
  });
});

test('la verdad es la API de Talo, no el aviso: si no se puede consultar, falla (Talo reintenta)', async () => {
  await conEntorno(async ({ deps, talo }) => {
    talo.falla = true;
    await assert.rejects(() => pagos.procesarPago('VAR-X', deps), /Talo caído/);
  });
});

// ───────────────────────── Liquidación de proveedores ─────────────────────────

test('liquidación: pago parcial y después el resto — se asienta solo la diferencia; el saldo cierra en cero', async () => {
  await conEntorno(async ({ redis, deps, nuevoPago, talo }) => {
    await datos.crear('liquidacion', '2026-11-13.prov-1', { provId: 'prov-1', monto: 10000, estado: 'pendiente', pagado: 0, pagos: {} }, deps);
    await libro.registrar({ id: 'cargo_gestion:t-1', tipo: 'cargo_gestion', parteId: 'prov-1', monto: 5000 }, deps);
    await libro.registrar({ id: 'cargo_gestion:t-2', tipo: 'cargo_gestion', parteId: 'prov-1', monto: 5000 }, deps);
    nuevoPago('VAR-L', { estado: 'UNDERPAID', externalId: 'hogar~liq~2026-11-13.prov-1', montoPagado: 4000, acreditado: 3960 });
    await pagos.procesarPago('VAR-L', deps);
    assert.strictEqual(await libro.saldoProveedor('prov-1', { redis }), 6000);
    assert.strictEqual((await datos.leer('liquidacion', '2026-11-13.prov-1', { redis })).estado, 'parcial');

    Object.assign(talo.pagos['VAR-L'], { estado: 'SUCCESS', montoPagado: 10000, acreditado: 9900 });
    await pagos.procesarPago('VAR-L', deps);
    await pagos.procesarPago('VAR-L', deps); // aviso repetido
    assert.strictEqual(await libro.saldoProveedor('prov-1', { redis }), 0);
    const l = await datos.leer('liquidacion', '2026-11-13.prov-1', { redis });
    assert.strictEqual(l.estado, 'pagada'); assert.strictEqual(l.pagado, 10000);
    const pagosLibro = (await libro.entradasDeProveedor('prov-1', { redis })).filter((e) => e.tipo === 'pago_proveedor');
    assert.deepStrictEqual(pagosLibro.map((e) => e.monto).sort((a, b) => a - b), [4000, 6000]); // (misma hora simulada: el orden no importa)
  });
});

// ───────────────────────── Devoluciones ─────────────────────────

test('devolución completa el ciclo: solicitada → en proceso → completada, asentada una sola vez', async () => {
  await conEntorno(async ({ redis, deps, nuevoPago, talo }) => {
    await solicitud(deps, 'sol-10');
    nuevoPago('VAR-10', { estado: 'OVERPAID', externalId: 'hogar~contactos~sol-10', montoPagado: 5000, acreditado: 4950 });
    await pagos.procesarPago('VAR-10', deps);
    const id = 'VAR-10.excedente';
    assert.deepStrictEqual(await pagos.conciliarReembolso(id, deps), { estado: 'solicitado' }, 'todavía no se ejecutó');

    await pagos.ejecutarReembolso(id, deps);
    assert.deepStrictEqual(talo.reembolsos, [{ id: 'VAR-10', monto: 500 }]);
    assert.deepStrictEqual(await pagos.ejecutarReembolso(id, deps), { ya: 'en_proceso' }, 'no se pide dos veces');
    assert.strictEqual(talo.reembolsos.length, 1);

    assert.strictEqual((await pagos.conciliarReembolso(id, deps)).estado, 'en_proceso', 'Talo todavía lo procesa');
    talo.pagos['VAR-10'].refunds[0].estado = 'SUCCESS';
    assert.strictEqual((await pagos.conciliarReembolso(id, deps)).estado, 'completado');
    assert.strictEqual((await pagos.conciliarReembolso(id, deps)).estado, 'completado');
    const ref = (await libro.entradasDeCliente('cli-1', { redis })).filter((e) => e.tipo === 'reembolso_cliente');
    assert.strictEqual(ref.length, 1); assert.strictEqual(ref[0].monto, 500);
  });
});

test('devolución fallida: queda marcada y se puede reintentar', async () => {
  await conEntorno(async ({ redis, deps, nuevoPago, talo }) => {
    await solicitud(deps, 'sol-11');
    nuevoPago('VAR-11', { estado: 'OVERPAID', externalId: 'hogar~contactos~sol-11', montoPagado: 5000, acreditado: 4950 });
    await pagos.procesarPago('VAR-11', deps);
    const id = 'VAR-11.excedente';
    await pagos.ejecutarReembolso(id, deps);
    talo.pagos['VAR-11'].refunds[0].estado = 'FAILED';
    assert.strictEqual((await pagos.conciliarReembolso(id, deps)).estado, 'fallido');
    assert.strictEqual((await libro.entradasDeCliente('cli-1', { redis })).filter((e) => e.tipo === 'reembolso_cliente').length, 0, 'no se asienta lo que no salió');
    await pagos.ejecutarReembolso(id, deps); // reintento
    assert.strictEqual(talo.reembolsos.length, 2);
    assert.strictEqual((await datos.leer('reembolso', id, { redis })).intentos, 2);
  });
});

test('devoluciones vencidas (más de 24 h): se detectan para alertar', async () => {
  await conEntorno(async ({ redis, deps, nuevoPago }) => {
    await solicitud(deps, 'sol-12');
    nuevoPago('VAR-12', { estado: 'OVERPAID', externalId: 'hogar~contactos~sol-12', montoPagado: 5000, acreditado: 4950 });
    await pagos.procesarPago('VAR-12', deps);
    assert.deepStrictEqual(await pagos.reembolsosVencidos(deps), []);
    const manana = Object.assign({}, deps, { ahora: new Date(AHORA.getTime() + 25 * 3600 * 1000) });
    const v = await pagos.reembolsosVencidos(manana);
    assert.strictEqual(v.length, 1); assert.strictEqual(v[0].id, 'VAR-12.excedente');
  });
});

test('solicitarReembolso: valida el monto y avisa si el mismo reembolso cambia de monto', async () => {
  await conEntorno(async ({ redis, deps }) => {
    await assert.rejects(() => pagos.solicitarReembolso({ paymentId: 'VAR-1', monto: 12.5, motivo: 'x' }, deps), /entero positivo/);
    await assert.rejects(() => pagos.solicitarReembolso({ paymentId: 'VAR-1', monto: 0, motivo: 'x' }, deps), /entero positivo/);
    await pagos.solicitarReembolso({ paymentId: 'VAR-1', monto: 500, motivo: 'excedente' }, deps);
    const otra = await pagos.solicitarReembolso({ paymentId: 'VAR-1', monto: 900, motivo: 'excedente' }, deps);
    assert.strictEqual(otra.nuevo, false); assert.strictEqual(otra.reembolso.monto, 500, 'no se pisa');
    const ef = await pagos.efectosPendientes(deps);
    assert.ok(ef.some((e) => e.motivo === 'reembolso_monto_cambio'));
  });
});

// ───────────────────────── Buzón y webhook ─────────────────────────

test('buzón: se procesa y se vacía; si Talo falla queda, y si se atasca más de 15 min se informa', async () => {
  await conEntorno(async ({ redis, deps, nuevoPago, talo }) => {
    await solicitud(deps, 'sol-20');
    nuevoPago('VAR-20', { estado: 'SUCCESS', externalId: 'hogar~contactos~sol-20', montoPagado: 4500, acreditado: 4455 });
    await pagos.anotarAviso(deps, 'VAR-20');
    assert.deepStrictEqual(await pagos.procesarBuzon(deps), { procesados: 1, fallidos: 0, atascados: [] });
    assert.deepStrictEqual(await redis.cmd('ZRANGE', 'hogar:inbox:talo', '0', '-1'), []);

    talo.falla = true;
    await pagos.anotarAviso(deps, 'VAR-21');
    assert.strictEqual((await pagos.procesarBuzon(deps)).fallidos, 1);
    assert.strictEqual((await redis.cmd('ZRANGE', 'hogar:inbox:talo', '0', '-1')).length, 1, 'sigue en el buzón');
    const luego = Object.assign({}, deps, { ahora: new Date(AHORA.getTime() + 20 * 60000) });
    assert.strictEqual((await pagos.procesarBuzon(luego)).atascados.length, 1);
    await assert.rejects(() => pagos.anotarAviso(deps, 'x'), /inválido/);
  });
});

function resFalso() {
  const r = { code: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

test('webhook: apagado por defecto; ignora lo que no es de Hogar; método no permitido', async () => {
  const handler = require('../api/hogar-talo-webhook');
  delete process.env.HOGAR_PAGOS_ACTIVO;
  let r = resFalso(); await handler({ method: 'POST', body: { paymentId: 'VAR-1', externalId: 'hogar~contactos~x1' } }, r);
  assert.deepStrictEqual(r.body, { ok: true, inactivo: true });
  process.env.HOGAR_PAGOS_ACTIVO = '1';
  try {
    r = resFalso(); await handler({ method: 'POST', body: {} }, r);
    assert.strictEqual(r.body.ignorado, 'sin paymentId');
    r = resFalso(); await handler({ method: 'POST', body: { paymentId: 'VAR-1', externalId: 'MYA-1__anticipo' } }, r);
    assert.strictEqual(r.body.ignorado, 'no es de Hogar');
    r = resFalso(); await handler({ method: 'GET' }, r);
    assert.strictEqual(r.code, 405);
  } finally { delete process.env.HOGAR_PAGOS_ACTIVO; }
});
