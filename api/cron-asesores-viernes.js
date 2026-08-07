// api/cron-asesores-viernes.js
//
// Resumen SEMANAL a los asesores: "así cerraste la semana" + empuje a cargar
// AHORA con Emi cualquier cliente en carpeta que cierre el finde/lunes, para
// que el lunes ya tenga presupuestos esperando.
//
// Corre los viernes 12:00 hora Argentina (15:00 UTC) — schedule "0 15 * * 5"
// en vercel.json. Se eligió mediodía (no 18hs) porque las cotizaciones corren
// en horas hábiles (pausan el finde de semana): mandarlo a las 18hs dejaría
// cero horas hábiles para que los mudanceros coticen antes del corte —
// arruinaría el propósito de "presupuestos listos para el lunes".
//
// Reusa de cron-asesores-semanal.js: la lista de destinatarios (misma marca
// por canal/inmobiliaria) y los helpers de Redis — una sola fuente de verdad
// para "quiénes son los asesores y cómo se llama/colorea su marca".
//
// ESTADÍSTICAS: por cada asesor, lee su índice {prefijo}:asesor:{codigo}:mudanzas
// (armado en cotizaciones.js al publicar un pedido referido) y cuenta, sobre
// los pedidos publicados desde el lunes 00:00 hora Argentina:
//   - clientesDerivados : todos los indexados esta semana
//   - conPresupuestos   : cotizaciones.length > 0
//   - conSenia          : anticipoPagado === true
//   - completadas       : estado === 'completada'
// (mudanza:{id} tiene TTL de 7 días — un pedido de la semana siempre está
// disponible; uno más viejo simplemente da null y se saltea.)
//
// SEGURIDAD: mismo esquema que cron-asesores-semanal.js —
//   1. Header de Vercel Cron, o
//   2. ?token=ADMIN_TOKEN (para probar/disparar a mano).
//
// MODOS DE PRUEBA (solo con ?token=ADMIN_TOKEN):
//   ?dry=1            → NO envía nada; devuelve a quiénes les llegaría + sus stats.
//   ?test=mail@x.com  → envía UN solo mail de muestra a esa dirección (con sus
//                       stats reales si ese mail es un asesor de canal) y corta.
//   ?verLog=1         → NO envía nada; devuelve el resultado guardado del
//                       último envío REAL de esta semana (enviados/errores/
//                       destinatarios). ?fecha=YYYY-MM-DD para ver una
//                       semana anterior (hora AR, formato de fechaAR()).
// Nunca manda al listado real salvo que dispare el propio cron de Vercel o el
// admin explícitamente sin ?dry/?test/?verLog.

const { Resend } = require('resend');
const base = require('./cron-asesores-semanal');
const { recolectarDestinatarios, SITE, WA_EMI, getJSON, redisCall, validEmail, headersListUnsub } = base;

// ── Lunes 00:00 hora Argentina (UTC-3 fijo) como ISO, para filtrar "esta semana" ──
function inicioSemanaISO() {
  var ahora = new Date();
  var ar = new Date(ahora.getTime() - 180 * 60 * 1000); // reloj de pared AR, expresado en campos UTC
  var dow = ar.getUTCDay(); // 0=domingo..6=sábado (ya en hora AR)
  var diasDesdeLunes = (dow === 0) ? 6 : (dow - 1);
  var lunes = new Date(ar.getTime() - diasDesdeLunes * 24 * 60 * 60 * 1000);
  // Medianoche AR de ese lunes = 03:00 UTC del mismo día calendario.
  return new Date(Date.UTC(lunes.getUTCFullYear(), lunes.getUTCMonth(), lunes.getUTCDate(), 3, 0, 0)).toISOString();
}

// ── HELPER: fecha YYYY-MM-DD en hora Argentina (para la marca de idempotencia) ──
function fechaAR() {
  var ahora = new Date();
  var ar = new Date(ahora.getTime() - 180 * 60 * 1000);
  return ar.getUTCFullYear() + '-' +
    String(ar.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(ar.getUTCDate()).padStart(2, '0');
}

// ── Stats de la semana de UN asesor, a partir de su índice de pedidos referidos ──
async function statsSemana(prefijo, codigo) {
  var stats = { clientesDerivados: 0, conPresupuestos: 0, conSenia: 0, completadas: 0 };
  if (!prefijo || !codigo) return stats;
  var ids = (await getJSON(prefijo + ':asesor:' + codigo + ':mudanzas')) || [];
  var desde = inicioSemanaISO();
  // Tope defensivo: un asesor con cientos de referidos no debería hacer que
  // esto escanee todo — los últimos 80 alcanzan de sobra para una semana.
  var recientes = ids.slice(-80);
  for (var i = 0; i < recientes.length; i++) {
    var m = await getJSON('mudanza:' + recientes[i]);
    if (!m) continue; // ya expiró (TTL 7 días) → es de hace más de una semana
    if (!m.fechaPublicacion || String(m.fechaPublicacion) < desde) continue;
    stats.clientesDerivados++;
    if ((m.cotizaciones || []).length > 0) stats.conPresupuestos++;
    if (m.anticipoPagado === true) stats.conSenia++;
    if (m.estado === 'completada') stats.completadas++;
  }
  return stats;
}

// ── PLANTILLA DEL EMAIL ──
function emailResumenSemanal(nombre, stats, canal) {
  var primerNombre = ((nombre || '').trim().split(' ')[0]) || 'Hola';
  return {
    subject: primerNombre + ', así cerraste la semana 📊',
    html: bodyHtml({
      canalNombre: canal && canal.canalNombre,
      color:       (canal && canal.color) || '#22C36A',
      fondoAviso:  (canal && canal.fondoAviso) || '#F5F7FA',
      nombre: primerNombre,
      stats: stats || { clientesDerivados: 0, conPresupuestos: 0, conSenia: 0, completadas: 0 }
    })
  };
}

function bodyHtml(p) {
  var s = p.stats;
  var filas = [
    ['Clientes derivados esta semana', s.clientesDerivados],
    ['Ya tienen presupuestos', s.conPresupuestos],
    ['Seña pagada', s.conSenia],
    ['Mudanza completada', s.completadas]
  ].map(function(f) {
    return '<tr><td style="padding:11px 8px;color:#475569;font-size:14px;border-top:1px solid #EEF1F5">' + f[0] + '</td>' +
      '<td style="padding:11px 8px;color:#0F1923;font-size:18px;font-weight:800;text-align:right;border-top:1px solid #EEF1F5">' + f[1] + '</td></tr>';
  }).join('');
  var marcaCanal = p.canalNombre
    ? '<span style="color:rgba(255,255,255,.75);font-size:15px;margin-left:10px">× ' + p.canalNombre + '</span>'
    : '';
  return '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">' +
    '<div style="background:#003580;padding:22px 28px;text-align:center">' +
      '<span style="font-family:Bebas Neue,Arial,sans-serif;font-size:30px;font-weight:900;letter-spacing:2px;color:#fff">MUDATE</span>' +
      '<span style="font-family:Bebas Neue,Arial,sans-serif;font-size:30px;font-weight:900;letter-spacing:2px;color:#22C36A">YA</span>' +
      marcaCanal +
    '</div>' +
    '<div style="padding:28px">' +
      '<h2 style="margin:0 0 16px;color:#0F1923;font-size:20px">Así cerraste la semana, ' + p.nombre + ' 📊</h2>' +
      '<table style="width:100%;border-collapse:collapse;margin-bottom:20px">' + filas + '</table>' +
      '<div style="background:' + p.fondoAviso + ';border-radius:12px;padding:16px 20px;margin-bottom:20px">' +
        '<div style="font-size:13px;font-weight:700;color:' + p.color + ';margin-bottom:8px">💡 Antes de que arranque el finde</div>' +
        '<p style="margin:0;color:#0F1923;font-size:13px;line-height:1.6">¿Tenés algún cliente en carpeta que cierra su operación este finde o el lunes a primera hora? Cargalo ahora con Emi — así cuando firme, los presupuestos YA están esperando. Nada de "dame un día que te consigo mudanceros": se lo mostrás ahí mismo.</p>' +
      '</div>' +
      '<div style="text-align:center;margin:24px 0">' +
        '<a href="' + WA_EMI + '" style="display:inline-block;background:#22C36A;color:#fff;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none">Cargar un cliente con Emi →</a>' +
      '</div>' +
      '<p style="color:#475569;font-size:13px;line-height:1.6;margin:0;text-align:center">Buen finde, ' + p.nombre + '. El lunes seguimos.</p>' +
      '<div style="margin-top:20px;padding-top:20px;border-top:1px solid #EEF1F5;text-align:center">' +
        '<div style="font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#94A3B8;margin-bottom:8px">Seguinos en IG</div>' +
        '<a href="https://www.instagram.com/mudateya.ar/" style="color:#003580;font-weight:700;font-size:14px;text-decoration:none">@mudateya.ar</a>' +
      '</div>' +
      '<p style="color:#94A3B8;font-size:11px;text-align:center;margin:24px 0 0;border-top:1px solid #E2E8F0;padding-top:16px">' +
        'Recibís este resumen porque sos Asesor de MudateYa. ¿No querés recibirlos más? Respondé este mail con <strong>BAJA</strong>.' +
      '</p>' +
    '</div>' +
  '</div>';
}

// ── HANDLER ──
module.exports = async function handler(req, res) {
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    return res.status(200).json({ ok: true, skipped: true, reason: 'no-production-env', env: process.env.VERCEL_ENV });
  }

  var esVercelCron = require('./_auth').esCronVercel(req);
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
  var verLog = req.query && req.query.verLog === '1';

  try {
    // ── MODO CONSULTA: leer el resultado guardado de un envío real ya hecho,
    // sin disparar nada. ?fecha=YYYY-MM-DD (hora AR) para ver una semana
    // anterior — default: la semana actual. ──
    if (verLog) {
      const fecha = (req.query && req.query.fecha) || fechaAR();
      const log = await getJSON('asesores:resumen-viernes:log:' + fecha);
      if (!log) return res.status(404).json({ ok: false, error: 'No hay envío real guardado para ' + fecha });
      return res.status(200).json({ ok: true, fecha, ...log });
    }

    var lista0 = await recolectarDestinatarios();

    // ── MODO TEST: mandar una sola muestra y cortar ──
    if (testTo) {
      if (!validEmail(testTo)) return res.status(400).json({ error: 'Email de test inválido' });
      var match = null;
      for (var m = 0; m < lista0.length; m++) {
        if (lista0[m].email.toLowerCase() === testTo.toLowerCase()) { match = lista0[m]; break; }
      }
      var stats = match ? await statsSemana(match.prefijo, match.codigo) : { clientesDerivados: 3, conPresupuestos: 2, conSenia: 1, completadas: 1 };
      var muestra = emailResumenSemanal(match ? match.nombre : 'Asesor de prueba', stats, match);
      var rt = await resend.emails.send({
        from: 'MudateYa Asesores <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
        to: testTo, subject: muestra.subject, html: muestra.html,
        headers: headersListUnsub(match ? match.linkBaja : null)
      });
      if (rt && rt.error) return res.status(502).json({ error: rt.error });
      return res.status(200).json({
        ok: true, test: true, enviadoA: testTo,
        esAsesorDeCanal: !!match,
        canal: match ? match.canal : null,
        statsUsadas: stats,
        statsReales: !!match
      });
    }

    // ── IDEMPOTENCIA: marca por semana (clave = viernes en hora AR) ──
    var claveSemana = 'asesores:resumen-viernes:' + fechaAR();
    if (!esDry) {
      var marca = await redisCall('set', [claveSemana, new Date().toISOString(), 'EX', '1296000', 'NX']);
      if (marca !== 'OK') {
        return res.status(200).json({ ok: true, skipped: true, reason: 'ya-enviado-esta-semana', clave: claveSemana });
      }
    }

    var resumen = { total: lista0.length, enviados: 0, errores: 0, destinatarios: [], fallidos: [] };

    for (var i = 0; i < lista0.length; i++) {
      var d = lista0[i];
      var st = await statsSemana(d.prefijo, d.codigo);

      if (esDry) {
        resumen.destinatarios.push({ email: d.email, canal: d.canal, stats: st });
        resumen.enviados++;
        continue;
      }

      var mail = emailResumenSemanal(d.nombre, st, d);
      try {
        var r = await resend.emails.send({
          from: 'MudateYa Asesores <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
          to: d.email, subject: mail.subject, html: mail.html,
          headers: headersListUnsub(d.linkBaja)
        });
        if (r && r.error) throw new Error(typeof r.error === 'string' ? r.error : JSON.stringify(r.error));
        resumen.enviados++;
        resumen.destinatarios.push({ email: d.email, canal: d.canal, stats: st });
      } catch (e) {
        resumen.errores++;
        resumen.fallidos.push({ email: d.email, error: e.message });
        console.warn('Error enviando resumen semanal a ' + d.email + ':', e.message);
      }
      await new Promise(function(ok){ setTimeout(ok, 120); });
    }

    // Guardamos el resultado real (solo cuando fue un envío de verdad, no un
    // dry-run) para poder consultar después quién recibió qué sin depender
    // de los logs de Vercel — ver ?verLog=1 arriba. TTL 30 días.
    if (!esDry) {
      try {
        await redisCall('set', ['asesores:resumen-viernes:log:' + fechaAR(), JSON.stringify(resumen), 'EX', String(30 * 24 * 60 * 60)]);
      } catch (e) { console.warn('No se pudo guardar el log del envío:', e.message); }
    }

    return res.status(200).json({ ok: true, dry: esDry, ...resumen });
  } catch (e) {
    console.error('Error en cron-asesores-viernes:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
