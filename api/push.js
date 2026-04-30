// api/push.js
// MudateYa - Push Notifications
//
// Endpoints:
//   GET  ?action=public-key
//        Devuelve la VAPID public key.
//
//   POST ?action=subscribe&email=xxx
//        Body: { subscription: {...} }
//        Auth: x-session-token (magic link) O perfil existente en Redis (Google OAuth)
//
//   POST ?action=unsubscribe&email=xxx
//        Body: { endpoint: '...' (opcional) }
//
//   POST ?action=test&email=xxx
//        Manda un push de prueba al usuario.
//
// Helper exportado:
//   require('./push').enviarPush(email, { titulo, cuerpo, link, icono })

var webpush = require('web-push');

// ── Redis (Upstash REST) ───────────────────────────────────────────────────────
var REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
var REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisCmd(args) {
  var r = await fetch(REDIS_URL + '/' + args.map(encodeURIComponent).join('/'), {
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN }
  });
  var j = await r.json();
  return j.result;
}

async function getJSON(key) {
  var raw = await redisCmd(['GET', key]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function setJSON(key, val) {
  return redisCmd(['SET', key, JSON.stringify(val)]);
}

async function delKey(key) {
  return redisCmd(['DEL', key]);
}

// ── VAPID ──────────────────────────────────────────────────────────────────────
var VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
var VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
var VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:jgalozaldivar@gmail.com';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

// ── Auth ────────────────────────────────────────────────────────────────────────
// Acepta DOS flujos:
//   A) sessionToken válido en Redis (login magic link) — más seguro
//   B) perfil de mudancero o cliente existente en Redis (login Google OAuth)
// Esto cubre los dos flujos actuales de la app sin romper nada.
async function autorizar(req, email) {
  if (!email) return false;
  var emailLow = email.toLowerCase();

  // A) sessionToken
  var token = req.headers['x-session-token'] || (req.query && req.query.sessionToken);
  if (token) {
    var t1 = await getJSON('session:mudancero:' + emailLow);
    if (t1 && t1 === token) return 'mudancero';
    var t2 = await getJSON('session:cliente:' + emailLow);
    if (t2 && t2 === token) return 'cliente';
  }

  // B) Sin token: validar que exista un perfil en Redis
  // Las keys reales en MudateYa son 'mudancero:perfil:{email}' y 'cliente:perfil:{email}'
  var perfilMud = await getJSON('mudancero:perfil:' + emailLow);
  if (perfilMud && perfilMud.email) return 'mudancero';

  var perfilCli = await getJSON('cliente:perfil:' + emailLow);
  if (perfilCli && perfilCli.email) return 'cliente';

  return false;
}

// ── Helper exportado: enviarPush ───────────────────────────────────────────────
async function enviarPush(email, data) {
  if (!email) return { ok: false, error: 'sin email' };
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.warn('[push] VAPID keys no configuradas');
    return { ok: false, error: 'sin vapid' };
  }

  var emailLower = email.toLowerCase();
  var subs = await getJSON('push:subs:' + emailLower);
  if (!subs || !Array.isArray(subs) || subs.length === 0) {
    return { ok: false, error: 'sin suscripciones' };
  }

  var payload = JSON.stringify({
    titulo: data.titulo || 'MudateYa',
    cuerpo: data.cuerpo || '',
    link: data.link || '/mi-cuenta',
    icono: data.icono || '/icon-192.png'
  });

  var enviados = 0;
  var subsValidas = [];

  for (var i = 0; i < subs.length; i++) {
    var sub = subs[i];
    try {
      await webpush.sendNotification(sub, payload, { TTL: 60 * 60 * 24 });
      enviados++;
      subsValidas.push(sub);
    } catch (err) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        console.log('[push] suscripción muerta para ' + emailLower + ', removiendo');
      } else {
        console.error('[push] error enviando a ' + emailLower + ':', err && err.message);
        subsValidas.push(sub);
      }
    }
  }

  if (subsValidas.length !== subs.length) {
    if (subsValidas.length === 0) {
      await delKey('push:subs:' + emailLower);
    } else {
      await setJSON('push:subs:' + emailLower, subsValidas);
    }
  }

  return { ok: true, enviados: enviados, total: subs.length };
}

// ── Handler HTTP ───────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  var action = (req.query && req.query.action) || '';

  // GET ?action=public-key — público
  if (action === 'public-key' && req.method === 'GET') {
    if (!VAPID_PUBLIC) {
      return res.status(500).json({ error: 'VAPID no configurada en el servidor' });
    }
    return res.status(200).json({ publicKey: VAPID_PUBLIC });
  }

  // El resto requiere email + auth
  var email = (req.query && req.query.email) || (req.body && req.body.email) || '';
  email = (email + '').toLowerCase().trim();

  if (!email) {
    return res.status(400).json({ error: 'Falta email' });
  }

  var rol = await autorizar(req, email);
  if (!rol) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  // POST ?action=subscribe — body: { subscription: {...} }
  if (action === 'subscribe' && req.method === 'POST') {
    var body = req.body || {};
    var sub = body.subscription;
    if (!sub || !sub.endpoint) {
      return res.status(400).json({ error: 'subscription inválida' });
    }

    var key = 'push:subs:' + email;
    var existentes = (await getJSON(key)) || [];

    var yaExiste = false;
    for (var i = 0; i < existentes.length; i++) {
      if (existentes[i].endpoint === sub.endpoint) {
        yaExiste = true;
        existentes[i] = sub;
        break;
      }
    }
    if (!yaExiste) existentes.push(sub);

    if (existentes.length > 5) {
      existentes = existentes.slice(-5);
    }

    await setJSON(key, existentes);
    return res.status(200).json({ ok: true, total: existentes.length });
  }

  // POST ?action=unsubscribe — body: { endpoint: '...' (opcional) }
  if (action === 'unsubscribe' && req.method === 'POST') {
    var body2 = req.body || {};
    var endpoint = body2.endpoint;
    var key2 = 'push:subs:' + email;
    var subs = (await getJSON(key2)) || [];

    if (endpoint) {
      subs = subs.filter(function(s){ return s.endpoint !== endpoint; });
      if (subs.length === 0) {
        await delKey(key2);
      } else {
        await setJSON(key2, subs);
      }
    } else {
      await delKey(key2);
    }

    return res.status(200).json({ ok: true });
  }

  // POST ?action=test — push de prueba
  if (action === 'test' && req.method === 'POST') {
    var resultado = await enviarPush(email, {
      titulo: '🚚 MudateYa',
      cuerpo: 'Las notificaciones funcionan. ¡Listo!',
      link: '/mi-cuenta'
    });
    return res.status(200).json(resultado);
  }

  return res.status(400).json({ error: 'action inválida' });
};

module.exports.enviarPush = enviarPush;
