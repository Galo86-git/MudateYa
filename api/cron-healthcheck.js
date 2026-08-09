// api/cron-healthcheck.js
// Chequeo periódico de los 3 servicios externos críticos: Redis (Upstash),
// Resend (mail) y Mercado Pago. Si alguno está caído, avisa a ADMIN_EMAIL —
// la idea es enterarnos ANTES de que un cliente se tope con el error, no
// después por un reclamo. Solo manda mail cuando el estado CAMBIA (ok→caído
// o caído→ok), no en cada corrida, para no repetir el mismo aviso cada 2hs
// mientras algo sigue caído.
//
// OJO: si el que está caído es justo Resend, este cron no puede avisar por
// mail (es el mismo servicio que falló) — en ese caso hay que mirar los logs
// de Vercel directamente (Cron Jobs → cron-healthcheck → View Logs).
//
// También sirve de chequeo manual: GET /api/cron-healthcheck?token=ADMIN_TOKEN

var { esAdmin, esCronVercel } = require('./_auth');

async function redisCall(method, ...args) {
  var url = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  var r = await fetch(url + '/' + [method, ...args].map(encodeURIComponent).join('/'), {
    headers: { Authorization: 'Bearer ' + token },
  });
  var data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function conTimeout(fn, ms) {
  var controller = new AbortController();
  var t = setTimeout(function () { controller.abort(); }, ms);
  try { return await fn(controller.signal); }
  finally { clearTimeout(t); }
}

async function chequearRedis() {
  try {
    var url = process.env.UPSTASH_REDIS_REST_URL;
    var token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return { ok: null, detalle: 'sin configurar' };
    var r = await conTimeout(function (signal) {
      return fetch(url + '/ping', { headers: { Authorization: 'Bearer ' + token }, signal: signal });
    }, 8000);
    if (!r.ok) return { ok: false, detalle: 'HTTP ' + r.status };
    var d = await r.json();
    return { ok: d.result === 'PONG', detalle: 'respuesta: ' + JSON.stringify(d) };
  } catch (e) {
    return { ok: false, detalle: e.message };
  }
}

async function chequearResend() {
  try {
    if (!process.env.RESEND_API_KEY) return { ok: null, detalle: 'sin configurar' };
    var r = await conTimeout(function (signal) {
      return fetch('https://api.resend.com/domains', {
        headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY },
        signal: signal,
      });
    }, 8000);
    return { ok: r.ok, detalle: 'HTTP ' + r.status };
  } catch (e) {
    return { ok: false, detalle: e.message };
  }
}

async function chequearMercadoPago() {
  try {
    if (!process.env.MP_ACCESS_TOKEN) return { ok: null, detalle: 'sin configurar' };
    var r = await conTimeout(function (signal) {
      return fetch('https://api.mercadopago.com/users/me', {
        headers: { Authorization: 'Bearer ' + process.env.MP_ACCESS_TOKEN },
        signal: signal,
      });
    }, 8000);
    return { ok: r.ok, detalle: 'HTTP ' + r.status };
  } catch (e) {
    return { ok: false, detalle: e.message };
  }
}

module.exports = async function handler(req, res) {
  var esVercelCron = false;
  try { esVercelCron = esCronVercel(req); } catch (e) {}
  var admin = false;
  try { admin = esAdmin(req); } catch (e) {}
  if (!esVercelCron && !admin) return res.status(401).json({ error: 'No autorizado' });

  var servicios = {
    redis: await chequearRedis(),
    resend: await chequearResend(),
    mercadopago: await chequearMercadoPago(),
  };

  // Solo avisamos en las TRANSICIONES de estado (comparamos contra la última
  // corrida, guardada en Redis), no en cada chequeo — así no spamea si algo
  // queda caído varias horas seguidas.
  var cambios = [];
  for (var nombre in servicios) {
    if (!servicios.hasOwnProperty(nombre)) continue;
    var chk = servicios[nombre];
    if (chk.ok === null) continue; // servicio sin configurar, no lo trackeamos

    var estadoAnterior = null;
    try { estadoAnterior = await redisCall('GET', 'healthcheck:estado:' + nombre); } catch (e) {}
    var estadoActual = chk.ok ? 'ok' : 'down';

    if (estadoAnterior !== estadoActual) {
      cambios.push({ nombre: nombre, de: estadoAnterior || '(primera corrida)', a: estadoActual, detalle: chk.detalle });
      try { await redisCall('SET', 'healthcheck:estado:' + nombre, estadoActual); } catch (e) {}
    }
  }

  // Historial para el panel en vivo (api/admin-panel.js) — a diferencia del
  // healthcheck:estado:{nombre} de arriba (que se pisa y solo sirve para
  // detectar transiciones), esto guarda cada corrida para poder mostrar una
  // línea de tiempo. Capado a 200 (a cada 2hs, ~16 días de historial).
  try {
    await redisCall('LPUSH', 'panel:salud-historial', JSON.stringify({
      ts: Date.now(),
      redis: servicios.redis.ok,
      resend: servicios.resend.ok,
      mercadopago: servicios.mercadopago.ok,
    }));
    await redisCall('LTRIM', 'panel:salud-historial', 0, 199);
  } catch (e) { console.warn('cron-healthcheck: no se pudo guardar historial:', e.message); }

  if (cambios.length && process.env.RESEND_API_KEY && process.env.ADMIN_EMAIL) {
    try {
      const { Resend } = require('resend');
      var resend = new Resend(process.env.RESEND_API_KEY);
      var hayAlgunCaido = cambios.some(function (c) { return c.a === 'down'; });
      var filas = cambios.map(function (c) {
        var caido = c.a === 'down';
        return '<tr style="border-top:1px solid #EFEDE6">' +
          '<td style="padding:9px 12px;font-weight:700;' + (caido ? 'color:#B42318' : 'color:#166534') + '">' + c.nombre.toUpperCase() + '</td>' +
          '<td style="padding:9px 12px">' + (caido ? 'CAÍDO' : 'RECUPERADO') + '</td>' +
          '<td style="padding:9px 12px;color:#5B6472;font-size:12px">' + c.detalle + '</td>' +
          '</tr>';
      }).join('');
      await resend.emails.send({
        from: 'MudateYa <noreply@mudateya.ar>',
        to: process.env.ADMIN_EMAIL,
        subject: (hayAlgunCaido ? '⚠️ ' : '✅ ') + 'MudateYa — cambio de estado en servicios críticos',
        html: '<div style="font-family:Arial,sans-serif;max-width:560px;margin:24px auto;color:#14202B">' +
          '<h2 style="margin:0 0 14px;font-size:19px">Healthcheck: cambio de estado</h2>' +
          '<table style="width:100%;border-collapse:collapse;font-size:13.5px">' + filas + '</table>' +
          '<p style="color:#8A93A0;font-size:11.5px;margin-top:18px">MudateYa · chequeo automático de Redis, Resend y Mercado Pago, cada 2hs.</p>' +
          '</div>',
      });
    } catch (e) {
      console.warn('cron-healthcheck: no se pudo mandar el mail de aviso:', e.message);
    }
  }

  return res.status(200).json({ ok: true, servicios: servicios, cambios: cambios });
};
