// Tests del almacenamiento privado de DNI (api/_dni-privado.js + api/dni.js).
const test = require('node:test');
const assert = require('node:assert');

const dni = require('../api/_dni-privado');
const handler = require('../api/dni');

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
const PNG = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n'), Buffer.alloc(10)]);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(30)]);

test('carpetaDe: no expone el email y es estable (sin importar mayúsculas)', () => {
  const a = dni.carpetaDe('Juan@Mail.com');
  assert.strictEqual(a, dni.carpetaDe('  juan@mail.com '));
  assert.ok(a.startsWith('dni/') && a.endsWith('/'));
  assert.ok(!a.includes('juan') && !a.includes('@'));
  assert.notStrictEqual(a, dni.carpetaDe('otro@mail.com'));
});

test('perteneceA: solo el dueño de la carpeta; rechaza rutas raras', () => {
  const p = dni.carpetaDe('a@a.com') + 'frente-1.jpg';
  assert.strictEqual(dni.perteneceA(p, 'a@a.com'), true);
  assert.strictEqual(dni.perteneceA(p, 'b@b.com'), false);
  assert.strictEqual(dni.perteneceA('dni/../x', 'a@a.com'), false);
  assert.strictEqual(dni.perteneceA('mudanceros/foto.jpg', 'a@a.com'), false);
  assert.strictEqual(dni.perteneceA(p, ''), false);
});

test('esPathnameDni: URLs y rutas ajenas no valen', () => {
  assert.strictEqual(dni.esPathnameDni('dni/abc/frente-1.jpg'), true);
  assert.strictEqual(dni.esPathnameDni('https://x.public.blob.vercel-storage.com/dni/a.jpg'), false);
  assert.strictEqual(dni.esPathnameDni(''), false);
  assert.strictEqual(dni.esPathnameDni(null), false);
});

test('tipoRealDeImagen: mira los bytes, no el Content-Type', () => {
  assert.strictEqual(dni.tipoRealDeImagen(JPG), 'image/jpeg');
  assert.strictEqual(dni.tipoRealDeImagen(PNG), 'image/png');
  assert.strictEqual(dni.tipoRealDeImagen(EXE), null);
  assert.strictEqual(dni.tipoRealDeImagen(Buffer.from('<html>hola mundo</html>')), null);
  assert.strictEqual(dni.tipoRealDeImagen(Buffer.alloc(3)), null);
});

test('subirDni: rechaza lo que no es imagen antes de tocar el store', async () => {
  await assert.rejects(() => dni.subirDni(EXE, 'a@a.com', 'frente'), /imagen válida/);
});

function resFalso() {
  const r = { code: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  return r;
}

test('api/dni sin credenciales: no deja subir ni leer', async () => {
  delete process.env.ADMIN_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  const post = resFalso();
  await handler({ method: 'POST', query: { email: 'a@a.com', lado: 'frente' }, headers: {} }, post);
  assert.strictEqual(post.code, 401);

  const get = resFalso();
  await handler({ method: 'GET', query: { pathname: dni.carpetaDe('a@a.com') + 'frente-1.jpg', email: 'a@a.com' }, headers: {} }, get);
  assert.strictEqual(get.code, 401);
  assert.strictEqual(get.headers['Cache-Control'], 'no-store');
});

test('api/dni: pathname inválido o método no permitido', async () => {
  const g = resFalso();
  await handler({ method: 'GET', query: { pathname: 'https://evil/x.jpg' }, headers: {} }, g);
  assert.strictEqual(g.code, 400);
  const d = resFalso();
  await handler({ method: 'DELETE', query: {}, headers: {} }, d);
  assert.strictEqual(d.code, 405);
});

test('api/dni: sin CORS abierto', async () => {
  const r = resFalso();
  await handler({ method: 'GET', query: { pathname: 'dni/x/y.jpg' }, headers: {} }, r);
  assert.strictEqual(r.headers['Access-Control-Allow-Origin'], undefined);
});

test('tokenPrivado: usa la variable propia primero; sin ninguna devuelve vacío y subirDni avisa claro', async () => {
  const claves = ['BLOB_PRIVADO_READ_WRITE_TOKEN', 'BLOB_BACKUP_READ_WRITE_TOKEN', 'BLOB_READ_WRITE_TOKEN'];
  const previo = {}; claves.forEach((k) => { previo[k] = process.env[k]; delete process.env[k]; });
  try {
    assert.strictEqual(dni.tokenPrivado(), '');
    await assert.rejects(() => dni.subirDni(JPG, 'a@a.com', 'frente'), /almacenamiento privado/);
    process.env.BLOB_READ_WRITE_TOKEN = 'publico-o-viejo';
    assert.strictEqual(dni.tokenPrivado(), 'publico-o-viejo');
    process.env.BLOB_PRIVADO_READ_WRITE_TOKEN = 'privado';
    assert.strictEqual(dni.tokenPrivado(), 'privado');
  } finally { claves.forEach((k) => { if (previo[k] === undefined) delete process.env[k]; else process.env[k] = previo[k]; }); }
});
