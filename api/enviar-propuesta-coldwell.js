// api/enviar-propuesta-coldwell.js
// ── ONE-OFF (solo admin) ──
// Primer contacto con las oficinas de Coldwell Banker en AMBA + Córdoba
// (api/_coldwell-oficinas.js, 28). A diferencia de RE/MAX/Keller Williams,
// el CTA acá manda a darse de alta como INMOBILIARIA (inmobiliarias-registro
// .html), no como asesor individual — así la oficina consigue su propio
// slug (mudateya.ar/inmobiliaria/{slug}) y de ahí sale el link de registro
// que después comparte puertas adentro con sus asesores.
//
// ENVÍO: Resend, uno por uno (28, no hace falta batch).
// IDEMPOTENCIA: Redis (clave coldwell-propuesta:enviados).
//
// SEGURIDAD: solo admin con ?token=ADMIN_TOKEN.
//   GET ?token=…              → DRY: cuenta pendientes/enviadas, NO envía nada.
//   GET ?token=…&test=x@y.com → envía UNA muestra a esa dirección (no marca).
//   GET ?token=…&apply=1      → ENVÍA a todas las pendientes (una sola corrida).

const { Resend } = require('resend');
const { esAdmin } = require('./_auth');
const { linkBaja } = require('./_baja');
const TODAS_OFICINAS = require('./_coldwell-oficinas');
const FIRMA_GALO_B64 = require('./_firma-galo');

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

var CLAVE_ENVIADOS = 'coldwell-propuesta:enviados';
var OFICINAS = TODAS_OFICINAS;

function linkPDF(email) {
  return 'https://mudateya.ar/api/enviar-propuesta-coldwell?pdf=1&e=' + encodeURIComponent(email);
}

function emailPropuesta(o) {
  var nm = esc(o.n || 'tu oficina');
  var linkB = linkBaja(o.e, 'coldwell-propuesta');
  var linkP = linkPDF(o.e);
  return {
    subject: nm + ': un beneficio de posventa para tu equipo',
    html:
      '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">' +
        '<div style="background:#003580;padding:22px 28px;text-align:center">' +
          '<span style="font-family:Bebas Neue,Arial,sans-serif;font-size:30px;font-weight:900;letter-spacing:2px;color:#fff">MUDATE</span>' +
          '<span style="font-family:Bebas Neue,Arial,sans-serif;font-size:30px;font-weight:900;letter-spacing:2px;color:#22C36A">YA</span>' +
        '</div>' +
        '<div style="padding:28px">' +
          '<h2 style="margin:0 0 12px;color:#0F1923;font-size:20px">Hola, equipo de ' + nm + ' 👋</h2>' +
          '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">Te escribimos desde <strong>MudateYa</strong>, la plataforma argentina de mudanzas con mudanceros verificados. Queríamos presentarles un beneficio de posventa para que puedan sumar a todo su equipo de asesores.</p>' +
          '<div style="background:#F5F7FA;border-radius:12px;padding:14px 20px;margin-bottom:18px">' +
            '<div style="font-size:12px;font-weight:700;color:#003580;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">En resumen:</div>' +
            '<ul style="margin:0;padding-left:20px;color:#0F1923;font-size:13px;line-height:1.6">' +
              '<li style="margin:6px 0">Cada asesor cobra <strong>5% de comisión</strong> por cada mudanza que su cliente concrete en alquiler, se liquida todos los meses.</li>' +
              '<li style="margin:6px 0">En compraventa, un regalo para el cliente que escala con el valor de la mudanza.</li>' +
              '<li style="margin:6px 0">Sin costo para la oficina ni para sus asesores.</li>' +
            '</ul>' +
          '</div>' +
          '<p style="color:#475569;font-size:13px;line-height:1.7;margin:0 0 16px">Se dan de alta una sola vez como oficina y les generamos un link propio (<code>mudateya.ar/inmobiliaria/tu-oficina</code>) para que después lo compartan puertas adentro — cada asesor se suma con ese link en 30 segundos.</p>' +
          '<div style="text-align:center;margin:20px 0">' +
            '<a href="https://mudateya.ar/inmobiliarias-registro.html" style="display:inline-block;background:#22C36A;color:#fff;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none">Dar de alta la oficina →</a>' +
          '</div>' +
          '<p style="text-align:center;margin:0 0 18px"><a href="' + linkP + '" style="color:#003580;font-size:13px;font-weight:600;text-decoration:underline">📄 Ver la propuesta completa en PDF →</a></p>' +
          '<p style="color:#475569;font-size:13px;line-height:1.7;margin:0">Si les interesa mostrárselo a su equipo con más detalle, con gusto coordinamos una llamada corta. Cualquier duda, respondan a este mismo mail.</p>' +
          '<div style="text-align:center;margin:22px 0 4px">' +
            '<a href="https://instagram.com/mudateya.ar" style="display:inline-block;color:#003580;font-size:13px;font-weight:700;text-decoration:none">📸 Seguinos en Instagram &#64;mudateya.ar</a>' +
          '</div>' +
          '<p style="color:#94A3B8;font-size:11px;text-align:center;margin:16px 0 0;border-top:1px solid #E2E8F0;padding-top:16px">Recibís este correo como oficina de Coldwell Banker. <a href="' + linkB + '" style="color:#94A3B8;text-decoration:underline">Darte de baja</a>.<br>MudateYa · mudateya.ar</p>' +
        '</div>' +
      '</div>',
    text:
      'Hola equipo de ' + nm + ',\n\n' +
      'Te escribimos desde MudateYa, la plataforma argentina de mudanzas con mudanceros verificados. Queríamos presentarles un beneficio de posventa para que puedan sumar a todo su equipo de asesores.\n\n' +
      'En resumen:\n' +
      '- Cada asesor cobra 5% de comisión por cada mudanza que su cliente concrete en alquiler, se liquida todos los meses.\n' +
      '- En compraventa, un regalo para el cliente que escala con el valor de la mudanza.\n' +
      '- Sin costo para la oficina ni para sus asesores.\n\n' +
      'Se dan de alta una sola vez como oficina y les generamos un link propio para que después lo compartan puertas adentro — cada asesor se suma con ese link en 30 segundos: https://mudateya.ar/inmobiliarias-registro.html\n\n' +
      'Propuesta completa en PDF: ' + linkP + '\n\n' +
      'Si les interesa mostrárselo a su equipo con más detalle, con gusto coordinamos una llamada corta. Cualquier duda, respondan a este mismo mail.\n\n' +
      'Seguinos en Instagram: https://instagram.com/mudateya.ar\n\n' +
      '—\nMudateYa · mudateya.ar\n' +
      'Recibís este correo como oficina de Coldwell Banker. Para darte de baja: ' + linkB
  };
}

// ── PDF institucional, personalizado con el nombre de la oficina.
//    Informativo — sin botón de CTA. Mismo patrón que las otras campañas. ──
function generarPDFOficinaBase64(o) {
  const PDFDocument = require('pdfkit');
  return new Promise(function(resolve, reject) {
    try {
      var nm = o.n || 'tu oficina';
      var doc = new PDFDocument({
        size: 'A4',
        margins: { top: 0, bottom: 60, left: 50, right: 50 },
        info: { Title: 'MudateYa × ' + nm }
      });
      var chunks = [];
      doc.on('data', function(c){ chunks.push(c); });
      doc.on('end', function(){ resolve(Buffer.concat(chunks).toString('base64')); });
      doc.on('error', reject);

      var PW = 595.28, ML = 50, MR = 50, CW = PW - ML - MR;
      var C_NAVY = '#003580', C_GREEN = '#22C36A';
      var C_TEXT1 = '#0F1923', C_TEXT2 = '#334155', C_TEXT3 = '#94A3B8';
      var C_BG2 = '#F5F7FA';

      function h2(txt) {
        doc.moveDown(1.1);
        doc.font('Helvetica-Bold').fontSize(13).fillColor(C_NAVY).text(txt, { width: CW });
        doc.moveDown(0.35);
      }
      function p(txt) {
        doc.font('Helvetica').fontSize(10.5).fillColor(C_TEXT2).text(txt, { width: CW, align: 'justify', lineGap: 3.5 });
      }

      doc.rect(0, 0, PW, 100).fill(C_NAVY);
      doc.font('Helvetica-Bold').fontSize(24).fillColor('#FFFFFF').text('MUDATE', ML, 32, { continued: true });
      doc.fillColor(C_GREEN).text('YA');
      doc.font('Helvetica').fontSize(10.5).fillColor('#B8D4FF').text('Marketplace de mudanzas y fletes verificados · Argentina', ML, 66);

      doc.y = 128;
      doc.font('Helvetica').fontSize(9.5).fillColor(C_TEXT3).text('PROPUESTA DE ALIANZA INSTITUCIONAL — PREPARADA PARA', ML, doc.y);
      doc.font('Helvetica-Bold').fontSize(19).fillColor(C_TEXT1).text(nm, ML, doc.y + 4);
      doc.y += 8;

      h2('¿Qué es MudateYa?');
      p('MudateYa es un marketplace argentino que conecta a personas que se mudan con mudanceros y fleteros verificados (DNI y vehículo validados), permitiéndoles comparar presupuestos reales y pagar de forma protegida a través de Mercado Pago o transferencia bancaria. Operamos en CABA, Gran Buenos Aires, La Plata, Córdoba y Rosario, y trabajamos como canal de valor agregado para inmobiliarias y redes de asesores en toda la Argentina.');

      h2('Por qué sumarse en este momento');
      p('El mercado de mudanzas en Argentina sigue siendo, en su mayoría, informal: se resuelve con recomendaciones sueltas o búsquedas en redes, sin verificación ni respaldo. Las oficinas y los asesores que incorporan hoy un servicio como MudateYa a su proceso de posventa son quienes construyen primero ese hábito con sus clientes, y capturan el beneficio antes de que se vuelva un estándar del sector.');

      h2('Beneficios concretos para ' + nm);
      var bullets = [
        'Un argumento adicional y diferencial al momento de disputar la exclusiva con el propietario.',
        'Comisión del 5% para el asesor por cada mudanza que su cliente concrete en alquiler, liquidada mensualmente.',
        'En operaciones de compraventa: un obsequio para el cliente que escala con el valor de la mudanza, sin comisión asociada.',
        'Sin costo de adhesión para la oficina ni para sus asesores.',
        'Alta una vez como oficina, con link propio para compartir puertas adentro con todo el equipo.'
      ];
      doc.moveDown(0.2);
      bullets.forEach(function(b){
        var by = doc.y;
        doc.circle(ML + 4, by + 6, 2.6).fill(C_GREEN);
        doc.font('Helvetica').fontSize(10.5).fillColor(C_TEXT1).text(b, ML + 16, by, { width: CW - 16, lineGap: 2.5 });
        doc.moveDown(0.35);
      });

      doc.moveDown(0.9);
      var sigW = 108, sigH = sigW * (560 / 640);
      doc.image(Buffer.from(FIRMA_GALO_B64, 'base64'), ML, doc.y, { width: sigW });
      doc.y += sigH + 2;
      doc.font('Helvetica-Bold').fontSize(11).fillColor(C_TEXT1).text('Juan Galo Zaldivar', ML, doc.y);
      doc.font('Helvetica').fontSize(9.5).fillColor(C_TEXT2).text('Cofounder, MudateYa', ML, doc.y);

      doc.moveDown(0.6);
      doc.roundedRect(ML, doc.y, CW, 46, 8).fill(C_BG2);
      doc.font('Helvetica').fontSize(9.5).fillColor(C_TEXT2)
         .text('Ante cualquier consulta, quedamos a disposición respondiendo a este mismo correo.', ML + 16, doc.y + 16, { width: CW - 32 });

      var espacioRestante = (doc.page.height - doc.page.margins.bottom) - doc.y;
      doc.moveDown(espacioRestante > 60 ? 1.2 : 0.3);
      doc.font('Helvetica').fontSize(8.5).fillColor(C_TEXT3)
         .text('MudateYa · contacto@mudateya.ar · mudateya.ar', ML, doc.y, { width: CW, align: 'center' });

      doc.end();
    } catch (e) { reject(e); }
  });
}

function payloadDe(o) {
  var m = emailPropuesta(o);
  var link = linkBaja(o.e, 'coldwell-propuesta');
  return {
    from: 'MudateYa <contacto@mudateya.ar>', to: o.e, subject: m.subject, html: m.html, text: m.text,
    headers: {
      'List-Unsubscribe': '<' + link + '>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    }
  };
}

module.exports = async function handler(req, res) {
  // ── PÚBLICO: sirve el PDF personalizado on-demand (link del mail, no adjunto). ──
  if (req.query && req.query.pdf === '1') {
    var eQuery = String(req.query.e || '').trim().toLowerCase();
    var oficina = TODAS_OFICINAS.find(function(o){ return o.e.toLowerCase() === eQuery; });
    if (!oficina) return res.status(404).json({ error: 'Oficina no encontrada' });
    var pdfB64 = await generarPDFOficinaBase64(oficina);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Disposition', 'inline; filename="MudateYa-' + String(oficina.n).replace(/[^a-z0-9]+/gi, '-') + '.pdf"');
    return res.status(200).end(Buffer.from(pdfB64, 'base64'));
  }

  if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
  if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY no configurado' });

  var resend = new Resend(process.env.RESEND_API_KEY);
  var testTo = req.query && req.query.test ? String(req.query.test).trim() : '';
  var apply = req.query && req.query.apply === '1';

  try {
    if (testTo) {
      if (!validEmail(testTo)) return res.status(400).json({ error: 'Email de test inválido' });
      var rt = await resend.emails.send(payloadDe({ n: 'Coldwell Banker Ápice', e: testTo }));
      if (rt && rt.error) return res.status(502).json({ error: rt.error });
      return res.status(200).json({ ok: true, test: true, enviadoA: testTo });
    }

    var enviados = (await getJSON(CLAVE_ENVIADOS)) || [];
    var enviadosSet = {}; enviados.forEach(function(e){ enviadosSet[String(e).toLowerCase()] = 1; });
    var suprimidos = (await redisCall('smembers', ['baja:emails'])) || [];
    var suprSet = {}; suprimidos.forEach(function(e){ suprSet[String(e).toLowerCase()] = 1; });
    var pendientes = OFICINAS.filter(function(o){ var k = o.e.toLowerCase(); return !enviadosSet[k] && !suprSet[k]; });

    if (!apply) {
      return res.status(200).json({
        ok: true, dry: true,
        totalOficinas: OFICINAS.length,
        yaEnviadas: enviados.length,
        suprimidas: suprimidos.length,
        pendientes: pendientes.length,
        muestra: pendientes.map(function(o){ return o.e; })
      });
    }

    var resumen = { enviadas: 0, errores: 0, fallidas: [] };
    for (var i = 0; i < pendientes.length; i++) {
      var o = pendientes[i];
      try {
        var r1 = await resend.emails.send(payloadDe(o));
        if (r1 && r1.error) throw new Error(typeof r1.error === 'string' ? r1.error : JSON.stringify(r1.error));
        enviados.push(o.e);
        await setJSON(CLAVE_ENVIADOS, enviados);
        resumen.enviadas++;
      } catch (e2) {
        resumen.errores++;
        resumen.fallidas.push({ email: o.e, error: e2.message });
      }
      await new Promise(function(ok){ setTimeout(ok, 130); });
    }
    return res.status(200).json({ ok: true, aplicado: true, ...resumen });
  } catch (e) {
    console.error('Error en enviar-propuesta-coldwell:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

// Exports internos — solo para preview/tests locales (no los usa Vercel).
module.exports.emailPropuesta = emailPropuesta;
module.exports.generarPDFOficinaBase64 = generarPDFOficinaBase64;
module.exports.OFICINAS = OFICINAS;
