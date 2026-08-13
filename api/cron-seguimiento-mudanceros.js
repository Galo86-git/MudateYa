// api/cron-seguimiento-mudanceros.js
// Seguimiento escalonado a las empresas de mudanza/fletes invitadas en frío
// por enviar-invitacion-mudanceros.js (api/_mudanceros-prospectos.js) —
// cadencia y cruce contra altas reales en ./_seguimiento.js: 7 días hasta
// el touch 3, cada 10 días de ahí en más, sin tope.
//
// SIEMBRA: arranca desde invitacion-mudanceros:enviados (touch 1). Esa
// lista se fue armando en varias tandas con fechas distintas (~26 el
// 2026-08-08, +92 y +65 el 2026-08-10) y no se guardó la fecha por email —
// por eso, a diferencia de REMAX/C21, acá NO se fuerza una fecha de siembra:
// el reloj del touch 2 arranca desde el día en que este cron corre por
// primera vez para cada empresa (más tarde de lo estrictamente exacto, pero
// nunca manda un toque de más ni antes de tiempo).
//
// CRUCE CONTRA ALTA: reusa exactamente el mismo chequeo que
// enviar-invitacion-mudanceros.js (./_mudanceros-dedupe.js — por email o por
// teléfono, últimos 8 dígitos, mismo índice que el bot de WhatsApp).
//
// COPY: mismo layout y CTA (/mudanceros) que la invitación original. Touch 2
// y 3 insisten un poco más en el beneficio; touch 4+ es un mail corto y
// espaciado.
//
// SEGURIDAD: Vercel Cron (Authorization: Bearer CRON_SECRET) o admin con
// ?token=ADMIN_TOKEN. A diferencia de enviar-invitacion-mudanceros.js (que
// es siempre manual a propósito), ESTE cron sí conviene tener en
// vercel.json: solo toca a quien ya está en la lista y venció su plazo, así
// que correrlo todos los días es seguro e idempotente.
//   GET ?token=…              → DRY: quiénes tocan hoy y con qué touch, NO envía.
//   GET ?token=…&apply=1      → manda los toques que correspondan hoy.

const { Resend } = require('resend');
const { esAdmin, esCronVercel } = require('./_auth');
const { linkBaja } = require('./_baja');
const { elegiblesHoy, marcarEnviado, getJSON } = require('./_seguimiento');
const { yaEsMudancero } = require('./_mudanceros-dedupe');
const { PROSPECTOS, REGION_TEXTO } = require('./_mudanceros-prospectos');

function esc(s) { return String(s || '').replace(/[<>&"]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]; }); }

var CLAVE_ESTADO = 'mudanceros-seguimiento:estado';

var EXCLUIR = [];
var UNIVERSO = PROSPECTOS.filter(function (o) { return EXCLUIR.indexOf(o.e) === -1; });

async function estaConvertido(o) { return yaEsMudancero(o); }

function emailTouch(o, touch) {
  var nm = esc(o.n || 'equipo');
  var linkB = linkBaja(o.e, 'mudanceros-seguimiento');
  var zona = esc((o.zona && o.zona.trim()) || REGION_TEXTO[o.region] || o.region || 'tu zona');
  var linkRegistro = 'https://mudateya.ar/mudanceros';

  var subject, introHtml, introText;
  if (touch === 2) {
    subject = nm + ': seguís sin estar en la red de MudateYa';
    introHtml = '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">La semana pasada te invitamos a sumarte como mudancero verificado en <strong>MudateYa</strong>. Todos los días publicamos mudanzas y fletes en ' + zona + ' — sumarte no tiene costo y los pedidos te llegan directo por WhatsApp.</p>';
    introText = 'La semana pasada te invitamos a sumarte como mudancero verificado en MudateYa. Todos los días publicamos mudanzas y fletes en ' + zona + ' — sumarte no tiene costo y los pedidos te llegan directo por WhatsApp.\n\n';
  } else if (touch === 3) {
    subject = nm + ': última chance de esta tanda para sumarte sin costo';
    introHtml = '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">Te escribimos por segunda vez. Mientras tanto, otros mudanceros de ' + zona + ' ya están recibiendo pedidos a través de <strong>MudateYa</strong>. Sumarte sigue sin costo.</p>';
    introText = 'Te escribimos por segunda vez. Mientras tanto, otros mudanceros de ' + zona + ' ya están recibiendo pedidos a través de MudateYa. Sumarte sigue sin costo.\n\n';
  } else {
    subject = nm + ': seguimos con lugar para vos en ' + zona;
    introHtml = '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">No queremos ser pesados — este es solo un recordatorio espaciado. <strong>MudateYa</strong> sigue sumando mudanceros verificados en ' + zona + ' cuando te sirva.</p>';
    introText = 'No queremos ser pesados — este es solo un recordatorio espaciado. MudateYa sigue sumando mudanceros verificados en ' + zona + ' cuando te sirva.\n\n';
  }

  return {
    subject: subject,
    html:
      '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">' +
        '<div style="background:#003580;padding:22px 28px;text-align:center">' +
          '<span style="font-family:Arial Black,Arial,sans-serif;font-size:28px;font-weight:900;letter-spacing:2px;color:#fff">MUDATE</span>' +
          '<span style="font-family:Arial Black,Arial,sans-serif;font-size:28px;font-weight:900;letter-spacing:2px;color:#22C36A">YA</span>' +
        '</div>' +
        '<div style="padding:28px">' +
          '<h2 style="margin:0 0 12px;color:#0F1923;font-size:20px">Hola, equipo de ' + nm + ' 👋</h2>' +
          introHtml +
          '<div style="text-align:center;margin:20px 0">' +
            '<a href="' + linkRegistro + '" style="display:inline-block;background:#22C36A;color:#fff;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none">Sumarme como mudancero →</a>' +
          '</div>' +
          '<p style="color:#475569;font-size:13px;line-height:1.7;margin:0">Si ya te sumaste, ignorá este mail. Si preferís que no te contactemos más, respondé y te sacamos de la lista.</p>' +
          '<p style="color:#94A3B8;font-size:11px;text-align:center;margin:16px 0 0;border-top:1px solid #E2E8F0;padding-top:16px">Recibís este correo porque tu empresa figura como mudancero/fletero en tu zona. <a href="' + linkB + '" style="color:#94A3B8;text-decoration:underline">Darte de baja</a>.<br>MudateYa · hola@mudateya.ar · mudateya.ar</p>' +
        '</div>' +
      '</div>',
    text:
      'Hola equipo de ' + nm + ',\n\n' + introText +
      'Sumarme como mudancero: ' + linkRegistro + '\n\n' +
      'Si ya te sumaste, ignorá este mail. Si preferís que no te contactemos más, respondé y te sacamos de la lista.\n\n' +
      '—\nMudateYa · hola@mudateya.ar · mudateya.ar\n' +
      'Para darte de baja: ' + linkB
  };
}

function payloadDe(o, touch) {
  var m = emailTouch(o, touch);
  var link = linkBaja(o.e, 'mudanceros-seguimiento');
  return {
    from: 'MudateYa <hola@mudateya.ar>', to: o.e, subject: m.subject, html: m.html, text: m.text,
    headers: { 'List-Unsubscribe': '<' + link + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
  };
}

module.exports = async function handler(req, res) {
  var esVercelCron = false;
  try { esVercelCron = esCronVercel(req); } catch (e) {}
  if (esVercelCron && process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    return res.status(200).json({ ok: true, skipped: true, reason: 'no-production-env' });
  }
  if (!esVercelCron && !esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
  if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY no configurado' });

  var resend = new Resend(process.env.RESEND_API_KEY);
  var apply = esVercelCron || (req.query && req.query.apply === '1');

  try {
    var semilla = {
      touch1: (await getJSON('invitacion-mudanceros:enviados')) || [],
      touch2: []
      // Sin fechaTouch1 a propósito — ver comentario del header.
    };

    var res1 = await elegiblesHoy({ clave: CLAVE_ESTADO, universo: UNIVERSO, semilla: semilla, estaConvertido: estaConvertido });
    var elegibles = res1.elegibles;
    var estado = res1.estado;

    if (!apply) {
      return res.status(200).json({
        ok: true, dry: true,
        universo: UNIVERSO.length,
        elegiblesHoy: elegibles.length,
        muestra: elegibles.slice(0, 10).map(function (x) { return { empresa: x.candidato.n, email: x.candidato.e, proximoTouch: x.proximoTouch }; })
      });
    }

    var resumen = { enviados: 0, errores: 0, fallidos: [] };
    for (var i = 0; i < elegibles.length; i++) {
      var x = elegibles[i];
      try {
        var r1 = await resend.emails.send(payloadDe(x.candidato, x.proximoTouch));
        if (r1 && r1.error) throw new Error(typeof r1.error === 'string' ? r1.error : JSON.stringify(r1.error));
        await marcarEnviado(CLAVE_ESTADO, estado, x.candidato.e, x.proximoTouch);
        resumen.enviados++;
      } catch (e2) {
        resumen.errores++;
        resumen.fallidos.push({ email: x.candidato.e, error: e2.message });
      }
      await new Promise(function (ok) { setTimeout(ok, 130); });
    }
    return res.status(200).json({ ok: true, aplicado: true, ...resumen });
  } catch (e) {
    console.error('Error en cron-seguimiento-mudanceros:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
