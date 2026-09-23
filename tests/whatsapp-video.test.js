// tests/whatsapp-video.test.js
// Bug real (2026-09-23, pedido muefp9tw365708): la clienta mandó un video por
// WhatsApp, el webhook lo descartaba en silencio y Emi cargó "Video adjunto
// muestra el acceso..." en el pedido. Los mudanceros cotizaron sin ver nada.
// Ahora, si llega un video, Emi recibe un aviso para decirle al cliente que no
// se puede recibir y para no cargarlo como adjunto.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { avisoVideoNoSoportado } = require('../api/whatsapp');

test('un video: aviso en singular, marcado como del sistema', () => {
  const t = avisoVideoNoSoportado(1);
  assert.match(t, /^\[Aviso del sistema/);
  assert.match(t, /un video/);
  assert.match(t, /NO se pueden recibir videos/);
});

test('varios videos: aviso en plural con la cantidad', () => {
  assert.match(avisoVideoNoSoportado(3), /3 videos/);
});

test('el aviso le pide a Emi que no lo cargue como adjunto del pedido', () => {
  assert.match(avisoVideoNoSoportado(1), /No afirmes que hay un video adjunto/);
});
