// La ventana para cotizar nunca pasa de X horas antes de la fecha y hora de inicio del trabajo.
const test = require('node:test');
const assert = require('node:assert');
const { limitarAlInicio, inicioTrabajo, vencimientoHabilISO } = require('../api/_habiles');

const AR = (y, m, d, hh, mm) => new Date(Date.UTC(y, m - 1, d, hh + 3, mm || 0));   // hora Argentina (UTC-3)
const iso = (d) => d.toISOString();

test('inicio del trabajo en hora argentina; sin hora se asume 9:00; fechas inválidas = sin tope', () => {
  assert.strictEqual(iso(inicioTrabajo('2026-11-15', '15:30')), iso(AR(2026, 11, 15, 15, 30)));
  assert.strictEqual(iso(inicioTrabajo('2026-11-15', '')), iso(AR(2026, 11, 15, 9, 0)));
  assert.strictEqual(inicioTrabajo('mañana', '10:00'), null); assert.strictEqual(inicioTrabajo('', ''), null); assert.strictEqual(inicioTrabajo('2026-13-40', '10:00'), null);
});

test('caso real (Yoselin): publicado sábado 14/11 05:30 para el domingo 15/11; antes vencía el martes 00:00, ahora 3 hs antes del inicio', () => {
  const ahora = AR(2026, 11, 14, 5, 30);
  const normal = vencimientoHabilISO(24, ahora);
  assert.strictEqual(iso(new Date(normal)), iso(AR(2026, 11, 17, 0, 0)), 'el reloj hábil no corre el fin de semana: vencía martes 00:00');
  assert.strictEqual(limitarAlInicio(normal, '2026-11-15', '10:00', ahora), iso(AR(2026, 11, 15, 7, 0)), 'domingo 10:00 menos 3 hs');
});

test('caso real (Ruben): publicado viernes 13/11 17:07 para el sábado 14/11 10:00', () => {
  const ahora = AR(2026, 11, 13, 17, 7);
  const r = limitarAlInicio(vencimientoHabilISO(24, ahora), '2026-11-14', '10:00', ahora);
  assert.strictEqual(r, iso(AR(2026, 11, 14, 7, 0)));
});

test('si la ventana normal ya termina antes del tope, no se toca', () => {
  const ahora = AR(2026, 11, 10, 15, 0);                                        // martes
  const normal = vencimientoHabilISO(24, ahora);                                // miércoles 15:00
  assert.strictEqual(limitarAlInicio(normal, '2026-11-20', '10:00', ahora), normal);
  const urgente = iso(new Date(ahora.getTime() + 3 * 3600000));                 // ventana urgente de 3 hs, trabajo mañana
  assert.strictEqual(limitarAlInicio(urgente, '2026-11-11', '18:00', ahora), urgente);
});

test('si el trabajo es tan pronto que el tope ya pasó, quedan al menos 1 hora para cotizar', () => {
  const ahora = AR(2026, 11, 10, 14, 0);
  const r = limitarAlInicio(vencimientoHabilISO(24, ahora), '2026-11-10', '15:00', ahora);   // arranca en 1 hora, tope = 12:00 (ya pasó)
  assert.strictEqual(r, iso(AR(2026, 11, 10, 15, 0)), 'ahora + 1 hora');
});

test('X horas configurable con COTIZAR_HASTA_HS_ANTES; fecha inválida no cambia nada', () => {
  const ahora = AR(2026, 11, 10, 8, 0);
  const normal = vencimientoHabilISO(24, ahora);
  process.env.COTIZAR_HASTA_HS_ANTES = '12';
  try { assert.strictEqual(limitarAlInicio(normal, '2026-11-11', '09:00', ahora), iso(AR(2026, 11, 10, 21, 0)), '12 hs antes del miércoles 09:00'); }
  finally { delete process.env.COTIZAR_HASTA_HS_ANTES; }
  assert.strictEqual(limitarAlInicio(normal, 'algún día', '09:00', ahora), normal);
});
