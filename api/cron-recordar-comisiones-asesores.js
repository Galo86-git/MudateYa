// api/cron-recordar-comisiones-asesores.js
//
// El 10º día hábil de cada mes, le avisa al admin por mail el total de
// comisiones de asesores que quedaron disponibles para pagar: las que se
// generaron el mes anterior. Regla de negocio (2026-08-07): la comisión de un
// mes se paga recién el día hábil 10 del mes siguiente — mismo criterio que
// la retención de 15 días hábiles de los mudanceros, pero mensual y por lote
// en vez de por operación. El panel de admin (Pago a asesores) aplica la
// misma regla para decidir qué mostrar como "lista para pagar".
//
// POR QUÉ CORRE TODOS LOS DÍAS DE LUNES A VIERNES EN VEZ DE UNA FECHA FIJA
// El día hábil 10 cae en una fecha de calendario distinta cada mes (fines de
// semana y feriados corren el conteo). No hay forma de fijarlo con un cron
// schedule de Vercel (que solo entiende fechas/días fijos), así que el cron
// corre todos los días de semana a las 7am hora argentina (vercel.json:
// "0 10 * * 1-5", 10 UTC = 7 AR) y el propio handler decide si HOY es el día
// 10 hábil del mes — si no lo es (o cae feriado), no hace nada.
//
// También sirve de chequeo manual: GET /api/cron-recordar-comisiones-asesores?token=ADMIN_TOKEN
// (agregando &forzar=1 salta el chequeo de fecha, útil para probar el mail).

var { esAdmin, esCronVercel } = require('./_auth');
var { esDiaHabil, aHoraAR } = require('./_habiles');

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

// ¿Es `fechaAR` el N-ésimo día hábil del mes en el que cae?
function esEnesimoHabilDelMes(fechaAR, n) {
  if (!esDiaHabil(fechaAR)) return false;
  var anio = fechaAR.getUTCFullYear();
  var mes = fechaAR.getUTCMonth();
  var count = 0;
  for (var dia = 1; dia <= fechaAR.getUTCDate(); dia++) {
    // Mediodía UTC para el chequeo: evita que un borde de horario corra el
    // día — acá solo importa a qué fecha de calendario (AR) corresponde.
    var d = new Date(Date.UTC(anio, mes, dia, 12, 0, 0));
    if (esDiaHabil(d)) count++;
  }
  return count === n;
}

var NOMBRES_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

module.exports = async function handler(req, res) {
  var esVercelCron = false;
  try { esVercelCron = esCronVercel(req); } catch (e) {}
  var admin = false;
  try { admin = esAdmin(req); } catch (e) {}
  if (!esVercelCron && !admin) return res.status(401).json({ error: 'No autorizado' });

  var ahoraAR = aHoraAR(new Date());
  // Solo un admin autenticado puede saltar el chequeo de fecha (para probar
  // el mail sin esperar al día 10 hábil real) — el cron de Vercel nunca manda forzar.
  var forzar = admin && req.query && req.query.forzar === '1';
  if (!forzar && !esEnesimoHabilDelMes(ahoraAR, 10)) {
    return res.status(200).json({ ok: true, hoyEsElDia: false });
  }

  // El mes que se paga HOY es el anterior al actual.
  var anioActual = ahoraAR.getUTCFullYear();
  var mesActual = ahoraAR.getUTCMonth(); // 0-indexado
  var mesComision = mesActual === 0 ? 11 : mesActual - 1;
  var anioComision = mesActual === 0 ? anioActual - 1 : anioActual;

  var activas = await getJSON('mudanzas:activas') || [];
  var pendientes = [];
  var total = 0;
  for (var i = 0; i < activas.length; i++) {
    try {
      var m = await getJSON('mudanza:' + activas[i]);
      if (!m || !m.saldoPagado) continue;
      if (!(parseInt(m.comisionInmobiliariaPagar) > 0)) continue;
      if (m.tipoOperacion === 'compraventa') continue;
      if (m.comisionAsesorPagada) continue;
      // Comisión directa a una inmobiliaria (sin asesor puntual) que ya se
      // marcó pagada desde el panel Inmobiliarias → Comisiones — mismo dinero,
      // otro flag (ver admin.html renderInmoComisiones / api/inmobiliarias.js
      // action=marcar-liquidada). Sin este chequeo, el recordatorio mensual
      // la seguía sumando para siempre aunque ya estuviera pagada.
      if (m.comisionInmobiliariaLiquidada) continue;
      var fc = m.fechaCompletada || m.fechaPagoSaldo;
      if (!fc) continue;
      var fcAR = aHoraAR(new Date(fc));
      if (fcAR.getUTCFullYear() !== anioComision || fcAR.getUTCMonth() !== mesComision) continue;
      var monto = parseInt(m.comisionInmobiliariaPagar) || 0;
      total += monto;
      pendientes.push({
        mudanzaId: m.id,
        asesorCodigo: m.partnerAsesor || '',
        cliente: m.clienteNombre || '',
        monto: monto,
      });
    } catch (e) { console.warn('cron-recordar-comisiones-asesores: error en mudanza', activas[i], e.message); }
  }

  if (!pendientes.length) {
    return res.status(200).json({ ok: true, hoyEsElDia: true, sinComisiones: true });
  }

  if (process.env.RESEND_API_KEY && process.env.ADMIN_EMAIL) {
    try {
      var { Resend } = require('resend');
      var resend = new Resend(process.env.RESEND_API_KEY);
      var nombreMes = NOMBRES_MES[mesComision] + ' ' + anioComision;
      // A propósito SOLO el total, sin desglose: el mail es para chequear a las
      // 7am si hay fondos en el banco antes de arrancar el día, no para leer
      // el detalle (eso ya está en el panel Pago a asesores cuando lo abran).
      await resend.emails.send({
        from: 'MudateYa <noreply@mudateya.ar>',
        to: process.env.ADMIN_EMAIL,
        subject: '💸 Pago a asesores hoy — $' + Number(total).toLocaleString('es-AR'),
        html: '<div style="font-family:Arial,sans-serif;max-width:480px;margin:24px auto;color:#14202B">' +
          '<h2 style="margin:0 0 6px;font-size:19px">Hoy toca pagar comisiones de asesores</h2>' +
          '<p style="color:#5B6472;font-size:13.5px;margin:0 0 16px">Comisiones de ' + esc(nombreMes) + ' (' + pendientes.length + ').</p>' +
          '<p style="margin:0;font-size:28px;font-weight:800;color:#003580">$' + Number(total).toLocaleString('es-AR') + '</p>' +
          '<a href="' + (process.env.SITE_URL || 'https://mudateya.ar') + '/admin" ' +
            'style="display:inline-block;background:#003580;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:700;margin-top:18px">Ver detalle en Pago a asesores →</a>' +
          '<p style="color:#8A93A0;font-size:11.5px;margin-top:20px">MudateYa · recordatorio automático, día hábil 10 de cada mes, 7am.</p>' +
          '</div>',
      });
    } catch (e) {
      console.warn('cron-recordar-comisiones-asesores: no se pudo mandar el mail:', e.message);
    }
  }

  return res.status(200).json({ ok: true, hoyEsElDia: true, total: total, cantidad: pendientes.length });
};
