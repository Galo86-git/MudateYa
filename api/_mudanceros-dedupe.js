// api/_mudanceros-dedupe.js
// Chequeo compartido de "¿esta empresa ya es mudancero registrado en
// MudateYa?" — por email o por teléfono (últimos 8 dígitos, mismo índice
// que usa el bot de WhatsApp). Extraído de enviar-invitacion-mudanceros.js
// (2026-08-11) para que cron-seguimiento-mudanceros.js use exactamente el
// mismo criterio, sin duplicarlo.

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
// (puede traer varios números separados por "/", prefijos, "WhatsApp", etc.)
// y devuelve los últimos 8 dígitos de cada una.
function telefonosCandidatos(raw) {
  var out = [];
  var matches = String(raw || '').match(/\d[\d\s().-]{5,}\d/g) || [];
  matches.forEach(function (m) {
    var digits = m.replace(/\D/g, '');
    if (digits.length >= 8) out.push(digits.slice(-8));
  });
  return out;
}

// true si ya es mudancero registrado en MudateYa (por email o por teléfono)
async function yaEsMudancero(o) {
  var perfil = await redisCall('get', ['mudancero:perfil:' + o.e.toLowerCase()]);
  if (perfil) return true;
  var tels = telefonosCandidatos(o.tel);
  for (var i = 0; i < tels.length; i++) {
    var match = await redisCall('hget', ['mudanceros:tel8-idx', tels[i]]);
    if (match) return true;
  }
  return false;
}

module.exports = { yaEsMudancero: yaEsMudancero, telefonosCandidatos: telefonosCandidatos };
