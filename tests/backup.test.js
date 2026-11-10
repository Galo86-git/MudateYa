// Backup y restauración de Redis, de punta a punta contra un Upstash simulado.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const RAIZ = path.join(__dirname, '..');
const CLAVE = crypto.randomBytes(32).toString('base64');

const { crearMock } = require('./_redis-mock');

function correr(script, args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(RAIZ, 'scripts', script), ...args], { env: { ...process.env, ...env }, cwd: RAIZ }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code || 1 : 0, stdout, stderr });
    });
  });
}

test('backup → archivo cifrado → restauración en prefijo aparte devuelve lo mismo', async () => {
  const { db, server } = crearMock();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port;
  const env = { UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: 'x', BACKUP_ENCRYPTION_KEY: CLAVE };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-bk-'));

  db.set('mudanza:MYA-1', { t: 'string', v: JSON.stringify({ id: 'MYA-1', total: 100, nombre: 'Ñandú "ç" 🚚' }), exp: 0 });
  db.set('sesion:a', { t: 'string', v: 'tok', exp: 5000000 });
  db.set('hash:x', { t: 'hash', v: { a: '1', b: '2' }, exp: 0 });
  db.set('lista:x', { t: 'list', v: ['uno', 'dos'], exp: 0 });
  db.set('set:x', { t: 'set', v: new Set(['p', 'q']), exp: 0 });
  db.set('z:x', { t: 'zset', v: [{ s: 1, m: 'a' }, { s: 2.5, m: 'b' }], exp: 0 });

  try {
    const c = await correr('backup-redis.mjs', ['--contar'], env);
    assert.strictEqual(c.code, 0, c.stderr);
    assert.match(c.stdout, /Claves en Redis: 6/);

    const b = await correr('backup-redis.mjs', ['--local', dir], env);
    assert.strictEqual(b.code, 0, b.stderr + b.stdout);
    const archivos = fs.readdirSync(dir);
    assert.strictEqual(archivos.length, 1);
    const bytes = fs.readFileSync(path.join(dir, archivos[0]));
    assert.ok(!bytes.toString('latin1').includes('MYA-1'), 'el backup no puede tener datos en claro');

    // Modo prueba de restauración: no escribe.
    const antes = db.size;
    const p = await correr('restaurar-backup.mjs', ['--archivo', path.join(dir, archivos[0])], env);
    assert.strictEqual(p.code, 0, p.stderr);
    assert.match(p.stdout, /6 claves/);
    assert.strictEqual(db.size, antes);

    // Restauración con prefijo: copia exacta en un espacio aparte.
    const r = await correr('restaurar-backup.mjs', ['--archivo', path.join(dir, archivos[0]), '--aplicar', '--prefijo', 'rt:'], env);
    assert.strictEqual(r.code, 0, r.stderr + r.stdout);
    for (const k of ['mudanza:MYA-1', 'sesion:a', 'hash:x', 'lista:x', 'set:x', 'z:x']) {
      const a = db.get(k), b2 = db.get('rt:' + k);
      assert.ok(b2, 'falta ' + k);
      assert.strictEqual(b2.t, a.t);
      assert.deepStrictEqual(b2.v, a.v, 'difiere ' + k);
    }
    assert.strictEqual(db.get('rt:sesion:a').exp, 5000000, 'conserva el vencimiento');

    // Sin prefijo y con claves existentes: se frena.
    const f = await correr('restaurar-backup.mjs', ['--archivo', path.join(dir, archivos[0]), '--aplicar'], env);
    assert.notStrictEqual(f.code, 0);
    assert.match(f.stderr, /ya existen/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clave equivocada o archivo adulterado: no restaura', async () => {
  const lib = await import('../scripts/_backup-lib.mjs');
  const k1 = lib.parseClave(CLAVE);
  const k2 = lib.parseClave(crypto.randomBytes(32).toString('hex'));
  const enc = lib.cifrar(Buffer.from('hola'), k1);
  assert.strictEqual(lib.descifrar(enc, k1).toString(), 'hola');
  assert.throws(() => lib.descifrar(enc, k2), /clave incorrecta|dañado/);
  const roto = Buffer.from(enc); roto[roto.length - 1] ^= 1;
  assert.throws(() => lib.descifrar(roto, k1), /clave incorrecta|dañado/);
  assert.throws(() => lib.descifrar(Buffer.from('no soy un backup de nadie, nada nada'), k1), /formato desconocido/);
  assert.throws(() => lib.parseClave('corta'), /32 bytes/);
});

test('fechaAR usa hora argentina, no la del servidor', async () => {
  const lib = await import('../scripts/_backup-lib.mjs');
  assert.strictEqual(lib.fechaAR(new Date('2026-11-10T02:30:00Z')), '2026-11-09'); // 23:30 del 9 en ARG
  assert.strictEqual(lib.fechaAR(new Date('2026-11-10T06:00:00Z')), '2026-11-10');
});
