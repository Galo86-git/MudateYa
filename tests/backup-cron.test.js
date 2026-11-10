// Backup dentro de MudateYa (api/_backup-core.js, api/cron-backup.js) y migración de DNI desde el admin.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { crearMock } = require('./_redis-mock');

const core = require('../api/_backup-core');
const CLAVE = crypto.randomBytes(32).toString('base64');

function resFalso() {
  const r = { code: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

test('volcarRedis + armarArchivo: el archivo se descifra y verifica; lo abre también el script de restauración', async () => {
  const { db, server } = crearMock();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    db.set('mudanza:1', { t: 'string', v: '{"id":1}', exp: 0 });
    db.set('h:1', { t: 'hash', v: { a: '1' }, exp: 0 });
    db.set('lock:x', { t: 'string', v: '1', exp: 0 });
    const redis = core.crearRedis('http://127.0.0.1:' + server.address().port, 'x');
    const v = await core.volcarRedis(redis, ['lock:']);
    assert.strictEqual(v.total, 2, 'saltea los prefijos pedidos');
    const clave = core.parseClave(CLAVE);
    const { archivo } = core.armarArchivo(v.lineas, '2026-11-10', clave);
    core.verificar(archivo, 2, clave);
    assert.throws(() => core.verificar(archivo, 3, clave), /Verificación fallida/);

    const lib = await import('../scripts/_backup-lib.mjs'); // formato compatible con restaurar-backup.mjs
    const txt = lib.descifrar(archivo, lib.parseClave(CLAVE)).toString('utf8').trim().split('\n');
    assert.strictEqual(JSON.parse(txt[0]).total, 2);
    assert.strictEqual(txt.length, 3);
  } finally { server.close(); }
});

test('aBorrar: conserva 30 diarios y el día 1 de los últimos meses', () => {
  const nombres = [];
  const base = new Date('2026-11-10T00:00:00Z');
  for (let i = 0; i < 200; i++) {
    const d = new Date(base.getTime() - i * 86400000).toISOString().slice(0, 10);
    nombres.push('backups/redis/' + d + '.mya');
  }
  const borrar = core.aBorrar(nombres, 30, 12);
  const quedan = nombres.filter((n) => !borrar.includes(n));
  assert.ok(quedan.includes('backups/redis/2026-11-10.mya'));
  assert.ok(quedan.includes('backups/redis/2026-10-12.mya'), 'último diario');
  assert.ok(!quedan.includes('backups/redis/2026-10-05.mya'), 'diario viejo no mensual se borra');
  assert.ok(quedan.includes('backups/redis/2026-10-01.mya') && quedan.includes('backups/redis/2026-05-01.mya'), 'mensuales');
  assert.ok(!borrar.includes('backups/redis/basura.txt'));
});

test('cron-backup y admin-dni-migrar: sin credenciales devuelven 401', async () => {
  delete process.env.ADMIN_TOKEN; delete process.env.CRON_SECRET;
  const a = resFalso();
  await require('../api/cron-backup')({ method: 'POST', query: {}, headers: {} }, a);
  assert.strictEqual(a.code, 401);
  const b = resFalso();
  await require('../api/admin-dni-migrar')({ method: 'POST', query: {}, body: { accion: 'aplicar' }, headers: {} }, b);
  assert.strictEqual(b.code, 401);
});

test('migración de DNI: clasifica públicas / privadas / URLs raras', () => {
  const { _resumen } = require('../api/admin-dni-migrar');
  const r = _resumen([
    { email: 'a@a.com', dniFrente: 'https://abc.public.blob.vercel-storage.com/x/dni.jpg', dniDorso: 'dni/h/dorso-1.jpg' },
    { email: 'b@b.com', dniFrente: 'https://evil.example.com/x.jpg', dniDorso: '' },
  ]);
  assert.deepStrictEqual(r, { perfilesConDni: 2, fotosPublicas: 1, fotosYaPrivadas: 1, fotosConUrlRara: 1 });
});
