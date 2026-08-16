// api/admin-corregir-email-mudanza.js
//
// Fix puntual (admin): corregir el email del cliente en un pedido ya
// publicado, típicamente un typo de dominio (gmial.com, hotmial.com, etc.)
// que hace que NINGÚN mail le haya llegado nunca (presupuestos, link de
// pago, confirmaciones). No es un cron, es para correr a mano caso por caso.
//
//   GET  /api/admin-corregir-email-mudanza?token=ADMIN_TOKEN&mudanzaId=MYA-...
//     -> PREVIEW: muestra el email actual cargado. No modifica nada.
//
//   POST /api/admin-corregir-email-mudanza?token=ADMIN_TOKEN&mudanzaId=MYA-...
//        body: { "email": "nombre@gmail.com", "apply": true }
//     -> Corrige mudanza.clienteEmail y mueve el índice cliente:{email}
//        (saca el id del email viejo, lo suma al nuevo) para que "mis
//        pedidos"/aceptar cotización sigan encontrando el pedido por email.

var { esAdmin } = require('./_auth');

async function redisCall(method, ...args) {
  var url   = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  var r = await fetch(url + '/' + [method, ...args].map(encodeURIComponent).join('/'), {
    headers: { Authorization: 'Bearer ' + token }
  });
  var data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}
async function getJSON(key) {
  var v = await redisCall('GET', key);
  if (!v) return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}
// Mismo TTL que usa cotizaciones.js en cada re-save de una mudanza (180
// días) — si no lo reaplicamos acá, un SET sin EX le saca el TTL y la
// mudanza queda persistiendo para siempre en Redis.
var TTL_MUDANZA = 60 * 60 * 24 * 180;
async function setJSON(key, value, exSeconds) {
  var str = JSON.stringify(value);
  if (exSeconds) await redisCall('SET', key, str, 'EX', String(exSeconds));
  else await redisCall('SET', key, str);
}

function emailValido(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
}

module.exports = async function handler(req, res) {
  if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });

  try {
    var mudanzaId = (req.query.mudanzaId || '').trim();
    if (!mudanzaId) return res.status(400).json({ error: 'Falta mudanzaId' });

    var mudanza = await getJSON('mudanza:' + mudanzaId);
    if (!mudanza) return res.status(404).json({ error: 'Pedido no encontrado' });

    if (req.method === 'GET') {
      return res.status(200).json({
        mudanzaId: mudanzaId,
        clienteNombre: mudanza.clienteNombre || '',
        clienteEmailActual: mudanza.clienteEmail || '(vacío)',
        clienteWA: mudanza.clienteWA || '',
      });
    }

    if (req.method === 'POST') {
      var body = req.body || {};
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      var nuevoEmail = String(body.email || '').trim().toLowerCase();
      var apply = body.apply === true;

      if (!emailValido(nuevoEmail)) return res.status(400).json({ error: 'Email nuevo inválido' });
      if (!apply) return res.status(400).json({ error: 'Mandá { "email": "...", "apply": true } para aplicar.', emailActual: mudanza.clienteEmail || '(vacío)', emailPropuesto: nuevoEmail });

      var emailViejo = String(mudanza.clienteEmail || '').trim().toLowerCase();
      if (emailViejo === nuevoEmail) {
        return res.status(200).json({ ok: true, sinCambios: true, motivo: 'El email ya es ese.' });
      }

      mudanza.clienteEmail = nuevoEmail;
      await setJSON('mudanza:' + mudanzaId, mudanza, TTL_MUDANZA);

      // Mover el índice cliente:{email} (lo usa mis-pedidos/mis-cotizaciones
      // y la verificación de dueño al aceptar una cotización) — si se deja el
      // id colgado solo del email viejo, el cliente no encuentra más su
      // pedido buscando por el email correcto.
      var movido = { deEmailViejo: false, aEmailNuevo: false };
      if (emailViejo) {
        try {
          var idxViejo = (await getJSON('cliente:' + emailViejo)) || [];
          var idxViejoFiltrado = idxViejo.filter(function (x) { return x !== mudanzaId; });
          if (idxViejoFiltrado.length !== idxViejo.length) {
            await setJSON('cliente:' + emailViejo, idxViejoFiltrado, 2592000);
            movido.deEmailViejo = true;
          }
        } catch (e) { /* no bloquea el fix principal */ }
      }
      try {
        var idxNuevo = (await getJSON('cliente:' + nuevoEmail)) || [];
        if (!idxNuevo.includes(mudanzaId)) {
          idxNuevo.push(mudanzaId);
          await setJSON('cliente:' + nuevoEmail, idxNuevo, 2592000);
          movido.aEmailNuevo = true;
        }
      } catch (e) { /* no bloquea el fix principal */ }

      return res.status(200).json({
        ok: true, mudanzaId: mudanzaId,
        emailAnterior: emailViejo || '(vacío)', emailNuevo: nuevoEmail,
        indiceCliente: movido
      });
    }

    return res.status(405).json({ error: 'Método no permitido' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
