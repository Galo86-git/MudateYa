// api/avisar-moderacion-contacto.js
//
// Aviso GENERAL a todos los mudanceros activos sobre la limpieza de fotos/
// descripciones con teléfono o email de contacto (ver moderar-fotos-mudanceros.js
// y moderar-contacto-mudanceros.js). Se manda a TODOS y no solo a los afectados
// porque no quedó un registro preciso de a quién le tocó en la primera pasada
// manual — mejor avisar de más que dejar a alguien sin saber por qué le
// falta una foto. Admin-only.
//
//   GET  /api/avisar-moderacion-contacto?token=ADMIN_TOKEN
//     -> PREVIEW: cuenta a cuántos mudanceros activos les mandaría el aviso. No manda nada.
//
//   POST /api/avisar-moderacion-contacto?token=ADMIN_TOKEN   { "apply": true }
//     -> Manda el mail a todos los mudanceros con estado != 'rechazado'.

var { esAdmin } = require('./_auth');
const { redisPipeline } = require('./_ia');
const { Resend } = require('resend');

async function redisCall(method, ...args) {
  var url   = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  var response = await fetch(
    url + '/' + [method, ...args].map(encodeURIComponent).join('/'),
    { headers: { Authorization: 'Bearer ' + token } }
  );
  var data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}
async function getJSON(key) {
  var val = await redisCall('GET', key);
  if (!val) return null;
  try { return JSON.parse(val); } catch (e) { return null; }
}

async function mandarAviso(perfil) {
  if (!process.env.RESEND_API_KEY) return false;
  var resend = new Resend(process.env.RESEND_API_KEY);
  var primerNombre = (perfil.nombre || '').split(' ')[0] || 'Hola';
  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
    to: perfil.email,
    subject: 'Aviso: revisión de fotos y descripciones en MudateYa',
    html:
      '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">' +
      '<div style="background:#003580;padding:20px 28px">' +
        '<span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#fff">Mudate</span>' +
        '<span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#22C36A">Ya</span>' +
      '</div>' +
      '<div style="padding:28px">' +
        '<h2 style="margin:0 0 10px;color:#0F1923;font-size:20px">Hola, ' + primerNombre + '</h2>' +
        '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 16px">Te escribimos porque hicimos una revisión general de fotos (perfil y vehículo) y descripciones de todos los mudanceros. Si alguna mostraba un teléfono o email de contacto, la sacamos — no lo permitimos porque los clientes tienen que contactarte siempre a través de MudateYa, nunca directo.</p>' +
        '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 16px">Este mail les llega a todos los mudanceros, no solo a los que tuvieron algo sacado. Si no te tocó nada, no tenés que hacer nada.</p>' +
        '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 20px">Si notás que te falta una foto o que tu descripción quedó corta, entrá a tu cuenta y volvela a completar (sin datos de contacto).</p>' +
        '<div style="text-align:center;margin:20px 0">' +
          '<a href="https://mudateya.ar/mi-cuenta" style="display:inline-block;background:#22C36A;color:#003580;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:14px">Revisar mi perfil →</a>' +
        '</div>' +
        '<p style="color:#94A3B8;font-size:11px;margin:0">¿Preguntas? Escribinos a <a href="mailto:hola&#64;mudateya.ar" style="color:#1A6FFF;font-weight:600">hola&#64;mudateya.ar</a></p>' +
      '</div>' +
      '</div>',
  });
  return true;
}

module.exports = async function handler(req, res) {
  if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });

  try {
    var emails = (await getJSON('mudanceros:todos')) || [];
    var perfiles = [];
    for (var off = 0; off < emails.length; off += 100) {
      var lote = emails.slice(off, off + 100);
      var vals = await redisPipeline(lote.map(function (e) { return ['GET', 'mudancero:perfil:' + e]; }));
      vals.forEach(function (v) { if (v) { try { perfiles.push(JSON.parse(v)); } catch (e) {} } });
    }
    var activos = perfiles.filter(function (p) { return p && p.estado !== 'rechazado'; });

    if (req.method === 'GET') {
      return res.status(200).json({ totalMudanceros: perfiles.length, seLeMandaria: activos.length });
    }

    if (req.method === 'POST') {
      var apply = !!(req.body && req.body.apply === true);
      if (!apply) return res.status(400).json({ error: 'Mandá { "apply": true } para enviar los mails.', seLeMandaria: activos.length });

      var enviados = [];
      for (var i = 0; i < activos.length; i++) {
        try {
          var ok = await mandarAviso(activos[i]);
          if (ok) enviados.push(activos[i].email);
        } catch (e) { console.warn('Aviso moderación ' + activos[i].email + ':', e.message); }
      }
      return res.status(200).json({ ok: true, total: enviados.length, enviados: enviados });
    }

    return res.status(405).json({ error: 'Método no permitido' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
