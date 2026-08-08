// api/enviar-invitacion-mudanceros.js
// ── ONE-OFF (solo admin) ──
// Invita a empresas de mudanza/fletes de AMBA, Córdoba y Rosario (encontradas
// por prospección web, no son clientes actuales) a sumarse como mudanceros
// verificados en MudateYa. Mail genérico desde hola@mudateya.ar, CTA a
// /mudanceros.
//
// DEDUP contra mudanceros que YA están en la plataforma (para no invitar a
// alguien que ya se registró): antes de mandar, chequea en Redis
//   1) si existe mudancero:perfil:{email}  (dedup por mail)
//   2) si el teléfono matchea mudanceros:tel8-idx (dedup por WhatsApp/tel,
//      últimos 8 dígitos — mismo índice que usa el bot de WhatsApp)
// Si cualquiera de los dos matchea, se saltea (no se manda).
//
// IDEMPOTENCIA propia de esta campaña: guarda los emails ya invitados en
// Redis (clave invitacion-mudanceros:enviados). Si se corre de nuevo, no
// duplica.
//
// SEGURIDAD: admin con ?token=ADMIN_TOKEN, o Vercel Cron (header Authorization
// Bearer CRON_SECRET — mismo mecanismo que enviar-propuesta-remax.js).
//   GET ?token=…              → DRY: cuenta pendientes/enviados/ya-mudanceros, NO envía nada.
//   GET ?token=…&test=x@y.com → envía UNA muestra a esa dirección (no marca, no chequea dedup).
//   GET ?token=…&apply=1      → ENVÍA a los pendientes (una sola corrida).
//   Vercel Cron                → aplica automático (agendado para las 9AM ART del 2026-08-08,
//                                 igual que enviar-propuesta-remax/garantías; idempotente, así
//                                 que si el cron sigue corriendo días después no reenvía nada).

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

// Saca todas las secuencias numéricas "tipo teléfono" de un string libre
// (puede traer varios números separados por "/", prefijos, "WhatsApp", etc.)
// y devuelve los últimos 8 dígitos de cada una — mismo criterio que
// mudanceros:tel8-idx.
function telefonosCandidatos(raw) {
  var out = [];
  var matches = String(raw || '').match(/\d[\d\s().-]{5,}\d/g) || [];
  matches.forEach(function(m) {
    var digits = m.replace(/\D/g, '');
    if (digits.length >= 8) out.push(digits.slice(-8));
  });
  return out;
}

var CLAVE_ENVIADOS = 'invitacion-mudanceros:enviados';

// ── Prospectos: empresas de mudanza/fletes en AMBA, Córdoba y Rosario ──
// Encontrados por búsqueda web (sitio propio de cada empresa), NO son
// mudanceros ya registrados en MudateYa — eso se chequea aparte en caliente
// contra Redis (ver yaEsMudancero). Solo incluye los que tienen email
// confirmado en su propia web (se descartaron ~49 que solo tenían
// teléfono/WhatsApp — esos van por otro canal, no por este script).
// Quedaron afuera por dato dudoso (revisar a mano si se quiere sumar):
//   - Cassandra Moving (cassandramooving@gmail.com, posible typo vs. dominio)
//   - Flete Master Rosario (email visto solo en snippet de búsqueda, no confirmado en el sitio)
var PROSPECTOS = [
  // AMBA
  { n: 'Vía MG', region: 'AMBA', e: 'viamg2015@gmail.com', tel: '11 6622-6123' },
  { n: 'Fletes Balvanera', region: 'AMBA', e: 'info@fletesbalvanera.com.ar', tel: '11 6860-3466' },
  { n: 'Fletes Ya', region: 'AMBA', e: 'contacto@fletesya.com.ar', tel: '+54 11 3221-0924' },
  { n: 'Fletes Baires', region: 'AMBA', e: 'hola@fletesbaires.com', tel: '(+5411) 4146-6082' },
  { n: 'Retroflet', region: 'AMBA', e: 'reservas@retroflet.com.ar', tel: '11 5639-0253 / 11 2040-1113' },
  { n: 'Transportes Vintage', region: 'AMBA', e: 'transportesvintage@gmail.com', tel: '11 5095-3053' },
  { n: 'Fletes y Mudanzas Nelson', region: 'AMBA', e: 'info@fletesymudanzasnelson.com.ar', tel: '011 4931-9102 / 11 6300-8580' },
  { n: 'Mudanzas Capital', region: 'AMBA', e: 'info@mudanzascapital.com.ar', tel: '011 4931-8570' },
  { n: 'Logística Almagro', region: 'AMBA', e: 'info@almagrologistica.com.ar', tel: '11 2176-4640' },
  { n: 'Mudanzas Norte', region: 'AMBA', e: 'contacto@mudanzasnorte.com.ar', tel: '11 4030-1055' },
  { n: 'Transporte SC', region: 'AMBA', e: 'info@transporte-sc.com.ar', tel: '11 6095-1997' },
  { n: 'Mudanzas Independencia', region: 'AMBA', e: 'info@mudanzasindependencia.com.ar', tel: '4931-8570 / 11-4055-3982' },
  { n: 'Transportes Argentinos', region: 'AMBA', e: 'info@transportesargentinos.com.ar', tel: '011 5263-0443' },
  // Córdoba
  { n: 'Mudanzas Nueva Córdoba', region: 'Córdoba', e: 'mudanzasnuevacordoba@gmail.com', tel: '+54 9 351 811-7933' },
  { n: 'Fu Fletes', region: 'Córdoba', e: 'fletesfu@hotmail.com', tel: '(0351) 471-7271 / +54 9 351 619-6876' },
  { n: 'CordobaFletes.com.ar', region: 'Córdoba', e: 'die60cr@gmail.com', tel: '0351 15-385-0577' },
  { n: 'Fletes Cor Mudanzas', region: 'Córdoba', e: 'info@fletescor.com', tel: '+54 9 351 340-4918' },
  { n: 'Grupo Fletes Córdoba', region: 'Córdoba', e: 'fletescordoba.ar@gmail.com', tel: '+54 9 351 818-7650' },
  { n: 'Cor-Flet', region: 'Córdoba', e: 'cor-flet@hotmail.com', tel: '351 274-1711' },
  { n: 'Mudanzas Acuario', region: 'Córdoba', e: 'mudanzasacuario@hotmail.com', tel: '(0351) 695-0035 / (0351) 15-612-9602' },
  // Rosario
  { n: 'Mudanzas Ya Rosario', region: 'Rosario', e: 'info@mudanzasyarosario.com.ar', tel: '+54 341 5103104 / +54 341 3342392' },
  { n: 'Bannelli Mudanzas', region: 'Rosario', e: 'mudanzasbannelli@hotmail.com', tel: '(0341) 154 68-1298 / 454-6657' },
  { n: 'Mudanzas América', region: 'Rosario', e: 'info@mudanzasamerica.com.ar', tel: '(0341) 156 585 606 / 156 847 739' },
  { n: 'Fletes Rosario', region: 'Rosario', e: 'miguelpulidook@gmail.com', tel: '341-209-3808' },
  { n: 'Fletes E&M', region: 'Rosario', e: 'fleteseymrosario@gmail.com', tel: '(0341) 155954223 / 156894869' },
  { n: 'Fletes Zona Norte', region: 'Rosario', e: 'info@fletes-zonanorte.com.ar', tel: '4793-1436 / 15-6802-8251' },
  { n: 'Mudanzas España', region: 'Rosario', e: 'contacto@mudanzasrosario.online', tel: '(0341) 482-3815 / 552-2322' }
];

function emailInvitacion(o) {
  var nm = esc(o.n || 'equipo');
  var linkB = linkBaja(o.e, 'invitacion-mudanceros');
  return {
    subject: o.n + ': sumate a MudateYa como mudancero verificado',
    html:
      '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">' +
        '<div style="background:#003580;padding:22px 28px;text-align:center">' +
          '<span style="font-family:Arial Black,Arial,sans-serif;font-size:28px;font-weight:900;letter-spacing:2px;color:#fff">MUDATE</span>' +
          '<span style="font-family:Arial Black,Arial,sans-serif;font-size:28px;font-weight:900;letter-spacing:2px;color:#22C36A">YA</span>' +
        '</div>' +
        '<div style="padding:28px">' +
          '<h2 style="margin:0 0 12px;color:#0F1923;font-size:20px">Hola, equipo de ' + nm + ' 👋</h2>' +
          '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">Te escribimos desde <strong>MudateYa</strong>, un marketplace argentino que conecta a mudanceros y fleteros verificados con clientes que están por mudarse.</p>' +
          '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">Publicás tu perfil, recibís pedidos reales de tu zona y cotizás cuando te conviene — sin obligación de aceptar todos.</p>' +
          '<div style="background:#F5F7FA;border-radius:12px;padding:14px 20px;margin-bottom:18px;text-align:center">' +
            '<span style="display:inline-block;margin:4px 8px;font-size:12px;font-weight:700;color:#003580;background:#E5ECF6;padding:6px 12px;border-radius:999px">Sin costo de alta</span>' +
            '<span style="display:inline-block;margin:4px 8px;font-size:12px;font-weight:700;color:#003580;background:#E5ECF6;padding:6px 12px;border-radius:999px">Pedidos reales de tu zona</span>' +
            '<span style="display:inline-block;margin:4px 8px;font-size:12px;font-weight:700;color:#003580;background:#E5ECF6;padding:6px 12px;border-radius:999px">Vos elegís qué cotizar</span>' +
          '</div>' +
          '<div style="text-align:center;margin:20px 0">' +
            '<a href="https://mudateya.ar/mudanceros" style="display:inline-block;background:#22C36A;color:#fff;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none">Sumarme como mudancero →</a>' +
          '</div>' +
          '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0">Si tenés dudas, respondé este mail y te contamos más.</p>' +
          '<p style="color:#94A3B8;font-size:11px;text-align:center;margin:22px 0 0;border-top:1px solid #E2E8F0;padding-top:16px">Recibís este correo porque tu empresa figura como mudancero/fletero en tu zona. <a href="' + linkB + '" style="color:#94A3B8;text-decoration:underline">Darte de baja</a>.<br>MudateYa · hola@mudateya.ar · mudateya.ar</p>' +
        '</div>' +
      '</div>'
  };
}

function payloadDe(o) {
  var m = emailInvitacion(o);
  var link = linkBaja(o.e, 'invitacion-mudanceros');
  return {
    from: 'MudateYa <hola@mudateya.ar>', to: o.e, subject: m.subject, html: m.html,
    headers: {
      'List-Unsubscribe': '<' + link + '>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    }
  };
}

// true si ya es mudancero registrado en MudateYa (por email o por teléfono)
async function yaEsMudancero(o) {
  var perfil = await redisCall('get', ['mudancero:perfil:' + o.e.toLowerCase()]);
  if (perfil) return true;
  var tels = telefonosCandidatos(o.tel);
  for (var i = 0; i < tels.length; i++) {
    var match = await redisCall('hget', ['mudanceros:tel8-idx', tels[i]]);
    if (match) return true;
  }
  return false;
}

module.exports = async function handler(req, res) {
  var esVercelCron = esCronVercel(req);
  // En previews (no producción) el cron no debe enviar nada.
  if (esVercelCron && process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    return res.status(200).json({ ok: true, skipped: true, reason: 'no-production-env' });
  }
  if (!esVercelCron && !esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
  if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY no configurado' });

  var resend = new Resend(process.env.RESEND_API_KEY);
  var testTo = req.query && req.query.test ? String(req.query.test).trim() : '';
  var apply  = esVercelCron || (req.query && req.query.apply === '1');

  try {
    // ── TEST: una muestra (no marca, no chequea dedup) ──
    if (testTo) {
      if (!validEmail(testTo)) return res.status(400).json({ error: 'Email de test inválido' });
      var rt = await resend.emails.send(payloadDe({ n: 'Vía MG', e: testTo, tel: '' }));
      if (rt && rt.error) return res.status(502).json({ error: rt.error });
      return res.status(200).json({ ok: true, test: true, enviadoA: testTo });
    }

    // ── Ya invitados en esta campaña ──
    var enviados = (await getJSON(CLAVE_ENVIADOS)) || [];
    var enviadosSet = {}; enviados.forEach(function(e){ enviadosSet[String(e).toLowerCase()] = 1; });
    var suprimidos = (await redisCall('smembers', ['baja:emails'])) || [];
    var suprSet = {}; suprimidos.forEach(function(e){ suprSet[String(e).toLowerCase()] = 1; });

    // ── Filtrar: no repetidos de esta campaña, no suprimidos, y no ya-mudanceros ──
    var candidatos = PROSPECTOS.filter(function(o){
      var k = o.e.toLowerCase();
      return !enviadosSet[k] && !suprSet[k];
    });
    var pendientes = [];
    var yaMudanceros = [];
    for (var c = 0; c < candidatos.length; c++) {
      var o = candidatos[c];
      if (await yaEsMudancero(o)) yaMudanceros.push(o.n + ' <' + o.e + '>');
      else pendientes.push(o);
    }

    // ── DRY (sin apply): informa, no envía ──
    if (!apply) {
      return res.status(200).json({
        ok: true, dry: true,
        totalProspectos: PROSPECTOS.length,
        yaInvitados: enviados.length,
        suprimidos: suprimidos.length,
        yaMudanceros: yaMudanceros.length,
        yaMudancerosMuestra: yaMudanceros.slice(0, 8),
        pendientes: pendientes.length,
        muestra: pendientes.slice(0, 8).map(function(o){ return o.n + ' <' + o.e + '>'; })
      });
    }

    // ── APPLY: enviar. Preferimos batch (rápido); si no está disponible o falla,
    //    caemos a envío uno por uno para no perder el lote. ──
    var resumen = { enviados: 0, errores: 0, fallidos: [], omitidosYaMudanceros: yaMudanceros.length };
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
          for (var b = 0; b < grupos[g].length; b++) { await _marcar(grupos[g][b].e); resumen.enviados++; }
        } catch (eb) {
          resumen.fallidos.push({ lote: g, modo: 'batch', error: eb.message });
          unoAUno = true; // reintentamos el lote uno por uno
        }
      }
      if (unoAUno) {
        for (var q = 0; q < grupos[g].length; q++) {
          var o = grupos[g][q];
          try { await _enviarUno(o); await _marcar(o.e); resumen.enviados++; }
          catch (e2) { resumen.errores++; resumen.fallidos.push({ email: o.e, error: e2.message }); }
          await new Promise(function(ok){ setTimeout(ok, 130); });
        }
      }
    }
    return res.status(200).json({ ok: true, aplicado: true, batchDisponible: hayBatch, ...resumen });
  } catch (e) {
    console.error('Error en enviar-invitacion-mudanceros:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
