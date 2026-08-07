// api/asesor-baja.js
//
// Baja de UN asesor de los mails MASIVOS a asesores (recordatorio semanal de
// los lunes, resumen de los viernes) — es el target del header
// List-Unsubscribe que llevan esos mails (ver cron-asesores-semanal.js).
// Gmail/Yahoo lo pesan mucho para no mandar a spam, y a partir de cierto
// volumen lo exigen.
//
// NO afecta la cuenta de asesor en sí: sigue pudiendo cotizar, recibir
// clientes por su link, cobrar su comisión y usar Emi con normalidad — a
// propósito NO toca `activo` (ese campo lo usa resolverAsesor() en
// cotizaciones.js para las notificaciones REALES de sus clientes referidos).
// Marca un campo aparte, `suprimidoMasivos:true`, que recolectarDestinatarios()
// (cron-asesores-semanal.js) filtra — deja de recibir SOLO estos 2 mails.
//
// GET  → click manual desde el mail: muestra una página de confirmación.
// POST → one-click de Gmail/Yahoo (RFC 8058, List-Unsubscribe-Post), sin
//        interacción del usuario — misma validación, sin body de respuesta.
//
// Firma: HMAC-SHA256(prefijo:codigo, ADMIN_TOKEN), primeros 24 hex del
// resultado. Mismo secreto que ya usa _auth.js para los tokens de sesión de
// admin, pero este endpoint NO da acceso admin: la firma solo autoriza
// apagar `activo` de ESE asesor puntual, nada más.

var crypto = require('crypto');

async function redisCall(method, ...args) {
  var url = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  var r = await fetch(url + '/' + [method, ...args].map(encodeURIComponent).join('/'), {
    headers: { Authorization: 'Bearer ' + token },
  });
  var d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}
async function getJSON(key) {
  var v = await redisCall('GET', key);
  return v ? JSON.parse(v) : null;
}
async function setJSON(key, value) {
  await redisCall('SET', key, JSON.stringify(value));
}
function firmar(prefijo, codigo) {
  var secreto = process.env.ADMIN_TOKEN || '';
  return crypto.createHmac('sha256', secreto).update(prefijo + ':' + codigo).digest('hex').slice(0, 24);
}
function igualSeguro(a, b) {
  try {
    var ba = Buffer.from(String(a));
    var bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch (e) { return false; }
}

var PREFIJOS_VALIDOS = ['remax', 'c21', 'mudafy', 'indep'];

module.exports = async function handler(req, res) {
  var canal = String((req.query && req.query.canal) || '');
  var codigo = String((req.query && req.query.codigo) || '');
  var sig = String((req.query && req.query.sig) || '');
  var esPost = req.method === 'POST';

  if (PREFIJOS_VALIDOS.indexOf(canal) === -1 || !codigo || !igualSeguro(sig, firmar(canal, codigo))) {
    if (esPost) return res.status(400).end();
    return res.status(400).send('Link inválido o vencido. Escribinos a hola@mudateya.ar y te damos de baja a mano.');
  }

  try {
    var key = canal + ':asesor:' + codigo;
    var a = await getJSON(key);
    if (a) {
      // OJO: NO tocar `a.activo` — ese campo lo usa resolverAsesor() en
      // cotizaciones.js para decidir si le avisa sus notificaciones REALES
      // (comisión pagada, cliente que reservó, etc.). Si un asesor se da de
      // baja del mail semanal, tiene que seguir enterándose de eso — usa un
      // campo aparte, solo leído por recolectarDestinatarios().
      a.suprimidoMasivos = true;
      await setJSON(key, a);
    }
  } catch (e) {
    console.error('asesor-baja:', e.message);
    if (esPost) return res.status(500).end();
    return res.status(500).send('Hubo un problema dándote de baja. Escribinos a hola@mudateya.ar y lo hacemos a mano.');
  }

  if (esPost) return res.status(200).end(); // one-click Gmail/Yahoo, sin body

  return res.status(200).send(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Baja — MudateYa</title>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
    '<body style="font-family:Arial,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#0F1923;padding:0 20px">' +
    '<h2 style="margin:0 0 12px">Listo, te dimos de baja</h2>' +
    '<p style="color:#475569;font-size:15px;line-height:1.6">No vas a recibir más estos recordatorios por mail. Seguís pudiendo usar tu link y recibir clientes con total normalidad.</p>' +
    '</body></html>'
  );
};
