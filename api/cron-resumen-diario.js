// api/cron-resumen-diario.js
// Resumen diario de actividad — corre por cron a las 20hs hora Argentina
// (23:00 UTC, ver vercel.json). Manda un mail a ADMIN_EMAIL con lo que pasó
// HOY (huso Argentina): pedidos nuevos, cotizaciones recibidas, mudanceros
// nuevos, cancelaciones (marcando en rojo las que necesitan reembolso a
// mano) y un snapshot del estado de las plantillas de WhatsApp.
//
// También sirve de chequeo manual: GET /api/cron-resumen-diario?token=ADMIN_TOKEN

var { esAdmin } = require('./_auth');
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
  var esVercelCron = req.headers['x-vercel-cron'] === '1';
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

    // Con cuánta gente distinta habló Emi hoy (registrarInteraccionDiaria en whatsapp.js).
    var hablaronClientes = (await redisCall('SCARD', 'emi:hablo:cliente:' + hoy)) || 0;
    var hablaronMudanceros = (await redisCall('SCARD', 'emi:hablo:mudancero:' + hoy)) || 0;

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
      cancelaciones: canceladasHoy.length,
      cancelacionesConProblema: canceladasConProblema.length,
      emiHablóConClientes: Number(hablaronClientes),
      emiHablóConMudanceros: Number(hablaronMudanceros),
      plantillasAprobadas: aprobadas,
      plantillasPendientes: pendientes,
    };

    if (req.method === 'GET' && !esVercelCron) {
      return res.status(200).json({ ok: true, resumen: resumen, detalle: { pedidosHoy, cotizacionesHoy, canceladasHoy, mudancerosNuevosHoy, asesoresGeneralesHoy, asesoresCanalHoy } });
    }

    // ── Mandar el mail (cron o admin forzándolo) ──
    var enviado = false;
    if (process.env.RESEND_API_KEY && process.env.ADMIN_EMAIL) {
      var resend = new Resend(process.env.RESEND_API_KEY);
      var filaLista = function (items, vacio) {
        if (!items.length) return '<p style="color:#94A3B8;font-size:13px;margin:0 0 16px">' + vacio + '</p>';
        return '<ul style="margin:0 0 16px;padding-left:18px;font-size:13px;color:#475569;line-height:1.7">'
          + items.map(function (t) { return '<li>' + t + '</li>'; }).join('') + '</ul>';
      };
      var htmlPedidos = filaLista(pedidosHoy.slice(0, 15).map(function (m) {
        return (m.tipo || 'mudanza') + ': ' + (m.desde || m.origen || '') + ' → ' + (m.hasta || m.destino || '') + ' (' + m.id + ')';
      }), 'Sin pedidos nuevos hoy.');
      var htmlCots = filaLista(cotizacionesHoy.slice(0, 15).map(function (c) {
        return c.mudancero + ': $' + Number(c.precio).toLocaleString('es-AR') + ' — pedido ' + c.mudanzaId;
      }), 'Sin cotizaciones nuevas hoy.');
      var htmlMud = filaLista(mudancerosNuevosHoy.slice(0, 15).map(function (p) {
        return (p.nombre || '') + (p.empresa ? ' (' + p.empresa + ')' : '') + ' — ' + p.email;
      }), 'Sin mudanceros nuevos hoy.');
      var htmlAsesores = filaLista(
        asesoresGeneralesHoy.map(function (a) { return (a.nombre || '') + ' (asesor) — ' + a.email; })
          .concat(asesoresCanalHoy.map(function (a) { return a.nombre + ' — ' + a.canal + (a.email ? ' (' + a.email + ')' : ''); })),
        'Sin asesores nuevos hoy.'
      );
      var htmlCancel = filaLista(canceladasHoy.slice(0, 15).map(function (m) {
        var problema = (m.anticipoPagado && !m.refundAnticipoId);
        return m.id + (problema ? ' ⚠️ <b style="color:#DC2626">necesita reembolso manual</b>' : (m.anticipoPagado ? ' (reembolso OK)' : ''));
      }), 'Sin cancelaciones hoy.');

      var alertaCritica = canceladasConProblema.length
        ? '<div style="background:#FEF2F2;border:1px solid #FECACA;border-left:4px solid #DC2626;border-radius:8px;padding:14px 18px;margin:0 0 20px"><b style="color:#DC2626">🚨 ' + canceladasConProblema.length + ' cancelación(es) necesitan reembolso manual hoy</b> — mirá el detalle de cancelaciones abajo.</div>'
        : '';

      await resend.emails.send({
        from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
        to: process.env.ADMIN_EMAIL,
        subject: '📊 Resumen del día ' + hoy + ' — MudateYa',
        html:
          '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">' +
          '<div style="background:#003580;padding:20px 28px"><span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#22C36A">Ya</span><span style="font-size:13px;color:rgba(255,255,255,.7);margin-left:10px">Resumen ' + hoy + '</span></div>' +
          '<div style="padding:28px">' +
            alertaCritica +
            '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:22px">' +
              '<div style="background:#F5F7FA;border-radius:10px;padding:12px 14px"><div style="font-size:11px;color:#94A3B8;text-transform:uppercase;font-weight:700">Pedidos nuevos</div><div style="font-size:22px;font-weight:800;color:#003580">' + resumen.pedidosNuevos + '</div></div>' +
              '<div style="background:#F5F7FA;border-radius:10px;padding:12px 14px"><div style="font-size:11px;color:#94A3B8;text-transform:uppercase;font-weight:700">Cotizaciones</div><div style="font-size:22px;font-weight:800;color:#003580">' + resumen.cotizacionesRecibidas + '</div></div>' +
              '<div style="background:#F5F7FA;border-radius:10px;padding:12px 14px"><div style="font-size:11px;color:#94A3B8;text-transform:uppercase;font-weight:700">Mudanceros nuevos</div><div style="font-size:22px;font-weight:800;color:#003580">' + resumen.mudancerosNuevos + '</div></div>' +
              '<div style="background:#F5F7FA;border-radius:10px;padding:12px 14px"><div style="font-size:11px;color:#94A3B8;text-transform:uppercase;font-weight:700">Asesores nuevos</div><div style="font-size:22px;font-weight:800;color:#003580">' + resumen.asesoresNuevos + '</div></div>' +
              '<div style="background:#F5F7FA;border-radius:10px;padding:12px 14px"><div style="font-size:11px;color:#94A3B8;text-transform:uppercase;font-weight:700">Cancelaciones</div><div style="font-size:22px;font-weight:800;color:' + (canceladasConProblema.length ? '#DC2626' : '#003580') + '">' + resumen.cancelaciones + '</div></div>' +
              '<div style="background:#F5F7FA;border-radius:10px;padding:12px 14px"><div style="font-size:11px;color:#94A3B8;text-transform:uppercase;font-weight:700">Emi habló con</div><div style="font-size:22px;font-weight:800;color:#003580">' + resumen.emiHablóConClientes + ' cli · ' + resumen.emiHablóConMudanceros + ' mud</div></div>' +
            '</div>' +
            '<h3 style="font-size:13px;color:#0F1923;text-transform:uppercase;letter-spacing:.5px;margin:0 0 8px">🚚 Pedidos nuevos</h3>' + htmlPedidos +
            '<h3 style="font-size:13px;color:#0F1923;text-transform:uppercase;letter-spacing:.5px;margin:0 0 8px">💰 Cotizaciones recibidas</h3>' + htmlCots +
            '<h3 style="font-size:13px;color:#0F1923;text-transform:uppercase;letter-spacing:.5px;margin:0 0 8px">🚛 Mudanceros nuevos</h3>' + htmlMud +
            '<h3 style="font-size:13px;color:#0F1923;text-transform:uppercase;letter-spacing:.5px;margin:0 0 8px">🤝 Asesores nuevos</h3>' + htmlAsesores +
            '<h3 style="font-size:13px;color:#0F1923;text-transform:uppercase;letter-spacing:.5px;margin:0 0 8px">❌ Cancelaciones</h3>' + htmlCancel +
            '<p style="color:#94A3B8;font-size:12px;margin-top:20px">Plantillas WhatsApp: ' + aprobadas + ' aprobadas · ' + pendientes + ' en revisión.</p>' +
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
