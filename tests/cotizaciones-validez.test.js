// tests/cotizaciones-validez.test.js
// Regla de negocio (api/cotizaciones.js, DIAS_VALIDEZ_COTIZACION): una
// cotización vale 15 días CORRIDOS desde que el mudancero la emitió (subido
// de 7 a 15 el 2026-08-08). Pasado ese plazo el cliente ya no la puede
// aceptar. Bug real encontrado el 2026-08-04: el endpoint de aceptar
// bloqueaba TODO pedido vencido a las 24hs (ESTADOS_ACEPTABLES no incluía
// 'vencido_con_cotizaciones'), sin importar que la cotización individual
// siguiera vigente. Este archivo cubre la regla de validez en sí; el bug de
// ESTADOS_ACEPTABLES requeriría un test de integración contra Redis (fuera
// de alcance acá).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cotizacionVencida, DIAS_VALIDEZ_COTIZACION } = require('../api/cotizaciones');

function haceDias(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

test('DIAS_VALIDEZ_COTIZACION es 15 (el número vive en un solo lugar)', () => {
  assert.equal(DIAS_VALIDEZ_COTIZACION, 15);
});

test('una cotización de hoy no está vencida', () => {
  const cot = { fecha: haceDias(0) };
  assert.equal(cotizacionVencida(cot, {}), false);
});

test('una cotización de hace 14 días todavía no está vencida', () => {
  const cot = { fecha: haceDias(14) };
  assert.equal(cotizacionVencida(cot, {}), false);
});

test('una cotización de hace 16 días ya está vencida', () => {
  const cot = { fecha: haceDias(16) };
  assert.equal(cotizacionVencida(cot, {}), true);
});

test('sin fecha en la cotización, cae al fechaPublicacion de la mudanza', () => {
  const cot = {};
  const mudanzaVieja = { fechaPublicacion: haceDias(16) };
  const mudanzaNueva = { fechaPublicacion: haceDias(1) };
  assert.equal(cotizacionVencida(cot, mudanzaVieja), true);
  assert.equal(cotizacionVencida(cot, mudanzaNueva), false);
});

test('sin ninguna fecha disponible, no bloquea al cliente (fail-open a propósito)', () => {
  assert.equal(cotizacionVencida({}, {}), false);
});
