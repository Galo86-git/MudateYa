// api/cron-seguimiento-keller.js
// Seguimiento escalonado a los Market Centers de Keller Williams
// (api/_keller-oficinas.js, 10) — cadencia y cruce contra altas reales en
// ./_seguimiento.js: 7 días hasta el touch 3, cada 10 días de ahí en más,
// sin tope. Esta red todavía no tenía ningún recordatorio (a diferencia de
// RE/MAX y CENTURY 21) — este cron es su primer seguimiento automático.
//
// SIEMBRA: arranca desde keller-propuesta:enviados (touch 1, mandado
// 2026-08-10). No hay touch 2 previo.
//
// CRUCE CONTRA ALTA: igual que Coldwell Banker — desde 2026-08-11 el CTA de
// enviar-propuesta-keller.js manda a inmobiliarias-registro.html, así el
// Market Center se da de alta UNA vez como partner con su propio slug
// (inmobiliaria:{slug}), no cada asesor suelto. El match primario es contra
// inmobiliarias:lista (email de contacto o nombre normalizado, fuzzy).
// Además se chequea indep:asesores como FALLBACK, por si algún Market Center
// ya usó el flujo viejo (asesor-registro.html → canal "independientes",
// vigente hasta 2026-08-11) antes del cambio — así no le mandamos un
// seguimiento a alguien que ya se sumó, aunque haya sido por el camino
// anterior.
//
// COPY: touch 2 y 3 linkean al PDF que ya sirve enviar-propuesta-keller.js
// (?pdf=1) — no se regenera acá. Touch 4+ es un mail corto y espaciado.
//
// SEGURIDAD: Vercel Cron (Authorization: Bearer CRON_SECRET) o admin con
// ?token=ADMIN_TOKEN.
//   GET ?token=…              → DRY: quiénes tocan hoy y con qué touch, NO envía.
//   GET ?token=…&apply=1      → manda los toques que correspondan hoy.

const { Resend } = require('resend');
const { esAdmin, esCronVercel } = require('./_auth');
const { linkBaja } = require('./_baja');
const { elegiblesHoy, marcarEnviado, getJSON } = require('./_seguimiento');
const OFICINAS = require('./_keller-oficinas');

function esc(s) { return String(s || '').replace(/[<>&"]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]; }); }
function normOficina(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
function contieneOSonContenidos(a, b) {
  if (!a || !b) return false;
  return a.indexOf(b) !== -1 || b.indexOf(a) !== -1;
}
function objetivoDe(nombreOficina) {
  return normOficina(nombreOficina).replace(/^kw /, '').replace(/^keller williams /, '');
}

var CLAVE_ESTADO = 'keller-seguimiento:estado';
var FECHA_TOUCH1 = '2026-08-10';

var EXCLUIR = [];
var UNIVERSO = OFICINAS.filter(function (o) { return EXCLUIR.indexOf(o.e) === -1; });

// ── Primario: inmobiliaria:{slug} (alta de oficina, flujo vigente) ──
var _cacheInmos = null;
async function inmobiliariasDeAlta() {
  if (_cacheInmos) return _cacheInmos;
  var slugs = (await getJSON('inmobiliarias:lista')) || [];
  var out = [];
  for (var i = 0; i < slugs.length; i++) {
    var cfg = await getJSON('inmobiliaria:' + slugs[i]);
    if (cfg) out.push({ email: String(cfg.contactoEmail || '').toLowerCase(), nombre: normOficina(cfg.nombre) });
  }
  _cacheInmos = out;
  return out;
}
// ── Fallback: indep:asesor:{codigo}.oficina (flujo viejo, hasta 2026-08-11) ──
var _cacheIndep = null;
async function asesoresIndependientesConAlta() {
  if (_cacheIndep) return _cacheIndep;
  var ids = (await getJSON('indep:asesores')) || [];
  var out = [];
  for (var i = 0; i < ids.length; i++) {
    var a = await getJSON('indep:asesor:' + ids[i]);
    if (a && a.oficina) out.push(normOficina(a.oficina));
  }
  _cacheIndep = out;
  return out;
}
async function estaConvertido(oficina) {
  var objetivo = objetivoDe(oficina.n);
  if (!objetivo) return false;

  var inmos = await inmobiliariasDeAlta();
  var emailObjetivo = String(oficina.e || '').toLowerCase();
  for (var i = 0; i < inmos.length; i++) {
    if (inmos[i].email && inmos[i].email === emailObjetivo) return true;
    if (contieneOSonContenidos(inmos[i].nombre, objetivo)) return true;
  }

  var nombresIndep = await asesoresIndependientesConAlta();
  for (var j = 0; j < nombresIndep.length; j++) {
    if (nombresIndep[j].indexOf('keller') === -1 && nombresIndep[j].indexOf('kw') === -1) continue;
    if (contieneOSonContenidos(nombresIndep[j], objetivo)) return true;
  }
  return false;
}

function linkPDF(email) {
  return 'https://mudateya.ar/api/enviar-propuesta-keller?pdf=1&e=' + encodeURIComponent(email);
}

function emailTouch(o, touch) {
  var nm = esc(o.n || 'tu Market Center');
  var linkB = linkBaja(o.e, 'keller-seguimiento');
  var linkP = linkPDF(o.e);
  var linkRegistro = 'https://mudateya.ar/inmobiliarias-registro.html';

  var subject, introHtml, introText;
  if (touch === 2) {
    subject = nm + ': ¿le diste una vuelta a la propuesta de MudateYa?';
    introHtml = '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">Hace una semana te escribimos sobre <strong>MudateYa</strong>: un beneficio de posventa para sumar a todo el equipo de asesores de ' + nm + ', sin costo para el Market Center.</p>';
    introText = 'Hace una semana te escribimos sobre MudateYa: un beneficio de posventa para sumar a todo el equipo de asesores de ' + nm + ', sin costo para el Market Center.\n\n';
  } else if (touch === 3) {
    subject = nm + ': te mandamos de nuevo la propuesta completa';
    introHtml = '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">Te escribimos por segunda vez sobre <strong>MudateYa</strong>. Como no tuvimos noticias, te dejamos otra vez la propuesta completa en PDF por si se pasó entre tantos mails.</p>';
    introText = 'Te escribimos por segunda vez sobre MudateYa. Como no tuvimos noticias, te dejamos otra vez la propuesta completa en PDF por si se pasó entre tantos mails.\n\n';
  } else {
    subject = nm + ': seguimos disponibles si te interesa sumar a tu equipo';
    introHtml = '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">No queremos ser pesados — este es solo un recordatorio espaciado. <strong>MudateYa</strong> sigue disponible para que el equipo de ' + nm + ' lo ofrezca a sus clientes cuando les sirva.</p>';
    introText = 'No queremos ser pesados — este es solo un recordatorio espaciado. MudateYa sigue disponible para que el equipo de ' + nm + ' lo ofrezca a sus clientes cuando les sirva.\n\n';
  }

  return {
    subject: subject,
    html:
      '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">' +
        '<div style="background:#003580;padding:22px 28px;text-align:center">' +
          '<span style="font-family:Bebas Neue,Arial,sans-serif;font-size:30px;font-weight:900;letter-spacing:2px;color:#fff">MUDATE</span>' +
          '<span style="font-family:Bebas Neue,Arial,sans-serif;font-size:30px;font-weight:900;letter-spacing:2px;color:#22C36A">YA</span>' +
        '</div>' +
        '<div style="padding:28px">' +
          '<h2 style="margin:0 0 12px;color:#0F1923;font-size:20px">Hola, equipo de ' + nm + ' 👋</h2>' +
          introHtml +
          '<div style="text-align:center;margin:20px 0">' +
            '<a href="' + linkRegistro + '" style="display:inline-block;background:#22C36A;color:#fff;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none">Dar de alta el Market Center →</a>' +
          '</div>' +
          (touch >= 3 ? '<p style="text-align:center;margin:0 0 18px"><a href="' + linkP + '" style="color:#003580;font-size:13px;font-weight:600;text-decoration:underline">📄 Ver la propuesta completa en PDF →</a></p>' : '') +
          '<p style="color:#475569;font-size:13px;line-height:1.7;margin:0">Si ya lo diste de alta, ignorá este mail. Cualquier duda, respondan a este mismo mail.</p>' +
          '<p style="color:#94A3B8;font-size:11px;text-align:center;margin:16px 0 0;border-top:1px solid #E2E8F0;padding-top:16px">Recibís este correo como Market Center de Keller Williams. <a href="' + linkB + '" style="color:#94A3B8;text-decoration:underline">Darte de baja</a>.<br>MudateYa · mudateya.ar</p>' +
        '</div>' +
      '</div>',
    text:
      'Hola equipo de ' + nm + ',\n\n' + introText +
      'Dar de alta el Market Center: ' + linkRegistro + '\n\n' +
      (touch >= 3 ? 'Propuesta completa en PDF: ' + linkP + '\n\n' : '') +
      'Si ya lo diste de alta, ignorá este mail. Cualquier duda, respondan a este mismo mail.\n\n' +
      '—\nMudateYa · mudateya.ar\n' +
      'Recibís este correo como Market Center de Keller Williams. Para darte de baja: ' + linkB
  };
}

function payloadDe(o, touch) {
  var m = emailTouch(o, touch);
  var link = linkBaja(o.e, 'keller-seguimiento');
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
      touch1: (await getJSON('keller-propuesta:enviados')) || [],
      touch2: [],
      fechaTouch1: FECHA_TOUCH1
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
    console.error('Error en cron-seguimiento-keller:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
