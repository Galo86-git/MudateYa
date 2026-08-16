// api/cron-recordar-contenido-asesores.js
//
// Aviso de los DOMINGOS a Galo (ADMIN_EMAIL) para revisar el mail que sale
// mañana a los asesores/inmobiliarias (cron-asesores-semanal.js, lunes 9am
// ARG). Corre los domingos 19:00 hora Argentina (22:00 UTC) — schedule
// "0 22 * * 0" en vercel.json.
//
// QUÉ HACE (reusa el contenido/template de cron-asesores-semanal.js, no lo
// duplica):
//   - Si YA hay contenido cargado en CONTENIDO_SEMANAS para el lunes que
//     viene: manda a ADMIN_EMAIL el mismo mail, con un banner arriba que
//     avisa que es una vista previa. Así se puede revisar contenido/diseño
//     antes de que salga en vivo.
//   - Si NO hay contenido cargado todavía: manda un aviso corto de que el
//     cron de mañana no va a mandar nada (varianteSemana() en
//     cron-asesores-semanal.js se frena sola si no hay entrada esa semana).
//
// Esto NO le manda nada a ningún asesor ni inmobiliaria real — es
// exclusivamente un aviso interno a ADMIN_EMAIL.
//
// SEGURIDAD: mismo esquema que el resto de los crons —
//   1. Header de Vercel Cron, o
//   2. ?token=ADMIN_TOKEN (para probar/disparar a mano).
// MODOS DE PRUEBA (solo con ?token=ADMIN_TOKEN):
//   ?dry=1  → no manda nada, devuelve qué mandaría (hay contenido o no, y la semana ISO calculada).

const { Resend } = require('resend');
const base = require('./cron-asesores-semanal');
const { numeroSemanaISO, CONTENIDO_SEMANAS, emailRecordatorio, redisCall } = base;

function fechaAR() {
  var ahora = new Date();
  var ar = new Date(ahora.getTime() - 180 * 60 * 1000);
  return ar.getUTCFullYear() + '-' +
    String(ar.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(ar.getUTCDate()).padStart(2, '0');
}

// Fecha DD/MM del lunes que viene, para el asunto/banner del mail.
function fechaCorta(d) {
  return String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

// El lunes más próximo hacia adelante, en hora ARG. Pensado para correr un
// domingo (da mañana), pero es robusto si se dispara a mano otro día: nunca
// devuelve HOY como "el lunes que viene" (si hoy ya es lunes, apunta al de
// la semana siguiente).
function proximoLunesAR() {
  var ahora = new Date();
  var ar = new Date(ahora.getTime() - 180 * 60 * 1000);
  var dow = ar.getUTCDay(); // 0=domingo..6=sábado, ya en hora AR
  var diasHastaLunes = ((1 - dow) + 7) % 7;
  if (diasHastaLunes === 0) diasHastaLunes = 7;
  return new Date(ar.getTime() + diasHastaLunes * 24 * 60 * 60 * 1000);
}

module.exports = async function handler(req, res) {
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    return res.status(200).json({ ok: true, skipped: true, reason: 'no-production-env', env: process.env.VERCEL_ENV });
  }

  var esVercelCron = require('./_auth').esCronVercel(req);
  var esAdmin      = require('./_auth').esAdmin(req);
  if (!esVercelCron && !esAdmin) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  var adminMail = process.env.ADMIN_EMAIL;
  if (!process.env.RESEND_API_KEY || !adminMail) {
    return res.status(500).json({ error: 'Falta RESEND_API_KEY o ADMIN_EMAIL' });
  }

  var esDry = req.query && req.query.dry === '1';

  try {
    var lunes = proximoLunesAR();
    var semanaISO = numeroSemanaISO(lunes);
    var hayContenido = !!CONTENIDO_SEMANAS[semanaISO];
    var fechaLunes = fechaCorta(lunes);

    if (esDry) {
      return res.status(200).json({ ok: true, dry: true, semanaISO: semanaISO, fechaLunes: fechaLunes, hayContenido: hayContenido });
    }

    // Idempotencia: una marca por domingo (mismo patrón que los otros crons
    // de este archivo) — si Vercel reintenta, no duplica el aviso.
    var claveSemana = 'admin:preview-asesores:' + fechaAR();
    var marca = await redisCall('set', [claveSemana, new Date().toISOString(), 'EX', '1296000', 'NX']);
    if (marca !== 'OK') {
      return res.status(200).json({ ok: true, skipped: true, reason: 'ya-avisado-este-domingo', clave: claveSemana });
    }

    var resend = new Resend(process.env.RESEND_API_KEY);

    if (!hayContenido) {
      await resend.emails.send({
        from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
        to: adminMail,
        subject: '⚠️ Falta cargar el contenido de asesores para mañana (' + fechaLunes + ')',
        html: '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">' +
          '<p style="color:#0F1923;font-size:15px;line-height:1.7">Todavía no cargaste el contenido de <code>CONTENIDO_SEMANAS</code> (semana ISO ' + semanaISO + ') para el mail de asesores/inmobiliarias de mañana lunes ' + fechaLunes + '.</p>' +
          '<p style="color:#475569;font-size:14px;line-height:1.7">Si no se carga antes de las 9:00 ARG, <strong>el cron de mañana no manda nada</strong> — se frena solo, sin avisar a nadie.</p>' +
          '</div>'
      });
      return res.status(200).json({ ok: true, enviado: 'sin-contenido', semanaISO: semanaISO, fechaLunes: fechaLunes });
    }

    var mail = emailRecordatorio('Asesor de prueba', null, null);
    var htmlConBanner =
      '<div style="max-width:560px;margin:0 auto 16px;background:#FFF7E6;border:1px solid #FCD34D;border-radius:10px;padding:14px 18px;font-family:Arial,sans-serif">' +
        '<div style="font-size:13px;font-weight:700;color:#92400E">👀 Vista previa — esto sale mañana ' + fechaLunes + ' a las 9:00 ARG a TODOS los asesores/inmobiliarias.</div>' +
        '<div style="font-size:12px;color:#92400E;margin-top:4px">El link/CTA de este preview no es real (no está atribuido a nadie). Si algo está mal, corregí <code>CONTENIDO_SEMANAS</code> (semana ' + semanaISO + ') en cron-asesores-semanal.js antes de las 9:00.</div>' +
      '</div>' + mail.html;

    await resend.emails.send({
      from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
      to: adminMail,
      subject: '👀 Preview: mail de asesores de mañana (' + fechaLunes + ') — ' + mail.subject,
      html: htmlConBanner
    });

    return res.status(200).json({ ok: true, enviado: 'preview', semanaISO: semanaISO, fechaLunes: fechaLunes });
  } catch (e) {
    console.error('Error en cron-recordar-contenido-asesores:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
