// tests/webhook-mp-referencia.test.js
// Bug real (2026-09-23, pedido muefp9tw365708): María pagó la seña por MP y el
// webhook no la registró — no se avisó al mudancero. MP devuelve las claves del
// metadata en snake_case (mudanza_id) y el webhook solo leía camelCase, así que
// respondía "sin_metadata" en silencio. extraerReferencia acepta ambas formas y
// cae a external_reference.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extraerReferencia } = require('../api/webhook-mp');

test('metadata camelCase (como se carga en las preferencias)', () => {
  const r = extraerReferencia({ mudanzaId: 'MYA-1787358762716', tipoPago: 'anticipo' }, '');
  assert.deepEqual(r, { mudanzaId: 'MYA-1787358762716', tipoPago: 'anticipo' });
});

test('metadata snake_case (como la devuelve MP)', () => {
  const r = extraerReferencia({ mudanza_id: 'muefp9tw365708', tipo_pago: 'anticipo' }, '');
  assert.deepEqual(r, { mudanzaId: 'muefp9tw365708', tipoPago: 'anticipo' });
});

test('sin metadata: external_reference de crear-preferencia (pedido de WhatsApp)', () => {
  const r = extraerReferencia({}, 'muefp9tw365708-anticipo-COT-1790188252902');
  assert.deepEqual(r, { mudanzaId: 'muefp9tw365708', tipoPago: 'anticipo' });
});

test('sin metadata: external_reference de crear-preferencia (pedido web MYA-)', () => {
  const r = extraerReferencia(null, 'MYA-1787358762716-saldo-COT-1790188252902');
  assert.deepEqual(r, { mudanzaId: 'MYA-1787358762716', tipoPago: 'saldo' });
});

test('sin metadata: external_reference del flujo de mail (cotizaciones.js)', () => {
  const r = extraerReferencia(undefined, 'MYA-1787358762716-COT-1790188252902-anticipo');
  assert.deepEqual(r, { mudanzaId: 'MYA-1787358762716', tipoPago: 'anticipo' });
});

test('sin metadata: external_reference del flujo de mail con id de WhatsApp', () => {
  const r = extraerReferencia({}, 'muefp9tw365708-COT-1790188252902-anticipo');
  assert.deepEqual(r, { mudanzaId: 'muefp9tw365708', tipoPago: 'anticipo' });
});

test('el metadata manda sobre external_reference', () => {
  const r = extraerReferencia({ mudanza_id: 'AAA', tipo_pago: 'saldo' }, 'muefp9tw365708-anticipo-COT-1');
  assert.deepEqual(r, { mudanzaId: 'AAA', tipoPago: 'saldo' });
});

test('nada reconocible → vacío (el webhook alerta al equipo)', () => {
  assert.deepEqual(extraerReferencia({}, 'cualquier-cosa'), { mudanzaId: '', tipoPago: '' });
  assert.deepEqual(extraerReferencia(null, ''), { mudanzaId: '', tipoPago: '' });
});
