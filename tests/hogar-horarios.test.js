// Horario de cada profesional y a quién se le avisa un pedido de la gestión de MYA (api/_hogar-reglas.js).
const test = require('node:test');
const assert = require('node:assert');
const r = require('../api/_hogar-reglas');

const D = (iso) => new Date(iso);
// Fechas de la semana del martes 10/11/2026 (hora Argentina = UTC-3).
const AR = (dia, hh, mm) => new Date(Date.UTC(2026, 10, dia, hh + 3, mm || 0));   // AR(10, 10, 0) = martes 10/11 10:00 hora AR

const T = (d, h) => ({ d, h });
const SEMANA = (lv, sab, dom) => ({ lun: lv, mar: lv, mie: lv, jue: lv, vie: lv, sab: sab || [], dom: dom || [] });
const PARTIDO = SEMANA([T('08:00', '12:00'), T('15:00', '19:00')], [T('08:00', '13:00')]);   // corta al mediodía
const DIA_COMPLETO = SEMANA([T('00:00', '24:00')], [T('00:00', '24:00')], [T('00:00', '24:00')]); // 24 horas, todos los días
const NOCTURNO = SEMANA([T('19:00', '23:00')]);                                                  // trabaja de noche

test('validarHorario: acepta horarios libres y rechaza los mal armados', () => {
  assert.deepStrictEqual(r.validarHorario(PARTIDO), { ok: true, errores: [] });
  assert.strictEqual(r.validarHorario(DIA_COMPLETO).ok, true, '24 horas = 00:00 a 24:00');
  assert.strictEqual(r.validarHorario(NOCTURNO).ok, true);
  const mal = (h, texto) => { const v = r.validarHorario(h); assert.strictEqual(v.ok, false, texto); assert.ok(v.errores.some((e) => e.includes(texto)), texto + ' → ' + JSON.stringify(v.errores)); };
  mal(Object.assign({}, PARTIDO, { lun: [T('08:00', '12:00'), T('11:00', '14:00')] }), 'se pisan');
  mal(Object.assign({}, PARTIDO, { lun: [T('12:00', '08:00')] }), 'termina antes de empezar');
  mal(Object.assign({}, PARTIDO, { lun: [T('8', '12:00')] }), 'hora inválida');
  mal(Object.assign({}, PARTIDO, { lun: [T('08:00', '25:00')] }), 'hora inválida');
  mal(Object.assign({}, PARTIDO, { lun: [T('06:00', '08:00'), T('09:00', '11:00'), T('12:00', '14:00')] }), 'hasta 2 tramos');
  const sinDomingo = Object.assign({}, PARTIDO); delete sinDomingo.dom;
  mal(sinDomingo, 'falta el día');
  assert.strictEqual(r.validarHorario(null).ok, false);
});

test('"lo antes posible": le llega solo a quien está disponible AHORA según su horario', () => {
  const ahora = (dia, hh, mm) => r.disponibleAhora(PARTIDO, AR(dia, hh, mm));
  assert.strictEqual(ahora(10, 10, 0), true, 'martes 10:00, dentro del tramo de la mañana');
  assert.strictEqual(ahora(10, 8, 0), true, 'justo al empezar');
  assert.strictEqual(ahora(10, 7, 59), false, 'un minuto antes de empezar');
  assert.strictEqual(ahora(10, 13, 0), false, 'cortó al mediodía');
  assert.strictEqual(ahora(10, 15, 30), true, 'tramo de la tarde');
  assert.strictEqual(ahora(10, 18, 30), true, 'le quedan 30 minutos');
  assert.strictEqual(ahora(10, 18, 31), false, 'le quedan menos de 30 minutos: no se le avisa');
  assert.strictEqual(ahora(14, 9, 0), true, 'sábado dentro de su horario'); // 14/11 sábado
  assert.strictEqual(ahora(14, 14, 0), false, 'sábado después de las 13');
  assert.strictEqual(ahora(15, 10, 0), false, 'domingo no atiende');
  // 24 horas: siempre disponible, de madrugada también
  for (const [d, h, m] of [[10, 3, 15], [14, 23, 40], [15, 0, 5]]) assert.strictEqual(r.disponibleAhora(DIA_COMPLETO, AR(d, h, m)), true, `${d} ${h}:${m}`);
  // un tramo que termina a las 24:00 sigue al día siguiente si ese día arranca a las 00:00; si no, se corta
  const hastaMedianoche = SEMANA([T('18:00', '24:00')]);
  assert.strictEqual(r.disponibleAhora(hastaMedianoche, AR(10, 23, 20)), true, 'le quedan 40 minutos');
  assert.strictEqual(r.disponibleAhora(hastaMedianoche, AR(10, 23, 40)), false, 'le quedan 20 minutos y el día siguiente no arranca a las 00:00');
  assert.strictEqual(r.atiendeHoy(DIA_COMPLETO, AR(10, 23, 50)), true);
  // de noche, quien trabaja de noche sí; quien trabaja de día no
  assert.strictEqual(r.disponibleAhora(NOCTURNO, AR(10, 21, 0)), true);
  assert.strictEqual(r.disponibleAhora(PARTIDO, AR(10, 21, 0)), false);
});

test('día + franja: se avisa a quien tiene ese día un tramo que se cruce con la franja', () => {
  const f = (h, ymd, franja) => r.disponibleEnFranja(h, ymd, franja);
  // martes 2026-11-10 y sábado 2026-11-14
  assert.strictEqual(f(PARTIDO, '2026-11-10', 'manana'), true, '8-12 se cruza con 8-13');
  assert.strictEqual(f(PARTIDO, '2026-11-10', 'tarde'), true, '15-19 se cruza con 13-18');
  assert.strictEqual(f(PARTIDO, '2026-11-14', 'manana'), true);
  assert.strictEqual(f(PARTIDO, '2026-11-14', 'tarde'), false, 'el sábado corta a las 13');
  assert.strictEqual(f(PARTIDO, '2026-11-15', 'manana'), false, 'domingo no atiende');
  assert.strictEqual(f(NOCTURNO, '2026-11-10', 'manana'), false); assert.strictEqual(f(NOCTURNO, '2026-11-10', 'tarde'), false, 'de 19 a 23 no cubre la tarde (13 a 18)');
  assert.strictEqual(f(DIA_COMPLETO, '2026-11-15', 'tarde'), true);
  // cruce mínimo de 30 minutos
  const justo = SEMANA([T('12:30', '14:00')]);
  assert.strictEqual(f(justo, '2026-11-10', 'manana'), true, '12:30-13:00 = 30 min de cruce');
  assert.strictEqual(f(SEMANA([T('12:45', '14:00')]), '2026-11-10', 'manana'), false, '15 min de cruce no alcanza');
  assert.strictEqual(f(PARTIDO, 'mañana', 'manana'), false); assert.strictEqual(f(PARTIDO, '2026-11-10', 'noche'), false);
});

test('"Atiende hoy" (filtro de la página del cliente)', () => {
  assert.strictEqual(r.atiendeHoy(PARTIDO, AR(10, 9, 0)), true);
  assert.strictEqual(r.atiendeHoy(PARTIDO, AR(10, 13, 0)), true, 'todavía le queda la tarde');
  assert.strictEqual(r.atiendeHoy(PARTIDO, AR(10, 18, 40)), false, 'ya casi termina su día');
  assert.strictEqual(r.atiendeHoy(PARTIDO, AR(15, 10, 0)), false, 'domingo');
  assert.strictEqual(r.atiendeHoy(DIA_COMPLETO, AR(15, 23, 0)), true);
});

test('cumpleAgenda: une los dos casos de lo que guarda Emi en el pedido', () => {
  assert.strictEqual(r.cumpleAgenda(PARTIDO, { asap: true, txt: 'Lo antes posible' }, AR(10, 10, 0)), true);
  assert.strictEqual(r.cumpleAgenda(PARTIDO, { asap: true }, AR(10, 13, 30)), false);
  assert.strictEqual(r.cumpleAgenda(PARTIDO, { fecha: '2026-11-14', txt: 'sábado 14/11', franja: 'tarde' }, AR(10, 10, 0)), false);
  assert.strictEqual(r.cumpleAgenda(PARTIDO, { fecha: '2026-11-14', txt: 'sábado 14/11', franja: 'manana' }, AR(10, 10, 0)), true);
  assert.strictEqual(r.cumpleAgenda(PARTIDO, null, AR(10, 10, 0)), false);
});

test('cuántos profesionales reciben un pedido (ejemplo con 4 profesionales, martes 10 a las 20:00)', () => {
  const pros = { partido: PARTIDO, completo: DIA_COMPLETO, nocturno: NOCTURNO, mananero: SEMANA([T('06:00', '14:00')]) };
  const reciben = (agenda, ahora) => Object.keys(pros).filter((k) => r.cumpleAgenda(pros[k], agenda, ahora)).sort();
  const noche = AR(10, 20, 0);
  assert.deepStrictEqual(reciben({ asap: true }, noche), ['completo', 'nocturno'], 'de noche: los de 24 h y los nocturnos');
  assert.deepStrictEqual(reciben({ asap: true }, AR(10, 9, 0)), ['completo', 'mananero', 'partido'], 'a la mañana: los de día');
  assert.deepStrictEqual(reciben({ fecha: '2026-11-11', franja: 'tarde' }, noche), ['completo', 'mananero', 'partido'], 'mañana a la tarde (el de 6 a 14 se cruza 1 hora con la tarde)');
});
