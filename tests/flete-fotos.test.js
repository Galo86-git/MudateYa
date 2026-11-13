// En un flete la foto es obligatoria y lo hace cumplir el código (no solo el prompt de Emi).
const test = require('node:test');
const assert = require('node:assert');
const wa = require('../api/whatsapp');

const BASE = { tipo_origen: 'casa', tipo_destino: 'casa', detalles: '6 tirantes de madera de 4,25 m', hora: '10:00' };

test('flete sin fotos: falta la foto, aunque lo demás esté completo', () => {
  assert.deepStrictEqual(wa.camposCriticosFaltantes(Object.assign({ tipo: 'flete' }, BASE), []), [wa.MSJ_FALTA_FOTO_FLETE]);
  assert.deepStrictEqual(wa.camposCriticosFaltantes(Object.assign({ tipo: 'flete' }, BASE), undefined), [wa.MSJ_FALTA_FOTO_FLETE]);
  assert.deepStrictEqual(wa.camposCriticosFaltantes(Object.assign({ tipo: 'Flete' }, BASE)), [wa.MSJ_FALTA_FOTO_FLETE], 'mayúsculas y sin el argumento');
});

test('flete con al menos una foto guardada: se puede publicar', () => {
  assert.deepStrictEqual(wa.camposCriticosFaltantes(Object.assign({ tipo: 'flete' }, BASE), ['https://blob/foto1.jpg']), []);
});

test('mudanza: la foto sigue siendo opcional', () => {
  assert.deepStrictEqual(wa.camposCriticosFaltantes(Object.assign({ tipo: 'mudanza' }, BASE), []), []);
});

test('el mensaje de la foto se suma a los otros datos que faltan', () => {
  const f = wa.camposCriticosFaltantes({ tipo: 'flete', tipo_origen: 'departamento' }, []);
  assert.ok(f.includes(wa.MSJ_FALTA_FOTO_FLETE)); assert.ok(f.includes('el piso del origen'));
});
