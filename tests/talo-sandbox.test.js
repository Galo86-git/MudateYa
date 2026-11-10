// Consola de pruebas de Talo (api/admin-talo-sandbox.js), cliente sandbox y prefijo de claves de Redis.
const test = require('node:test');
const assert = require('node:assert');
const { crearMock } = require('./_redis-mock');

const { crearCliente } = require('../api/_redis');
const consola = require('../api/admin-talo-sandbox');
const sandbox = require('../api/_talo-sandbox');
const talo = require('../api/_talo');

async function conRedisMock(fn) {
  const m = crearMock();
  await new Promise((r) => m.server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + m.server.address().port;
  try { await fn({ m, url, base: crearCliente({ url, token: 'x', esperaMs: 5 }), conPrefijo: crearCliente({ url, token: 'x', esperaMs: 5, prefijoClaves: 'sandbox:' }) }); }
  finally { await new Promise((r) => m.server.close(r)); }
}

// Talo sandbox simulado. Opciones: suma (¿junta transferencias al mismo alias?), escala (100 = centavos).
function taloFalso(o) {
  o = Object.assign({ suma: true, escala: 1 }, o);
  const pagos = {}; let n = 0;
  const estadoDe = (p) => (p.recibido === 0 ? 'PENDING' : p.recibido === p.pedido ? 'SUCCESS' : p.recibido > p.pedido ? 'OVERPAID' : 'UNDERPAID');
  const vista = (p) => ({
    paymentId: p.id, estado: estadoDe(p), externalId: p.externalId, montoPedido: p.pedido, montoPagado: p.recibido * o.escala,
    acreditado: Math.round(p.recibido * 0.99) * o.escala, comision: Math.round(p.recibido * 0.01) * o.escala, transferencias: [], reembolsado: 0,
    refunds: p.refunds.map((x, i) => ({ n: i, id: 'R' + i, estado: x.estado, monto: x.monto })), cvu: p.cvu, alias: p.alias, expira: '', paymentUrl: '',
  });
  return {
    pagos, reembolsosPedidos: [],
    configurado: () => true, fuente: 'falso', base: 'https://sandbox-api.talo.com.ar',
    async crearPago(x) { const id = 'VAR-' + (++n); pagos[id] = { id, pedido: x.monto, recibido: 0, externalId: x.externalId, cvu: '000000' + n, alias: 'alias.' + n, refunds: [] }; return vista(pagos[id]); },
    async faucet(cvu, monto) { const p = Object.values(pagos).find((x) => x.cvu === cvu); p.recibido = o.suma ? p.recibido + monto : monto; return true; },
    async consultarPagoCompleto(id) {
      const p = pagos[id];
      p.refunds.forEach((r) => { if (r.estado === 'PENDING') r.estado = 'SUCCESS'; }); // la devolución "se procesa" en la siguiente consulta
      return vista(p);
    },
    async reembolsar(id, op) { const p = pagos[id]; this.reembolsosPedidos.push({ id, monto: op && op.monto }); p.refunds.push({ estado: 'PENDING', monto: (op && op.monto) || p.recibido }); return { ok: true, yaPendiente: false }; },
  };
}

async function correr(nombre, opts) {
  let informe; let claves;
  await conRedisMock(async ({ m, conPrefijo }) => {
    const t = taloFalso(opts);
    informe = await consola._correrEscenario(nombre, { redis: conPrefijo, talo: t, ahora: new Date(), webhookUrl: 'x', topeEsperaMs: 60, pasoMs: 5 });
    informe.t = t;
    claves = [...m.db.keys()];
  });
  informe.claves = claves;
  return informe;
}

const fallos = (i) => i.pasos.filter((p) => p.ok === false).map((p) => p.titulo);

test('consola: escenario EXACTO sin hallazgos', async () => {
  const i = await correr('exacto');
  assert.deepStrictEqual(i.hallazgos, []);
  assert.ok(i.pasos.filter((p) => p.ok === true).length >= 6);
});

test('consola: escenario DE MENOS sin hallazgos (espera el resto)', async () => {
  const i = await correr('menos');
  assert.deepStrictEqual(i.hallazgos, []);
});

test('consola: escenario DE MÁS acredita, pide y completa la devolución', async () => {
  const i = await correr('mas');
  assert.deepStrictEqual(i.hallazgos, []);
  assert.deepStrictEqual(i.t.reembolsosPedidos, [{ id: 'VAR-1', monto: 500 }]);
  assert.deepStrictEqual(i.detalle.libro.map((e) => e.tipo).sort(), ['cobro_contactos', 'reembolso_cliente']);
});

test('consola: escenario TARDÍO devuelve todo', async () => {
  const i = await correr('tarde');
  assert.deepStrictEqual(i.hallazgos, []);
  assert.deepStrictEqual(i.t.reembolsosPedidos, [{ id: 'VAR-1', monto: 5000 }]);
});

test('consola: COMPLETAR confirma que Talo suma las transferencias', async () => {
  const i = await correr('completar', { suma: true });
  assert.deepStrictEqual(i.hallazgos, []);
});

test('consola: COMPLETAR detecta si Talo NO suma las transferencias del mismo alias', async () => {
  const i = await correr('completar', { suma: false });
  assert.ok(i.hallazgos.some((h) => /SUMA las dos transferencias/.test(h)), JSON.stringify(i.hallazgos));
});

test('consola: detecta si Talo trabaja en CENTAVOS', async () => {
  const i = await correr('exacto', { escala: 100 });
  assert.ok(i.hallazgos.some((h) => /unidad del monto/.test(h) && /CENTAVOS/.test(h)), JSON.stringify(i.hallazgos));
});

test('consola: TODO queda bajo "sandbox:" — nada toca las claves reales', async () => {
  for (const nombre of ['exacto', 'mas']) {
    const i = await correr(nombre);
    assert.ok(i.claves.length > 5);
    assert.deepStrictEqual(i.claves.filter((k) => k.indexOf('sandbox:') !== 0), [], 'claves sin prefijo en ' + nombre);
    assert.ok(i.claves.some((k) => k.indexOf('sandbox:hogar:libro:e:') === 0), 'el libro de prueba existe, pero aislado');
  }
});

test('consola: limpiar borra solo lo de prueba y deja lo real', async () => {
  await conRedisMock(async ({ m, base, conPrefijo }) => {
    await base.setJSON('hogar:libro:e:cobro:real-1', { real: true }, { permanente: true });
    await base.setJSON('sandbox:otra-cosa', { x: 1 }, { permanente: true });
    await consola._correrEscenario('exacto', { redis: conPrefijo, talo: taloFalso(), ahora: new Date(), webhookUrl: 'x', topeEsperaMs: 60, pasoMs: 5 });
    const n = await consola._limpiar(base);
    assert.ok(n > 5);
    const quedan = [...m.db.keys()];
    assert.deepStrictEqual(quedan.sort(), ['hogar:libro:e:cobro:real-1', 'sandbox:otra-cosa']);
  });
});

test('redis con prefijoClaves: SCAN devuelve claves sin prefijo, el lock funciona, y un comando desconocido falla', async () => {
  await conRedisMock(async ({ m, conPrefijo }) => {
    await conPrefijo.setJSON('a:1', { v: 1 }, { permanente: true });
    assert.ok(m.db.has('sandbox:a:1') && !m.db.has('a:1'));
    assert.deepStrictEqual(await conPrefijo.scanAll('a:*'), ['a:1']);
    assert.strictEqual(await conPrefijo.withLock('lock:z', 5, async () => 'ok'), 'ok');
    assert.strictEqual(m.db.has('sandbox:lock:z'), false, 'se liberó la clave prefijada');
    await assert.rejects(() => conPrefijo.cmd('FLUSHALL'), /no soportado/);
    assert.ok(m.db.has('sandbox:a:1'), 'no se tocó nada');
  });
});

test('cliente sandbox: la URL es fija; las credenciales de producción nunca se usan en producción', () => {
  assert.strictEqual(sandbox.BASE, 'https://sandbox-api.talo.com.ar');
  const dev = { TALO_USER_ID: 'u', TALO_CLIENT_ID: 'c', TALO_CLIENT_SECRET: 's' };
  assert.strictEqual(sandbox.credenciales(Object.assign({ TALO_MODO: 'sandbox' }, dev)).fuente, 'TALO_* (TALO_MODO no es produccion)');
  assert.strictEqual(sandbox.credenciales(dev).userId, 'u', 'sin TALO_MODO se asume sandbox (como _talo.js)');
  assert.strictEqual(sandbox.credenciales(Object.assign({ TALO_MODO: 'produccion' }, dev)), null, 'producción: no se reutilizan');
  const conSb = sandbox.credenciales({ TALO_MODO: 'produccion', TALO_SANDBOX_USER_ID: 'su', TALO_SANDBOX_CLIENT_ID: 'sc', TALO_SANDBOX_CLIENT_SECRET: 'ss' });
  assert.strictEqual(conSb.userId, 'su');
  assert.strictEqual(sandbox.crearTaloSandbox({ TALO_MODO: 'produccion' }).configurado(), false);
});

test('parsearPagoCompleto: bruto, neto, comisión, devoluciones', () => {
  const p = talo.parsearPagoCompleto({
    id: 'VAR-9', payment_status: 'OVERPAID', external_id: 'hogar~contactos~x1', price: { amount: 4500 },
    transactions: [{ transactionType: 'INBOUND', amount: 3000, credited_amount: 2970, commission_amount: 30, tax_amount: 0 }, { amount: 2000, credited_amount: 1980, commission_amount: 20, tax_amount: 0, transaction_id: 'TX2' }, { is_refund: true, transactionType: 'OUTBOUND', amount: 500 }],
    refunds: [{ refund_status: 'success', amount: '500' }], quotes: [{ address: '0001', alias: 'a.b' }], transaction_fields: { refunded_amount: 500 },
  }, 'VAR-9');
  assert.strictEqual(p.montoPagado, 5000); assert.strictEqual(p.acreditado, 4950); assert.strictEqual(p.comision, 50);
  assert.strictEqual(p.reembolsado, 500); assert.deepStrictEqual(p.refunds.map((r) => r.estado), ['SUCCESS']); assert.strictEqual(p.cvu, '0001');
  const vacio = talo.parsearPagoCompleto({ id: 'VAR-1', payment_status: 'PENDING' }, 'VAR-1');
  assert.strictEqual(vacio.montoPagado, 0); assert.deepStrictEqual(vacio.refunds, []);
});

function resFalso() {
  const r = { code: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

test('endpoint: sin admin → 401; solo POST; acciones inválidas', async () => {
  delete process.env.ADMIN_TOKEN;
  let r = resFalso(); await consola({ method: 'POST', headers: {}, body: { accion: 'estado' } }, r);
  assert.strictEqual(r.code, 401);
  process.env.ADMIN_TOKEN = 'tok-test';
  try {
    r = resFalso(); await consola({ method: 'GET', headers: { 'x-admin-token': 'tok-test' } }, r);
    assert.strictEqual(r.code, 405);
    r = resFalso(); await consola({ method: 'POST', headers: { 'x-admin-token': 'tok-test' }, body: { accion: 'inventada' } }, r);
    assert.strictEqual(r.code, 400);
    delete process.env.TALO_SANDBOX_USER_ID; process.env.TALO_MODO = 'produccion';
    r = resFalso(); await consola({ method: 'POST', headers: { 'x-admin-token': 'tok-test' }, body: { accion: 'estado' } }, r);
    assert.strictEqual(r.body.credencialesSandbox, false); assert.match(r.body.falta, /TALO_SANDBOX_USER_ID/);
    r = resFalso(); await consola({ method: 'POST', headers: { 'x-admin-token': 'tok-test' }, body: { accion: 'escenario', nombre: 'exacto' } }, r);
    assert.strictEqual(r.code, 400, 'sin credenciales no corre nada');
  } finally { delete process.env.ADMIN_TOKEN; delete process.env.TALO_MODO; }
});
