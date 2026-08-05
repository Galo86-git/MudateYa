// tests/habiles.test.js
// Regla de negocio: el pedido queda abierto 24 HORAS HÁBILES para cotizar
// (no 24hs corridas) — el reloj se pausa fines de semana y feriados. Ver
// api/_habiles.js para la definición completa. Estos casos replican los
// ejemplos documentados en el header de ese archivo, más el caso real
// verificado a mano el 2026-08-04 (pedido MYA publicado un domingo).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sumarHorasHabiles, esDiaHabil, aHoraAR } = require('../api/_habiles');

test('publicado domingo → el reloj arranca el lunes 00:00 y vence el martes 00:00 (caso real verificado)', () => {
  // Domingo 2026-08-02, 01:32 ART (04:32 UTC) — mismo caso que el pedido real
  // "Guise 1600" que se cerró el 2026-08-04.
  const desde = new Date('2026-08-02T04:32:26.305Z');
  const vence = sumarHorasHabiles(desde, 24);
  assert.equal(vence.toISOString(), '2026-08-04T03:00:00.000Z'); // martes 00:00 ART
});

test('publicado un miércoles a media mañana → vence 24hs hábiles después, el jueves a la misma hora', () => {
  // Miércoles 2026-08-05, 10:00 ART (13:00 UTC) — ni fin de semana ni feriado de por medio.
  const desde = new Date('2026-08-05T13:00:00.000Z');
  const vence = sumarHorasHabiles(desde, 24);
  assert.equal(vence.toISOString(), '2026-08-06T13:00:00.000Z'); // jueves misma hora
});

test('publicado viernes → vence el lunes a la misma hora (fin de semana no cuenta)', () => {
  // Viernes 2026-07-31, 12:00 ART (15:00 UTC).
  const desde = new Date('2026-07-31T15:00:00.000Z');
  const vence = sumarHorasHabiles(desde, 24);
  assert.equal(vence.toISOString(), '2026-08-03T15:00:00.000Z'); // lunes misma hora
});

// esDiaHabil espera una fecha YA desplazada a hora argentina (aHoraAR) — así
// se usa internamente en sumarHorasHabiles. Los tests replican ese uso.
test('esDiaHabil: sábado y domingo no son hábiles', () => {
  assert.equal(esDiaHabil(aHoraAR(new Date('2026-08-01T15:00:00.000Z'))), false); // sábado
  assert.equal(esDiaHabil(aHoraAR(new Date('2026-08-02T15:00:00.000Z'))), false); // domingo
});

test('esDiaHabil: un feriado nacional cargado en la tabla no es hábil', () => {
  assert.equal(esDiaHabil(aHoraAR(new Date('2026-05-25T15:00:00.000Z'))), false); // Revolución de Mayo
});

test('esDiaHabil: un día de semana común es hábil', () => {
  assert.equal(esDiaHabil(aHoraAR(new Date('2026-08-05T15:00:00.000Z'))), true); // miércoles común
});
