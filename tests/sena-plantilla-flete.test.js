// tests/sena-plantilla-flete.test.js
// El aviso "ganaste un pedido" al mudancero decía "Mudanza:" también en fletes.
// Se creó mudancero_elegido_flete ("Flete:") aparte, sin tocar la existente:
// editar una plantilla aprobada la borra al instante y deja el aviso sin
// plantilla hasta que Meta re-aprueba. Regla: el flete usa la nueva SOLO si ya
// está aprobada; si no, sigue con mudancero_elegido. Nunca queda sin plantilla.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const plantillasPath = require.resolve('../api/_plantillas');
const { avisarSenaConfirmada } = require('../api/_whatsapp');

async function nombresUsados(mudanza, statusFlete) {
  const usadas = [];
  const original = require.cache[plantillasPath];
  require.cache[plantillasPath] = {
    id: plantillasPath, filename: plantillasPath, loaded: true,
    exports: {
      resolver: async (nombre) => (nombre === 'mudancero_elegido_flete' && statusFlete ? { sid: 'HXfake', status: statusFlete } : null),
      enviarPlantilla: async (to, nombre) => { usadas.push(nombre); return { enviado: true, via: 'plantilla' }; },
    },
  };
  try {
    await avisarSenaConfirmada(mudanza);
  } finally {
    if (original) require.cache[plantillasPath] = original; else delete require.cache[plantillasPath];
  }
  return usadas.filter((n) => n.startsWith('mudancero_elegido'));
}

function pedido(tipo) {
  return {
    id: 'muefp9tw365708', tipo, desde: 'San Fernando', hasta: 'Beccar', fecha: '2026-09-28',
    clienteNombre: 'Maria', clienteWA: '+5491144060640',
    cotizacionAceptada: { mudanceroNombre: 'TRANSPORTE PANISA SRL', mudanceroTel: '+5491140454154', mudanceroEmail: 'contacto@transpanisa.com' },
  };
}

test('flete con la plantilla nueva aprobada → usa mudancero_elegido_flete', async () => {
  assert.deepEqual(await nombresUsados(pedido('flete'), 'approved'), ['mudancero_elegido_flete']);
});

test('flete con la plantilla nueva pendiente → sigue con mudancero_elegido', async () => {
  assert.deepEqual(await nombresUsados(pedido('flete'), 'pending'), ['mudancero_elegido']);
});

test('flete con la plantilla nueva inexistente → sigue con mudancero_elegido', async () => {
  assert.deepEqual(await nombresUsados(pedido('flete'), null), ['mudancero_elegido']);
});

test('mudanza → siempre mudancero_elegido, aunque la de flete esté aprobada', async () => {
  assert.deepEqual(await nombresUsados(pedido('mudanza'), 'approved'), ['mudancero_elegido']);
});
