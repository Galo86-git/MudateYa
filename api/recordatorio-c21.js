// api/recordatorio-c21.js
// ── ONE-OFF (solo admin) ──
// Recordatorio a las oficinas CENTURY 21 de AMBA + Córdoba + Rosario (84) que
// ya recibieron la propuesta de MudateYa (enviar-propuesta-c21.js) y todavía no
// se sumaron ningún asesor. Copy más corto y directo ("che, ¿lo viste?"), mismo
// link a /c21-registro.html. Calcado de recordatorio-remax.js (mismo patrón,
// mismo generador de PDF), adaptado a CENTURY 21.
//
// A diferencia de RE/MAX, acá TODAS las oficinas ya recibieron la propuesta
// original el mismo día (10/8) — no hay distinción "nueva" vs "recordatorio",
// es recordatorio para las 84.
//
// EXCLUIR: dejar cargadas a mano las oficinas con las que ya haya charla directa
// por mail (respondieron y alguien del equipo les está contestando 1 a 1) — no
// tiene sentido mandarles un recordatorio genérico en medio de esa conversación.
//
// ENVÍO: batch de Resend (hasta 100 por llamada).
// IDEMPOTENCIA: Redis (clave c21-recordatorio:enviados) — propia, separada de
// c21-propuesta:enviados, para no pisar el registro de la campaña 1.
//
// SEGURIDAD: solo admin con ?token=ADMIN_TOKEN.
//   GET ?token=…              → DRY: cuenta pendientes/enviadas, NO envía nada.
//   GET ?token=…&test=x@y.com → envía UNA muestra a esa dirección (no marca).
//   GET ?token=…&apply=1      → ENVÍA a todas las pendientes (una sola corrida).

const { Resend } = require('resend');
const { esAdmin } = require('./_auth');
const { linkBaja } = require('./_baja');
const TODAS_OFICINAS = require('./_c21-oficinas');
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
function chunk(arr, size) { var out = []; for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; }

var CLAVE_ENVIADOS = 'c21-recordatorio:enviados';

// ── Ya en charla directa por mail — no les mandamos el recordatorio genérico.
//    Cargar acá los emails a mano si aparece algún caso antes de correr apply. ──
var EXCLUIR = [];

var OFICINAS = TODAS_OFICINAS.filter(function(o){ return EXCLUIR.indexOf(o.e) === -1; });

// ── Link al PDF servido on-demand por este mismo endpoint (?pdf=1&e=...) —
//    no se adjunta al mail: un adjunto igual a 84 direcciones del mismo dominio
//    externo en una corrida corta es justo el patrón que el filtro corporativo
//    de CENTURY 21 (Microsoft 365 / Google Workspace) puede leer como mailing
//    masivo y empezar a cuarentenar (mismo motivo que en recordatorio-remax). ──
function linkPDF(email) {
  return 'https://mudateya.ar/api/recordatorio-c21?pdf=1&e=' + encodeURIComponent(email);
}

function emailRecordatorio(o) {
  var nm = esc(o.n || 'tu oficina');
  var linkB = linkBaja(o.e, 'c21-recordatorio');
  var linkP = linkPDF(o.e);
  var subject = nm + ': ¿ya le contaste a tus asesores sobre MudateYa?';
  var introHtml = '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">Hace unos días te contamos sobre <strong>MudateYa</strong> como un beneficio extra para tus asesores. Como no tuvimos noticias, te lo volvemos a acercar por si se pasó entre tantos mails.</p>';
  var introText = 'Hace unos días te contamos sobre MudateYa como un beneficio extra para tus asesores. Como no tuvimos noticias, te lo volvemos a acercar por si se pasó entre tantos mails.\n\n';
  return {
    subject: subject,
    html:
      '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">' +
        '<div style="background:#003580;padding:22px 28px;text-align:center">' +
          '<span style="font-family:Bebas Neue,Arial,sans-serif;font-size:30px;font-weight:900;letter-spacing:2px;color:#fff">MUDATE</span>' +
          '<span style="font-family:Bebas Neue,Arial,sans-serif;font-size:30px;font-weight:900;letter-spacing:2px;color:#22C36A">YA</span>' +
        '</div>' +
        '<div style="padding:28px">' +
          '<h2 style="margin:0 0 12px;color:#0F1923;font-size:20px">Hola, equipo de ' + nm + ' 👋</h2>' +
          introHtml +
          '<div style="background:#F5F7FA;border-radius:12px;padding:14px 20px;margin-bottom:18px">' +
            '<div style="font-size:12px;font-weight:700;color:#003580;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">En resumen:</div>' +
            '<ul style="margin:0;padding-left:20px;color:#0F1923;font-size:13px;line-height:1.6">' +
              '<li style="margin:6px 0">Cada asesor cobra <strong>5% de comisión</strong> por cada mudanza que su cliente concrete, se liquida todos los meses.</li>' +
              '<li style="margin:6px 0">Sin costo para la oficina ni para el cliente.</li>' +
              '<li style="margin:6px 0">El registro es individual, <strong>30 segundos</strong>, con el link de abajo.</li>' +
            '</ul>' +
          '</div>' +
          '<div style="text-align:center;margin:20px 0">' +
            '<a href="https://mudateya.ar/c21-registro.html" style="display:inline-block;background:#22C36A;color:#fff;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none">Sumar a mis asesores →</a>' +
          '</div>' +
          '<p style="text-align:center;margin:0 0 18px"><a href="' + linkP + '" style="color:#003580;font-size:13px;font-weight:600;text-decoration:underline">📄 Ver la propuesta completa en PDF →</a></p>' +
          '<p style="color:#475569;font-size:13px;line-height:1.7;margin:0">Cualquier duda, respondan a este mismo mail.</p>' +
          '<div style="text-align:center;margin:22px 0 4px">' +
            '<a href="https://instagram.com/mudateya.ar" style="display:inline-block;color:#003580;font-size:13px;font-weight:700;text-decoration:none">📸 Seguinos en Instagram &#64;mudateya.ar</a>' +
          '</div>' +
          '<p style="color:#94A3B8;font-size:11px;text-align:center;margin:16px 0 0;border-top:1px solid #E2E8F0;padding-top:16px">Recibís este correo como oficina CENTURY 21. <a href="' + linkB + '" style="color:#94A3B8;text-decoration:underline">Darte de baja</a>.<br>MudateYa · mudateya.ar</p>' +
        '</div>' +
      '</div>',
    text:
      'Hola equipo de ' + nm + ',\n\n' +
      introText +
      'En resumen:\n' +
      '- Cada asesor cobra 5% de comisión por cada mudanza que su cliente concrete, se liquida todos los meses.\n' +
      '- Sin costo para la oficina ni para el cliente.\n' +
      '- El registro es individual, 30 segundos: https://mudateya.ar/c21-registro.html\n\n' +
      'Propuesta completa en PDF: ' + linkP + '\n\n' +
      'Cualquier duda, respondan a este mismo mail.\n\n' +
      'Seguinos en Instagram: https://instagram.com/mudateya.ar\n\n' +
      '—\nMudateYa · mudateya.ar\n' +
      'Recibís este correo como oficina CENTURY 21. Para darte de baja: ' + linkB
  };
}

// ── PDF institucional, personalizado con el nombre de la oficina.
//    Informativo — sin botón de CTA, el link va solo en el cuerpo del mail. ──
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

      // ── Header navy ──
      doc.rect(0, 0, PW, 100).fill(C_NAVY);
      doc.font('Helvetica-Bold').fontSize(24).fillColor('#FFFFFF').text('MUDATE', ML, 32, { continued: true });
      doc.fillColor(C_GREEN).text('YA');
      doc.font('Helvetica').fontSize(10.5).fillColor('#B8D4FF').text('Marketplace de mudanzas y fletes verificados · Argentina', ML, 66);

      doc.y = 128;
      doc.font('Helvetica').fontSize(9.5).fillColor(C_TEXT3).text('PROPUESTA DE ALIANZA INSTITUCIONAL — PREPARADA PARA', ML, doc.y);
      doc.font('Helvetica-Bold').fontSize(19).fillColor(C_TEXT1).text(nm, ML, doc.y + 4);
      doc.y += 8;

      h2('¿Qué es MudateYa?');
      p('MudateYa es un marketplace argentino que conecta a personas que se mudan con mudanceros y fleteros verificados (DNI y vehículo validados), permitiéndoles comparar presupuestos reales y pagar de forma protegida a través de Mercado Pago o transferencia bancaria. Operamos en CABA, Gran Buenos Aires, La Plata, Córdoba y Rosario, y trabajamos como canal de valor agregado para inmobiliarias y oficinas de bienes raíces en toda la Argentina.');

      h2('Por qué sumarse en este momento');
      p('El mercado de mudanzas en Argentina sigue siendo, en su mayoría, informal: se resuelve con recomendaciones sueltas o búsquedas en redes, sin verificación ni respaldo. Las oficinas y los asesores que incorporan hoy un servicio como MudateYa a su proceso de posventa son quienes construyen primero ese hábito con sus clientes, y capturan el beneficio antes de que se vuelva un estándar del sector. Cuanto antes se integre a la rutina de la oficina, antes empieza a generar valor de forma recurrente para los asesores y sus clientes.');

      h2('Beneficios concretos para ' + nm);
      var bullets = [
        'Un argumento adicional y diferencial al momento de disputar la exclusiva con el propietario.',
        'Comisión del 5% para el asesor por cada mudanza que su cliente concrete en alquiler, liquidada mensualmente.',
        'En operaciones de compraventa: un obsequio para el cliente que escala con el valor de la mudanza, sin comisión asociada.',
        'Sin costo de adhesión para la oficina ni para los asesores.',
        'Alta individual por asesor, con link de derivación propio para hacer seguimiento de sus operaciones.'
      ];
      doc.moveDown(0.2);
      bullets.forEach(function(b){
        var by = doc.y;
        doc.circle(ML + 4, by + 6, 2.6).fill(C_GREEN);
        doc.font('Helvetica').fontSize(10.5).fillColor(C_TEXT1).text(b, ML + 16, by, { width: CW - 16, lineGap: 2.5 });
        doc.moveDown(0.35);
      });

      // ── Firma manuscrita, tamaño proporcional (no estirada) ──
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

      // ── Footer institucional — fluye después del contenido, no a una
      //    coordenada fija (eso empujaba una página 2 en blanco). El gap se
      //    recorta si queda poco lugar en la página, para no cruzar el margen
      //    inferior y disparar un salto de página con el footer solo. ──
      var espacioRestante = (doc.page.height - doc.page.margins.bottom) - doc.y;
      doc.moveDown(espacioRestante > 60 ? 1.2 : 0.3);
      doc.font('Helvetica').fontSize(8.5).fillColor(C_TEXT3)
         .text('MudateYa · contacto@mudateya.ar · mudateya.ar', ML, doc.y, { width: CW, align: 'center' });

      doc.end();
    } catch (e) { reject(e); }
  });
}

function payloadDe(o) {
  var m = emailRecordatorio(o);
  var link = linkBaja(o.e, 'c21-recordatorio');
  return {
    from: 'MudateYa <contacto@mudateya.ar>', to: o.e, subject: m.subject, html: m.html, text: m.text,
    headers: {
      'List-Unsubscribe': '<' + link + '>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    }
  };
}

module.exports = async function handler(req, res) {
  // ── PÚBLICO: sirve el PDF personalizado on-demand (link del mail, no
  //    adjunto). Solo lo genera si el email matches una oficina real de la
  //    lista — no es info sensible, pero evita servir PDFs para cualquier
  //    email al voleo. ──
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
      var rt = await resend.emails.send(payloadDe({ n: 'CENTURY 21 Test', e: testTo }));
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
        excluidas: EXCLUIR.length,
        yaEnviadas: enviados.length,
        suprimidas: suprimidos.length,
        pendientes: pendientes.length,
        muestra: pendientes.slice(0, 8).map(function(o){ return o.e; })
      });
    }

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
    console.error('Error en recordatorio-c21:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

// Exports internos — solo para preview/tests locales (no los usa Vercel).
module.exports.emailRecordatorio = emailRecordatorio;
module.exports.generarPDFOficinaBase64 = generarPDFOficinaBase64;
module.exports.OFICINAS = OFICINAS;
