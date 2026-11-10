// tests/ajuste-retirar.test.js
// Problema real: un ajuste de precio no se podía corregir. Si el mudancero se
// equivocaba con el monto (un cero de más), el cliente solo podía aceptarlo o
// rechazarlo, y rechazar CANCELA toda la mudanza. Ahora el mudancero puede
// retirar la propuesta mientras el cliente no respondió (retirarAjusteEnMemoria).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { retirarAjusteEnMemoria, MAX_RETIROS_AJUSTE } = require('../api/cotizaciones');

function pedido(estadoAjuste) {
  return {
    id: 'MYA-1',
    cotizacionAceptada: { mudanceroEmail: 'mud@x.com', precio: 100000 },
    ajustePrecio: estadoAjuste === null ? undefined : {
      estado: estadoAjuste, montoOriginal: 100000, montoNuevo: 1000000, motivo: 'escaleras', propuestoEn: '2026-11-01T10:00:00Z',
    },
  };
}

test('retira un ajuste pendiente: queda "retirado", suma un retiro y guarda historial', () => {
  const m = pedido('pendiente_aprobacion');
  const r = retirarAjusteEnMemoria(m, 'mud@x.com', '2026-11-01T11:00:00Z');
  assert.equal(r.ok, true);
  assert.equal(m.ajustePrecio.estado, 'retirado');
  assert.equal(m.ajustePrecio.retiros, 1);
  assert.equal(m.ajustePrecio.retiradoEn, '2026-11-01T11:00:00Z');
  assert.equal(m.ajustePrecio.historialAjustes.length, 1);
  assert.equal(m.ajustePrecio.historialAjustes[0].montoNuevo, 1000000);
});

test('un retiro NO toca el precio de la cotización aceptada', () => {
  const m = pedido('pendiente_aprobacion');
  retirarAjusteEnMemoria(m, 'mud@x.com');
  assert.equal(m.cotizacionAceptada.precio, 100000);
});

test('solo el mudancero de la cotización aceptada puede retirarlo', () => {
  const m = pedido('pendiente_aprobacion');
  const r = retirarAjusteEnMemoria(m, 'otro@x.com');
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(m.ajustePrecio.estado, 'pendiente_aprobacion');
});

test('si el cliente ya aceptó, no se puede retirar (y no se modifica nada)', () => {
  const m = pedido('aceptado');
  const r = retirarAjusteEnMemoria(m, 'mud@x.com');
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /ya aceptó/);
  assert.equal(m.ajustePrecio.estado, 'aceptado');
});

test('si el cliente ya rechazó, no se puede retirar', () => {
  const r = retirarAjusteEnMemoria(pedido('rechazado'), 'mud@x.com');
  assert.equal(r.ok, false);
  assert.match(r.error, /ya rechazó/);
});

test('retirar dos veces seguidas falla la segunda', () => {
  const m = pedido('pendiente_aprobacion');
  assert.equal(retirarAjusteEnMemoria(m, 'mud@x.com').ok, true);
  const r2 = retirarAjusteEnMemoria(m, 'mud@x.com');
  assert.equal(r2.ok, false);
  assert.match(r2.error, /ya estaba retirado/);
});

test('sin ajuste en la mudanza no hay nada que retirar', () => {
  const r = retirarAjusteEnMemoria(pedido(null), 'mud@x.com');
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('el tope de retiros por mudanza es 2', () => {
  assert.equal(MAX_RETIROS_AJUSTE, 2);
});
