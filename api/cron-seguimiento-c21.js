// api/cron-seguimiento-c21.js
// Seguimiento escalonado a las oficinas CENTURY 21 independientes (no
// confundir con CENTURY 21 Nagy, que ya está de alta como asesor y quedó
// excluida a mano en _c21-oficinas.js) — cadencia y cruce contra altas
// reales en ./_seguimiento.js: 7 días hasta el touch 3, cada 10 días de ahí
// en más, sin tope.
//
// SIEMBRA: arranca desde c21-propuesta:enviados (touch 1) y
// c21-recordatorio:enviados (touch 2 — salió el mismo día, ~10 min después
// del touch 1, como segunda parte del mismo envío) — 2026-08-10 para ambos.
//
// CRUCE CONTRA ALTA: a diferencia de RE/MAX, c21.js NO valida el campo
// "oficina" contra ningún padrón — el asesor lo tipea libre (alta
// individual) o viene de un CSV que subió la propia oficina
// (c21-importar.html, alta masiva). Por eso acá el match es por
// SUBSTRING normalizado (¿el nombre de la oficina de _c21-oficinas.js
// aparece dentro de lo que tipeó el asesor, o viceversa?), no exacto —
// más laxo a propósito para no perderse altas reales por una tilde o un
// "CENTURY 21" vs "C21".
//
// COPY: touch 2 y 3 linkean al PDF que ya sirve recordatorio-c21.js — no se
// regenera acá. Touch 4+ es un mail corto y espaciado.
//
// SEGURIDAD: Vercel Cron (Authorization: Bearer CRON_SECRET) o admin con
// ?token=ADMIN_TOKEN.
//   GET ?token=…              → DRY: quiénes tocan hoy y con qué touch, NO envía.
//   GET ?token=…&apply=1      → manda los toques que correspondan hoy.

const { Resend } = require('resend');
const { esAdmin, esCronVercel } = require('./_auth');
const { linkBaja } = require('./_baja');
const { elegiblesHoy, marcarEnviado, getJSON } = require('./_seguimiento');
const OFICINAS = require('./_c21-oficinas');

function esc(s) { return String(s || '').replace(/[<>&"]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]; }); }
function chunk(arr, size) { var out = []; for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; }
function normOficina(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
function contieneOSonContenidos(a, b) {
  if (!a || !b) return false;
  return a.indexOf(b) !== -1 || b.indexOf(a) !== -1;
}

var CLAVE_ESTADO = 'c21-seguimiento:estado';
var FECHA_TOUCH1 = '2026-08-10';
var FECHA_TOUCH2 = '2026-08-10';

var EXCLUIR = []; // cargar acá a mano oficinas en charla directa 1 a 1
var UNIVERSO = OFICINAS.filter(function (o) { return EXCLUIR.indexOf(o.e) === -1; });

var _cacheAsesores = null;
async function nombresConAlta() {
  if (_cacheAsesores) return _cacheAsesores;
  var ids = (await getJSON('c21:asesores')) || [];
  var out = [];
  for (var i = 0; i < ids.length; i++) {
    var a = await getJSON('c21:asesor:' + ids[i]);
    if (a && a.oficina) out.push(normOficina(a.oficina));
  }
  _cacheAsesores = out;
  return out;
}
async function estaConvertido(oficina) {
  var nombres = await nombresConAlta();
  var objetivo = normOficina(oficina.n).replace(/^century 21 /, '');
  for (var i = 0; i < nombres.length; i++) {
    if (contieneOSonContenidos(nombres[i], objetivo)) return true;
  }
  return false;
}

function linkPDF(email) {
  return 'https://mudateya.ar/api/recordatorio-c21?pdf=1&e=' + encodeURIComponent(email);
}

function emailTouch(o, touch) {
  var nm = esc(o.n || 'tu oficina');
  var linkB = linkBaja(o.e, 'c21-seguimiento');
  var linkP = linkPDF(o.e);
  var linkRegistro = 'https://mudateya.ar/c21-registro.html';

  var subject, introHtml, introText;
  if (touch === 2) {
    subject = nm + ': ¿le diste una vuelta a la propuesta de MudateYa?';
    introHtml = '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">Hace una semana te escribimos sobre <strong>MudateYa</strong>: tus asesores pueden ofrecerle a cada comprador o inquilino una mudanza con precio cerrado y mudanceros verificados, sin costo para la oficina.</p>';
    introText = 'Hace una semana te escribimos sobre MudateYa: tus asesores pueden ofrecerle a cada comprador o inquilino una mudanza con precio cerrado y mudanceros verificados, sin costo para la oficina.\n\n';
  } else if (touch === 3) {
    subject = nm + ': te mandamos de nuevo la propuesta completa';
    introHtml = '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">Te escribimos por segunda vez sobre <strong>MudateYa</strong>. Como no tuvimos noticias, te dejamos otra vez la propuesta completa en PDF por si se pasó entre tantos mails.</p>';
    introText = 'Te escribimos por segunda vez sobre MudateYa. Como no tuvimos noticias, te dejamos otra vez la propuesta completa en PDF por si se pasó entre tantos mails.\n\n';
  } else {
    subject = nm + ': seguimos disponibles si te interesa sumar a tus asesores';
    introHtml = '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">No queremos ser pesados — este es solo un recordatorio espaciado. <strong>MudateYa</strong> sigue disponible para que tus asesores lo ofrezcan a sus clientes cuando les sirva.</p>';
    introText = 'No queremos ser pesados — este es solo un recordatorio espaciado. MudateYa sigue disponible para que tus asesores lo ofrezcan a sus clientes cuando les sirva.\n\n';
  }

  return {
    subject: subject,
    html:
      '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">' +
        '<div style="background:#252526;padding:22px 28px;border-bottom:3px solid #BEAF87">' +
          '<span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#22C36A">Ya</span>' +
          '<span style="color:#BEAF87;font-size:13px;font-weight:700;margin-left:8px">× CENTURY 21</span>' +
        '</div>' +
        '<div style="padding:28px">' +
          '<h2 style="margin:0 0 12px;color:#0F1923;font-size:20px">Hola, equipo de ' + nm + ' 👋</h2>' +
          introHtml +
          '<div style="text-align:center;margin:20px 0">' +
            '<a href="' + linkRegistro + '" style="display:inline-block;background:#22C36A;color:#fff;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none">Sumar a mis asesores →</a>' +
          '</div>' +
          (touch >= 3 ? '<p style="text-align:center;margin:0 0 18px"><a href="' + linkP + '" style="color:#003580;font-size:13px;font-weight:600;text-decoration:underline">📄 Ver la propuesta completa en PDF →</a></p>' : '') +
          '<p style="color:#475569;font-size:13px;line-height:1.7;margin:0">Si ya lo activaste, ignorá este mail. Cualquier duda, respondan a este mismo mail.</p>' +
          '<p style="color:#94A3B8;font-size:11px;text-align:center;margin:16px 0 0;border-top:1px solid #E2E8F0;padding-top:16px">Recibís este correo como oficina CENTURY 21. <a href="' + linkB + '" style="color:#94A3B8;text-decoration:underline">Darte de baja</a>.<br>MudateYa · mudateya.ar</p>' +
        '</div>' +
      '</div>',
    text:
      'Hola equipo de ' + nm + ',\n\n' + introText +
      'Sumar a mis asesores: ' + linkRegistro + '\n\n' +
      (touch >= 3 ? 'Propuesta completa en PDF: ' + linkP + '\n\n' : '') +
      'Si ya lo activaste, ignorá este mail. Cualquier duda, respondan a este mismo mail.\n\n' +
      '—\nMudateYa · mudateya.ar\n' +
      'Recibís este correo como oficina CENTURY 21. Para darte de baja: ' + linkB
  };
}

function payloadDe(o, touch) {
  var m = emailTouch(o, touch);
  var link = linkBaja(o.e, 'c21-seguimiento');
  return {
    from: 'MudateYa <contacto@mudateya.ar>', to: o.e, subject: m.subject, html: m.html, text: m.text,
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
      touch1: (await getJSON('c21-propuesta:enviados')) || [],
      touch2: (await getJSON('c21-recordatorio:enviados')) || [],
      fechaTouch1: FECHA_TOUCH1,
      fechaTouch2: FECHA_TOUCH2
    };

    var res1 = await elegiblesHoy({ clave: CLAVE_ESTADO, universo: UNIVERSO, semilla: semilla, estaConvertido: estaConvertido });
    var elegibles = res1.elegibles;
    var estado = res1.estado;

    if (!apply) {
      return res.status(200).json({
        ok: true, dry: true,
        universo: UNIVERSO.length,
        elegiblesHoy: elegibles.length,
        muestra: elegibles.slice(0, 10).map(function (x) { return { oficina: x.candidato.n, email: x.candidato.e, proximoTouch: x.proximoTouch }; })
      });
    }

    var resumen = { enviados: 0, errores: 0, fallidos: [] };
    async function _enviarUno(x) {
      var r1 = await resend.emails.send(payloadDe(x.candidato, x.proximoTouch));
      if (r1 && r1.error) throw new Error(typeof r1.error === 'string' ? r1.error : JSON.stringify(r1.error));
    }
    var hayBatch = !!(resend.batch && typeof resend.batch.send === 'function');
    var grupos = chunk(elegibles, 100);
    for (var g = 0; g < grupos.length; g++) {
      var unoAUno = !hayBatch;
      if (hayBatch) {
        try {
          var rb = await resend.batch.send(grupos[g].map(function (x) { return payloadDe(x.candidato, x.proximoTouch); }));
          if (rb && rb.error) throw new Error(typeof rb.error === 'string' ? rb.error : JSON.stringify(rb.error));
          for (var b = 0; b < grupos[g].length; b++) { await marcarEnviado(CLAVE_ESTADO, estado, grupos[g][b].candidato.e, grupos[g][b].proximoTouch); resumen.enviados++; }
        } catch (eb) {
          resumen.fallidos.push({ lote: g, modo: 'batch', error: eb.message });
          unoAUno = true;
        }
      }
      if (unoAUno) {
        for (var q = 0; q < grupos[g].length; q++) {
          var x = grupos[g][q];
          try { await _enviarUno(x); await marcarEnviado(CLAVE_ESTADO, estado, x.candidato.e, x.proximoTouch); resumen.enviados++; }
          catch (e2) { resumen.errores++; resumen.fallidos.push({ email: x.candidato.e, error: e2.message }); }
          await new Promise(function (ok) { setTimeout(ok, 130); });
        }
      }
    }
    return res.status(200).json({ ok: true, aplicado: true, batchDisponible: hayBatch, ...resumen });
  } catch (e) {
    console.error('Error en cron-seguimiento-c21:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
