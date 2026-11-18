// El comentario del pedido no debe traer cuántas fotos "adjuntó" el cliente:
// ese número lo escribía Emi contando lo que se MANDÓ, y no coincidía con las
// fotos realmente guardadas (tope de 6, o fotos que fallaron al subir).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { quitarConteoFotos } = require('../api/whatsapp');

test('saca "N fotos adjuntas" del final del comentario', () => {
  assert.equal(
    quitarConteoFotos('Sillón en L, bicicleta fija y Vespa. Sube a planta alta en destino. 8 fotos adjuntas.'),
    'Sillón en L, bicicleta fija y Vespa. Sube a planta alta en destino.'
  );
});

test('saca "Fotos adjuntas: N"', () => {
  assert.equal(quitarConteoFotos('Heladera y lavarropas. Fotos adjuntas: 3'), 'Heladera y lavarropas.');
});

test('saca el singular', () => {
  assert.equal(quitarConteoFotos('1 foto adjunta y un sillón'), 'y un sillón');
});

test('no toca el resto del texto ni menciones de fotos sin conteo', () => {
  assert.equal(quitarConteoFotos('Tengo fotos del sillón'), 'Tengo fotos del sillón');
});

test('vacío o nulo devuelve lo mismo', () => {
  assert.equal(quitarConteoFotos(''), '');
  assert.equal(quitarConteoFotos(null), null);
});
