// api/enviar-propuestas-colegios.js
// ── ONE-OFF (solo admin) ──
// Envía la propuesta de MudateYa a los Colegios de Martilleros y Corredores
// Públicos de la Provincia de Buenos Aires + CUCICBA (CABA), personalizada
// con el nombre de cada colegio, desde contacto@mudateya.ar, con CTA a
// registrarse en /inmobiliarias-registro.
//
// Mail informativo/frío: sin cifras concretas de comisión ni del bonus de
// matrícula — solo menciona que hay beneficios para el asesor y el corredor.
// Si el colegio pide más info, se le manda por separado lo armado para
// Quilmes (fuera de este script).
//
// IDEMPOTENCIA: guarda los emails ya enviados en Redis (clave
// colegios-propuesta:enviados, un array). Si se vuelve a correr, saltea los
// que ya recibieron — nunca duplica.
//
// SEGURIDAD: solo admin con ?token=ADMIN_TOKEN.
//   GET ?token=…              → DRY: cuenta pendientes/enviadas, NO envía nada.
//   GET ?token=…&test=x@y.com → envía UNA muestra a esa dirección (no marca).
//   GET ?token=…&apply=1      → ENVÍA a todos los pendientes (una sola corrida).

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

var CLAVE_ENVIADOS = 'colegios-propuesta:enviados';

// ── Colegios de Martilleros y Corredores Públicos de la Pcia. de Bs. As. + CUCICBA (CABA) ──
// Fuente: martillerosba.org.ar/colegio-departamentales (directorio oficial),
// CUCICBA verificado por separado (colegioinmobiliario.org.ar). Falta
// Avellaneda-Lanús: no tiene email público, solo Instagram — gestionar aparte.
var COLEGIOS = [
  { n: 'CUCICBA', nombreCompleto: 'Colegio Único de Corredores Inmobiliarios de la Ciudad Autónoma de Buenos Aires (CUCICBA)', e: 'info@colegioinmobiliario.org.ar' },
  { n: 'San Isidro', nombreCompleto: 'Colegio de Martilleros y Corredores Públicos de San Isidro', e: 'colegio@cmcpsi.org.ar' },
  { n: 'San Martín', nombreCompleto: 'Colegio de Martilleros y Corredores Públicos de San Martín', e: 'secretaria@cmcpsm.org.ar' },
  { n: 'Morón', nombreCompleto: 'Colegio de Martilleros y Corredores Públicos de Morón', e: 'presidencia@martillerosmoron.org.ar' },
  { n: 'Moreno-Gral. Rodríguez', nombreCompleto: 'Colegio de Martilleros y Corredores Públicos de Moreno-General Rodríguez', e: 'comarcomgr@yahoo.com.ar' },
  { n: 'La Matanza', nombreCompleto: 'Colegio de Martilleros y Corredores Públicos de La Matanza', e: 'secretaria.matanza@hotmail.com' },
  { n: 'Lomas de Zamora', nombreCompleto: 'Colegio de Martilleros y Corredores Públicos de Lomas de Zamora', e: 'colegio@cmcplz.com.ar' },
  { n: 'Quilmes', nombreCompleto: 'Colegio de Martilleros y Corredores Públicos de Quilmes', e: 'cmycquilmes@outlook.com' },
  { n: 'Zárate-Campana', nombreCompleto: 'Colegio de Martilleros y Corredores Públicos de Zárate-Campana', e: 'info@cmzc.org.ar' },
  { n: 'La Plata', nombreCompleto: 'Colegio de Martilleros y Corredores Públicos de La Plata', e: 'gerencia@martilleroslp.org.ar' },
  { n: 'Mercedes', nombreCompleto: 'Colegio de Martilleros y Corredores Públicos de Mercedes', e: 'comarcomercedes@gmail.com' },
  { n: 'Junín', nombreCompleto: 'Colegio de Martilleros y Corredores Públicos de Junín', e: 'colegiomartillerosjunin@gmail.com' },
  { n: 'Pergamino', nombreCompleto: 'Colegio de Martilleros y Corredores Públicos de Pergamino', e: 'colegiopergamino@hotmail.com' },
  { n: 'San Nicolás', nombreCompleto: 'Colegio de Martilleros y Corredores Públicos de San Nicolás', e: 'cmcpsnic@yahoo.com.ar' },
  { n: 'Azul', nombreCompleto: 'Colegio de Martilleros y Corredores Públicos de Azul', e: 'colmartiazul@gmail.com' },
  { n: 'Dolores', nombreCompleto: 'Colegio de Martilleros y Corredores Públicos de Dolores', e: 'info@comado.com.ar' },
  { n: 'Mar del Plata', nombreCompleto: 'Colegio de Martilleros y Corredores Públicos de Mar del Plata', e: 'secretaria@martillerosmdp.com.ar' },
  { n: 'Necochea', nombreCompleto: 'Colegio de Martilleros y Corredores Públicos de Necochea', e: 'info@martycorrnecochea.com.ar' },
  { n: 'Trenque Lauquen', nombreCompleto: 'Colegio de Martilleros y Corredores Públicos de Trenque Lauquen', e: 'colmartl@cetl.com.ar' },
  { n: 'Bahía Blanca', nombreCompleto: 'Colegio de Martilleros y Corredores Públicos de Bahía Blanca', e: 'martillerosbb@bvconline.com.ar' }
];

function emailPropuesta(o) {
  var nombreCompleto = esc(o.nombreCompleto || 'tu Colegio');
  var linkB = linkBaja(o.e, 'colegios-propuesta');
  return {
    subject: o.n + ': un beneficio de mudanzas para sus matriculados',
    html:
      '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">' +
        '<div style="background:#003580;padding:22px 28px;text-align:center">' +
          '<span style="font-family:Arial Black,Arial,sans-serif;font-size:28px;font-weight:900;letter-spacing:2px;color:#fff">MUDATE</span>' +
          '<span style="font-family:Arial Black,Arial,sans-serif;font-size:28px;font-weight:900;letter-spacing:2px;color:#22C36A">YA</span>' +
        '</div>' +
        '<div style="padding:28px">' +
          '<h2 style="margin:0 0 12px;color:#0F1923;font-size:20px">Hola, equipo del ' + nombreCompleto + ' 👋</h2>' +
          '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">Les escribimos desde <strong>MudateYa</strong>, un marketplace argentino de mudanzas y fletes verificados (mudanceros con DNI, vehículo y antecedentes chequeados; presupuestos comparables en minutos; pago protegido 50/50).</p>' +
          '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">Les proponemos algo simple: que cada matriculado del Colegio tenga una forma concreta de recomendar una mudanza confiable a sus clientes — con beneficios tanto para el asesor como para el corredor, según el tipo de operación.</p>' +
          '<div style="background:#F5F7FA;border-radius:12px;padding:14px 20px;margin-bottom:18px;text-align:center">' +
            '<span style="display:inline-block;margin:4px 8px;font-size:12px;font-weight:700;color:#003580;background:#E5ECF6;padding:6px 12px;border-radius:999px">Sin costo</span>' +
            '<span style="display:inline-block;margin:4px 8px;font-size:12px;font-weight:700;color:#003580;background:#E5ECF6;padding:6px 12px;border-radius:999px">Registro en 30 segundos</span>' +
            '<span style="display:inline-block;margin:4px 8px;font-size:12px;font-weight:700;color:#003580;background:#E5ECF6;padding:6px 12px;border-radius:999px">Sin apps ni integraciones</span>' +
          '</div>' +
          '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 6px">El registro es de 30 segundos y no tiene costo para el Colegio ni para los matriculados:</p>' +
          '<div style="text-align:center;margin:20px 0">' +
            '<a href="https://mudateya.ar/inmobiliarias-registro" style="display:inline-block;background:#22C36A;color:#fff;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none">Registrarse gratis →</a>' +
          '</div>' +
          '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0">Si prefieren, también podemos coordinar una charla breve de 15 minutos para contarles los detalles antes de sumarse.</p>' +
          '<p style="color:#94A3B8;font-size:11px;text-align:center;margin:22px 0 0;border-top:1px solid #E2E8F0;padding-top:16px">Recibís este correo como institución colegiada de martilleros y corredores públicos. <a href="' + linkB + '" style="color:#94A3B8;text-decoration:underline">Darte de baja</a>.<br>MudateYa · contacto@mudateya.ar · mudateya.ar</p>' +
        '</div>' +
      '</div>'
  };
}

function payloadDe(o) {
  var m = emailPropuesta(o);
  var link = linkBaja(o.e, 'colegios-propuesta');
  return {
    from: 'MudateYa <contacto@mudateya.ar>', to: o.e, subject: m.subject, html: m.html,
    headers: {
      'List-Unsubscribe': '<' + link + '>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    }
  };
}

module.exports = async function handler(req, res) {
  if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
  if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY no configurado' });

  var resend = new Resend(process.env.RESEND_API_KEY);
  var testTo = req.query && req.query.test ? String(req.query.test).trim() : '';
  var apply  = req.query && req.query.apply === '1';

  try {
    // ── TEST: una muestra (no marca) ──
    if (testTo) {
      if (!validEmail(testTo)) return res.status(400).json({ error: 'Email de test inválido' });
      var rt = await resend.emails.send(payloadDe({ n: 'San Isidro', nombreCompleto: 'Colegio de Martilleros y Corredores Públicos de San Isidro', e: testTo }));
      if (rt && rt.error) return res.status(502).json({ error: rt.error });
      return res.status(200).json({ ok: true, test: true, enviadoA: testTo });
    }

    // ── Pendientes (saltea los ya enviados) ──
    var enviados = (await getJSON(CLAVE_ENVIADOS)) || [];
    var enviadosSet = {}; enviados.forEach(function(e){ enviadosSet[String(e).toLowerCase()] = 1; });
    var suprimidos = (await redisCall('smembers', ['baja:emails'])) || [];
    var suprSet = {}; suprimidos.forEach(function(e){ suprSet[String(e).toLowerCase()] = 1; });
    var pendientes = COLEGIOS.filter(function(o){ var k = o.e.toLowerCase(); return !enviadosSet[k] && !suprSet[k]; });

    // ── DRY (sin apply): informa, no envía ──
    if (!apply) {
      return res.status(200).json({
        ok: true, dry: true,
        totalColegios: COLEGIOS.length,
        yaEnviados: enviados.length,
        suprimidos: suprimidos.length,
        pendientes: pendientes.length,
        muestra: pendientes.slice(0, 8).map(function(o){ return o.n + ' <' + o.e + '>'; })
      });
    }

    // ── APPLY: enviar. Preferimos batch (rápido); si no está disponible o falla,
    //    caemos a envío uno por uno para no perder el lote. ──
    var resumen = { enviados: 0, errores: 0, fallidos: [] };
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
    console.error('Error en enviar-propuestas-colegios:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
