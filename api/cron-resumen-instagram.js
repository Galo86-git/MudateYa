// api/cron-resumen-instagram.js
// Resumen semanal de Instagram — corre por cron los lunes a las 9am hora
// Argentina (12:00 UTC, ver vercel.json). Manda un mail a ADMIN_EMAIL con
// alcance, visitas al perfil, seguidores nuevos y el ranking de los últimos
// posteos por interacción (para ver qué contenido funciona y qué no).
//
// REQUIERE un permiso que el token de hoy (IG_ACCESS_TOKEN) NO tiene:
//   instagram_business_manage_insights
// El token actual solo se pidió con instagram_business_manage_messages (para
// el bot de DMs, ver api/instagram.js). Sin ese permiso agregado y sin volver
// a autorizar la app (Meta for Developers → tu app → Instagram API with
// Instagram Login → Permissions → agregar instagram_business_manage_insights
// → repetir el login de Instagram para generar un token nuevo con ese scope
// → actualizar IG_ACCESS_TOKEN en Vercel), este cron va a fallar con un error
// de permisos — lo deja claro en el mail/respuesta en vez de fallar en
// silencio, así que ya queda listo para cuando se agregue el permiso.
//
// También sirve de chequeo manual: GET /api/cron-resumen-instagram?token=ADMIN_TOKEN
// (agregando &enviar=1 se fuerza el mail en vez de solo devolver el JSON).

var { esAdmin, esCronVercel } = require('./_auth');
const { Resend } = require('resend');

const GRAPH = 'https://graph.instagram.com/v21.0';

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
async function getJSON(key) {
  var v = await redisCall('GET', key);
  if (!v) return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}
async function setJSON(key, value) {
  await redisCall('SET', key, JSON.stringify(value));
}

// 'YYYY-MM-DD' en huso Argentina.
function fechaAR(d) {
  return (d || new Date()).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}

// Llamada a Graph con manejo de error legible — si falta el permiso, Meta
// devuelve un código de error específico (10 / 200 / 803 según el caso) con
// un mensaje humano en error.message; lo propagamos tal cual en vez de un
// "fetch failed" genérico.
async function graphGet(path, params) {
  var qs = new URLSearchParams(Object.assign({ access_token: process.env.IG_ACCESS_TOKEN }, params || {}));
  var r = await fetch(GRAPH + path + '?' + qs.toString());
  var d = await r.json();
  if (d.error) {
    var msg = d.error.message || 'Error desconocido de la API de Instagram';
    var err = new Error(msg);
    err.esPermiso = /permission|scope|access_token/i.test(msg) || d.error.code === 10 || d.error.code === 200;
    throw err;
  }
  return d;
}

// Insights de cuenta (alcance, visitas al perfil) de los últimos 7 días.
// 'reach' y 'profile_views' son los dos métricos más estables entre cuentas
// chicas y grandes — 'impressions' está deprecado a nivel cuenta en muchas
// apps nuevas, así que no lo pedimos para no romper el cron entero por un
// solo métrico no soportado.
async function insightsCuenta(igUserId) {
  var d = await graphGet('/' + igUserId + '/insights', {
    metric: 'reach,profile_views',
    period: 'day',
    metric_type: 'total_value',
    since: Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000),
    until: Math.floor(Date.now() / 1000),
  });
  var out = { reach: 0, profileViews: 0 };
  (d.data || []).forEach(function (m) {
    var total = (m.total_value && m.total_value.value) || 0;
    if (m.name === 'reach') out.reach = total;
    if (m.name === 'profile_views') out.profileViews = total;
  });
  return out;
}

// Insights de un posteo puntual. Distintos tipos de media (foto/carrusel/
// reel) soportan distintos métricos — pedimos el set más común y si Meta
// rechaza alguno igual devolvemos lo que sí vino, en vez de tirar el posteo
// entero del ranking.
async function insightsMedia(mediaId) {
  try {
    var d = await graphGet('/' + mediaId + '/insights', { metric: 'reach,saved,shares' });
    var out = { reach: 0, saved: 0, shares: 0 };
    (d.data || []).forEach(function (m) {
      var v = (m.values && m.values[0] && m.values[0].value) || 0;
      if (m.name === 'reach') out.reach = v;
      if (m.name === 'saved') out.saved = v;
      if (m.name === 'shares') out.shares = v;
    });
    return out;
  } catch (e) {
    return { reach: null, saved: null, shares: null };
  }
}

module.exports = async function handler(req, res) {
  var esVercelCron = esCronVercel(req);
  var admin = false;
  try { admin = esAdmin(req); } catch (e) {}
  if (!esVercelCron && !admin) return res.status(401).json({ error: 'No autorizado' });

  if (!process.env.IG_ACCESS_TOKEN) {
    return res.status(200).json({ ok: false, error: 'Falta IG_ACCESS_TOKEN en las variables de entorno.' });
  }

  try {
    var hoy = fechaAR();

    var cuenta = await graphGet('/me', { fields: 'id,username,followers_count,media_count' });

    var resumenCuenta;
    try {
      resumenCuenta = await insightsCuenta(cuenta.id);
    } catch (e) {
      var faltaPermiso = e.esPermiso;
      return res.status(200).json({
        ok: false,
        error: faltaPermiso
          ? 'El token de Instagram no tiene el permiso instagram_business_manage_insights. Agregalo en Meta for Developers → tu app → Instagram API with Instagram Login → Permissions, volvé a autorizar la app (repetir el login de Instagram) para generar un token nuevo, y actualizá IG_ACCESS_TOKEN en Vercel.'
          : e.message,
        detalleOriginal: e.message,
      });
    }

    // Últimos posteos (hasta 12) con su interacción básica (siempre viene en
    // el objeto media, no requiere insights) + insights por posteo.
    var mediaResp = await graphGet('/me/media', {
      fields: 'id,caption,media_type,permalink,timestamp,like_count,comments_count',
      limit: '12',
    });
    var posteos = [];
    for (var i = 0; i < (mediaResp.data || []).length; i++) {
      var m = mediaResp.data[i];
      var ins = await insightsMedia(m.id);
      var caption = (m.caption || '').replace(/\s+/g, ' ').trim();
      posteos.push({
        id: m.id,
        tipo: m.media_type,
        fecha: m.timestamp,
        permalink: m.permalink,
        caption: caption.length > 70 ? caption.slice(0, 70) + '…' : caption,
        likes: m.like_count || 0,
        comentarios: m.comments_count || 0,
        reach: ins.reach,
        guardados: ins.saved,
        compartidos: ins.shares,
        interaccion: (m.like_count || 0) + (m.comments_count || 0) + (ins.saved || 0) + (ins.shares || 0),
      });
    }
    posteos.sort(function (a, b) { return b.interaccion - a.interaccion; });

    // Comparar contra la semana pasada (si hay snapshot guardado).
    var semanaPasada = await getJSON('ig:insights:ultima');
    var deltaSeguidores = semanaPasada ? cuenta.followers_count - semanaPasada.seguidores : null;
    var deltaReach = semanaPasada ? resumenCuenta.reach - semanaPasada.reach : null;

    var resumen = {
      fecha: hoy,
      usuario: cuenta.username,
      seguidores: cuenta.followers_count,
      totalPosteos: cuenta.media_count,
      reach7d: resumenCuenta.reach,
      profileViews7d: resumenCuenta.profileViews,
      deltaSeguidores: deltaSeguidores,
      deltaReach: deltaReach,
      posteos: posteos,
    };

    // Guardar snapshot para la comparación de la próxima semana.
    try {
      await setJSON('ig:insights:ultima', {
        fecha: hoy,
        seguidores: cuenta.followers_count,
        reach: resumenCuenta.reach,
        profileViews: resumenCuenta.profileViews,
      });
      await setJSON('ig:insights:semana:' + hoy, resumen);
    } catch (e) { console.warn('No se pudo guardar snapshot de IG:', e.message); }

    var forzarEnvio = req.query.enviar === '1';
    if (req.method === 'GET' && !esVercelCron && !forzarEnvio) {
      return res.status(200).json({ ok: true, resumen: resumen });
    }

    var enviado = false;
    if (process.env.RESEND_API_KEY && process.env.ADMIN_EMAIL) {
      var resend = new Resend(process.env.RESEND_API_KEY);

      var signo = function (n) { return n == null ? '' : (n > 0 ? ' (+' + n + ')' : n < 0 ? ' (' + n + ')' : ' (=)'); };

      var scoreCelda = function (num, label, esUltima) {
        var borde = esUltima ? '' : 'border-left:1px solid #EFEDE6;';
        return '<td style="text-align:center;padding:0 6px;' + borde + '">' +
          '<div style="font-family:Georgia,serif;font-size:26px;font-weight:700;color:#003580;font-variant-numeric:tabular-nums;line-height:1">' + num + '</div>' +
          '<div style="font-size:9.5px;letter-spacing:.7px;text-transform:uppercase;color:#8A93A0;margin-top:6px;line-height:1.3">' + label + '</div>' +
        '</td>';
      };

      var filasPosteos = posteos.map(function (p, i) {
        var metricas = p.likes + ' likes · ' + p.comentarios + ' com.' +
          (p.guardados != null ? ' · ' + p.guardados + ' guardados' : '') +
          (p.reach != null ? ' · ' + p.reach + ' alcance' : '');
        return '<tr>' +
          '<td style="padding:9px 0;font-size:13px;color:#14202B;' + (i === 0 ? '' : 'border-top:1px solid #EFEDE6;') + '">' +
            '<a href="' + p.permalink + '" style="color:#14202B;text-decoration:none">' + (p.caption || '(sin texto)') + '</a>' +
            '<span style="display:block;color:#5B6472;font-size:11.5px;margin-top:2px">' + metricas + '</span>' +
          '</td>' +
          '<td style="padding:9px 0;font-size:13px;color:#003580;font-weight:700;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;' + (i === 0 ? '' : 'border-top:1px solid #EFEDE6;') + '">' + p.interaccion + '</td>' +
        '</tr>';
      }).join('');

      await resend.emails.send({
        from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
        to: process.env.ADMIN_EMAIL,
        subject: 'Resumen semanal de Instagram — MudateYa',
        html:
          '<div style="font-family:Arial,Helvetica,sans-serif;color:#14202B;max-width:600px;margin:0 auto;background:#fff;border:1px solid #E7E4DC">' +
            '<div style="background:#003580;padding:26px 32px 22px;color:#fff">' +
              '<div style="font-family:Georgia,\'Times New Roman\',serif;font-size:24px;font-weight:700;letter-spacing:.2px">Mudate<span style="color:#6FE0A0">Ya</span></div>' +
              '<div style="font-family:Georgia,serif;font-style:italic;font-size:12.5px;color:#C7D6EE;margin-top:4px">Resumen semanal de Instagram · @' + resumen.usuario + '</div>' +
            '</div>' +
            '<div style="padding:24px 32px 20px">' +
              '<table role="presentation" style="width:100%;border-collapse:collapse"><tr>' +
                scoreCelda(resumen.seguidores, 'Seguidores' + signo(deltaSeguidores), false) +
                scoreCelda(resumen.reach7d, 'Alcance 7d' + signo(deltaReach), false) +
                scoreCelda(resumen.profileViews7d, 'Visitas al perfil', true) +
              '</tr></table>' +
            '</div>' +
            '<div style="padding:4px 32px 4px">' +
              '<div style="padding:16px 0 8px;border-top:1px solid #EFEDE6"><span style="font-family:Georgia,serif;font-size:13.5px;font-weight:700;color:#14202B">Últimos posteos, por interacción</span></div>' +
              (posteos.length
                ? '<table role="presentation" style="width:100%;border-collapse:collapse">' + filasPosteos + '</table>'
                : '<p style="margin:0;font-size:12.5px;color:#8A93A0;font-style:italic">Sin posteos recientes.</p>') +
            '</div>' +
            '<div style="padding:22px 32px 26px;font-size:11px;color:#8A93A0;border-top:1px solid #E7E4DC;margin-top:22px">' +
              'Generado automáticamente todos los lunes · @' + resumen.usuario + ' tiene ' + resumen.totalPosteos + ' posteos en total' +
            '</div>' +
          '</div>',
      });
      enviado = true;
    }

    return res.status(200).json({ ok: true, enviado: enviado, resumen: resumen });
  } catch (e) {
    console.error('cron-resumen-instagram:', e.message);
    return res.status(200).json({ ok: false, error: e.message });
  }
};
