// api/enviar-propuesta-c21.js
// ── ONE-OFF (solo admin) ──
// Envía la propuesta de MudateYa a las oficinas CENTURY 21 de AMBA + Córdoba +
// Rosario (84), personalizada con el nombre de cada oficina, desde
// contacto@mudateya.ar, con CTA a registrarse en /c21-registro.html.
// Mismo patrón que enviar-propuesta-remax.js (copiado y adaptado).
//
// ENVÍO: usa el batch de Resend (hasta 100 por llamada) → 1 sola llamada para las 84.
//
// IDEMPOTENCIA: guarda los emails ya enviados en Redis (clave c21-propuesta:enviados,
// un array). Si se vuelve a correr, saltea los que ya recibieron — nunca duplica.
//
// SEGURIDAD: solo admin con ?token=ADMIN_TOKEN.
//   GET ?token=…              → DRY: cuenta pendientes/enviadas, NO envía nada.
//   GET ?token=…&test=x@y.com → envía UNA muestra a esa dirección (no marca).
//   GET ?token=…&apply=1      → ENVÍA a todas las pendientes (una sola corrida).

const { Resend } = require('resend');
const { esAdmin, esCronVercel } = require('./_auth');
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

var CLAVE_ENVIADOS = 'c21-propuesta:enviados';

// ── Oficinas CENTURY 21 de AMBA + Córdoba + Rosario — 84 ──
var OFICINAS = require('./_c21-oficinas');

function emailPropuesta(o) {
  var nm = esc(o.n || 'tu oficina');
  var linkB = linkBaja(o.e, 'c21-propuesta');
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
          '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">Te escribimos para invitar a tu oficina a sumarse a <strong>MudateYa</strong> — es una oportunidad concreta, y sin costo, para tus asesores.</p>' +
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
            '<a href="https://mudateya.ar/c21-registro.html" style="display:inline-block;background:#22C36A;color:#fff;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none">Registro para asesores →</a>' +
          '</div>' +
          '<div style="text-align:center;margin:22px 0 4px">' +
            '<a href="https://instagram.com/mudateya.ar" style="display:inline-block;color:#003580;font-size:13px;font-weight:700;text-decoration:none">📸 Seguinos en Instagram &#64;mudateya.ar</a>' +
          '</div>' +
          '<p style="color:#94A3B8;font-size:11px;text-align:center;margin:16px 0 0;border-top:1px solid #E2E8F0;padding-top:16px">Recibís este correo como oficina CENTURY 21. <a href="' + linkB + '" style="color:#94A3B8;text-decoration:underline">Darte de baja</a>.<br>MudateYa · mudateya.ar</p>' +
        '</div>' +
      '</div>'
  };
}

function payloadDe(o) {
  var m = emailPropuesta(o);
  var link = linkBaja(o.e, 'c21-propuesta');
  return {
    from: 'MudateYa <contacto@mudateya.ar>', to: o.e, subject: m.subject, html: m.html,
    headers: {
      'List-Unsubscribe': '<' + link + '>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    }
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
  var testTo = req.query && req.query.test ? String(req.query.test).trim() : '';
  var apply  = esVercelCron || (req.query && req.query.apply === '1');

  try {
    // ── TEST: una muestra (no marca) ──
    if (testTo) {
      if (!validEmail(testTo)) return res.status(400).json({ error: 'Email de test inválido' });
      var rt = await resend.emails.send(payloadDe({ n: 'CENTURY 21 Test', e: testTo }));
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
          unoAUno = true;
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
    console.error('Error en enviar-propuesta-c21:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
