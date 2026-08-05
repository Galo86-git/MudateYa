// api/baja.js
// Baja (unsubscribe) de un clic para las campañas de email de MudateYa.
// Al abrir el link (GET) o al POST de "one-click" de Gmail/Outlook, agrega el
// email a la lista de suprimidos en Redis (SET "baja:emails"). Los envíos
// consultan esa lista y saltean a los suprimidos.
//
// URL:  /api/baja?e={email}&c={campaña}&s={firma}
// La firma la genera api/_baja.js (HMAC) — si no coincide, no hace nada.

var { firmar } = require('./_baja');

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

function pagina(titulo, mensaje, ok) {
  var color = ok ? '#22C36A' : '#EF4444';
  var icono = ok ? '✓' : '×';
  return '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<title>' + titulo + ' · MudateYa</title></head>' +
    '<body style="font-family:Arial,sans-serif;background:#F5F7FA;margin:0;padding:0;display:flex;min-height:100vh;align-items:center;justify-content:center">' +
    '<div style="background:#fff;border:1px solid #E2E8F0;border-radius:16px;padding:40px 32px;max-width:420px;text-align:center;box-shadow:0 8px 24px rgba(15,25,35,.06)">' +
      '<div style="font-size:22px;font-weight:900;letter-spacing:1px;margin-bottom:20px"><span style="color:#003580">MUDATE</span><span style="color:#22C36A">YA</span></div>' +
      '<div style="width:56px;height:56px;border-radius:50%;background:' + color + ';color:#fff;font-size:30px;line-height:56px;margin:0 auto 16px">' + icono + '</div>' +
      '<h1 style="font-size:19px;color:#0F1923;margin:0 0 10px">' + titulo + '</h1>' +
      '<p style="font-size:14px;color:#475569;line-height:1.6;margin:0">' + mensaje + '</p>' +
    '</div></body></html>';
}

module.exports = async function handler(req, res) {
  var q = req.query || {};
  var email = String(q.e || '').toLowerCase().trim();
  var firma = String(q.s || '');
  var campania = String(q.c || '');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!email || !firma || firma !== firmar(email)) {
    // Link inválido o adulterado: no damos de baja a nadie.
    res.status(400).send(pagina('Link inválido', 'Este link de baja no es válido. Si querés dejar de recibir correos, respondé el último mail que te enviamos.', false));
    return;
  }

  try {
    await redisCall('sadd', ['baja:emails', email]);
    // Guardamos un pequeño registro (campaña) para métricas, sin bloquear si falla.
    try { await redisCall('hset', ['baja:detalle', email, campania || 'directo']); } catch (e) {}
    res.status(200).send(pagina('Listo, te diste de baja', 'No vas a recibir más correos de MudateYa a <strong>' + email + '</strong>. Si fue un error, escribinos a contacto@mudateya.ar.', true));
  } catch (e) {
    console.error('Error en /api/baja:', e.message);
    res.status(500).send(pagina('Ups, algo falló', 'No pudimos procesar la baja ahora. Probá de nuevo en un rato o escribinos a contacto@mudateya.ar.', false));
  }
};
