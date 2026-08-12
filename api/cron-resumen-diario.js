// api/cron-resumen-diario.js
// Resumen diario de actividad — corre por cron a las 20hs hora Argentina
// (23:00 UTC, ver vercel.json). Manda un mail a ADMIN_EMAIL con lo que pasó
// HOY (huso Argentina): pedidos nuevos, cotizaciones recibidas, mudanceros
// nuevos, cancelaciones (marcando en rojo las que necesitan reembolso a
// mano) y un snapshot del estado de las plantillas de WhatsApp.
//
// También sirve de chequeo manual: GET /api/cron-resumen-diario?token=ADMIN_TOKEN

var { esAdmin, esCronVercel } = require('./_auth');
const { redisPipeline } = require('./_ia');
const { Resend } = require('resend');

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

// 'YYYY-MM-DD' en huso Argentina, para comparar timestamps ISO por día.
function fechaAR(iso) {
  if (!iso) return null;
  try { return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }); }
  catch (e) { return null; }
}

// Trae los últimos N ids de un índice y los resuelve a objetos vía pipeline
// (acotado a propósito: alcanza de sobra para un solo día de actividad, sin
// escanear el historial completo a medida que crezca).
async function ultimosObjetos(keyIndice, prefijoObjeto, cantidad) {
  var ids = (await getJSON(keyIndice)) || [];
  var ultimos = ids.slice(-cantidad);
  var objetos = [];
  for (var off = 0; off < ultimos.length; off += 100) {
    var lote = ultimos.slice(off, off + 100);
    var vals = await redisPipeline(lote.map(function (id) { return ['GET', prefijoObjeto + id]; }));
    vals.forEach(function (v) { if (v) { try { objetos.push(JSON.parse(v)); } catch (e) {} } });
  }
  return objetos;
}

// Asesores dados de alta hoy en los 4 canales de canales.js (remax, mudafy,
// c21, independientes — todos comparten el mismo modelo, solo cambia el
// prefijo de Redis).
var CANALES_ASESORES = [
  { nombre: 'RE/MAX', prefijo: 'remax' },
  { nombre: 'Mudafy', prefijo: 'mudafy' },
  { nombre: 'Century 21', prefijo: 'c21' },
  { nombre: 'Independientes', prefijo: 'indep' },
];
async function asesoresPorCanalHoy(hoy) {
  var resultado = [];
  for (var i = 0; i < CANALES_ASESORES.length; i++) {
    var canal = CANALES_ASESORES[i];
    var objetos = await ultimosObjetos(canal.prefijo + ':asesores', canal.prefijo + ':asesor:', 100);
    objetos.filter(function (a) { return fechaAR(a.createdAt) === hoy; }).forEach(function (a) {
      resultado.push({ canal: canal.nombre, nombre: a.nombre || '', email: a.email || '' });
    });
  }
  return resultado;
}

module.exports = async function handler(req, res) {
  var esVercelCron = esCronVercel(req);
  var admin = false;
  try { admin = esAdmin(req); } catch (e) {}
  if (!esVercelCron && !admin) return res.status(401).json({ error: 'No autorizado' });

  try {
    var hoy = fechaAR(new Date().toISOString());

    var mudanzas = await ultimosObjetos('mudanzas:todos', 'mudanza:', 300);
    var mudanceros = await ultimosObjetos('mudanceros:todos', 'mudancero:perfil:', 150);

    var pedidosHoy = mudanzas.filter(function (m) {
      return fechaAR(m.fechaPublicacion || m.creado) === hoy;
    });
    var cotizacionesHoy = [];
    mudanzas.forEach(function (m) {
      (Array.isArray(m.cotizaciones) ? m.cotizaciones : []).forEach(function (c) {
        if (fechaAR(c.fecha) === hoy) cotizacionesHoy.push({ mudanzaId: m.id, mudancero: c.mudanceroNombre || '', precio: c.precio || 0 });
      });
    });
    var canceladasHoy = mudanzas.filter(function (m) { return fechaAR(m.canceladaEn) === hoy; });
    var canceladasConProblema = canceladasHoy.filter(function (m) { return m.anticipoPagado && !m.refundAnticipoId; });
    var mudancerosNuevosHoy = mudanceros.filter(function (p) { return fechaAR(p.fechaRegistro) === hoy; });

    // Asesores nuevos hoy: sistema general (api/asesores.js) + los 4 canales
    // de canales.js (RE/MAX, Mudafy, C21, independientes).
    var asesoresGenerales = await ultimosObjetos('asesores:todos', 'asesor:', 100);
    var asesoresGeneralesHoy = asesoresGenerales.filter(function (a) { return fechaAR(a.creadoEn) === hoy; });
    var asesoresCanalHoy = await asesoresPorCanalHoy(hoy);

    // Inmobiliarias dadas de alta hoy (api/inmobiliarias.js — índice
    // 'inmobiliarias:lista', ver el modelo ahí).
    var inmobiliarias = await ultimosObjetos('inmobiliarias:lista', 'inmobiliaria:', 200);
    var inmobiliariasNuevasHoy = inmobiliarias.filter(function (i) { return fechaAR(i.fechaAlta) === hoy; });

    // Con cuánta gente distinta habló Emi hoy (registrarInteraccionDiaria en whatsapp.js).
    var hablaronClientes = (await redisCall('SCARD', 'emi:hablo:cliente:' + hoy)) || 0;
    var hablaronMudanceros = (await redisCall('SCARD', 'emi:hablo:mudancero:' + hoy)) || 0;
    var hablaronAsesores = (await redisCall('SCARD', 'emi:hablo:asesor:' + hoy)) || 0;

    var registroPlantillas = (await getJSON('plantillas:registro')) || {};
    var nombresPlantillas = Object.keys(registroPlantillas);
    var aprobadas = nombresPlantillas.filter(function (n) { return registroPlantillas[n].status === 'approved'; }).length;
    var pendientes = nombresPlantillas.filter(function (n) { return registroPlantillas[n].status === 'pending' || registroPlantillas[n].status === 'received'; }).length;

    var resumen = {
      fecha: hoy,
      pedidosNuevos: pedidosHoy.length,
      cotizacionesRecibidas: cotizacionesHoy.length,
      mudancerosNuevos: mudancerosNuevosHoy.length,
      asesoresNuevos: asesoresGeneralesHoy.length + asesoresCanalHoy.length,
      inmobiliariasNuevas: inmobiliariasNuevasHoy.length,
      cancelaciones: canceladasHoy.length,
      cancelacionesConProblema: canceladasConProblema.length,
      emiHablóConClientes: Number(hablaronClientes),
      emiHablóConMudanceros: Number(hablaronMudanceros),
      emiHablóConAsesores: Number(hablaronAsesores),
      plantillasAprobadas: aprobadas,
      plantillasPendientes: pendientes,
    };

    // GET normal = solo vista previa (no manda mail). Para forzar el envío
    // desde un link (sin terminal, ej. desde el celu) se puede agregar
    // &enviar=1 a la misma URL — sigue exigiendo el token de admin.
    var forzarEnvio = req.query.enviar === '1';
    if (req.method === 'GET' && !esVercelCron && !forzarEnvio) {
      return res.status(200).json({ ok: true, resumen: resumen, detalle: { pedidosHoy, cotizacionesHoy, canceladasHoy, mudancerosNuevosHoy, asesoresGeneralesHoy, asesoresCanalHoy, inmobiliariasNuevasHoy } });
    }

    // ── Mandar el mail (cron o admin forzándolo) ──
    // Estilo "ledger/scoreboard": números grandes tipo tablero + secciones
    // como planilla (nombre a la izquierda, dato alineado a la derecha), en
    // vez de tarjetas grises con emoji. Todo inline (obligatorio para mail).
    var enviado = false;
    if (process.env.RESEND_API_KEY && process.env.ADMIN_EMAIL) {
      var resend = new Resend(process.env.RESEND_API_KEY);

      var seccion = function (titulo, cantidad, filas, vacio) {
        var head = '<div style="padding:16px 0 8px;border-top:1px solid #EFEDE6">' +
          '<span style="font-family:Georgia,serif;font-size:13.5px;font-weight:700;color:#14202B">' + titulo +
          (cantidad != null ? '<span style="color:#8A93A0;font-weight:400;font-size:12px;margin-left:2px"> · ' + cantidad + '</span>' : '') +
          '</span></div>';
        if (!filas.length) {
          return head + '<p style="padding:0 0 9px;margin:0;font-size:12.5px;color:#8A93A0;font-style:italic">' + vacio + '</p>';
        }
        var filasHtml = '<table role="presentation" style="width:100%;border-collapse:collapse">' +
          filas.map(function (f, i) {
            var borde = i === 0 ? '' : 'border-top:1px solid #EFEDE6;';
            return '<tr>' +
              '<td style="padding:7px 0;font-size:13px;color:#14202B;' + borde + '">' + f.nombre +
                (f.sub ? '<span style="display:block;color:#5B6472;font-size:11.5px;margin-top:1px">' + f.sub + '</span>' : '') +
              '</td>' +
              '<td style="padding:7px 0;font-size:12.5px;color:#5B6472;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;' + borde + '">' + f.valor + (f.chip || '') + '</td>' +
            '</tr>';
          }).join('') +
          '</table>';
        return head + filasHtml;
      };
      var chipCritico = '<span style="display:inline-block;font-size:10px;font-weight:700;letter-spacing:.3px;padding:2px 7px;border-radius:2px;margin-left:8px;background:#FCEEEC;color:#B42318;vertical-align:1px">crítico</span>';

      var filasPedidos = pedidosHoy.slice(0, 15).map(function (m) {
        var val = m.urgente ? 'urgente' : (m.ambientes || (m.tipo === 'flete' ? 'flete' : ''));
        return { nombre: (m.tipo || 'mudanza') + ' — ' + (m.desde || m.origen || '') + ' → ' + (m.hasta || m.destino || ''), sub: m.id, valor: val };
      });
      var filasCots = cotizacionesHoy.slice(0, 15).map(function (c) {
        return { nombre: c.mudancero || 'mudancero', sub: 'pedido ' + c.mudanzaId, valor: '$' + Number(c.precio).toLocaleString('es-AR') };
      });
      var filasMud = mudancerosNuevosHoy.slice(0, 15).map(function (p) {
        return { nombre: (p.nombre || '') + (p.empresa ? ' (' + p.empresa + ')' : ''), sub: p.email, valor: p.zonaBase || '—' };
      });
      var filasAsesores = asesoresGeneralesHoy.map(function (a) {
        return { nombre: a.nombre || '', sub: a.email || '', valor: 'alta hoy' };
      }).concat(asesoresCanalHoy.map(function (a) {
        return { nombre: a.nombre || '', sub: a.canal, valor: 'alta hoy' };
      }));
      var filasInmo = inmobiliariasNuevasHoy.slice(0, 15).map(function (i) {
        return { nombre: i.nombre || '', sub: i.contactoEmail || '', valor: 'alta hoy' };
      });
      var filasCancel = canceladasHoy.slice(0, 15).map(function (m) {
        var problema = (m.anticipoPagado && !m.refundAnticipoId);
        var sub = m.anticipoPagado ? (problema ? 'seña pagada, sin reintegrar' : 'seña reintegrada') : 'sin seña pagada';
        return { nombre: m.id, sub: sub, valor: problema ? 'reembolso manual' : '', chip: problema ? chipCritico : '' };
      });

      var alertaCritica = canceladasConProblema.length
        ? '<p style="margin:0;padding:13px 32px;background:#FCEEEC;border-bottom:1px solid #F3B8AE;font-size:13px;color:#B42318;line-height:1.5"><b>' + canceladasConProblema.length + ' cancelación(es) necesitan reembolso manual hoy</b> — el pago no se pudo reintegrar solo. Mirá el detalle en Cancelaciones, abajo.</p>'
        : '';

      var ahoraAR = new Date();
      var datelineTxt = ahoraAR.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      datelineTxt = datelineTxt.charAt(0).toUpperCase() + datelineTxt.slice(1);
      var horaTxt = ahoraAR.toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit' });

      var scoreCelda = function (num, label, esUltima, flag) {
        var borde = esUltima ? '' : 'border-left:1px solid #EFEDE6;';
        return '<td style="text-align:center;padding:0 6px;' + borde + '">' +
          '<div style="font-family:Georgia,serif;font-size:26px;font-weight:700;color:' + (flag ? '#B42318' : '#003580') + ';font-variant-numeric:tabular-nums;line-height:1">' + num + '</div>' +
          '<div style="font-size:9.5px;letter-spacing:.7px;text-transform:uppercase;color:#8A93A0;margin-top:6px;line-height:1.3">' + label + '</div>' +
        '</td>';
      };

      await resend.emails.send({
        from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
        to: process.env.ADMIN_EMAIL,
        subject: 'Resumen del día ' + hoy + ' — MudateYa',
        html:
          '<div style="font-family:Arial,Helvetica,sans-serif;color:#14202B;max-width:600px;margin:0 auto;background:#fff;border:1px solid #E7E4DC">' +
            '<div style="background:#003580;padding:26px 32px 22px;color:#fff">' +
              '<div style="font-family:Georgia,\'Times New Roman\',serif;font-size:24px;font-weight:700;letter-spacing:.2px">Mudate<span style="color:#6FE0A0">Ya</span></div>' +
              '<div style="font-family:Georgia,serif;font-style:italic;font-size:12.5px;color:#C7D6EE;margin-top:4px">Resumen del día</div>' +
              '<div style="font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:#89A2CC;margin-top:14px;border-top:1px solid rgba(255,255,255,.18);padding-top:12px">' + datelineTxt + ' · ' + horaTxt + '</div>' +
            '</div>' +
            alertaCritica +
            '<div style="padding:24px 32px 20px">' +
              '<table role="presentation" style="width:100%;border-collapse:collapse"><tr>' +
                scoreCelda(resumen.pedidosNuevos, 'Pedidos', false, false) +
                scoreCelda(resumen.cotizacionesRecibidas, 'Cotizaciones', false, false) +
                scoreCelda(resumen.mudancerosNuevos, 'Mudanceros', false, false) +
                scoreCelda(resumen.asesoresNuevos, 'Asesores', false, false) +
                scoreCelda(resumen.inmobiliariasNuevas, 'Inmobiliarias', false, false) +
                scoreCelda(resumen.cancelaciones, 'Cancelaciones', true, canceladasConProblema.length > 0) +
              '</tr></table>' +
            '</div>' +
            '<div style="padding:4px 32px 4px">' +
              seccion('Pedidos nuevos', resumen.pedidosNuevos, filasPedidos, 'Sin pedidos nuevos hoy.') +
              seccion('Cotizaciones recibidas', resumen.cotizacionesRecibidas, filasCots, 'Sin cotizaciones nuevas hoy.') +
              seccion('Mudanceros nuevos', resumen.mudancerosNuevos, filasMud, 'Sin mudanceros nuevos hoy.') +
              seccion('Asesores nuevos', resumen.asesoresNuevos, filasAsesores, 'Sin asesores nuevos hoy.') +
              seccion('Inmobiliarias nuevas', resumen.inmobiliariasNuevas, filasInmo, 'Sin inmobiliarias nuevas hoy.') +
              seccion('Cancelaciones', resumen.cancelaciones, filasCancel, 'Sin cancelaciones hoy.') +
              seccion('Emi habló hoy con', null, [
                { nombre: 'Clientes', valor: String(resumen.emiHablóConClientes) },
                { nombre: 'Mudanceros', valor: String(resumen.emiHablóConMudanceros) },
                { nombre: 'Asesores', valor: String(resumen.emiHablóConAsesores) },
              ], '') +
            '</div>' +
            '<div style="margin:18px 32px 0;padding:12px 16px;background:#F6F5F1;border:1px solid #EFEDE6;font-size:12px;color:#5B6472">' +
              '<table role="presentation" style="width:100%"><tr>' +
                '<td>Plantillas de WhatsApp</td>' +
                '<td style="text-align:right;font-variant-numeric:tabular-nums"><b style="color:#14202B">' + aprobadas + '</b> aprobadas · <b style="color:#14202B">' + pendientes + '</b> en revisión</td>' +
              '</tr></table>' +
            '</div>' +
            '<div style="padding:22px 32px 26px;font-size:11px;color:#8A93A0;border-top:1px solid #E7E4DC;margin-top:22px">' +
              'Generado automáticamente todas las noches a las 20hs · <a href="https://mudateya.ar/admin" style="color:#003580;text-decoration:none">Ver panel de admin →</a>' +
            '</div>' +
          '</div>',
      });
      enviado = true;
    }

    return res.status(200).json({ ok: true, enviado: enviado, resumen: resumen });
  } catch (e) {
    console.error('cron-resumen-diario:', e.message);
    return res.status(200).json({ error: e.message });
  }
};
