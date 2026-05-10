// api/cron-onboarding.js
//
// Cron de recordatorio de onboarding para mudanceros pre-registrados.
// Recorre todos los perfiles de mudanceros, identifica los que están en estado
// 'pre-registrado' y manda emails escalonados (día 1 / día 3 / día 7) para que
// completen su perfil y empiecen a recibir pedidos.
//
// IDEMPOTENCIA: cada envío se registra en perfil.recordatoriosEnviados (array).
// Si el cron corre dos veces el mismo día, no duplica mails.
//
// AUTO-STOP: si el mudancero ya completó (estadoOnboarding==='completo'), si
// pasaron más de 8 días desde el alta, o si ya recibió los 3 recordatorios, el
// cron lo ignora.
//
// SEGURIDAD: el endpoint solo se ejecuta si:
//   1. Llega del Vercel Cron (header x-vercel-cron === '1'), o
//   2. Se llama manualmente con ?token=ADMIN_TOKEN

const { Resend } = require('resend');

// ── Wrappers Redis (mismos patrones que el resto del proyecto) ──
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

async function setJSON(key, value) {
  return redisCall('set', [key, JSON.stringify(value)]);
}

async function scanKeys(pattern) {
  var keys = [];
  var cursor = '0';
  var safety = 0;
  do {
    var r = await fetch(process.env.UPSTASH_REDIS_REST_URL + '/scan/' + cursor + '/match/' + encodeURIComponent(pattern) + '/count/200', {
      headers: { Authorization: 'Bearer ' + process.env.UPSTASH_REDIS_REST_TOKEN }
    });
    var d = await r.json();
    if (d.error) throw new Error(d.error);
    cursor = d.result[0];
    keys = keys.concat(d.result[1] || []);
    safety++;
    if (safety > 100) break; // failsafe
  } while (cursor !== '0');
  return keys;
}

// ── HELPER: días enteros transcurridos ──
function diasDesde(fechaISO) {
  if (!fechaISO) return 999;
  var t = new Date(fechaISO).getTime();
  if (isNaN(t)) return 999;
  var ms = Date.now() - t;
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// ── HELPER: qué recordatorio toca según días pasados ──
function recordatorioQueToca(diasPasados, enviados) {
  enviados = enviados || [];
  // Día 1: si pasó >= 1 día y < 3, y no se envió dia1
  if (diasPasados >= 1 && diasPasados < 3 && enviados.indexOf('dia1') === -1) return 'dia1';
  // Día 3: si pasó >= 3 días y < 7, y no se envió dia3
  if (diasPasados >= 3 && diasPasados < 7 && enviados.indexOf('dia3') === -1) return 'dia3';
  // Día 7: si pasó >= 7 días y < 9, y no se envió dia7
  if (diasPasados >= 7 && diasPasados < 9 && enviados.indexOf('dia7') === -1) return 'dia7';
  return null;
}

// ── PLANTILLAS EMAIL ──
function emailDia1(perfil) {
  var primerNombre = (perfil.nombre || '').split(' ')[0] || 'mudancero';
  return {
    subject: '¡Hola ' + primerNombre + '! Te falta un paso para activar tu cuenta',
    html: bodyHtml({
      titulo: '¡Hola ' + primerNombre + '! 👋',
      lead:   'Te diste de alta en MudateYa ayer pero tu perfil todavía está incompleto, así que no estás recibiendo pedidos.',
      cta:    'Completar mi perfil →',
      bullets: [
        'Cargar tu vehículo y precios',
        'Subir foto del vehículo y de tu DNI',
        'Datos para cobrar (CBU o Mercado Pago)'
      ],
      cierre: 'Te toma 5 minutos. Si algo te frenó o tenés dudas, respondé este mail y te ayudo personalmente.',
      pd:     null
    })
  };
}

function emailDia3(perfil) {
  var primerNombre = (perfil.nombre || '').split(' ')[0] || 'mudancero';
  return {
    subject: primerNombre + ', estás perdiendo pedidos en tu zona',
    html: bodyHtml({
      titulo: primerNombre + ', tus competidores ya están cotizando 🚛',
      lead:   'Pasaron 3 días desde que te diste de alta y todavía no completaste tu perfil. Cada día que pasa son pedidos que se llevan otros mudanceros verificados.',
      cta:    'Activar mi perfil ahora →',
      bullets: [
        'Vehículo y precios',
        'Foto del vehículo y DNI',
        'CBU o Mercado Pago'
      ],
      cierre: 'Te toma 5 minutos. ¿Te trabaste con algo? Respondé este mail y lo resolvemos.',
      pd:     '💡 La plataforma es 100% gratis hasta que concretes un trabajo. No tenés nada que perder.'
    })
  };
}

function emailDia7(perfil) {
  var primerNombre = (perfil.nombre || '').split(' ')[0] || 'mudancero';
  return {
    subject: primerNombre + ', último recordatorio · tu cuenta queda inactiva',
    html: bodyHtml({
      titulo: 'Último recordatorio, ' + primerNombre,
      lead:   'Hace una semana que te diste de alta en MudateYa. Si no completás tu perfil en los próximos días, vamos a marcar tu cuenta como inactiva y dejarás de aparecer en nuestro sistema.',
      cta:    'Completar mi perfil →',
      bullets: [
        'Vehículo y precios (2 min)',
        'Foto del vehículo y DNI (2 min)',
        'CBU o Mercado Pago (1 min)'
      ],
      cierre: '¿No te interesa más? Sin problema — respondé este mail con "BAJA" y te eliminamos. Sino, esperamos verte activo pronto.',
      pd:     null
    })
  };
}

function bodyHtml(p) {
  var bullets = p.bullets.map(function(b) {
    return '<li style="margin:6px 0">' + b + '</li>';
  }).join('');
  var pd = p.pd
    ? '<div style="background:#FEF3C7;border-left:3px solid #F59E0B;border-radius:8px;padding:12px 16px;margin-top:20px;font-size:13px;color:#78350F;line-height:1.5">' + p.pd + '</div>'
    : '';
  return '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">' +
    '<div style="background:#003580;padding:22px 28px;text-align:center">' +
      '<div style="font-family:Georgia,serif;font-size:26px;font-weight:900;letter-spacing:2px;color:#fff">MUDATEYA</div>' +
    '</div>' +
    '<div style="padding:28px">' +
      '<h2 style="margin:0 0 12px;color:#0F1923;font-size:20px">' + p.titulo + '</h2>' +
      '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">' + p.lead + '</p>' +
      '<div style="background:#F5F7FA;border-radius:12px;padding:14px 20px;margin-bottom:18px">' +
        '<div style="font-size:12px;font-weight:700;color:#1A6FFF;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Te falta:</div>' +
        '<ul style="margin:0;padding-left:20px;color:#0F1923;font-size:13px;line-height:1.5">' + bullets + '</ul>' +
      '</div>' +
      '<div style="text-align:center;margin:24px 0">' +
        '<a href="https://mudateya.ar/mi-cuenta" style="display:inline-block;background:#22C36A;color:#fff;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none">' + p.cta + '</a>' +
      '</div>' +
      '<p style="color:#475569;font-size:13px;line-height:1.6;margin:0">' + p.cierre + '</p>' +
      pd +
      '<p style="color:#94A3B8;font-size:11px;text-align:center;margin:24px 0 0;border-top:1px solid #E2E8F0;padding-top:16px">¿Dudas? Respondé este mail o escribinos a <a href="mailto:hola@mudateya.ar" style="color:#1A6FFF;text-decoration:none">hola@mudateya.ar</a></p>' +
    '</div>' +
  '</div>';
}

// ── HANDLER ──
module.exports = async function handler(req, res) {
  // Seguridad: solo Vercel Cron o admin con token
  var esVercelCron = req.headers['x-vercel-cron'] === '1';
  var token        = (req.query && req.query.token) || (req.url && new URL(req.url, 'http://x').searchParams.get('token'));
  var esAdmin      = token === (process.env.ADMIN_TOKEN || 'mya-admin-2026');
  if (!esVercelCron && !esAdmin) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: 'RESEND_API_KEY no configurado' });
  }

  var resend = new Resend(process.env.RESEND_API_KEY);
  var resumen = { revisados: 0, enviados: { dia1: 0, dia3: 0, dia7: 0 }, errores: 0, detalle: [] };

  try {
    // Recorrer todos los perfiles de mudanceros
    var keys = await scanKeys('mudancero:perfil:*');

    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var perfil = await getJSON(key);
      if (!perfil || !perfil.email) continue;

      resumen.revisados++;

      // Stop conditions
      if (perfil.estadoOnboarding === 'completo') continue;
      // Si no es pre-registrado (alta vieja sin flag) lo dejamos pasar — el flag
      // estadoOnboarding solo existe en altas cortas nuevas. Si querés que aplique
      // también a altas viejas incompletas, comentá el siguiente if:
      if (perfil.estadoOnboarding !== 'pre-registrado') continue;

      var dias = diasDesde(perfil.fechaRegistro);
      if (dias > 9) continue; // ya pasó la ventana

      var enviados = perfil.recordatoriosEnviados || [];
      var cual = recordatorioQueToca(dias, enviados);
      if (!cual) continue;

      // Armar el email según cuál toca
      var mail;
      if (cual === 'dia1') mail = emailDia1(perfil);
      else if (cual === 'dia3') mail = emailDia3(perfil);
      else if (cual === 'dia7') mail = emailDia7(perfil);
      if (!mail) continue;

      // Enviar
      try {
        await resend.emails.send({
          from:    'MudateYa <noreply@mudateya.ar>',
          to:      perfil.email,
          subject: mail.subject,
          html:    mail.html,
        });
        // Registrar en Redis para no duplicar
        perfil.recordatoriosEnviados = enviados.concat([cual]);
        perfil.ultimoRecordatorioOnboarding = new Date().toISOString();
        await setJSON(key, perfil);
        resumen.enviados[cual]++;
        resumen.detalle.push({ email: perfil.email, recordatorio: cual, dias: dias });
      } catch(e) {
        resumen.errores++;
        resumen.detalle.push({ email: perfil.email, error: e.message });
        console.warn('Error enviando ' + cual + ' a ' + perfil.email + ':', e.message);
      }
    }

    return res.status(200).json({ ok: true, ...resumen });
  } catch(e) {
    console.error('Error en cron-onboarding:', e.message);
    return res.status(500).json({ error: e.message, ...resumen });
  }
};
