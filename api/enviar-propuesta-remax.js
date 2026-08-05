// api/enviar-propuesta-remax.js
// ── ONE-OFF (solo admin) ──
// Envía la propuesta de MudateYa a las oficinas RE/MAX de AMBA (127), personalizada
// con el nombre de cada oficina, desde contacto@mudateya.ar, con CTA a registrarse
// en /remax-registro.html. Los emails salen de la API pública de RE/MAX (findAll),
// filtrados a AMBA por coordenadas (CABA + GBA + La Plata).
//
// ENVÍO: usa el batch de Resend (hasta 100 por llamada) → 2 llamadas para las 127,
// rápido y sin chocar el rate limit ni el timeout de la función.
//
// IDEMPOTENCIA: guarda los emails ya enviados en Redis (clave remax-propuesta:enviados,
// un array). Si se vuelve a correr, saltea los que ya recibieron — nunca duplica.
//
// SEGURIDAD: solo admin con ?token=ADMIN_TOKEN.
//   GET ?token=…              → DRY: cuenta pendientes/enviadas, NO envía nada.
//   GET ?token=…&test=x@y.com → envía UNA muestra a esa dirección (no marca).
//   GET ?token=…&apply=1      → ENVÍA a todas las pendientes (una sola corrida).

const { Resend } = require('resend');
const { esAdmin } = require('./_auth');
const { linkBaja } = require('./_baja');

async function redisCall(method, args) {
  var url = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  var r = await fetch(url + '/' + method + '/' + args.map(encodeURIComponent).join('/'), {
    headers: { Authorization: 'Bearer ' + token }
  });
  var data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}
async function getJSON(k) { var v = await redisCall('get', [k]); if (!v) return null; try { return JSON.parse(v); } catch(e) { return null; } }
async function setJSON(k, v) { return redisCall('set', [k, JSON.stringify(v)]); }

function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim()); }
function esc(s) { return String(s || '').replace(/[<>&"]/g, function(c){ return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]; }); }
function chunk(arr, size) { var out = []; for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; }

var CLAVE_ENVIADOS = 'remax-propuesta:enviados';

// ── Oficinas RE/MAX de AMBA (CABA + GBA + La Plata) — 127 ──
var OFICINAS = [
  {n:'REMAX 197', e:'197@remax.com.ar'},
  {n:'REMAX 202', e:'202@remax.com.ar'},
  {n:'REMAX Acción', e:'accion@remax.com.ar'},
  {n:'REMAX Actitud', e:'actitud@remax.com.ar'},
  {n:'REMAX Advance', e:'advance@remax.com.ar'},
  {n:'REMAX Alfa', e:'alfa@remax.com.ar'},
  {n:'REMAX Alfil', e:'alfil@remax.com.ar'},
  {n:'REMAX Alianza', e:'alianza@remax.com.ar'},
  {n:'REMAX Amazing', e:'amazing@remax.com.ar'},
  {n:'REMAX Apolo', e:'apolo@remax.com.ar'},
  {n:'REMAX Avenida', e:'avenida@remax.com.ar'},
  {n:'REMAX Ayres', e:'ayres@remax.com.ar'},
  {n:'REMAX Beat', e:'beat@remax.com.ar'},
  {n:'REMAX Believe', e:'believe@remax.com.ar'},
  {n:'REMAX Blue', e:'blue@remax.com.ar'},
  {n:'REMAX Buró', e:'buro@remax.com.ar'},
  {n:'REMAX Buró II', e:'buro2@remax.com.ar'},
  {n:'REMAX Caminos', e:'caminos@remax.com.ar'},
  {n:'REMAX Capital', e:'capital@remax.com.ar'},
  {n:'REMAX Centenario', e:'centenario@remax.com.ar'},
  {n:'REMAX Cimientos', e:'cimientos@remax.com.ar'},
  {n:'REMAX Class', e:'class@remax.com.ar'},
  {n:'REMAX Class II', e:'class2@remax.com.ar'},
  {n:'REMAX Class III', e:'class3@remax.com.ar'},
  {n:'REMAX Cosmopolita', e:'cosmopolita@remax.com.ar'},
  {n:'REMAX Crea', e:'crea@remax.com.ar'},
  {n:'REMAX Cromo', e:'cromo@remax.com.ar'},
  {n:'REMAX Cuore', e:'cuore@remax.com.ar'},
  {n:'REMAX Data Gold', e:'datagold@remax.com.ar'},
  {n:'REMAX Data House', e:'datahouse@remax.com.ar'},
  {n:'REMAX Data Lagos', e:'lagos@remax.com.ar'},
  {n:'REMAX Data Work', e:'datawork@remax.com.ar'},
  {n:'REMAX Del Plata', e:'delplata@remax.com.ar'},
  {n:'REMAX Deluxe', e:'deluxe@remax.com.ar'},
  {n:'REMAX Desafío', e:'desafio@remax.com.ar'},
  {n:'REMAX Desafío II', e:'desafio2@remax.com.ar'},
  {n:'REMAX Diagonal II', e:'diagonal2@remax.com.ar'},
  {n:'REMAX Domira', e:'domira@remax.com.ar'},
  {n:'REMAX Downtown', e:'downtown@remax.com.ar'},
  {n:'REMAX Dreams', e:'dreams@remax.com.ar'},
  {n:'REMAX Duo', e:'duo@remax.com.ar'},
  {n:'REMAX Emblema', e:'emblema@remax.com.ar'},
  {n:'REMAX Encore', e:'encore@remax.com.ar'},
  {n:'REMAX Energy', e:'energy@remax.com.ar'},
  {n:'REMAX Enjoy', e:'enjoy@remax.com.ar'},
  {n:'REMAX Espacio', e:'espacio@remax.com.ar'},
  {n:'REMAX Estilo', e:'estilo@remax.com.ar'},
  {n:'REMAX Estudio', e:'estudio@remax.com.ar'},
  {n:'REMAX Evolution', e:'evolution@remax.com.ar'},
  {n:'REMAX Eximia', e:'eximia@remax.com.ar'},
  {n:'REMAX Express', e:'express@remax.com.ar'},
  {n:'REMAX Extremo', e:'extremo@remax.com.ar'},
  {n:'REMAX Fire', e:'fire@remax.com.ar'},
  {n:'REMAX Flow', e:'flow@remax.com.ar'},
  {n:'REMAX Fly', e:'fly@remax.com.ar'},
  {n:'REMAX Free', e:'free@remax.com.ar'},
  {n:'REMAX Friends', e:'friends@remax.com.ar'},
  {n:'REMAX GO', e:'go@remax.com.ar'},
  {n:'REMAX Grammar', e:'grammar@remax.com.ar'},
  {n:'REMAX Harmony', e:'harmony@remax.com.ar'},
  {n:'REMAX Heart', e:'heart@remax.com.ar'},
  {n:'REMAX Home', e:'home@remax.com.ar'},
  {n:'REMAX Horizonte', e:'horizonte@remax.com.ar'},
  {n:'REMAX Ilusión', e:'ilusion@remax.com.ar'},
  {n:'REMAX Invictus', e:'invictus@remax.com.ar'},
  {n:'REMAX Iron', e:'iron@remax.com.ar'},
  {n:'REMAX Juntos', e:'juntos@remax.com.ar'},
  {n:'REMAX La Vie', e:'lavie@remax.com.ar'},
  {n:'REMAX Legado', e:'legado@remax.com.ar'},
  {n:'REMAX Leven', e:'leven@remax.com.ar'},
  {n:'REMAX Life', e:'life@remax.com.ar'},
  {n:'REMAX Link', e:'link@remax.com.ar'},
  {n:'REMAX Metro', e:'metro@remax.com.ar'},
  {n:'REMAX Mirage', e:'mirage@remax.com.ar'},
  {n:'REMAX Moments', e:'moments@remax.com.ar'},
  {n:'REMAX Namai', e:'namai@remax.com.ar'},
  {n:'REMAX Nativo', e:'nativo@remax.com.ar'},
  {n:'REMAX Naval', e:'naval@remax.com.ar'},
  {n:'REMAX Net', e:'net@remax.com.ar'},
  {n:'REMAX New', e:'new@remax.com.ar'},
  {n:'REMAX Nexo', e:'nexo@remax.com.ar'},
  {n:'REMAX Nova', e:'nova@remax.com.ar'},
  {n:'REMAX Origen', e:'origen@remax.com.ar'},
  {n:'REMAX Paradise', e:'paradise@remax.com.ar'},
  {n:'REMAX Parque', e:'parque@remax.com.ar'},
  {n:'REMAX Parque III', e:'parque3@remax.com.ar'},
  {n:'REMAX Platino', e:'platino@remax.com.ar'},
  {n:'REMAX Platino II', e:'platino2@remax.com.ar'},
  {n:'REMAX Platino III', e:'platino3@remax.com.ar'},
  {n:'REMAX Potencia', e:'potencia@remax.com.ar'},
  {n:'REMAX Power', e:'power@remax.com.ar'},
  {n:'REMAX Premium', e:'premium@remax.com.ar'},
  {n:'REMAX Premium II', e:'premium2@remax.com.ar'},
  {n:'REMAX Premium III', e:'premium3@remax.com.ar'},
  {n:'REMAX Premium IV', e:'premium4@remax.com.ar'},
  {n:'REMAX Premium V', e:'premium5@remax.com.ar'},
  {n:'REMAX Propósito', e:'proposito@remax.com.ar'},
  {n:'REMAX Raíces', e:'raices@remax.com.ar'},
  {n:'REMAX Remeros', e:'remeros@remax.com.ar'},
  {n:'REMAX Rio', e:'rio@remax.com.ar'},
  {n:'REMAX Roble', e:'roble@remax.com.ar'},
  {n:'REMAX Roble II', e:'roble2@remax.com.ar'},
  {n:'REMAX Splendid', e:'splendid@remax.com.ar'},
  {n:'REMAX Stage', e:'stage@remax.com.ar'},
  {n:'REMAX Star', e:'star@remax.com.ar'},
  {n:'REMAX Sunset', e:'sunset@remax.com.ar'},
  {n:'REMAX Sur', e:'sur@remax.com.ar'},
  {n:'REMAX Tango', e:'tango@remax.com.ar'},
  {n:'REMAX Teatro', e:'teatro@remax.com.ar'},
  {n:'REMAX Time', e:'time@remax.com.ar'},
  {n:'REMAX Titanium', e:'titanium@remax.com.ar'},
  {n:'REMAX Total I', e:'total@remax.com.ar'},
  {n:'REMAX Towers', e:'towers@remax.com.ar'},
  {n:'REMAX Unidos', e:'unidos@remax.com.ar'},
  {n:'REMAX Uno', e:'uno@remax.com.ar'},
  {n:'REMAX Uno IV', e:'uno4@remax.com.ar'},
  {n:'REMAX Up', e:'up@remax.com.ar'},
  {n:'REMAX Urbana', e:'urbana@remax.com.ar'},
  {n:'REMAX Urbana II', e:'urbana2@remax.com.ar'},
  {n:'REMAX Urbana III', e:'urbana3@remax.com.ar'},
  {n:'REMAX Vanguard', e:'vanguard@remax.com.ar'},
  {n:'REMAX Vibra', e:'vibra@remax.com.ar'},
  {n:'REMAX Village', e:'village@remax.com.ar'},
  {n:'REMAX Vincit', e:'vincit@remax.com.ar'},
  {n:'REMAX Visión', e:'vision@remax.com.ar'},
  {n:'REMAX Vita', e:'vita@remax.com.ar'},
  {n:'REMAX Zenit', e:'zenit@remax.com.ar'}
];

function emailPropuesta(o) {
  var nm = esc(o.n || 'tu oficina');
  var linkB = linkBaja(o.e, 'remax-propuesta');
  return {
    subject: o.n + ': activá MudateYa para tu oficina',
    html:
      '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">' +
        '<div style="background:#003580;padding:22px 28px;text-align:center">' +
          '<span style="font-family:Bebas Neue,Arial,sans-serif;font-size:30px;font-weight:900;letter-spacing:2px;color:#fff">MUDATE</span>' +
          '<span style="font-family:Bebas Neue,Arial,sans-serif;font-size:30px;font-weight:900;letter-spacing:2px;color:#22C36A">YA</span>' +
        '</div>' +
        '<div style="padding:28px">' +
          '<h2 style="margin:0 0 12px;color:#0F1923;font-size:20px">Hola, equipo de ' + nm + ' 👋</h2>' +
          '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">Hace unos días te escribimos para invitar a tu oficina a sumarse a <strong>MudateYa</strong>. Te lo recordamos porque es una oportunidad concreta —y sin costo— para tus asesores.</p>' +
          '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">MudateYa es un marketplace de mudanzas con mudanceros verificados. Cada cliente que alquila o compra se muda: con nosotros, tus asesores le resuelven ese momento y quedan como héroes.</p>' +
          '<div style="background:#F5F7FA;border-radius:12px;padding:14px 20px;margin-bottom:18px">' +
            '<div style="font-size:12px;font-weight:700;color:#003580;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Beneficios para tus asesores:</div>' +
            '<ul style="margin:0;padding-left:20px;color:#0F1923;font-size:13px;line-height:1.6">' +
              '<li style="margin:6px 0">Cada asesor tiene su <strong>link propio</strong> para armar cotizaciones de mudanza en 2 minutos.</li>' +
              '<li style="margin:6px 0">Un <strong>servicio premium</strong> para el cliente justo después de la firma, sin que el equipo mueva un dedo.</li>' +
              '<li style="margin:6px 0"><strong>Gratis</strong> para la oficina y para el cliente. Un diferencial que la competencia no ofrece.</li>' +
            '</ul>' +
          '</div>' +
          '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 6px">Pasales este link a tus asesores: cada uno se registra en 30 seg y arma cotizaciones con su propio acceso.</p>' +
          '<div style="text-align:center;margin:20px 0">' +
            '<a href="https://mudateya.ar/remax-registro.html" style="display:inline-block;background:#22C36A;color:#fff;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none">Registro para asesores →</a>' +
          '</div>' +
          '<div style="text-align:center;margin:22px 0 4px">' +
            '<a href="https://instagram.com/mudateya.ar" style="display:inline-block;color:#003580;font-size:13px;font-weight:700;text-decoration:none">📸 Seguinos en Instagram &#64;mudateya.ar</a>' +
          '</div>' +
          '<p style="color:#94A3B8;font-size:11px;text-align:center;margin:16px 0 0;border-top:1px solid #E2E8F0;padding-top:16px">Recibís este correo como oficina RE/MAX. <a href="' + linkB + '" style="color:#94A3B8;text-decoration:underline">Darte de baja</a>.<br>MudateYa · mudateya.ar</p>' +
        '</div>' +
      '</div>'
  };
}

function payloadDe(o) {
  var m = emailPropuesta(o);
  var link = linkBaja(o.e, 'remax-propuesta');
  return {
    from: 'MudateYa <contacto@mudateya.ar>', to: o.e, subject: m.subject, html: m.html,
    headers: {
      'List-Unsubscribe': '<' + link + '>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    }
  };
}

module.exports = async function handler(req, res) {
  // Puede dispararlo el Vercel Cron (9am ART) o un admin con token.
  var esVercelCron = req.headers['x-vercel-cron'] === '1';
  // En previews (no producción) el cron no debe enviar nada.
  if (esVercelCron && process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    return res.status(200).json({ ok: true, skipped: true, reason: 'no-production-env' });
  }
  if (!esVercelCron && !esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
  if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY no configurado' });

  var resend = new Resend(process.env.RESEND_API_KEY);
  var testTo = req.query && req.query.test ? String(req.query.test).trim() : '';
  // El cron aplica automáticamente; manual requiere &apply=1. La idempotencia
  // (baja + ya-enviados) hace que las corridas siguientes no manden nada.
  var apply  = esVercelCron || (req.query && req.query.apply === '1');

  try {
    // ── TEST: una muestra (no marca) ──
    if (testTo) {
      if (!validEmail(testTo)) return res.status(400).json({ error: 'Email de test inválido' });
      var rt = await resend.emails.send(payloadDe({ n: 'REMAX Nova', e: testTo }));
      if (rt && rt.error) return res.status(502).json({ error: rt.error });
      return res.status(200).json({ ok: true, test: true, enviadoA: testTo });
    }

    // ── Pendientes (saltea las ya enviadas) ──
    var enviados = (await getJSON(CLAVE_ENVIADOS)) || [];
    var enviadosSet = {}; enviados.forEach(function(e){ enviadosSet[String(e).toLowerCase()] = 1; });
    var suprimidos = (await redisCall('smembers', ['baja:emails'])) || [];
    var suprSet = {}; suprimidos.forEach(function(e){ suprSet[String(e).toLowerCase()] = 1; });
    var pendientes = OFICINAS.filter(function(o){ var k = o.e.toLowerCase(); return !enviadosSet[k] && !suprSet[k]; });

    // ── DRY (sin apply): informa, no envía ──
    if (!apply) {
      return res.status(200).json({
        ok: true, dry: true,
        totalOficinas: OFICINAS.length,
        yaEnviadas: enviados.length,
        suprimidas: suprimidos.length,
        pendientes: pendientes.length,
        muestra: pendientes.slice(0, 8).map(function(o){ return o.e; })
      });
    }

    // ── APPLY: enviar. Preferimos batch (rápido); si no está en esta versión de
    //    Resend o falla, caemos a envío uno por uno para no perder el lote. ──
    var resumen = { enviadas: 0, errores: 0, fallidas: [] };
    async function _marcar(email){ enviados.push(email); await setJSON(CLAVE_ENVIADOS, enviados); }
    async function _enviarUno(o){
      var r1 = await resend.emails.send(payloadDe(o));
      if (r1 && r1.error) throw new Error(typeof r1.error === 'string' ? r1.error : JSON.stringify(r1.error));
    }
    var hayBatch = !!(resend.batch && typeof resend.batch.send === 'function');
    var grupos = chunk(pendientes, 100);
    for (var g = 0; g < grupos.length; g++) {
      var unoAUno = !hayBatch;
      if (hayBatch) {
        try {
          var rb = await resend.batch.send(grupos[g].map(payloadDe));
          if (rb && rb.error) throw new Error(typeof rb.error === 'string' ? rb.error : JSON.stringify(rb.error));
          for (var b = 0; b < grupos[g].length; b++) { await _marcar(grupos[g][b].e); resumen.enviadas++; }
        } catch (eb) {
          resumen.fallidas.push({ lote: g, modo: 'batch', error: eb.message });
          unoAUno = true; // reintentamos el lote uno por uno
        }
      }
      if (unoAUno) {
        for (var q = 0; q < grupos[g].length; q++) {
          var o = grupos[g][q];
          try { await _enviarUno(o); await _marcar(o.e); resumen.enviadas++; }
          catch (e2) { resumen.errores++; resumen.fallidas.push({ email: o.e, error: e2.message }); }
          await new Promise(function(ok){ setTimeout(ok, 130); });
        }
      }
    }
    return res.status(200).json({ ok: true, aplicado: true, batchDisponible: hayBatch, ...resumen });
  } catch (e) {
    console.error('Error en enviar-propuesta-remax:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
