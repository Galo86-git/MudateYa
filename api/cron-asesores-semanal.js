// api/cron-asesores-semanal.js
//
// Recordatorio SEMANAL a los asesores de CANAL (Remax, C21, Mudafy,
// Independientes). Corre todos los lunes 09:00 hora Argentina (12:00 UTC) —
// schedule "0 12 * * 1" en vercel.json.
//
// A cada asesor le manda su LINK EXCLUSIVO de cotización ya existente:
//   https://mudateya.ar/inmobiliaria/{canal}?asesor={codigo}
// No se inventa ningún link: se usa el codigo propio de cada asesor.
//
// QUIÉN NO RECIBE (por decisión de producto):
//   - Asesores del registro genérico (indice asesores:todos): no tienen link
//     de cotización, así que quedan afuera.
//   - Aliados (programa de referidos de edificios): otro circuito.
//
// IDEMPOTENCIA: al arrancar setea una marca en Redis por semana (SET ... NX).
// Si el cron corre dos veces el mismo lunes (reintento de Vercel), la segunda
// vez ve la marca y no manda nada. La marca expira sola a los 15 días.
// Además se deduplica por email (si un asesor está en dos canales, un solo mail).
//
// SEGURIDAD: el endpoint solo se ejecuta si:
//   1. Llega del Vercel Cron (header x-vercel-cron === '1'), o
//   2. Se llama manualmente con ?token=ADMIN_TOKEN (para probar).
//
// MODOS DE PRUEBA (solo con ?token=ADMIN_TOKEN):
//   ?dry=1            → NO envía nada; devuelve a cuántos y a quiénes les llegaría
//                       (con el canal y el link de cada uno).
//   ?test=mail@x.com  → envía UN solo mail de muestra a esa dirección y corta.
//                       Si ese mail es un asesor de canal, usa su link REAL.

const { Resend } = require('resend');

// ── Canales con link exclusivo de cotización (?asesor={codigo}) ──
// prefijo = prefijo de las claves en Redis · slug = canal en la URL pública.
// Ojo: independientes guarda con prefijo "indep" pero la URL dice "independientes".
// nombre/color/fondoAviso: MISMO branding que ya usa el mail de alta en
// api/canales.js (asesorRegistro) — se duplica acá a propósito (config mínima,
// sin efectos secundarios) para no acoplar este cron a ese archivo.
var CANALES = [
  { prefijo: 'remax',  slug: 'remax',          nombre: 'RE/MAX',                color: '#DC1C2E', fondoAviso: '#FFF5F5' },
  { prefijo: 'c21',    slug: 'c21',             nombre: 'Century 21',            color: '#BEAF87', fondoAviso: '#FBF8F1' },
  { prefijo: 'mudafy', slug: 'mudafy',          nombre: 'Mudafy',                color: '#FF5A5F', fondoAviso: '#FFF5F5' },
  { prefijo: 'indep',  slug: 'independientes',  nombre: 'Asesores independientes', color: '#003580', fondoAviso: '#F5F8FC' }
];
var SITE = 'https://mudateya.ar';
var WA_EMI = 'https://wa.me/12399462954?text=' + encodeURIComponent('Hola Emi!');

// ── Wrappers Redis (mismo patrón que cron-onboarding.js) ──
async function redisCall(method, args) {
  var url   = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  var r = await fetch(url + '/' + method + '/' + args.map(encodeURIComponent).join('/'), {
    headers: { Authorization: 'Bearer ' + token }
  });
  var data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function getJSON(key) {
  var v = await redisCall('get', [key]);
  if (!v) return null;
  try { return JSON.parse(v); } catch(e) { return null; }
}

// ── HELPER: fecha YYYY-MM-DD en hora Argentina (para la clave semanal) ──
function fechaAR() {
  // Argentina es UTC-3 fijo (sin horario de verano).
  var ahora = new Date();
  var ar = new Date(ahora.getTime() - 180 * 60 * 1000);
  return ar.getUTCFullYear() + '-' +
    String(ar.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(ar.getUTCDate()).padStart(2, '0');
}

function validEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
}

// ── HELPER: link exclusivo de cotización de un asesor ──
// Es EXACTAMENTE el mismo que arma cada canal (remax.js/c21.js/mudafy.js/
// independientes.js): SITE + /inmobiliaria/{slug}?asesor={codigo}.
function linkCotizacion(slug, codigo) {
  return SITE + '/inmobiliaria/' + slug + '?asesor=' + encodeURIComponent(codigo);
}

// ── Recolecta los destinatarios: recorre el índice de cada canal, arma el link
//    real de cada asesor y deduplica por email. Devuelve [{email,nombre,canal,link}]. ──
async function recolectarDestinatarios() {
  var out = [];
  var vistos = {};
  for (var c = 0; c < CANALES.length; c++) {
    var canal = CANALES[c];
    var ids = await getJSON(canal.prefijo + ':asesores') || [];
    for (var i = 0; i < ids.length; i++) {
      var a = await getJSON(canal.prefijo + ':asesor:' + ids[i]);
      if (!a || !validEmail(a.email)) continue;
      if (a.activo === false) continue; // asesor dado de baja
      var k = String(a.email).toLowerCase().trim();
      if (vistos[k]) continue;          // ya listado por otro canal
      vistos[k] = true;
      out.push({
        email:  a.email,
        nombre: a.nombre || '',
        canal:  canal.slug,
        canalNombre: canal.nombre,
        color: canal.color,
        fondoAviso: canal.fondoAviso,
        link:   linkCotizacion(canal.slug, a.codigo || ids[i])
      });
    }
  }
  return out;
}

// ── PLANTILLA DEL EMAIL ──
// canal (opcional): { canalNombre, color, fondoAviso } — si no viene (ej. modo
// test sin match), cae al branding genérico de MudateYa.
function emailRecordatorio(nombre, ctaHref, canal) {
  var primerNombre = ((nombre || '').trim().split(' ')[0]) || 'Hola';
  return {
    subject: primerNombre + ', ¿tenés alguna operación abierta esta semana?',
    html: bodyHtml({
      canalNombre: canal && canal.canalNombre,
      color:       (canal && canal.color) || '#22C36A',
      fondoAviso:  (canal && canal.fondoAviso) || '#F5F7FA',
      titulo: '¡Arrancá la semana, ' + primerNombre + '! 🚀',
      lead:   '¿Tenés alguna operación abierta esta semana — alquiler o compraventa? En cuanto la cierres, proponele la mudanza a tu cliente: es un servicio premium, gratis, que te posiciona frente a él y te trae ' +
              (canal && canal.canalNombre === 'Asesores independientes' ? 'una comisión o un regalo para tu cliente' : 'un beneficio') + ' según el tipo de operación.',
      bullets: [
        'Cargás los datos del cliente y de la mudanza',
        'Elegís presupuestos de mudanceras verificadas',
        'Se los enviás por mail y WhatsApp, a tu nombre'
      ],
      cta:     'Armar un presupuesto →',
      ctaHref: ctaHref || (SITE + '/asesores'),
      cierre:  'Es gratis para vos y para tu cliente. Cuantos más mandás, más te recuerdan cuando llega la hora de mudarse.'
    })
  };
}

function bodyHtml(p) {
  var bullets = p.bullets.map(function(b) {
    return '<li style="margin:6px 0">' + b + '</li>';
  }).join('');
  var marcaCanal = p.canalNombre
    ? '<span style="color:rgba(255,255,255,.75);font-size:15px;margin-left:10px">× ' + p.canalNombre + '</span>'
    : '';
  return '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">' +
    '<div style="background:#003580;padding:22px 28px;text-align:center">' +
      '<span style="font-family:Bebas Neue,Arial,sans-serif;font-size:30px;font-weight:900;letter-spacing:2px;color:#fff">MUDATE</span>' +
      '<span style="font-family:Bebas Neue,Arial,sans-serif;font-size:30px;font-weight:900;letter-spacing:2px;color:#22C36A">YA</span>' +
      marcaCanal +
    '</div>' +
    '<div style="padding:28px">' +
      '<h2 style="margin:0 0 12px;color:#0F1923;font-size:20px">' + p.titulo + '</h2>' +
      '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">' + p.lead + '</p>' +
      '<div style="background:' + p.fondoAviso + ';border-radius:12px;padding:14px 20px;margin-bottom:18px">' +
        '<div style="font-size:12px;font-weight:700;color:' + p.color + ';text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">En 2 minutos:</div>' +
        '<ul style="margin:0;padding-left:20px;color:#0F1923;font-size:13px;line-height:1.5">' + bullets + '</ul>' +
      '</div>' +
      '<div style="text-align:center;margin:24px 0">' +
        '<a href="' + p.ctaHref + '" style="display:inline-block;background:' + p.color + ';color:#fff;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none">' + p.cta + '</a>' +
      '</div>' +
      '<p style="color:#475569;font-size:13px;line-height:1.6;margin:0">' + p.cierre + '</p>' +
      '<div style="background:#F0FFF4;border:1px solid #BBF7D0;border-radius:10px;padding:14px 16px;margin-top:20px;text-align:center">' +
        '<div style="font-size:13px;color:#166534;font-weight:600;margin-bottom:8px">📱 Y si te resulta más rápido, hacelo por WhatsApp con Emi</div>' +
        '<a href="' + WA_EMI + '" style="display:inline-block;background:#22C36A;color:#fff;text-decoration:none;padding:9px 20px;border-radius:8px;font-size:13px;font-weight:700">Escribirle a Emi →</a>' +
      '</div>' +
      '<div style="margin-top:20px;padding-top:20px;border-top:1px solid #EEF1F5;text-align:center">' +
        '<div style="font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#94A3B8;margin-bottom:8px">Seguinos en IG</div>' +
        '<a href="https://www.instagram.com/mudateya.ar/" style="color:#003580;font-weight:700;font-size:14px;text-decoration:none">@mudateya.ar</a>' +
      '</div>' +
      '<p style="color:#94A3B8;font-size:11px;text-align:center;margin:24px 0 0;border-top:1px solid #E2E8F0;padding-top:16px">' +
        'Recibís este recordatorio porque sos Asesor de MudateYa. ¿No querés recibirlos más? Respondé este mail con <strong>BAJA</strong>.' +
      '</p>' +
    '</div>' +
  '</div>';
}

// ── HANDLER ──
module.exports = async function handler(req, res) {
  // Skip silencioso en deployments preview (Vercel corre crons en previews sin
  // el header x-vercel-cron; devolvíamos 401 y ensuciaba los logs).
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    return res.status(200).json({ ok: true, skipped: true, reason: 'no-production-env', env: process.env.VERCEL_ENV });
  }

  // Seguridad: solo Vercel Cron o admin con token
  var esVercelCron = require('./_auth').esCronVercel(req);
  var esAdmin      = require('./_auth').esAdmin(req);
  if (!esVercelCron && !esAdmin) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: 'RESEND_API_KEY no configurado' });
  }

  var resend = new Resend(process.env.RESEND_API_KEY);
  var esDry  = req.query && req.query.dry === '1';
  var testTo = req.query && req.query.test ? String(req.query.test).trim() : '';

  try {
    // ── MODO TEST: mandar una sola muestra y cortar ──
    if (testTo) {
      if (!validEmail(testTo)) return res.status(400).json({ error: 'Email de test inválido' });
      // Si el mail de test es un asesor de canal, usamos su link REAL de cotización.
      var lista0 = await recolectarDestinatarios();
      var match = null;
      for (var m = 0; m < lista0.length; m++) {
        if (lista0[m].email.toLowerCase() === testTo.toLowerCase()) { match = lista0[m]; break; }
      }
      var muestra = emailRecordatorio(match ? match.nombre : 'Asesor de prueba', match ? match.link : null, match);
      var rt = await resend.emails.send({
        from: 'MudateYa Asesores <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
        to: testTo, subject: muestra.subject, html: muestra.html
      });
      if (rt && rt.error) return res.status(502).json({ error: rt.error });
      return res.status(200).json({
        ok: true, test: true, enviadoA: testTo,
        esAsesorDeCanal: !!match,
        canal: match ? match.canal : null,
        link:  match ? match.link : null
      });
    }

    // ── IDEMPOTENCIA: marca por semana (clave = lunes en hora AR) ──
    // SET ... NX devuelve 'OK' si la seteó, o null si ya existía → ya corrió hoy.
    var claveSemana = 'asesores:recordatorio-semanal:' + fechaAR();
    if (!esDry) {
      var marca = await redisCall('set', [claveSemana, new Date().toISOString(), 'EX', '1296000', 'NX']);
      if (marca !== 'OK') {
        return res.status(200).json({ ok: true, skipped: true, reason: 'ya-enviado-esta-semana', clave: claveSemana });
      }
    }

    // ── Recolectar destinatarios (canales) y enviar ──
    var lista = await recolectarDestinatarios();
    var resumen = { total: lista.length, enviados: 0, errores: 0, destinatarios: [], fallidos: [] };

    for (var i = 0; i < lista.length; i++) {
      var d = lista[i];

      if (esDry) {
        resumen.destinatarios.push({ email: d.email, canal: d.canal, link: d.link });
        resumen.enviados++;
        continue;
      }

      var mail = emailRecordatorio(d.nombre, d.link, d);
      try {
        var r = await resend.emails.send({
          from: 'MudateYa Asesores <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
          to: d.email, subject: mail.subject, html: mail.html
        });
        if (r && r.error) throw new Error(typeof r.error === 'string' ? r.error : JSON.stringify(r.error));
        resumen.enviados++;
        resumen.destinatarios.push({ email: d.email, canal: d.canal });
      } catch (e) {
        resumen.errores++;
        resumen.fallidos.push({ email: d.email, error: e.message });
        console.warn('Error enviando recordatorio semanal a ' + d.email + ':', e.message);
      }
      // Respiro para no pegarle al rate limit de Resend
      await new Promise(function(ok){ setTimeout(ok, 120); });
    }

    return res.status(200).json({ ok: true, dry: esDry, ...resumen });
  } catch (e) {
    console.error('Error en cron-asesores-semanal:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
