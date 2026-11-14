// Búsqueda de un country / barrio cerrado por nombre en Google Maps (api/_geo.js → buscarLugares), con Google simulado.
const test = require('node:test');
const assert = require('node:assert');
const geo = require('../api/_geo');

const fetchOriginal = global.fetch;
const claveOriginal = process.env.GOOGLE_MAPS_API_KEY;
test.afterEach(() => { global.fetch = fetchOriginal; if (claveOriginal === undefined) delete process.env.GOOGLE_MAPS_API_KEY; else process.env.GOOGLE_MAPS_API_KEY = claveOriginal; });

const resultado = (formatted, localidad, provincia, tipos) => ({
  formatted_address: formatted, types: tipos || ['neighborhood', 'political'],
  address_components: [
    { long_name: localidad, types: ['locality', 'political'] },
    { long_name: provincia, types: ['administrative_area_level_1', 'political'] },
  ],
});
const googleResponde = (json) => { process.env.GOOGLE_MAPS_API_KEY = 'x'; global.fetch = async () => ({ json: async () => json }); };

test('un nombre que se repite devuelve varios candidatos distintos, con localidad y provincia, para que elija el cliente', async () => {
  googleResponde({ status: 'OK', results: [
    resultado('Santa Bárbara, Benavídez, Buenos Aires', 'Benavídez', 'Buenos Aires'),
    resultado('Santa Bárbara, Pilar, Buenos Aires', 'Pilar', 'Buenos Aires'),
    resultado('Santa Bárbara, Benavídez, Buenos Aires', 'Benavídez', 'Buenos Aires'),   // repetido: se descarta
    resultado('Santa Bárbara, Córdoba', 'Córdoba', 'Córdoba'),
  ] });
  const r = await geo.buscarLugares('Santa Bárbara');
  assert.strictEqual(r.ok, true); assert.strictEqual(r.lugares.length, 3);
  assert.deepStrictEqual(r.lugares.map((l) => l.localidad), ['Benavídez', 'Pilar', 'Córdoba']);
  assert.strictEqual(r.lugares[0].provincia, 'Buenos Aires');
});

test('hasta 5 candidatos; un solo resultado; ninguno', async () => {
  googleResponde({ status: 'OK', results: Array.from({ length: 9 }, (_, i) => resultado('Lugar ' + i, 'Loc ' + i, 'Prov')) });
  assert.strictEqual((await geo.buscarLugares('Lugar')).lugares.length, 5);
  googleResponde({ status: 'OK', results: [resultado('Los Álamos, Pilar', 'Pilar', 'Buenos Aires')] });
  assert.strictEqual((await geo.buscarLugares('Los Álamos')).lugares.length, 1);
  googleResponde({ status: 'ZERO_RESULTS', results: [] });
  assert.deepStrictEqual(await geo.buscarLugares('No existe'), { ok: true, lugares: [] });
});

test('sin clave, sin nombre o con error de Google: ok:false (Emi sigue pidiendo la localidad al cliente)', async () => {
  delete process.env.GOOGLE_MAPS_API_KEY;
  assert.strictEqual((await geo.buscarLugares('Santa Bárbara')).ok, false);
  googleResponde({ status: 'OK', results: [] });
  assert.strictEqual((await geo.buscarLugares('  ')).ok, false);
  googleResponde({ status: 'REQUEST_DENIED', results: [] });
  assert.strictEqual((await geo.buscarLugares('Santa Bárbara')).ok, false);
  process.env.GOOGLE_MAPS_API_KEY = 'x'; global.fetch = async () => { throw new Error('red caída'); };
  assert.strictEqual((await geo.buscarLugares('Santa Bárbara')).ok, false);
});
