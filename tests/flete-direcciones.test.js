// Las direcciones de origen y destino tienen que ser EXACTAS y figurar en Google Maps, sin excepciones
// (countries y barrios cerrados se aceptan por nombre, sin calle y número, pero también tienen que figurar en Google Maps). Lo exige el código, no solo el prompt de Emi.
const test = require('node:test');
const assert = require('node:assert');
const geo = require('../api/_geo');
const wa = require('../api/whatsapp');

// Google simulado: decide según el texto.
let respuestaGoogle = null;
const original = geo.geocodificar;
test.before(() => { geo.geocodificar = async (dir) => (typeof respuestaGoogle === 'function' ? respuestaGoogle(String(dir)) : respuestaGoogle); });
test.after(() => { geo.geocodificar = original; });

const OK = { ok: true, existe: true, completa: true };
const INCOMPLETA = { ok: true, existe: true, completa: false };
const NO_EXISTE = { ok: false, existe: false, motivo: 'no_encontrada' };
const SIN_RESPUESTA = { ok: false, motivo: 'sin_key' };

test('texto: calle y número válidos; ciudad, barrio o zona sin número, no', () => {
  for (const d of ['Obispo Salguero 750, CABA', 'Av. Mitre 4144, Caseros', 'Libertador 1234 piso 3', '25 de Mayo 1234']) assert.strictEqual(wa.textoConCalleYNumero(d), true, d);
  for (const d of ['Cipolletti, Río Negro', 'Palermo', 'Caseros', 'zona norte', '', null, undefined, 'mi casa']) assert.strictEqual(wa.textoConCalleYNumero(d), false, String(d));
});

test('el pedido de Felipe Moreno (CABA → Cipolletti) se rechaza por el destino, y explica qué falta', async () => {
  respuestaGoogle = OK;
  const f = await wa.direccionesInexactas({ origen: 'Obispo Salguero 750, CABA', destino: 'Cipolletti, Río Negro' });
  assert.strictEqual(f.length, 1); assert.match(f[0], /destino/); assert.match(f[0], /calle y número/);
});

test('origen y destino completos y en Google: no falta nada; si faltan los dos, avisa los dos', async () => {
  respuestaGoogle = OK;
  assert.deepStrictEqual(await wa.direccionesInexactas({ origen: 'Av. Mitre 4144, Caseros', destino: 'W. de Tata 4425, Caseros' }), []);
  const f = await wa.direccionesInexactas({ origen: 'Palermo', destino: 'Cipolletti' });
  assert.strictEqual(f.length, 2); assert.match(f[0], /origen/); assert.match(f[1], /destino/);
});

test('si no figura en Google Maps no se toma el pedido: ni inexistente ni incompleta', async () => {
  respuestaGoogle = NO_EXISTE;
  let f = await wa.direccionesInexactas({ origen: 'Av. Mitre 4144, Caseros', destino: 'Calle Inventada 999, Caseros' });
  assert.strictEqual(f.length, 2); assert.match(f[0], /no existe en Google Maps/);
  respuestaGoogle = INCOMPLETA;                              // existe la zona pero no la calle con ese número (p. ej. una ruta)
  f = await wa.direccionesInexactas({ origen: 'Ruta 8 km 52, Pilar', destino: 'Av. Mitre 4144, Caseros' });
  assert.strictEqual(f.length, 2); assert.match(f[0], /no figura completa en Google Maps/); assert.match(f[0], /dirección aproximada cercana/);
});

test('excepción: countries y barrios cerrados se aceptan por nombre (sin calle y número), pero TIENEN que figurar en Google Maps', async () => {
  const lugares = ['Country Los Cardales, Exaltación de la Cruz', 'Barrio cerrado Los Álamos, Pilar', 'Club de Campo La Martona', 'Barrio privado San Matías, Escobar'];
  const destinoOk = 'Av. Mitre 4144, Caseros';
  for (const g of [OK, INCOMPLETA]) {                         // Google lo reconoce (aunque no traiga calle y número): alcanza
    respuestaGoogle = (dir) => (/Mitre/.test(dir) ? OK : g);
    for (const d of lugares) assert.deepStrictEqual(await wa.direccionesInexactas({ origen: d, destino: destinoOk }), [], d + ' / ' + JSON.stringify(g));
  }
  respuestaGoogle = (dir) => (/Mitre/.test(dir) ? OK : NO_EXISTE);   // Google NO lo ubica: no se toma el pedido
  for (const d of lugares) {
    const f = await wa.direccionesInexactas({ origen: d, destino: destinoOk });
    assert.strictEqual(f.length, 1, d); assert.match(f[0], /origen/); assert.match(f[0], /country o barrio cerrado/); assert.match(f[0], /no figura en Google Maps/);
  }
  respuestaGoogle = OK;
  const f = await wa.direccionesInexactas({ origen: 'Barrio Norte', destino: destinoOk });   // "Barrio Norte" es un barrio común, no un barrio cerrado
  assert.strictEqual(f.length, 1); assert.match(f[0], /origen/);
});

test('si Google no responde (sin clave, caído o lento) no se frena un pedido con calle y número', async () => {
  respuestaGoogle = SIN_RESPUESTA;
  assert.deepStrictEqual(await wa.direccionesInexactas({ origen: 'Av. Mitre 4144, Caseros', destino: 'W. de Tata 4425, Caseros' }), []);
  respuestaGoogle = () => new Promise((r) => setTimeout(() => r(OK), 6000));   // más lento que el límite de 4 s
  const t0 = Date.now();
  assert.deepStrictEqual(await wa.direccionesInexactas({ origen: 'Av. Mitre 4144, Caseros', destino: 'W. de Tata 4425, Caseros' }), []);
  assert.ok(Date.now() - t0 < 12000);
  // aun sin Google, ciudad sin número se rechaza
  respuestaGoogle = SIN_RESPUESTA;
  assert.strictEqual((await wa.direccionesInexactas({ origen: 'Av. Mitre 4144, Caseros', destino: 'Cipolletti, Río Negro' })).length, 1);
});

test('"barrio Santa Barbarita" a secas se rechaza y Emi recibe cómo seguir; cargado como barrio cerrado y ubicado en Google, se acepta', async () => {
  respuestaGoogle = OK;
  let f = await wa.direccionesInexactas({ origen: 'Diego Palma 306, Villa Ballester', destino: 'barrio Santa Barbarita' });
  assert.strictEqual(f.length, 1); assert.match(f[0], /destino/); assert.match(f[0], /Barrio cerrado <nombre>, <localidad>/);
  respuestaGoogle = (dir) => (/Santa B/.test(dir) ? INCOMPLETA : OK);    // Google ubica el barrio pero sin calle y número
  assert.deepStrictEqual(await wa.direccionesInexactas({ origen: 'Diego Palma 306, Villa Ballester', destino: 'Barrio cerrado Santa Bárbara, Tigre' }), []);
  respuestaGoogle = (dir) => (/Santa B/.test(dir) ? NO_EXISTE : OK);     // Google no lo ubica: no se toma
  f = await wa.direccionesInexactas({ origen: 'Diego Palma 306, Villa Ballester', destino: 'Barrio cerrado Santa Bárbara, Tigre' });
  assert.strictEqual(f.length, 1); assert.match(f[0], /no figura en Google Maps/);
});

test('el resumen para confirmar incluye la distancia y las fotos; la nota obliga a decir los km y a no inventar precios', () => {
  const input = { tipo: 'flete', origen: 'Diego Palma 306, San Isidro', destino: 'Barrio cerrado Pacheco Golf, General Pacheco', fecha: '2026-11-14', hora: '15:00', detalles: 'Heladera Drean 314L con Freezer' };
  const r = wa.armarResumenPedido(input, 58.4, 2);
  assert.match(r, /Distancia aproximada por ruta: 58 km/); assert.match(r, /Fotos adjuntas: 2/); assert.match(r, /Heladera Drean/);
  assert.doesNotMatch(wa.armarResumenPedido(input, 0, 0), /Distancia|Fotos adjuntas/, 'sin km ni fotos no se inventa nada');
  assert.match(wa.textoKm(58.4), /58 km/); assert.match(wa.textoKm(58.4), /NO inventes ni estimes ningún precio/); assert.strictEqual(wa.textoKm(0), '');
});
