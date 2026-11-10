// Capa de datos de MYA Hogar: cliente Redis, libro de cargos, entidades y reglas.
const test = require('node:test');
const assert = require('node:assert');
const { crearMock } = require('./_redis-mock');

const { crearCliente, RedisError, LockOcupado, IdempotenciaEnCurso } = require('../api/_redis');
const libro = require('../api/_hogar-libro');
const datos = require('../api/_hogar-datos');
const reglas = require('../api/_hogar-reglas');

async function conRedis(fn, opts) {
  const m = crearMock();
  await new Promise((r) => m.server.listen(0, '127.0.0.1', r));
  const redis = crearCliente(Object.assign({ url: 'http://127.0.0.1:' + m.server.address().port, token: 'x', esperaMs: 5 }, opts || {}));
  try { await fn(redis, m); } finally { await new Promise((r) => m.server.close(r)); }
}
const D = (iso) => new Date(iso);

// ───────────────────────── Cliente Redis ─────────────────────────

test('redis: reintenta lecturas ante 503 y se recupera', async () => {
  await conRedis(async (r, m) => {
    await r.cmd('SET', 'a', '1');
    m.estado.fallos = 2;
    assert.strictEqual(await r.cmd('GET', 'a'), '1');
  });
});

test('redis: NO reintenta comandos que podrían duplicar (RPUSH)', async () => {
  await conRedis(async (r, m) => {
    m.estado.fallos = 1; m.estado.pedidos = 0;
    await assert.rejects(() => r.cmd('RPUSH', 'l', 'x'), RedisError);
    assert.strictEqual(m.estado.pedidos, 1, 'un solo intento');
    assert.strictEqual(m.db.has('l'), false);
  });
});

test('redis: tiempo límite — no se cuelga', async () => {
  await conRedis(async (r, m) => {
    m.estado.demoraMs = 400;
    const t0 = Date.now();
    await assert.rejects(() => r.cmd('GET', 'a'), RedisError);
    assert.ok(Date.now() - t0 < 1500);
  }, { timeoutMs: 100, intentos: 2 });
});

test('redis: setJSON obliga a decidir el vencimiento', async () => {
  await conRedis(async (r, m) => {
    await assert.rejects(() => r.setJSON('k', { a: 1 }), /ttlSeg o permanente/);
    await r.setJSON('k', { a: 1 }, { ttlSeg: 60 });
    assert.strictEqual(m.db.get('k').exp, 60000);
    await r.setJSON('p', { a: 1 }, { permanente: true });
    assert.strictEqual(m.db.get('p').exp, 0);
    assert.strictEqual(await r.setJSON('p', { a: 2 }, { permanente: true, nx: true }), false);
    assert.deepStrictEqual(await r.getJSON('p'), { a: 1 });
  });
});

test('redis: withLock da exclusión mutua (10 incrementos en paralelo no se pisan)', async () => {
  await conRedis(async (r) => {
    await r.setJSON('n', { v: 0 }, { permanente: true });
    await Promise.all(Array.from({ length: 10 }, () => r.withLock('lock:n', 10, async () => {
      const x = await r.getJSON('n');
      await new Promise((res) => setTimeout(res, 5));
      await r.setJSON('n', { v: x.v + 1 }, { permanente: true });
    }, { esperaMs: 5000, pasoMs: 10 })));
    assert.strictEqual((await r.getJSON('n')).v, 10);
  });
});

test('redis: withLock falla CERRADO si Redis no responde (no ejecuta la sección crítica)', async () => {
  await conRedis(async (r, m) => {
    let corrio = false;
    m.estado.fallos = 99;
    await assert.rejects(() => r.withLock('lock:x', 5, async () => { corrio = true; }), RedisError);
    assert.strictEqual(corrio, false);
  });
});

test('redis: withLock ocupado → LockOcupado; y se libera al terminar o fallar', async () => {
  await conRedis(async (r, m) => {
    let adentro = null;
    const largo = r.withLock('lock:y', 10, async () => { await new Promise((res) => setTimeout(res, 150)); });
    await new Promise((res) => setTimeout(res, 20));
    adentro = r.withLock('lock:y', 10, async () => 1, { esperaMs: 30, pasoMs: 10 });
    await assert.rejects(() => adentro, LockOcupado);
    await largo;
    assert.strictEqual(m.db.has('lock:y'), false, 'liberado');
    await assert.rejects(() => r.withLock('lock:z', 10, async () => { throw new Error('boom'); }), /boom/);
    assert.strictEqual(m.db.has('lock:z'), false, 'liberado aunque falle');
  });
});

test('redis: idempotente ejecuta una sola vez; repite el resultado; libera si falla', async () => {
  await conRedis(async (r) => {
    let veces = 0;
    const a = await r.idempotente('evt:1', 60, async () => { veces++; return { ok: true, n: veces }; });
    const b = await r.idempotente('evt:1', 60, async () => { veces++; return { ok: false }; });
    assert.strictEqual(veces, 1);
    assert.strictEqual(a.repetido, false);
    assert.strictEqual(b.repetido, true);
    assert.deepStrictEqual(b.resultado, { ok: true, n: 1 });

    await assert.rejects(() => r.idempotente('evt:2', 60, async () => { throw new Error('falló'); }), /falló/);
    const c = await r.idempotente('evt:2', 60, async () => 'ahora sí');
    assert.strictEqual(c.repetido, false, 'después de fallar se puede reintentar');
    assert.strictEqual(c.resultado, 'ahora sí');

    // Ejecución en curso: un segundo pedido simultáneo no corre en paralelo.
    let libre;
    const lento = r.idempotente('evt:3', 60, () => new Promise((res) => { libre = res; }));
    await new Promise((res) => setTimeout(res, 20));
    await assert.rejects(() => r.idempotente('evt:3', 60, async () => 'x'), IdempotenciaEnCurso);
    libre('listo'); await lento;
  });
});

test('redis: scanAll respeta el patrón', async () => {
  await conRedis(async (r) => {
    await r.cmd('SET', 'hogar:a:1', 'x'); await r.cmd('SET', 'hogar:a:2', 'x'); await r.cmd('SET', 'otro:1', 'x');
    assert.deepStrictEqual((await r.scanAll('hogar:a:*')).sort(), ['hogar:a:1', 'hogar:a:2']);
  });
});

// ───────────────────────── Libro de cargos ─────────────────────────

test('libro: registrar es idempotente — el mismo evento dos veces no duplica nada', async () => {
  await conRedis(async (redis) => {
    const e = { id: 'cargo_gestion:trabajo-1', tipo: 'cargo_gestion', parteId: 'prov-1', monto: 5000, trabajoId: 'trabajo-1' };
    const a = await libro.registrar(e, { redis, ahora: D('2026-11-10T15:00:00Z') });
    const b = await libro.registrar(e, { redis, ahora: D('2026-11-11T15:00:00Z') });
    assert.strictEqual(a.nuevo, true);
    assert.strictEqual(b.nuevo, false);
    assert.strictEqual(b.entrada.ts, a.entrada.ts, 'conserva la primera fecha');
    assert.strictEqual((await libro.entradasDeProveedor('prov-1', { redis })).length, 1);
    assert.strictEqual(await libro.saldoProveedor('prov-1', { redis }), 5000);
  });
});

test('libro: el mismo id con datos distintos es un conflicto (no pisa)', async () => {
  await conRedis(async (redis) => {
    await libro.registrar({ id: 'pago_proveedor:talo-123', tipo: 'pago_proveedor', parteId: 'prov-1', monto: 5000 }, { redis });
    await assert.rejects(() => libro.registrar({ id: 'pago_proveedor:talo-123', tipo: 'pago_proveedor', parteId: 'prov-1', monto: 9000 }, { redis }), libro.ConflictoLibro);
    const e = await redis.getJSON(libro.K.entrada('pago_proveedor:talo-123'));
    assert.strictEqual(e.monto, 5000, 'la entrada original no cambió');
  });
});

test('libro: validaciones (monto entero positivo, tipo, nota en ajustes, ids)', async () => {
  await conRedis(async (redis) => {
    const base = { id: 'cargo_gestion:t-1', tipo: 'cargo_gestion', parteId: 'p1', monto: 5000 };
    for (const mal of [
      { monto: 0 }, { monto: -5 }, { monto: 12.5 }, { monto: '5000' }, { monto: libro.MAX_MONTO + 1 },
      { tipo: 'inventado' }, { id: 'x' }, { id: 'tiene espacios!' }, { parteId: '' },
      { tipo: 'ajuste_debito' }, // sin nota
      { tipo: 'reembolso_cliente', nota: 'ok' }, // nota muy corta
    ]) {
      await assert.rejects(() => libro.registrar(Object.assign({}, base, mal), { redis }), libro.EntradaInvalida, JSON.stringify(mal));
    }
    await libro.registrar({ id: 'ajuste:a-1', tipo: 'ajuste_credito', parteId: 'p1', monto: 1000, nota: 'error de carga del lunes' }, { redis });
  });
});

test('libro: saldo del proveedor = cargos − condonaciones − pagos; primer trabajo gratis', async () => {
  await conRedis(async (redis) => {
    const r = (e) => libro.registrar(e, { redis });
    // Primer trabajo (gratis): cargo + condonación → deuda 0
    for (const a of reglas.cargoPorTrabajoGestionado(false).asientos) await r({ id: a.tipo + ':t-1', tipo: a.tipo, parteId: 'p1', monto: a.monto, trabajoId: 't-1' });
    assert.strictEqual(await libro.saldoProveedor('p1', { redis }), 0);
    // Segundo y tercero se cobran
    for (const t of ['t-2', 't-3']) for (const a of reglas.cargoPorTrabajoGestionado(true).asientos) await r({ id: a.tipo + ':' + t, tipo: a.tipo, parteId: 'p1', monto: a.monto, trabajoId: t });
    assert.strictEqual(await libro.saldoProveedor('p1', { redis }), 10000);
    await r({ id: 'pago_proveedor:talo-9', tipo: 'pago_proveedor', parteId: 'p1', monto: 10000, refExterna: 'talo-9' });
    assert.strictEqual(await libro.saldoProveedor('p1', { redis }), 0);
    // El proveedor p2 no se mezcla
    await r({ id: 'cargo_gestion:t-9', tipo: 'cargo_gestion', parteId: 'p2', monto: 5000, trabajoId: 't-9' });
    assert.strictEqual(await libro.saldoProveedor('p1', { redis }), 0);
    assert.strictEqual((await libro.entradasDeTrabajo('t-2', { redis })).length, 1);
  });
});

test('libro: totales por tipo en un período', async () => {
  await conRedis(async (redis) => {
    const r = (id, tipo, monto, iso) => libro.registrar({ id, tipo, parteId: 'c1', monto }, { redis, ahora: D(iso) });
    await r('cobro_contactos:a1', 'cobro_contactos', 3000, '2026-11-10T12:00:00Z');
    await r('cobro_contactos:a2', 'cobro_contactos', 4500, '2026-11-12T12:00:00Z');
    await r('cobro_gestion:a3', 'cobro_gestion', 5000, '2026-11-20T12:00:00Z');
    const todas = await libro.entradasDeCliente('c1', { redis });
    assert.deepStrictEqual(libro.totalesPorTipo(todas, D('2026-11-10T00:00:00Z').getTime(), D('2026-11-15T00:00:00Z').getTime()), { cobro_contactos: 7500 });
    assert.deepStrictEqual(libro.totalesPorTipo(todas), { cobro_contactos: 7500, cobro_gestion: 5000 });
  });
});

test('libro: si se corta entre la entrada y los índices, repetir completa; y el control lo detecta/repara', async () => {
  await conRedis(async (redis, m) => {
    const e = { id: 'cargo_gestion:t-77', tipo: 'cargo_gestion', parteId: 'p7', monto: 5000, trabajoId: 't-77' };
    // Simulación del corte: la entrada se guardó (punto de confirmación) pero no hay índices.
    const ent = Object.assign({}, e, { ts: 1, creado: 'x', parte: 'proveedor', efectoSaldo: 1, refExterna: null, nota: null, por: 'sistema', trabajoId: 't-77' });
    await redis.setJSON(libro.K.entrada(e.id), ent, { permanente: true });
    assert.strictEqual((await libro.entradasDeProveedor('p7', { redis })).length, 0);
    const c = await libro.verificarIntegridad({ redis });
    assert.strictEqual(c.ok, false); assert.strictEqual(c.sinIndice, 1);
    const rep = await libro.verificarIntegridad({ redis, repararIndices: true });
    assert.strictEqual(rep.reparadas, 1);
    assert.strictEqual((await libro.verificarIntegridad({ redis })).ok, true);
    assert.strictEqual(await libro.saldoProveedor('p7', { redis }), 5000);
    // Y repetir el registro no duplica
    const otra = await libro.registrar(e, { redis });
    assert.strictEqual(otra.nuevo, false);
    assert.strictEqual((await libro.entradasDeProveedor('p7', { redis })).length, 1);
  });
});

// ───────────────────────── Entidades ─────────────────────────

test('datos: crear / leer / actualizar con versión, y sin vencimiento', async () => {
  await conRedis(async (redis, m) => {
    const o = { redis, ahora: D('2026-11-10T12:00:00Z') };
    const p = await datos.crear('proveedor', 'prov-1', { nombre: 'Juan', rubro: 'plomeria' }, o);
    assert.strictEqual(p._v, 1);
    assert.strictEqual(m.db.get('hogar:proveedor:prov-1').exp, 0, 'no vence');
    await assert.rejects(() => datos.crear('proveedor', 'prov-1', {}, o), datos.EntidadExistente);
    const n = await datos.actualizar('proveedor', 'prov-1', (x) => { x.estado = 'activo'; }, { redis, ahora: D('2026-11-11T12:00:00Z') });
    assert.strictEqual(n._v, 2); assert.strictEqual(n.estado, 'activo'); assert.strictEqual(n.creado, p.creado);
    await assert.rejects(() => datos.actualizar('proveedor', 'no-existe', () => {}, { redis }), datos.EntidadInexistente);
    await assert.rejects(() => datos.actualizar('proveedor', 'prov-1', () => { throw new Error('no guardar'); }, { redis }), /no guardar/);
    assert.strictEqual((await datos.leer('proveedor', 'prov-1', { redis }))._v, 2, 'si mutar falla no se guarda');
    assert.deepStrictEqual(await datos.ids('proveedor', { redis }), ['prov-1']);
    await assert.rejects(() => datos.crear('inventado', 'abc', {}, o), /desconocido/);
  });
});

test('datos: actualizaciones concurrentes no se pierden', async () => {
  await conRedis(async (redis) => {
    await datos.crear('trabajo', 'trab-1', { visitas: 0 }, { redis });
    await Promise.all(Array.from({ length: 8 }, () => datos.actualizar('trabajo', 'trab-1', (t) => { t.visitas += 1; }, { redis, esperaLockMs: 8000 })));
    const t = await datos.leer('trabajo', 'trab-1', { redis });
    assert.strictEqual(t.visitas, 8);
    assert.strictEqual(t._v, 9);
  });
});

test('datos: primer trabajo gratis por DNI se concede una sola vez', async () => {
  await conRedis(async (redis) => {
    const h = 'a'.repeat(32);
    assert.strictEqual(await datos.reservarPrimerTrabajoGratis(h, 'trab-1', { redis }), true);
    assert.strictEqual(await datos.reservarPrimerTrabajoGratis(h, 'trab-1', { redis }), true, 'reintento del mismo trabajo');
    assert.strictEqual(await datos.reservarPrimerTrabajoGratis(h, 'trab-2', { redis }), false, 'otro trabajo con el mismo DNI');
    await assert.rejects(() => datos.reservarPrimerTrabajoGratis('1234', 'trab-1', { redis }), /dniHash/);
  });
});

test('datos: precios por defecto, guardados y validados', async () => {
  await conRedis(async (redis) => {
    assert.deepStrictEqual(await datos.precios({ redis }), reglas.PRECIOS_DEFAULT);
    await datos.guardarPrecios({ contactoDirecto: 1800, gestionAbierto: 6000, vigenteDesde: '2026-12-01' }, { redis });
    assert.strictEqual((await datos.precios({ redis })).contactoDirecto, 1800);
    await assert.rejects(() => datos.guardarPrecios({ contactoDirecto: 0, gestionAbierto: 6000 }, { redis }), /Precios inválidos/);
    await assert.rejects(() => datos.guardarPrecios({ contactoDirecto: 15.5, gestionAbierto: 6000 }, { redis }), /Precios inválidos/);
  });
});

test('datos: control de integridad de índices', async () => {
  await conRedis(async (redis) => {
    await datos.crear('cliente', 'cli-1', { nombre: 'Ana' }, { redis });
    await redis.setJSON('hogar:cliente:cli-2', { id: 'cli-2' }, { permanente: true }); // sin pasar por crear()
    const c = await datos.verificarIntegridad('cliente', { redis });
    assert.strictEqual(c.ok, false); assert.strictEqual(c.sinIndice, 1);
    await datos.verificarIntegridad('cliente', { redis, reparar: true });
    assert.strictEqual((await datos.verificarIntegridad('cliente', { redis })).ok, true);
  });
});

// ───────────────────────── Reglas puras ─────────────────────────

test('reglas: modo directo $1.500 por contacto; límites', () => {
  assert.strictEqual(reglas.totalModoDirecto(1), 1500);
  assert.strictEqual(reglas.totalModoDirecto(3), 4500);
  assert.strictEqual(reglas.totalModoDirecto(3, { contactoDirecto: 1800, gestionAbierto: 6000 }), 5400);
  for (const n of [0, -1, 2.5, 21, '3']) assert.throws(() => reglas.totalModoDirecto(n), /inválida/);
});

test('reglas: primer trabajo gratis → cargo + condonación; después solo cargo', () => {
  const primero = reglas.cargoPorTrabajoGestionado(false);
  assert.strictEqual(primero.condonado, true);
  assert.deepStrictEqual(primero.asientos.map((a) => a.tipo), ['cargo_gestion', 'condonacion_gestion']);
  const segundo = reglas.cargoPorTrabajoGestionado(true);
  assert.strictEqual(segundo.condonado, false);
  assert.deepStrictEqual(segundo.asientos, [{ tipo: 'cargo_gestion', monto: 5000 }]);
});

test('reglas: cierre de los viernes 18:00 hora Argentina (21:00 UTC)', () => {
  // 2026-11-13 es viernes.
  assert.strictEqual(reglas.ultimoCierre(D('2026-11-13T20:59:00Z')).toISOString(), '2026-11-06T21:00:00.000Z', 'viernes 17:59 → todavía el anterior');
  assert.strictEqual(reglas.ultimoCierre(D('2026-11-13T21:00:00Z')).toISOString(), '2026-11-13T21:00:00.000Z', 'viernes 18:00 en punto');
  assert.strictEqual(reglas.ultimoCierre(D('2026-11-14T01:00:00Z')).toISOString(), '2026-11-13T21:00:00.000Z', 'viernes 22:00 AR (ya sábado en UTC)');
  assert.strictEqual(reglas.ultimoCierre(D('2026-11-16T02:00:00Z')).toISOString(), '2026-11-13T21:00:00.000Z', 'domingo 23:00 AR (ya lunes en UTC)');
  assert.strictEqual(reglas.ultimoCierre(D('2026-11-10T15:00:00Z')).toISOString(), '2026-11-06T21:00:00.000Z', 'martes');
  const p = reglas.periodoDeLiquidacion(D('2026-11-13T21:05:00Z'));
  assert.strictEqual(p.clave, '2026-11-13');
  assert.strictEqual(p.desde.toISOString(), '2026-11-06T21:00:00.000Z');
});

test('reglas: un trabajo cae en el primer cierre posterior', () => {
  assert.strictEqual(reglas.cierreQueCorresponde(D('2026-11-10T15:00:00Z')).toISOString(), '2026-11-13T21:00:00.000Z');
  assert.strictEqual(reglas.cierreQueCorresponde(D('2026-11-13T21:00:00Z')).toISOString(), '2026-11-13T21:00:00.000Z');
  assert.strictEqual(reglas.cierreQueCorresponde(D('2026-11-13T21:00:01Z')).toISOString(), '2026-11-20T21:00:00.000Z');
});

test('reglas: bloqueo el lunes 09:00 si no pagó el cierre', () => {
  const cierre = D('2026-11-13T21:00:00Z');
  assert.strictEqual(reglas.bloqueoDesde(cierre).toISOString(), '2026-11-16T12:00:00.000Z'); // lunes 09:00 AR
  assert.strictEqual(reglas.estaBloqueado(D('2026-11-16T11:59:00Z'), [cierre]), false);
  assert.strictEqual(reglas.estaBloqueado(D('2026-11-16T12:00:00Z'), [cierre]), true);
  assert.strictEqual(reglas.estaBloqueado(D('2026-11-20T12:00:00Z'), []), false, 'sin deuda no se bloquea');
});

test('reglas: relojes del cliente (15 → recordar, 30 → cancelar) y del proveedor (10)', () => {
  const t0 = D('2026-11-10T15:00:00Z');
  const mas = (m) => new Date(t0.getTime() + m * 60000);
  assert.strictEqual(reglas.estadoRelojCliente(t0, mas(14.9), false), 'esperando');
  assert.strictEqual(reglas.estadoRelojCliente(t0, mas(15), false), 'recordar');
  assert.strictEqual(reglas.estadoRelojCliente(t0, mas(16), true), 'esperando', 'ya recordado');
  assert.strictEqual(reglas.estadoRelojCliente(t0, mas(30), true), 'cancelar');
  assert.strictEqual(reglas.estadoRelojCliente(t0, mas(30), false), 'cancelar');
  assert.strictEqual(reglas.proveedorVencido(t0, mas(9.99)), false);
  assert.strictEqual(reglas.proveedorVencido(t0, mas(10)), true);
});

test('reglas: horario 7 a 19 hora Argentina; urgencias 24 h', () => {
  assert.strictEqual(reglas.dentroDeHorario(D('2026-11-10T09:59:00Z')), false); // 06:59 AR
  assert.strictEqual(reglas.dentroDeHorario(D('2026-11-10T10:00:00Z')), true);  // 07:00 AR
  assert.strictEqual(reglas.dentroDeHorario(D('2026-11-10T21:59:00Z')), true);  // 18:59 AR
  assert.strictEqual(reglas.dentroDeHorario(D('2026-11-10T22:00:00Z')), false); // 19:00 AR
  assert.strictEqual(reglas.dentroDeHorario(D('2026-11-10T03:00:00Z'), true), true);
});
