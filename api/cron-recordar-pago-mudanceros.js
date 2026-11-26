// api/cron-recordar-pago-mudanceros.js
//
// Le avisa al admin POR MAIL, UNA SOLA VEZ, cuando hay pagos a mudanceros que ya cumplieron la retención de
// 15 días hábiles y hay que liquidarlos (los que el panel Liquidaciones pasa de "En retención" a "Por liquidar").
// Un solo mail por corrida, agrupado por mudancero, con el total a transferir.
//
// NO REPITE: cada pago avisado queda marcado en Redis (liq:avisado:{mudanzaId}:{tipoPago}); el mail del día
// siguiente solo incluye pagos nuevos. Un pago ya liquidado desde el panel (liquidadoAnticipoEn/SaldoEn) no se avisa.
//
// Corre de lunes a viernes a las 7am AR (vercel.json: "0 10 * * 1-5"). Fines de semana y feriados no cuentan como
// hábiles: lo que venza ese día se avisa el próximo día hábil. Chequeo manual (admin):
//   GET /api/cron-recordar-pago-mudanceros?token=ADMIN_TOKEN        → manda el mail si hay pagos nuevos
//   &simular=1  → no manda ni marca nada, solo devuelve qué avisaría
//
// OJO: la comisión (feePct) replica la de action=admin-pagos en cotizaciones.js. Si cambia allá, cambiarla acá.

var { esAdmin, esCronVercel } = require('./_auth');
var { esDiaHabil, aHoraAR } = require('./_habiles');

var DIAS_LIQUIDACION = 15; // mismo plazo que admin.html (DIAS_LIQUIDACION)

async function redisCall(method, ...args) {
  var url = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  var r = await fetch(url + '/' + [method, ...args].map(encodeURIComponent).join('/'), {
    headers: { Authorization: 'Bearer ' + token },
  });
  var d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}
async function getJSON(key) {
  var v = await redisCall('GET', key);
  return v ? JSON.parse(v) : null;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function pesos(n) { return '$' + Number(n || 0).toLocaleString('es-AR'); }

// Día de calendario (AR) en que se libera un pago: fechaPago + 15 días hábiles. Devuelve 'YYYY-MM-DD'.
function diaLiberacion(fechaPagoISO) {
  var d = aHoraAR(new Date(fechaPagoISO)); // Date "corrido" a hora AR, se lee con getUTC*
  if (isNaN(d)) return null;
  var cont = 0;
  while (cont < DIAS_LIQUIDACION) {
    d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
    if (esDiaHabil(d)) cont++;
  }
  return d.toISOString().slice(0, 10);
}

module.exports = async function handler(req, res) {
  var esVercelCron = false;
  try { esVercelCron = esCronVercel(req); } catch (e) {}
  var admin = false;
  try { admin = esAdmin(req); } catch (e) {}
  if (!esVercelCron && !admin) return res.status(401).json({ error: 'No autorizado' });
  var simular = admin && req.query && req.query.simular === '1';

  var hoyAR = aHoraAR(new Date()).toISOString().slice(0, 10);
  var activas = (await getJSON('mudanzas:activas')) || [];
  var nuevos = [];

  for (var i = 0; i < activas.length; i++) {
    try {
      var m = await getJSON('mudanza:' + activas[i]);
      if (!m || !(m.anticipoPagado || m.saldoPagado)) continue;
      var esFlete = String(m.tipo || '').toLowerCase() === 'flete';
      var esPlanReferidos = !!(m.origenCanal === true || m.origenAsesor === true || m.refAliado || m.partner || m.partnerAsesor || m.partnerSlugCrudo);
      var feePct = m.sinComisionPlataforma ? 0 : (esFlete ? 0.20 : (esPlanReferidos ? 0.25 : 0.15));
      var cot = m.cotizacionAceptada || {};
      var precioBase = parseInt(cot.precio || m.precio_estimado || 0);
      var pagos = [];
      if (m.anticipoPagado) {
        var mA = parseInt(m.anticipoMonto) || Math.round(precioBase * 0.5);
        pagos.push({ tipoPago: 'anticipo', bruto: mA, fechaPago: m.fechaPagoAnticipo, liquidado: !!m.liquidadoAnticipoEn });
      }
      if (m.saldoPagado) {
        var antPagado = parseInt(m.anticipoMonto || 0) || 0;
        var mS = parseInt(m.saldoMonto) || Math.max(0, precioBase - antPagado) || Math.round(precioBase * 0.5);
        pagos.push({ tipoPago: 'saldo', bruto: mS, fechaPago: m.fechaPagoSaldo, liquidado: !!m.liquidadoSaldoEn });
      }
      for (var j = 0; j < pagos.length; j++) {
        var p = pagos[j];
        if (p.liquidado || !p.fechaPago) continue;
        var lib = diaLiberacion(p.fechaPago);
        if (!lib || lib > hoyAR) continue; // todavía en retención
        var clave = 'liq:avisado:' + m.id + ':' + p.tipoPago;
        if (await redisCall('GET', clave)) continue; // ya se avisó
        nuevos.push({
          clave: clave,
          mudanceroNombre: cot.mudanceroNombre || '—',
          mudanceroEmail: cot.mudanceroEmail || '',
          tipoPago: p.tipoPago,
          ruta: String(m.desde || '').split(',')[0] + ' → ' + String(m.hasta || '').split(',')[0],
          neto: p.bruto - Math.round(p.bruto * feePct),
          liberado: lib,
        });
      }
    } catch (e) { console.warn('cron-recordar-pago-mudanceros: error en mudanza', activas[i], e.message); }
  }

  if (!nuevos.length) return res.status(200).json({ ok: true, hoy: hoyAR, nuevos: 0 });

  var total = nuevos.reduce(function (s, x) { return s + x.neto; }, 0);
  if (simular) return res.status(200).json({ ok: true, simulacion: true, hoy: hoyAR, nuevos: nuevos.length, total: total, detalle: nuevos.map(function (x) { return { mudancero: x.mudanceroNombre, tipo: x.tipoPago, ruta: x.ruta, neto: x.neto, liberado: x.liberado }; }) });

  if (!process.env.RESEND_API_KEY || !process.env.ADMIN_EMAIL) {
    return res.status(200).json({ ok: false, error: 'Falta RESEND_API_KEY o ADMIN_EMAIL: no se mandó el mail' });
  }

  // Agrupar por mudancero
  var grupos = {};
  nuevos.forEach(function (x) {
    var k = x.mudanceroEmail || x.mudanceroNombre;
    (grupos[k] = grupos[k] || { nombre: x.mudanceroNombre, items: [], total: 0 });
    grupos[k].items.push(x);
    grupos[k].total += x.neto;
  });
  var filas = Object.keys(grupos).map(function (k) {
    var g = grupos[k];
    var detalle = g.items.map(function (x) {
      return '<div style="font-size:13px;color:#5B6472;margin-top:3px">' + (x.tipoPago === 'anticipo' ? 'Anticipo' : 'Saldo') + ' · ' + esc(x.ruta) + ' · ' + pesos(x.neto) + '</div>';
    }).join('');
    return '<div style="border:1px solid #E2E8F0;border-radius:10px;padding:12px 14px;margin-bottom:10px">' +
      '<div style="display:flex;justify-content:space-between;font-weight:700;font-size:15px"><span>' + esc(g.nombre) + '</span><span style="color:#003580">' + pesos(g.total) + '</span></div>' + detalle + '</div>';
  }).join('');

  try {
    var { Resend } = require('./_resend-seguro');
    var resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: 'MudateYa <noreply@mudateya.ar>',
      to: process.env.ADMIN_EMAIL,
      subject: '💸 Hay que pagar a mudanceros — ' + pesos(total),
      html: '<div style="font-family:Arial,sans-serif;max-width:520px;margin:24px auto;color:#14202B">' +
        '<h2 style="margin:0 0 6px;font-size:19px">Ya cumplieron la retención: toca pagar</h2>' +
        '<p style="color:#5B6472;font-size:13.5px;margin:0 0 16px">' + nuevos.length + (nuevos.length === 1 ? ' pago listo' : ' pagos listos') + ' para transferir (neto, ya descontada la comisión).</p>' +
        filas +
        '<p style="margin:14px 0 0;font-size:26px;font-weight:800;color:#003580">Total: ' + pesos(total) + '</p>' +
        '<a href="' + (process.env.SITE_URL || 'https://mudateya.ar') + '/admin" style="display:inline-block;background:#003580;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:700;margin-top:16px">Ir a Liquidaciones →</a>' +
        '<p style="color:#8A93A0;font-size:11.5px;margin-top:20px">MudateYa · aviso automático, una sola vez por pago. Después de transferir, marcalo como ✓ Liquidado en el panel.</p>' +
        '</div>',
    });
  } catch (e) {
    console.warn('cron-recordar-pago-mudanceros: no se pudo mandar el mail:', e.message);
    return res.status(200).json({ ok: false, error: 'No se pudo mandar el mail: ' + e.message });
  }

  // Recién con el mail enviado se marcan como avisados (si falla el envío, mañana se reintenta).
  for (var k2 = 0; k2 < nuevos.length; k2++) {
    try { await redisCall('SET', nuevos[k2].clave, String(Date.now()), 'EX', String(400 * 24 * 60 * 60)); } catch (e) {}
  }
  return res.status(200).json({ ok: true, hoy: hoyAR, nuevos: nuevos.length, total: total });
};
