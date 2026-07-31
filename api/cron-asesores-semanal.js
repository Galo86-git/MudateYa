// api/cron-asesores-semanal.js
//
// Recordatorio SEMANAL a todos los asesores dados de alta.
// Corre todos los lunes 09:00 hora Argentina (12:00 UTC) — schedule "0 12 * * 1"
// en vercel.json. Recorre el índice global `asesores:todos`, y a cada asesor
// activo le manda un mail de activación: "convertí cada cliente que se muda en
// un servicio premium (y gratis) para vos".
//
// IDEMPOTENCIA: al arrancar setea una marca en Redis por semana (SET ... NX).
// Si el cron corre dos veces el mismo lunes (reintento de Vercel), la segunda
// vez ve la marca y no manda nada. La marca expira sola a los 15 días.
//
// SEGURIDAD: el endpoint solo se ejecuta si:
//   1. Llega del Vercel Cron (header x-vercel-cron === '1'), o
//   2. Se llama manualmente con ?token=ADMIN_TOKEN (para probar).
//
// MODOS DE PRUEBA (solo con ?token=ADMIN_TOKEN):
//   ?dry=1            → NO envía nada; devuelve a cuántos y a quiénes les llegaría.
//   ?test=mail@x.com  → envía UN solo mail de muestra a esa dirección y corta.

const { Resend } = require('resend');

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

// ── PLANTILLA DEL EMAIL ──
function emailRecordatorio(asesor) {
  var primerNombre = ((asesor.nombre || '').trim().split(' ')[0]) || 'Hola';
  return {
    subject: primerNombre + ', ¿algún cliente que se muda esta semana?',
    html: bodyHtml({
      titulo: '¡Arrancá la semana, ' + primerNombre + '! 🚀',
      lead:   'Te lo recordamos todos los lunes porque funciona: cada cliente que alquila o compra con vos se va a mudar. Convertí ese momento en un servicio premium — y gratis — que te posiciona frente a tu cliente.',
      bullets: [
        'Cargás los datos del cliente y de la mudanza',
        'Elegís 3 presupuestos de mudanceras verificadas',
        'Se los enviás por mail y WhatsApp, a tu nombre'
      ],
      cta:    'Armar un presupuesto →',
      cierre: 'Es gratis para vos y para tu cliente. Cuantos más mandás, más te recuerdan cuando llega la hora de mudarse.'
    })
  };
}

function bodyHtml(p) {
  var bullets = p.bullets.map(function(b) {
    return '<li style="margin:6px 0">' + b + '</li>';
  }).join('');
  return '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">' +
    '<div style="background:#003580;padding:22px 28px;text-align:center">' +
      '<span style="font-family:Bebas Neue,Arial,sans-serif;font-size:30px;font-weight:900;letter-spacing:2px;color:#fff">MUDATE</span>' +
      '<span style="font-family:Bebas Neue,Arial,sans-serif;font-size:30px;font-weight:900;letter-spacing:2px;color:#22C36A">YA</span>' +
    '</div>' +
    '<div style="padding:28px">' +
      '<h2 style="margin:0 0 12px;color:#0F1923;font-size:20px">' + p.titulo + '</h2>' +
      '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">' + p.lead + '</p>' +
      '<div style="background:#F5F7FA;border-radius:12px;padding:14px 20px;margin-bottom:18px">' +
        '<div style="font-size:12px;font-weight:700;color:#003580;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">En 2 minutos:</div>' +
        '<ul style="margin:0;padding-left:20px;color:#0F1923;font-size:13px;line-height:1.5">' + bullets + '</ul>' +
      '</div>' +
      '<div style="text-align:center;margin:24px 0">' +
        '<a href="https://mudateya.ar/asesor-dashboard" style="display:inline-block;background:#22C36A;color:#fff;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none">' + p.cta + '</a>' +
      '</div>' +
      '<p style="color:#475569;font-size:13px;line-height:1.6;margin:0">' + p.cierre + '</p>' +
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
  var esVercelCron = req.headers['x-vercel-cron'] === '1';
  var token        = (req.query && req.query.token) || (req.url && new URL(req.url, 'http://x').searchParams.get('token'));
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
      var muestra = emailRecordatorio({ nombre: 'Asesor de prueba' });
      var rt = await resend.emails.send({
        from: 'MudateYa Asesores <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
        to: testTo, subject: muestra.subject, html: muestra.html
      });
      if (rt && rt.error) return res.status(502).json({ error: rt.error });
      return res.status(200).json({ ok: true, test: true, enviadoA: testTo });
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

    // ── Recorrer el índice global de asesores ──
    var emails = await getJSON('asesores:todos') || [];
    var resumen = { total: emails.length, enviados: 0, salteados: 0, errores: 0, destinatarios: [], fallidos: [] };

    for (var i = 0; i < emails.length; i++) {
      var asesor = await getJSON('asesor:' + emails[i]);
      if (!asesor || !validEmail(asesor.email)) { resumen.salteados++; continue; }
      // Respetar bajas / inactivos
      if (asesor.estado && asesor.estado !== 'activo') { resumen.salteados++; continue; }

      if (esDry) { resumen.destinatarios.push(asesor.email); resumen.enviados++; continue; }

      var mail = emailRecordatorio(asesor);
      try {
        var r = await resend.emails.send({
          from: 'MudateYa Asesores <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
          to: asesor.email, subject: mail.subject, html: mail.html
        });
        if (r && r.error) throw new Error(typeof r.error === 'string' ? r.error : JSON.stringify(r.error));
        resumen.enviados++;
        resumen.destinatarios.push(asesor.email);
      } catch (e) {
        resumen.errores++;
        resumen.fallidos.push({ email: asesor.email, error: e.message });
        console.warn('Error enviando recordatorio semanal a ' + asesor.email + ':', e.message);
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
