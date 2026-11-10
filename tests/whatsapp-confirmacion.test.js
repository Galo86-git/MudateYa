// tests/whatsapp-confirmacion.test.js
// Acciones de Emi sin marcha atrás (proponer ajuste, completar mudanza,
// aceptar/rechazar ajuste) se confirman en DOS pasos, forzado en código: el
// primer paso no ejecuta nada y devuelve un resumen; el segundo solo vale si
// la persona contestó en un mensaje POSTERIOR y la cita aparece en él.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pedirConfirmacion, confirmacionValida } = require('../api/whatsapp');

const ACCION = 'proponer_ajuste';
const CLAVE = 'MYA-1|480000';

test('el primer paso devuelve un resumen y NO ejecuta nada', () => {
  const conv = { nTurnos: 3 };
  const r = pedirConfirmacion(conv, ACCION, CLAVE, 'Vas a cambiar el precio a $480.000');
  assert.equal(r.requiere_confirmacion, true);
  assert.equal(r.ejecutado, false);
  assert.match(r.resumen, /480\.000/);
  assert.equal(conv.confirmPendiente.accion, ACCION);
});

test('confirmar en el MISMO turno no vale (el modelo no puede autoconfirmarse)', () => {
  const conv = { nTurnos: 3 };
  pedirConfirmacion(conv, ACCION, CLAVE, 'x');
  assert.equal(confirmacionValida(conv, ACCION, CLAVE, 'si', 'si'), false);
});

test('confirmar en un turno POSTERIOR con la cita en el mensaje vale', () => {
  const conv = { nTurnos: 3 };
  pedirConfirmacion(conv, ACCION, CLAVE, 'x');
  conv.nTurnos = 4;
  assert.equal(confirmacionValida(conv, ACCION, CLAVE, 'Sí, confirmo', 'Sí, confirmo!'), true);
});

test('la cita tiene que estar en el mensaje actual', () => {
  const conv = { nTurnos: 3 };
  pedirConfirmacion(conv, ACCION, CLAVE, 'x');
  conv.nTurnos = 4;
  assert.equal(confirmacionValida(conv, ACCION, CLAVE, 'sí confirmo', 'esperá, dejame pensarlo'), false);
});

test('una cita corta no matchea por casualidad dentro de otra palabra', () => {
  const conv = { nTurnos: 3 };
  pedirConfirmacion(conv, ACCION, CLAVE, 'x');
  conv.nTurnos = 4;
  // "si" está dentro de "simple" pero no es la palabra "si"
  assert.equal(confirmacionValida(conv, ACCION, CLAVE, 'si', 'es muy simple de hacer'), false);
});

test('si cambian los datos (otro monto), la confirmación anterior no sirve', () => {
  const conv = { nTurnos: 3 };
  pedirConfirmacion(conv, ACCION, CLAVE, 'x');
  conv.nTurnos = 4;
  assert.equal(confirmacionValida(conv, ACCION, 'MYA-1|4800000', 'si', 'si'), false);
});

test('si es otra acción, no sirve', () => {
  const conv = { nTurnos: 3 };
  pedirConfirmacion(conv, ACCION, CLAVE, 'x');
  conv.nTurnos = 4;
  assert.equal(confirmacionValida(conv, 'completar_mudanza', CLAVE, 'si', 'si'), false);
});

test('sin un resumen previo no hay nada que confirmar', () => {
  assert.equal(confirmacionValida({ nTurnos: 4 }, ACCION, CLAVE, 'si', 'si'), false);
});

test('una confirmación vencida (más de 30 minutos) no vale', () => {
  const conv = { nTurnos: 3 };
  pedirConfirmacion(conv, ACCION, CLAVE, 'x');
  conv.nTurnos = 4;
  conv.confirmPendiente.ts = Date.now() - 31 * 60 * 1000;
  assert.equal(confirmacionValida(conv, ACCION, CLAVE, 'si', 'si'), false);
});

test('cita vacía no vale', () => {
  const conv = { nTurnos: 3 };
  pedirConfirmacion(conv, ACCION, CLAVE, 'x');
  conv.nTurnos = 4;
  assert.equal(confirmacionValida(conv, ACCION, CLAVE, '', 'si'), false);
});
