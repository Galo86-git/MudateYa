// tests/match-mudanceros.test.js
// Regla de negocio: el matching de zona tiene que reconocer coberturas
// nacionales ("Toda Argentina", "todo el país", etc.) como comodín — si no,
// un mudancero que declaró cobertura nacional nunca recibe pedidos fuera de
// su zona base. Bug real encontrado con un mudancero (Premier Moving) el
// 2026-08-04: "Toda Argentina" se reducía a la palabra "toda" (la lista de
// stopwords descartaba "argentina") y nunca coincidía con nada.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { coincideZona, palabrasZona } = require('../api/match-mudanceros');

test('coincideZona: matchea por nombre de zona literal', () => {
  const cobertura = 'CABA, GBA Norte (San Isidro, Vicente López)';
  const palabras = palabrasZona('Retiro CABA hasta San Isidro');
  assert.equal(coincideZona(cobertura, palabras), true);
});

test('coincideZona: NO matchea una zona no declarada, sin comodín', () => {
  const cobertura = 'CABA, GBA Norte (San Isidro, Vicente López)';
  const palabras = palabrasZona('Zárate hasta Campana');
  assert.equal(coincideZona(cobertura, palabras), false);
});

test('coincideZona: "Toda Argentina" matchea cualquier zona (comodín nacional)', () => {
  const cobertura = 'GBA Norte (San Isidro, Vicente López, etc.) Toda Argentina';
  const palabras = palabrasZona('Retiro CABA hasta Zárate');
  assert.equal(coincideZona(cobertura, palabras), true);
});

test('coincideZona: variantes de comodín nacional también matchean', () => {
  const palabras = palabrasZona('Ushuaia hasta La Quiaca');
  assert.equal(coincideZona('Cobertura: todo el país', palabras), true);
  assert.equal(coincideZona('Trabajamos a nivel nacional', palabras), true);
  assert.equal(coincideZona('Cubrimos todas las zonas', palabras), true);
});

test('coincideZona: la palabra "argentina" sola (no la frase completa) NO activa el comodín', () => {
  // Ej: alguien puso solo el país en un campo de dirección, no una declaración
  // de cobertura nacional — no debería activar el comodín por accidente.
  const cobertura = 'Buenos Aires, Argentina';
  const palabras = palabrasZona('Zárate hasta Campana');
  assert.equal(coincideZona(cobertura, palabras), false);
});
