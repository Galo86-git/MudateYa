// api/desarrolladoras.js
// Canal "Soy Desarrolladora" — contacto corto desde el sitio (ej. QR del stand
// en la Expo Real Estate 2026). A diferencia de inmobiliarias/asesores, no es
// alta de cuenta: guardamos el lead y mandamos un mail automático con el link
// al PDF de la propuesta + un CTA para conversar. El seguimiento real
// (agendar, cerrar) lo hace el equipo a mano a partir de esos mails.
//
// POST ?action=solicitar-contacto  { empresa, nombre, email, telefono?, origen? }
//   → guarda el lead, manda el mail con el PDF, responde { ok:true }
// GET  ?pdf=1&id=...                → sirve el PDF de la propuesta on-demand (público, vía link del mail)
// GET  ?action=listar&token=ADMIN_TOKEN → lista de leads (admin)

var { esAdmin } = require('./_auth');
var { linkBaja } = require('./_baja');
var FIRMA_GALO_B64 = require('./_firma-galo');

var CLAVE_LISTA = 'desarrolladoras:contactos';

async function redisCall(method, args) {
  var url = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  var r = await fetch(url + '/' + [method].concat(args).map(encodeURIComponent).join('/'), {
    headers: { Authorization: 'Bearer ' + token }
  });
  var j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
async function getJSON(k) { var v = await redisCall('get', [k]); return v ? JSON.parse(v) : null; }
async function setJSON(k, v) { return redisCall('set', [k, JSON.stringify(v)]); }

function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim()); }
function esc(s) { return String(s || '').replace(/[<>&"]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]; }); }

function linkPDF(id) {
  return 'https://mudateya.ar/api/desarrolladoras?pdf=1&id=' + encodeURIComponent(id);
}

function emailContacto(lead) {
  var nm = esc(lead.empresa);
  var primerNombre = esc((lead.nombre || '').split(' ')[0] || '');
  var linkB = linkBaja(lead.email, 'desarrolladoras-contacto');
  var linkP = linkPDF(lead.id);
  var linkCharla = 'mailto:contacto@mudateya.ar?subject=' + encodeURIComponent('Programa para Desarrolladoras — ' + lead.empresa);
  return {
    subject: 'MudateYa para ' + nm + ': una opción para tus compradores al momento de la entrega',
    html:
      '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">' +
        '<div style="background:#003580;padding:22px 28px;text-align:center">' +
          '<span style="font-family:Bebas Neue,Arial,sans-serif;font-size:30px;font-weight:900;letter-spacing:2px;color:#fff">MUDATE</span>' +
          '<span style="font-family:Bebas Neue,Arial,sans-serif;font-size:30px;font-weight:900;letter-spacing:2px;color:#22C36A">YA</span>' +
        '</div>' +
        '<div style="padding:28px">' +
          '<h2 style="margin:0 0 12px;color:#0F1923;font-size:20px">Hola' + (primerNombre ? ', ' + primerNombre : '') + ' 👋</h2>' +
          '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">Gracias por tu interés en MudateYa. Somos un marketplace argentino de mudanzas: conectamos a quien se muda con mudanceros verificados, presupuestos comparables y pago protegido — y lo pensamos como una opción lista para ofrecerle a los compradores de <strong>' + nm + '</strong> justo en el momento de la entrega.</p>' +
          '<div style="background:#F5F7FA;border-radius:12px;padding:14px 20px;margin-bottom:18px">' +
            '<div style="font-size:12px;font-weight:700;color:#003580;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">En resumen:</div>' +
            '<ul style="margin:0;padding-left:20px;color:#0F1923;font-size:13px;line-height:1.6">' +
              '<li style="margin:6px 0">Un beneficio ya resuelto para sumar al proceso de entrega de unidades, sin que la desarrolladora tenga que operarlo.</li>' +
              '<li style="margin:6px 0">Mudanceros verificados, presupuestos comparables y pago protegido.</li>' +
              '<li style="margin:6px 0">Sin costo para la desarrolladora ni para el comprador.</li>' +
            '</ul>' +
          '</div>' +
          '<div style="text-align:center;margin:20px 0">' +
            '<a href="' + linkCharla + '" style="display:inline-block;background:#22C36A;color:#fff;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none">Quiero conversar →</a>' +
          '</div>' +
          '<p style="text-align:center;margin:0 0 18px"><a href="' + linkP + '" style="color:#003580;font-size:13px;font-weight:600;text-decoration:underline">📄 Ver la propuesta completa en PDF →</a></p>' +
          '<p style="color:#475569;font-size:13px;line-height:1.7;margin:0">Cualquier duda, respondan a este mismo mail.</p>' +
          '<p style="color:#94A3B8;font-size:11px;text-align:center;margin:22px 0 0;border-top:1px solid #E2E8F0;padding-top:16px">Recibís este correo porque dejaste tu contacto en mudateya.ar. <a href="' + linkB + '" style="color:#94A3B8;text-decoration:underline">Darte de baja</a>.<br>MudateYa · mudateya.ar</p>' +
        '</div>' +
      '</div>',
    text:
      'Hola' + (primerNombre ? ', ' + primerNombre : '') + ',\n\n' +
      'Gracias por tu interés en MudateYa. Somos un marketplace argentino de mudanzas: conectamos a quien se muda con mudanceros verificados, presupuestos comparables y pago protegido — y lo pensamos como una opción lista para ofrecerle a los compradores de ' + nm + ' justo en el momento de la entrega.\n\n' +
      'En resumen:\n' +
      '- Un beneficio ya resuelto para sumar al proceso de entrega de unidades, sin que la desarrolladora tenga que operarlo.\n' +
      '- Mudanceros verificados, presupuestos comparables y pago protegido.\n' +
      '- Sin costo para la desarrolladora ni para el comprador.\n\n' +
      'Propuesta completa en PDF: ' + linkP + '\n\n' +
      'Si querés conversarlo, respondé este mismo mail o escribinos a contacto@mudateya.ar.\n\n' +
      '—\nMudateYa · mudateya.ar\n' +
      'Recibís este correo porque dejaste tu contacto en mudateya.ar. Para darte de baja: ' + linkB
  };
}

// ── PDF institucional genérico, personalizado con el nombre de la empresa.
//    Mismo criterio que el resto de las campañas: sin botón de CTA adentro,
//    el link a conversar va en el cuerpo del mail. ──
function generarPDFDesarrolladoraBase64(lead) {
  const PDFDocument = require('pdfkit');
  return new Promise(function (resolve, reject) {
    try {
      var nm = lead.empresa || 'tu empresa';
      var doc = new PDFDocument({
        size: 'A4',
        margins: { top: 0, bottom: 60, left: 50, right: 50 },
        info: { Title: 'MudateYa × ' + nm }
      });
      var chunks = [];
      doc.on('data', function (c) { chunks.push(c); });
      doc.on('end', function () { resolve(Buffer.concat(chunks).toString('base64')); });
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
      doc.font('Helvetica').fontSize(9.5).fillColor(C_TEXT3).text('PROPUESTA — PROGRAMA PARA DESARROLLADORAS — PREPARADA PARA', ML, doc.y);
      doc.font('Helvetica-Bold').fontSize(19).fillColor(C_TEXT1).text(nm, ML, doc.y + 4);
      doc.y += 8;

      h2('¿Qué es MudateYa?');
      p('MudateYa es un marketplace argentino que conecta a personas que se mudan con mudanceros y fleteros verificados (DNI y vehículo validados), permitiéndoles comparar presupuestos reales y pagar de forma protegida a través de Mercado Pago o transferencia bancaria. Operamos en CABA, Gran Buenos Aires, La Plata, Córdoba y Rosario.');

      h2('Por qué sumarlo al momento de la entrega');
      p('Cada entrega de posesión trae, para el comprador, una mudanza que resolver — y hoy la mayoría de las desarrolladoras no le ofrecen ninguna alternativa concreta para eso. Sumar MudateYa como parte del proceso de entrega es un gesto de servicio que no le cuesta nada a la desarrolladora, mejora la experiencia final del comprador, y queda asociado a la marca en un momento de alta atención.');

      h2('Beneficios concretos para ' + nm);
      var bullets = [
        'Un servicio ya resuelto para ofrecer a tus compradores en el momento de la entrega, sin que la desarrolladora tenga que operarlo.',
        'Mudanceros verificados, presupuestos comparables y pago protegido — el mismo estándar que ofrecerías vos.',
        'Sin costo de adhesión para la desarrolladora ni para el comprador.',
        'Se puede integrar como beneficio de bienvenida, parte del kit de entrega, o simple mención en la comunicación de posventa.'
      ];
      doc.moveDown(0.2);
      bullets.forEach(function (b) {
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

module.exports = async function handler(req, res) {
  // ── PÚBLICO: sirve el PDF on-demand (link del mail, no adjunto). Solo lo
  //    genera si el id matches un lead real guardado — evita servir PDFs para
  //    cualquier id al voleo. ──
  if (req.query && req.query.pdf === '1') {
    var id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Falta id' });
    var lead = await getJSON('desarrolladora:contacto:' + id);
    if (!lead) return res.status(404).json({ error: 'No encontrado' });
    var pdfB64 = await generarPDFDesarrolladoraBase64(lead);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Disposition', 'inline; filename="MudateYa-' + String(lead.empresa).replace(/[^a-z0-9]+/gi, '-') + '.pdf"');
    return res.status(200).end(Buffer.from(pdfB64, 'base64'));
  }

  var action = (req.query && req.query.action) || '';

  if (action === 'listar') {
    if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
    var ids = (await getJSON(CLAVE_LISTA)) || [];
    var leads = [];
    for (var i = 0; i < ids.length; i++) {
      var l = await getJSON('desarrolladora:contacto:' + ids[i]);
      if (l) leads.push(l);
    }
    return res.status(200).json({ ok: true, total: leads.length, leads: leads });
  }

  if (action === 'solicitar-contacto') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
    if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY no configurado' });
    try {
      var body = req.body || {};
      var empresa = String(body.empresa || '').trim().slice(0, 80);
      var nombre = String(body.nombre || '').trim().slice(0, 80);
      var email = String(body.email || '').trim().toLowerCase().slice(0, 120);
      var telefono = String(body.telefono || '').trim().slice(0, 40);
      var origen = String(body.origen || '').trim().slice(0, 60);

      if (empresa.length < 2) return res.status(400).json({ error: 'Falta el nombre de la empresa' });
      if (!nombre) return res.status(400).json({ error: 'Falta el nombre' });
      if (!validEmail(email)) return res.status(400).json({ error: 'Email inválido' });

      var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      var lead = {
        id: id, empresa: empresa, nombre: nombre, email: email, telefono: telefono,
        origen: origen, createdAt: new Date().toISOString()
      };
      await setJSON('desarrolladora:contacto:' + id, lead);
      var lista = (await getJSON(CLAVE_LISTA)) || [];
      lista.push(id);
      await setJSON(CLAVE_LISTA, lista);

      var { Resend } = require('resend');
      var resend = new Resend(process.env.RESEND_API_KEY);
      var mail = emailContacto(lead);
      var linkB = linkBaja(email, 'desarrolladoras-contacto');
      var envio = await resend.emails.send({
        from: 'MudateYa <contacto@mudateya.ar>',
        to: email,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        headers: {
          'List-Unsubscribe': '<mailto:hola@mudateya.ar?subject=BAJA>, <' + linkB + '>',
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });
      if (envio && envio.error) throw new Error(envio.error.message || JSON.stringify(envio.error));

      return res.status(200).json({ ok: true, id: id });
    } catch (e) {
      console.error('Error en desarrolladoras (solicitar-contacto):', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Falta ?action=' });
};

// Exports internos — solo para preview/tests locales (no los usa Vercel).
module.exports.emailContacto = emailContacto;
module.exports.generarPDFDesarrolladoraBase64 = generarPDFDesarrolladoraBase64;
