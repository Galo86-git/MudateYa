// api/_inmobiliarias-dedupe.js
// Chequeo compartido de "¿esta inmobiliaria ya está en MudateYa?" — por email
// (mismo índice que usa /api/inmobiliarias?action=solicitar-alta para no
// duplicar altas) o por teléfono (últimos 8 dígitos, mismo índice
// inmocontacto:tel8-idx que usa Emi por WhatsApp — ver whatsapp.js). Mismo
// patrón que api/_mudanceros-dedupe.js, para que enviar-invitacion-
// inmobiliarias.js no dependa solo del email: antes de esto, una inmobiliaria
// que ya se había dado de alta con OTRO mail (o cuyo mail cambió) podía
// volver a recibir la invitación.

async function redisCall(method, args) {
  var url = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  var r = await fetch(url + '/' + method + '/' + args.map(encodeURIComponent).join('/'), {
    headers: { Authorization: 'Bearer ' + token }
  });
  var data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

// Saca todas las secuencias numéricas "tipo teléfono" de un string libre
// (puede traer varios números separados por "/", prefijos, etc.) y devuelve
// los últimos 8 dígitos de cada una.
function telefonosCandidatos(raw) {
  var out = [];
  var matches = String(raw || '').match(/\d[\d\s().-]{5,}\d/g) || [];
  matches.forEach(function (m) {
    var digits = m.replace(/\D/g, '');
    if (digits.length >= 8) out.push(digits.slice(-8));
  });
  return out;
}

// true si ya es una inmobiliaria en MudateYa (por email o por teléfono)
async function yaEsInmobiliaria(o) {
  var solicitud = await redisCall('get', ['solicitud-inmo:email:' + String(o.e || '').toLowerCase()]);
  if (solicitud) return true;
  var tels = telefonosCandidatos(o.tel);
  for (var i = 0; i < tels.length; i++) {
    var match = await redisCall('hget', ['inmocontacto:tel8-idx', tels[i]]);
    if (match) return true;
  }
  return false;
}

module.exports = { yaEsInmobiliaria: yaEsInmobiliaria, telefonosCandidatos: telefonosCandidatos };
