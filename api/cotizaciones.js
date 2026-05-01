// api/cotizaciones.js — Upstash Redis + PDF con pdfmake
const { Resend } = require('resend');

// Helper de push notifications (definido en api/push.js)
// Si push.js no está disponible o falla, los envíos de email siguen funcionando normal.
let enviarPush = async function() { return { ok: false, error: 'push no cargado' }; };
try {
  enviarPush = require('./push').enviarPush || enviarPush;
} catch (e) {
  console.warn('[push] no se pudo cargar push.js:', e.message);
}

// ════════════════════════════════════════════════════
// REDIS
// ════════════════════════════════════════════════════
async function redisCall(method, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  const response = await fetch(`${url}/${[method, ...args].map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}
async function getJSON(key) {
  const val = await redisCall('GET', key);
  if (!val) return null;
  return JSON.parse(val);
}
async function setJSON(key, value, exSeconds) {
  const str = JSON.stringify(value);
  if (exSeconds) await redisCall('SET', key, str, 'EX', String(exSeconds));
  else await redisCall('SET', key, str);
}

// ════════════════════════════════════════════════════
// GENERADOR PDF con PDFKit
// ════════════════════════════════════════════════════
async function generarPDFBase64(datos) {
  const PDFDocument = require('pdfkit');

  // ── DATOS ────────────────────────────────────────────────────────
  const nro           = datos.id || 'MYA-0001';
  const fechaDoc      = datos.fechaEmision || new Date().toLocaleDateString('es-AR', { day:'numeric', month:'long', year:'numeric' });
  const clienteNombre = datos.clienteNombre || '—';
  const clienteEmail  = datos.clienteEmail  || '—';
  const mudNombre     = datos.mudanceroNombre || '—';
  const mudInits      = (datos.mudanceroNombre || 'MV').slice(0,2).toUpperCase();
  const desde         = datos.desde || '—';
  const hasta         = datos.hasta || '—';
  const fechaMud      = datos.fecha || '—';
  const ambientes     = datos.ambientes || '—';
  const objetos       = datos.objetos || datos.servicios || '—';
  const extras        = datos.extras || '';
  const nota          = datos.nota || '';
  const tiempo        = datos.tiempoEstimado || '';
  const precio        = parseInt(String(datos.precio || '0').replace(/\./g,'').replace(/[^0-9]/g,'')) || 0;
  const precioFmt     = '$' + precio.toLocaleString('es-AR');

  // ── COLORES ───────────────────────────────────────────────────────
  // Paleta MudateYa — legible sobre blanco
  const C_NAVY    = '#003580';   // azul oscuro — textos principales, logo
  const C_GREEN   = '#22C36A';   // verde — acentos, precio
  const C_GRND    = '#17A356';   // verde oscuro — textos sobre fondo verde
  const C_BLUE    = '#1A6FFF';   // azul medio — títulos sección
  const C_TEXT1   = '#0F1923';   // negro suave — texto principal
  const C_TEXT2   = '#475569';   // gris medio — texto secundario
  const C_TEXT3   = '#64748B';   // gris claro — labels, hints
  const C_BG1     = '#FFFFFF';   // blanco puro
  const C_BG2     = '#F5F7FA';   // gris muy claro — fondo alternante
  const C_BG3     = '#E8F5EE';   // verde muy claro — fondo precio, verificado
  const C_BG4     = '#F0FFF6';   // verde palido — fondo badge
  const C_BORDER  = '#E2E8F0';   // borde gris claro
  const C_BGRN    = '#BBF7D0';   // borde verde

  // ── DOCUMENTO ────────────────────────────────────────────────────
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    info: { Title: 'Presupuesto MudateYa ' + nro },
    bufferPages: true,
  });

  const chunks = [];
  doc.on('data', c => chunks.push(c));

  const PW = 595.28;  // page width
  const PH = 841.89;  // page height
  const ML = 40;      // margen izquierdo
  const MR = 40;      // margen derecho
  const CW = PW - ML - MR;  // content width = 515.28

  // ── HELPERS ───────────────────────────────────────────────────────
  function fillRect(x, y, w, h, color, r) {
    r = r || 0;
    if (r > 0) doc.roundedRect(x, y, w, h, r).fill(color);
    else doc.rect(x, y, w, h).fill(color);
  }
  function strokeRect(x, y, w, h, color, lw, r) {
    doc.save();
    doc.lineWidth(lw || 0.5).strokeColor(color);
    if (r) doc.roundedRect(x, y, w, h, r).stroke();
    else doc.rect(x, y, w, h).stroke();
    doc.restore();
  }
  function hLine(x1, x2, y, color, lw) {
    doc.save().moveTo(x1, y).lineTo(x2, y).strokeColor(color).lineWidth(lw || 0.5).stroke().restore();
  }
  function t(str, x, y, font, size, color, opts) {
    doc.font(font).fontSize(size).fillColor(color);
    doc.text(String(str || ''), x, y, opts || {});
  }
  function label(str, x, y, w) {
    t(str.toUpperCase(), x, y, 'Helvetica-Bold', 7, C_TEXT3, { width: w || CW, lineBreak: false });
  }
  function value(str, x, y, w) {
    t(str, x, y, 'Helvetica', 9, C_TEXT1, { width: w || CW - 110, lineBreak: false });
  }

  // ══════════════════════════════════════════════════════════════════
  // ESTRUCTURA DE LA PÁGINA
  // ══════════════════════════════════════════════════════════════════

  let Y = 0;

  // ── 1. HEADER ─────────────────────────────────────────────────────
  // Fondo blanco con franja verde abajo
  fillRect(0, 0, PW, 72, C_BG1);
  // Franja verde inferior del header
  fillRect(0, 68, PW, 4, C_GREEN);

  // Logo MudateYa
  doc.font('Helvetica-Bold').fontSize(28).fillColor(C_NAVY);
  doc.text('Mudate', ML, 20, { lineBreak: false, continued: false });
  const wMudate = doc.widthOfString('Mudate');
  doc.font('Helvetica-Bold').fontSize(28).fillColor(C_GREEN);
  doc.text('Ya', ML + wMudate, 20, { lineBreak: false });

  // Subtítulo
  doc.font('Helvetica').fontSize(8).fillColor(C_TEXT3);
  doc.text('El marketplace de mudanzas de Argentina', ML, 52, { lineBreak: false });

  // Número de cotización (derecha)
  doc.font('Helvetica-Bold').fontSize(14).fillColor(C_NAVY);
  doc.text(nro, 0, 18, { width: PW - MR, align: 'right' });
  doc.font('Helvetica').fontSize(7).fillColor(C_TEXT3);
  doc.text('COTIZACION', 0, 38, { width: PW - MR, align: 'right' });
  doc.font('Helvetica').fontSize(8).fillColor(C_TEXT2);
  doc.text(fechaDoc, 0, 50, { width: PW - MR, align: 'right' });

  Y = 82;

  // ── 2. BADGE ──────────────────────────────────────────────────────
  fillRect(0, Y, PW, 24, C_BG4);
  hLine(0, PW, Y, C_BGRN, 0.5);
  hLine(0, PW, Y + 24, C_BGRN, 0.5);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(C_GRND);
  doc.text('PRESUPUESTO OFICIAL  -  Valido 7 dias', ML, Y + 8);

  Y = 116;

  // ── 3. CLIENTE + MUDANCERO ────────────────────────────────────────
  const CARD_H = 76;
  const COL_W  = (CW - 12) / 2;

  // Card cliente
  fillRect(ML, Y, COL_W, CARD_H, C_BG2, 6);
  strokeRect(ML, Y, COL_W, CARD_H, C_BORDER, 0.5, 6);
  label('Cliente', ML + 12, Y + 10, COL_W - 20);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(C_NAVY);
  doc.text(clienteNombre, ML + 12, Y + 24, { width: COL_W - 20, lineBreak: false });
  doc.font('Helvetica').fontSize(8).fillColor(C_TEXT3);
  doc.text(clienteEmail, ML + 12, Y + 42, { width: COL_W - 20, lineBreak: false });

  // Card mudancero
  const MX = ML + COL_W + 12;
  fillRect(MX, Y, COL_W, CARD_H, C_BG2, 6);
  strokeRect(MX, Y, COL_W, CARD_H, C_BORDER, 0.5, 6);
  label('Mudancero', MX + 12, Y + 10, COL_W - 20);

  // Avatar
  fillRect(MX + 12, Y + 24, 32, 32, C_BG3, 5);
  strokeRect(MX + 12, Y + 24, 32, 32, C_BGRN, 0.5, 5);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(C_GRND);
  doc.text(mudInits, MX + 12, Y + 31, { width: 32, align: 'center' });

  // Nombre mudancero
  doc.font('Helvetica-Bold').fontSize(12).fillColor(C_NAVY);
  doc.text(mudNombre, MX + 52, Y + 24, { width: COL_W - 64, lineBreak: false });

  // Badge verificado
  fillRect(MX + 52, Y + 44, 60, 14, C_BG3, 3);
  strokeRect(MX + 52, Y + 44, 60, 14, C_BGRN, 0.5, 3);
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor(C_GRND);
  doc.text('VERIFICADO', MX + 52, Y + 48, { width: 60, align: 'center' });

  Y += CARD_H + 16;

  // ── 4. DETALLE MUDANZA ────────────────────────────────────────────
  // Título sección
  doc.font('Helvetica-Bold').fontSize(8).fillColor(C_BLUE);
  doc.text('DETALLE DE LA MUDANZA', ML, Y);
  Y += 12;
  hLine(ML, PW - MR, Y, C_BORDER, 0.5);
  Y += 6;

  const filas = [
    ['DESDE',      desde    ],
    ['HASTA',      hasta    ],
    ['FECHA',      fechaMud ],
    ['AMBIENTES',  ambientes],
    ['OBJETOS',    objetos  ],
  ];
  if (extras) filas.push(['SERVICIOS', extras]);
  if (nota)   filas.push(['NOTA', nota]);
  if (tiempo) filas.push(['TIEMPO EST.', tiempo]);

  filas.forEach(([lbl, val], i) => {
    const rowH = 20;
    if (i % 2 === 0) fillRect(ML, Y, CW, rowH, C_BG2, 2);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C_TEXT3);
    doc.text(lbl, ML + 10, Y + 6, { width: 90, lineBreak: false });
    doc.font('Helvetica').fontSize(9).fillColor(C_TEXT1);
    doc.text(String(val || '—'), ML + 108, Y + 6, { width: CW - 118, lineBreak: false });
    Y += rowH;
  });

  Y += 14;

  // ── 5. PRECIO ─────────────────────────────────────────────────────
  fillRect(ML, Y, CW, 68, C_BG3, 8);
  strokeRect(ML, Y, CW, 68, C_BGRN, 0.5, 8);
  // Barra izquierda verde
  fillRect(ML, Y, 5, 68, C_GREEN, 0);

  // Precio: tamaño adaptativo según largo (evita pisar la frase del costado)
  // $999.999 entra fácil; $2.000.000 ya empieza a apretar; $20.000.000 mucho más.
  var precioFontSize = precioFmt.length >= 12 ? 26 : (precioFmt.length >= 10 ? 30 : 36);
  doc.font('Helvetica-Bold').fontSize(precioFontSize).fillColor(C_NAVY);
  doc.text(precioFmt, ML + 20, Y + (precioFontSize === 36 ? 10 : (precioFontSize === 30 ? 14 : 18)), { lineBreak: false });
  // Calcular ancho real del precio renderizado para posicionar la frase después
  var precioWidth = doc.widthOfString(precioFmt);
  var fraseStartX = ML + 20 + precioWidth + 18; // 18px de gap

  doc.font('Helvetica-Bold').fontSize(7).fillColor(C_TEXT3);
  doc.text('PRECIO TOTAL', ML + 20, Y + 52);

  // Frase a la derecha: usa el espacio que quede después del precio
  var fraseAvailWidth = (ML + CW - 14) - fraseStartX;
  if (fraseAvailWidth >= 100) {
    // Si entra con tamaño normal, dos líneas
    doc.font('Helvetica').fontSize(8).fillColor(C_TEXT2);
    doc.text('Pago 100% por Mercado Pago.\nSeguro y protegido.', fraseStartX, Y + 22, { width: fraseAvailWidth, align: 'left' });
  } else if (fraseAvailWidth >= 60) {
    // Espacio justo: tipografía más chica
    doc.font('Helvetica').fontSize(7).fillColor(C_TEXT2);
    doc.text('Pago seguro\nMercado Pago', fraseStartX, Y + 24, { width: fraseAvailWidth, align: 'left' });
  }
  // Si no entra nada, la frase se omite (mejor que se solape)

  Y += 82;

  // ── 6. PROXIMOS PASOS ─────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(8).fillColor(C_BLUE);
  doc.text('PROXIMOS PASOS', ML, Y);
  Y += 12;

  fillRect(ML, Y, CW, 64, C_BG2, 6);
  strokeRect(ML, Y, CW, 64, C_BORDER, 0.5, 6);

  const pasos = [
    ['1', 'Aceptar\ncotizacion'],
    ['2', 'Pagar con\nMercado Pago'],
    ['3', 'Coordinar\nfecha y hora'],
    ['4', 'Mudanza\nlista!'],
  ];
  const stepW = CW / 4;
  pasos.forEach(([num, txt], i) => {
    const sx = ML + i * stepW + stepW / 2;
    // Círculo
    doc.circle(sx, Y + 26, 12).fill(C_GREEN);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(C_BG1);
    doc.text(num, sx - 12, Y + 19, { width: 24, align: 'center' });
    doc.font('Helvetica').fontSize(6.5).fillColor(C_TEXT2);
    doc.text(txt, sx - 28, Y + 42, { width: 56, align: 'center' });
    // Línea conectora
    if (i < 3) hLine(sx + 12, sx + stepW - 12, Y + 26, C_BORDER, 1);
  });

  Y += 78;

  // ── 7. GARANTIAS ──────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(8).fillColor(C_BLUE);
  doc.text('POR QUE ELEGIRNOS', ML, Y);
  Y += 12;

  const garantias = [
    { icon: 'MP',   titulo: 'Pago seguro',    sub: 'Mercado Pago' },
    { icon: 'DNI',  titulo: 'Verificado',      sub: 'Identidad confirmada' },
    { icon: '*****', titulo: 'Resenas',          sub: 'Verificadas' },
    { icon: '$=',   titulo: 'Sin sorpresas',   sub: 'Precio acordado' },
  ];
  const GW = (CW - 9) / 4;
  garantias.forEach((g, i) => {
    const gx = ML + i * (GW + 3);
    fillRect(gx, Y, GW, 54, C_BG2, 5);
    strokeRect(gx, Y, GW, 54, C_BORDER, 0.5, 5);
    doc.font('Helvetica-Bold').fontSize(12).fillColor(C_NAVY);
    doc.text(g.icon, gx, Y + 8, { width: GW, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(7).fillColor(C_TEXT1);
    doc.text(g.titulo, gx, Y + 28, { width: GW, align: 'center' });
    doc.font('Helvetica').fontSize(6).fillColor(C_TEXT3);
    doc.text(g.sub, gx, Y + 40, { width: GW, align: 'center' });
  });

  Y += 68;

  // ── 8a. AVISO AJUSTE DE PRECIO ────────────────────────────────────
  // Cuadro celeste informando que el mudancero puede proponer ajuste si detecta
  // condiciones no previstas durante el relevamiento.
  const ajusteY = Y;
  const ajusteH = 38;
  fillRect(ML, ajusteY, CW, ajusteH, '#EFF6FF', 5);
  strokeRect(ML, ajusteY, CW, ajusteH, '#93C5FD', 0.5, 5);
  fillRect(ML, ajusteY, 4, ajusteH, '#1A6FFF', 0);
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#1E40AF');
  doc.text('PRECIO SUJETO A AJUSTE', ML + 14, ajusteY + 6, { lineBreak: false });
  doc.font('Helvetica').fontSize(7).fillColor('#1E3A8A');
  doc.text('Si al dia de la mudanza hubiera condiciones no previstas (mas volumen, accesos complicados, piso sin ascensor, etc.), el mudancero puede proponerte un ajuste justificado. Vos decidis si lo aceptas; si rechazas, recuperas tu anticipo completo.', ML + 14, ajusteY + 18, { width: CW - 28, lineGap: 1 });

  Y += ajusteH + 8;

  // ── 8. AVISO PAGO SEGURO ──────────────────────────────────────────
  const avisoY = Y;
  fillRect(ML, avisoY, CW, 26, '#FFFBEB', 5);
  strokeRect(ML, avisoY, CW, 26, '#FCD34D', 0.5, 5);
  fillRect(ML, avisoY, 4, 26, '#F59E0B', 0);
  doc.font('Helvetica').fontSize(7.5).fillColor('#92400E').text('MudateYa solo garantiza pagos a traves de su plataforma. Pagos fuera de la plataforma no estan protegidos.', ML + 14, avisoY + 8, { width: CW - 28 });

  Y += 44;

  // ── 9. FOOTER ─────────────────────────────────────────────────────
  hLine(ML, PW - MR, Y, C_BORDER, 0.5);
  Y += 8;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(C_NAVY);
  doc.text('MudateYa', ML, Y, { lineBreak: false });
  doc.font('Helvetica').fontSize(8).fillColor(C_TEXT3);
  doc.text('  mudateya.ar  -  hola@mudateya.ar', ML + 56, Y, { lineBreak: false });
  doc.font('Helvetica').fontSize(7).fillColor(C_TEXT3);
  doc.text('Valida 7 dias  |  ' + nro, 0, Y, { width: PW - MR, align: 'right' });

  doc.end();

  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
    doc.on('error', reject);
  });
}


// ════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ════════════════════════════════════════════════════

// ── Email de alta exitosa al mudancero aprobado ───────────────────
async function enviarEmailAltaMudancero(perfil) {
  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);
  const token = Buffer.from(perfil.email + ':' + Date.now()).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
  await setJSON('terminos:token:' + token, { email: perfil.email, creado: new Date().toISOString() }, 7 * 24 * 60 * 60);
  const nombre = perfil.nombre || 'Mudancero';
  const empresa = perfil.empresa ? ' · ' + perfil.empresa : '';
  const linkTerminos = 'https://mudateya.ar/aceptar-terminos?token=' + token;
  await resend.emails.send({
    from:    'MudateYa <noreply@mudateya.ar>',
    to:      perfil.email,
    subject: '🎉 ¡Fuiste aprobado en MudateYa! Activá tu cuenta',
    html: '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">' +
      '<div style="background:#003580;padding:28px 32px"><div style="font-size:26px;font-weight:900;color:#fff">Mudate<span style="color:#22C36A">Ya</span></div></div>' +
      '<div style="background:#22C36A;padding:4px"></div>' +
      '<div style="padding:32px">' +
        '<div style="font-size:40px;text-align:center;margin-bottom:16px">🎉</div>' +
        '<h2 style="font-size:22px;color:#003580;margin:0 0 8px;text-align:center">¡Estás aprobado, ' + nombre + '!</h2>' +
        '<p style="font-size:14px;color:#475569;text-align:center;margin:0 0 28px">Revisamos tu perfil' + empresa + ' y todo está en orden.<br/>Ya podés empezar a recibir pedidos en tu zona.</p>' +
        '<div style="background:#F0FFF4;border:1px solid #BBF7D0;border-radius:12px;padding:20px 24px;margin-bottom:28px">' +
          '<div style="font-size:15px;font-weight:700;color:#166534;margin-bottom:8px">Un último paso — Aceptá los Términos y Condiciones</div>' +
          '<p style="font-size:13px;color:#475569;margin:0 0 16px;line-height:1.6">Para activar tu cuenta y aparecer en el catálogo, aceptá los Términos y Condiciones de MudateYa. Incluyen las comisiones y las reglas de la plataforma.</p>' +
          '<a href="' + linkTerminos + '" style="display:block;background:#22C36A;color:#fff;text-align:center;padding:14px 24px;border-radius:10px;text-decoration:none;font-size:15px;font-weight:700">✓ Aceptar Términos y Condiciones →</a>' +
          '<p style="font-size:11px;color:#94A3B8;text-align:center;margin:10px 0 0;font-family:monospace">Link válido por 7 días</p>' +
        '</div>' +
        '<div style="background:#F8FAFC;border-radius:10px;padding:16px 20px;margin-bottom:24px">' +
          '<div style="font-size:13px;font-weight:700;color:#0F1923;margin-bottom:10px">Comisiones:</div>' +
          '<table style="width:100%;font-size:13px;color:#475569">' +
            '<tr><td style="padding:4px 0">🏠 Mudanzas</td><td style="text-align:right;font-weight:700;color:#003580">15% por trabajo completado</td></tr>' +
            '<tr><td style="padding:4px 0">📦 Fletes</td><td style="text-align:right;font-weight:700;color:#003580">20% por trabajo completado</td></tr>' +
            '<tr><td style="padding:4px 0">🏢 Pedidos Plan Referidos</td><td style="text-align:right;font-weight:700;color:#003580">25% por trabajo completado</td></tr>' +
            '<tr><td colspan="2" style="padding:6px 0 4px;color:#64748B;font-size:11px;font-style:italic">Plan Referidos: pedidos que llegan pre-calificados desde nuestros asesores inmobiliarios aliados.</td></tr>' +
            '<tr><td colspan="2" style="padding:4px 0;color:#94A3B8;font-size:11px">Solo pagás comisión cuando completás un trabajo. Sin costos fijos.</td></tr>' +
          '</table>' +
          '<div style="margin-top:12px;padding-top:12px;border-top:1px solid #E2E8F0;font-size:12px;color:#64748B;line-height:1.6">' +
            '💸 <strong>Liquidación:</strong> dentro de los <strong>15 días hábiles</strong> posteriores a la confirmación del pago del cliente.' +
          '</div>' +
        '</div>' +
        '<div style="text-align:center"><a href="https://mudateya.ar/mi-cuenta" style="color:#1A6FFF;font-size:13px;text-decoration:none">Ver mi cuenta en MudateYa →</a></div>' +
      '</div>' +
      '<div style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:16px 32px;text-align:center"><p style="font-size:11px;color:#94A3B8;font-family:monospace;margin:0">MudateYa · <a href="https://mudateya.ar" style="color:#94A3B8">mudateya.ar</a></p></div>' +
    '</div>',
  });
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS PARA PROGRAMA DE ALIADOS
// ═══════════════════════════════════════════════════════════════════
// Llama internamente al endpoint /api/aliados con header de autenticación interna.
// No usamos import directo para mantener los endpoints desacoplados.
async function aliadosCall(actionName, body) {
  try {
    var url = 'https://mudateya.ar/api/aliados?action=' + actionName;
    var r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': process.env.INTERNAL_API_SECRET || ''
      },
      body: JSON.stringify(body || {})
    });
    if (!r.ok) return { ok:false };
    return await r.json();
  } catch(e) {
    console.warn('aliadosCall error:', e.message);
    return { ok:false };
  }
}

// Crea atribución al publicar si el cliente viene con ref válida
async function hookCrearAtribucion(mudanzaId, refSlug, tipo) {
  if (!refSlug || !mudanzaId) return;
  try {
    await aliadosCall('internal-crear-atribucion', {
      mudanzaId: mudanzaId,
      slug: String(refSlug).toUpperCase().trim(),
      tipo: tipo || 'mudanza'
    });
  } catch(e) { console.warn('hookCrearAtribucion:', e.message); }
}

// Acredita la atribución al completarse la mudanza (saldo pagado)
async function hookAcreditarAliado(mudanzaId) {
  if (!mudanzaId) return;
  try {
    await aliadosCall('internal-acreditar', { mudanzaId: mudanzaId });
  } catch(e) { console.warn('hookAcreditarAliado:', e.message); }
}

// Cancela la atribución si la mudanza se elimina o cancela
async function hookCancelarAtribucion(mudanzaId) {
  if (!mudanzaId) return;
  try {
    await aliadosCall('internal-cancelar', { mudanzaId: mudanzaId });
  } catch(e) { console.warn('hookCancelarAtribucion:', e.message); }
}

// ── Hook ASESORES (Plan Referidos) ──────────────────────────────────
async function asesoresCall(actionName, body) {
  try {
    var url = 'https://mudateya.ar/api/asesores?action=' + actionName;
    var r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': process.env.INTERNAL_API_SECRET || ''
      },
      body: JSON.stringify(body || {})
    });
    if (!r.ok) return { ok:false };
    return await r.json();
  } catch(e) {
    console.warn('asesoresCall error:', e.message);
    return { ok:false };
  }
}

// Marca un pedido-asesor como pagado (anticipo) o completado (saldo)
async function hookAsesorPagado(pedidoAsesorId, tipoPago) {
  if (!pedidoAsesorId) return;
  try {
    await asesoresCall('internal-marcar-pagado', {
      pedidoAsesorId: pedidoAsesorId,
      tipoPago: tipoPago || 'anticipo'
    });
  } catch(e) { console.warn('hookAsesorPagado:', e.message); }
}

// Marca un pedido-asesor como cancelado (cliente eliminó la mudanza).
// El handler interno notifica al asesor (push + email).
async function hookAsesorCancelado(pedidoAsesorId) {
  if (!pedidoAsesorId) return;
  try {
    await asesoresCall('internal-marcar-cancelado', {
      pedidoAsesorId: pedidoAsesorId
    });
  } catch(e) { console.warn('hookAsesorCancelado:', e.message); }
}

module.exports = async function handler(req, res) {
  // ── CORS: solo aceptar requests desde mudateya.ar ──────────────
  const allowedOrigins = [
    'https://mudateya.ar',
    'https://www.mudateya.ar',
    process.env.ALLOWED_ORIGIN || '', // para staging/dev
  ].filter(Boolean);
  const origin = req.headers.origin || '';
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    // Request sin Origin (ej: curl desde el servidor mismo, Vercel cron)
    res.setHeader('Access-Control-Allow-Origin', 'https://mudateya.ar');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Token');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  // ── RATE LIMITING por IP ─────────────────────────────────────────
  const RATE_LIMITED_ACTIONS = ['publicar', 'cotizar', 'analizar-foto', 'crear-sesion', 'request-magic-link', 'request-magic-link-cliente'];
  if (RATE_LIMITED_ACTIONS.includes(action)) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    const rlKey = `ratelimit:${action}:${ip}`;
    const MAX_PER_MINUTE = action === 'analizar-foto' ? 5 : 15;
    try {
      const current = await redisCall('INCR', rlKey);
      if (parseInt(current) === 1) await redisCall('EXPIRE', rlKey, '60');
      if (parseInt(current) > MAX_PER_MINUTE) {
        return res.status(429).json({ error: 'Demasiados requests. Esperá un momento.' });
      }
    } catch(rlErr) {
      console.warn('Rate limit check failed:', rlErr.message);
      // Si Redis falla el rate limit, continuar igual (no bloquear)
    }
  }

  // ── AUTH HELPERS ────────────────────────────────────────────────
  // Acciones que requieren que el email del body/query coincida con
  // el token de sesión guardado en Redis (clienteToken o mudanceroToken)
  async function verificarSesionCliente(email) {
    const token = req.headers['x-session-token'] || req.query.sessionToken;
    if (!token) return false;
    const tokenGuardado = await getJSON(`session:cliente:${email}`);
    return tokenGuardado && tokenGuardado === token;
  }
  async function verificarSesionMudancero(email) {
    const token = req.headers['x-session-token'] || req.query.sessionToken;
    if (!token) return false;
    const tokenGuardado = await getJSON(`session:mudancero:${email}`);
    return tokenGuardado && tokenGuardado === token;
  }
  // Acción pública: crear sesión al hacer login con Google (llamada desde el frontend)
  // El frontend ya validó el token con el SDK de Google — acá solo guardamos la sesión
  if (action === 'crear-sesion' && req.method === 'POST') {
    const { email, googleIdToken, rol } = req.body;
    if (!email || !googleIdToken) return res.status(400).json({ error: 'Faltan datos' });
    // Verificar el token de Google en el backend
    const verifyUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${googleIdToken}`;
    const verifyRes = await fetch(verifyUrl);
    const verifyData = await verifyRes.json();
    if (verifyData.email !== email) return res.status(401).json({ error: 'Token inválido' });
    if (verifyData.aud !== process.env.GOOGLE_CLIENT_ID) return res.status(401).json({ error: 'Token inválido' });
    // Generar token de sesión
    const sessionToken = require('crypto').randomBytes(32).toString('hex');
    const ttl = 60 * 60 * 24 * 7; // 7 días
    const prefix = rol === 'mudancero' ? 'mudancero' : 'cliente';
    await setJSON(`session:${prefix}:${email}`, sessionToken, ttl);
    return res.status(200).json({ ok: true, sessionToken, ttl });
  }

  // ── MAGIC LINK: solicitar link de login por email ──────────────────
  // POST /api/cotizaciones?action=request-magic-link  body: { email }
  // Solo manda link si el email pertenece a un mudancero registrado.
  // Rate limit: máximo 3 magic links por email cada 10 minutos.
  if (action === 'request-magic-link' && req.method === 'POST') {
    const { email } = req.body || {};
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Email inválido' });
    }
    const emailNorm = String(email).trim().toLowerCase();
    // Rate limit por email (3 intentos / 10 min)
    const rlKey = `magiclink:rl:${emailNorm}`;
    const intentos = (await getJSON(rlKey)) || 0;
    if (intentos >= 3) {
      // Respondemos 200 igual para no filtrar info, pero no mandamos email
      return res.status(200).json({ ok: true, message: 'Si tu email está registrado, recibirás un link en breve.' });
    }
    await setJSON(rlKey, intentos + 1, 600); // TTL 10 min

    // Verificar que el mudancero exista
    const perfil = await getJSON(`mudancero:perfil:${emailNorm}`);
    if (!perfil) {
      // Respondemos 200 igual para no filtrar emails registrados a un atacante
      return res.status(200).json({ ok: true, message: 'Si tu email está registrado, recibirás un link en breve.' });
    }

    // Generar token único (UUID-like, 32 chars hex)
    const token = require('crypto').randomBytes(32).toString('hex');
    const TTL_LINK = 15 * 60; // 15 minutos
    await setJSON(`magiclink:token:${token}`, { email: emailNorm, creado: Date.now() }, TTL_LINK);

    // Mandar email
    if (!process.env.RESEND_API_KEY) {
      console.error('[magic-link] RESEND_API_KEY no configurada');
      return res.status(500).json({ error: 'Error de configuración del servidor' });
    }
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const link = `https://mudateya.ar/mi-cuenta?token=${token}`;
    const nombre = String(perfil.nombre || 'Mudancero').replace(/[<>&"']/g, function(c){
      return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c];
    });

    try {
      await resend.emails.send({
        from:    'MudateYa <noreply@mudateya.ar>',
        to:      emailNorm,
        subject: '🔑 Tu link de acceso a MudateYa',
        html: '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">' +
          '<div style="background:#003580;padding:28px 32px"><div style="font-size:26px;font-weight:900;color:#fff">Mudate<span style="color:#22C36A">Ya</span></div></div>' +
          '<div style="background:#22C36A;padding:4px"></div>' +
          '<div style="padding:32px">' +
            '<div style="font-size:40px;text-align:center;margin-bottom:12px">🔑</div>' +
            '<h2 style="font-size:20px;color:#003580;margin:0 0 8px;text-align:center">Hola ' + nombre + ',</h2>' +
            '<p style="font-size:14px;color:#475569;text-align:center;margin:0 0 24px;line-height:1.5">Hacé click en el botón para entrar a tu cuenta de MudateYa.<br/>Este link es válido por <b>15 minutos</b> y se puede usar una sola vez.</p>' +
            '<div style="text-align:center;margin:24px 0">' +
              '<a href="' + link + '" style="display:inline-block;background:#22C36A;color:#fff;font-weight:700;font-size:15px;padding:14px 32px;border-radius:10px;text-decoration:none">Ingresar a mi cuenta</a>' +
            '</div>' +
            '<p style="font-size:12px;color:#64748B;text-align:center;margin:20px 0 0;line-height:1.5">Si el botón no funciona, copiá y pegá este link en tu navegador:<br/><span style="font-family:monospace;font-size:11px;word-break:break-all;color:#475569">' + link + '</span></p>' +
            '<div style="margin-top:28px;padding-top:20px;border-top:1px solid #E2E8F0">' +
              '<p style="font-size:11px;color:#94A3B8;text-align:center;margin:0;line-height:1.5">Si vos no pediste este link, podés ignorar este email.<br/>Por seguridad, el link expira en 15 minutos.</p>' +
            '</div>' +
          '</div>' +
          '<div style="background:#F5F7FA;padding:16px 32px;text-align:center;font-size:11px;color:#94A3B8">© MudateYa · <a href="https://mudateya.ar" style="color:#1A6FFF;text-decoration:none">mudateya.ar</a></div>' +
          '</div>'
      });
    } catch(emailErr) {
      console.error('[magic-link] Error enviando email:', emailErr);
      return res.status(500).json({ error: 'No se pudo enviar el email. Intentá de nuevo en unos minutos.' });
    }
    return res.status(200).json({ ok: true, message: 'Si tu email está registrado, recibirás un link en breve.' });
  }

  // ── MAGIC LINK CLIENTE: solicitar link de login para cliente ──────
  // POST /api/cotizaciones?action=request-magic-link-cliente  body: { email, nombre }
  // No requiere que el cliente exista previamente en Redis (puede ser nuevo).
  // Rate limit: 3 magic links por email cada 10 min.
  if (action === 'request-magic-link-cliente' && req.method === 'POST') {
    const { email, nombre } = req.body || {};
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Email inválido' });
    }
    const emailNorm = String(email).trim().toLowerCase();
    const nombreNorm = String(nombre || emailNorm.split('@')[0]).trim().slice(0, 80);

    // Rate limit por email
    const rlKey = `magiclink:rl:cliente:${emailNorm}`;
    const intentos = (await getJSON(rlKey)) || 0;
    if (intentos >= 3) {
      return res.status(200).json({ ok: true, message: 'Si todo está OK, recibirás un link en breve.' });
    }
    await setJSON(rlKey, intentos + 1, 600);

    // Generar token
    const token = require('crypto').randomBytes(32).toString('hex');
    const TTL_LINK = 15 * 60;
    await setJSON(`magiclink:token:${token}`, {
      email: emailNorm,
      nombre: nombreNorm,
      tipo: 'cliente',
      creado: Date.now()
    }, TTL_LINK);

    if (!process.env.RESEND_API_KEY) {
      console.error('[magic-link-cliente] RESEND_API_KEY no configurada');
      return res.status(500).json({ error: 'Error de configuración del servidor' });
    }
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const link = `https://mudateya.ar/?token=${token}`;
    const nombreEsc = nombreNorm.replace(/[<>&"']/g, function(c){
      return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c];
    });

    try {
      await resend.emails.send({
        from:    'MudateYa <noreply@mudateya.ar>',
        to:      emailNorm,
        subject: '🔑 Tu link para publicar tu mudanza en MudateYa',
        html: '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">' +
          '<div style="background:#003580;padding:28px 32px"><div style="font-size:26px;font-weight:900;color:#fff">Mudate<span style="color:#22C36A">Ya</span></div></div>' +
          '<div style="background:#22C36A;padding:4px"></div>' +
          '<div style="padding:32px">' +
            '<div style="font-size:40px;text-align:center;margin-bottom:12px">📦</div>' +
            '<h2 style="font-size:20px;color:#003580;margin:0 0 8px;text-align:center">Hola ' + nombreEsc + ',</h2>' +
            '<p style="font-size:14px;color:#475569;text-align:center;margin:0 0 24px;line-height:1.5">Hacé click para volver a MudateYa y completar tu pedido de mudanza.<br/>El link es válido por <b>15 minutos</b> y se puede usar una sola vez.</p>' +
            '<div style="text-align:center;margin:24px 0">' +
              '<a href="' + link + '" style="display:inline-block;background:#22C36A;color:#fff;font-weight:700;font-size:15px;padding:14px 32px;border-radius:10px;text-decoration:none">Ingresar y publicar mi mudanza</a>' +
            '</div>' +
            '<p style="font-size:12px;color:#64748B;text-align:center;margin:20px 0 0;line-height:1.5">Si el botón no funciona, copiá este link:<br/><span style="font-family:monospace;font-size:11px;word-break:break-all;color:#475569">' + link + '</span></p>' +
            '<div style="margin-top:28px;padding-top:20px;border-top:1px solid #E2E8F0">' +
              '<p style="font-size:11px;color:#94A3B8;text-align:center;margin:0;line-height:1.5">Si vos no pediste este link, podés ignorar este email.<br/>Por seguridad, expira en 15 minutos.</p>' +
            '</div>' +
          '</div>' +
          '<div style="background:#F5F7FA;padding:16px 32px;text-align:center;font-size:11px;color:#94A3B8">© MudateYa · <a href="https://mudateya.ar" style="color:#1A6FFF;text-decoration:none">mudateya.ar</a></div>' +
          '</div>'
      });
    } catch(emailErr) {
      console.error('[magic-link-cliente] Error enviando email:', emailErr);
      return res.status(500).json({ error: 'No se pudo enviar el email. Intentá de nuevo.' });
    }
    return res.status(200).json({ ok: true, message: 'Te mandamos un link a tu email. Revisá tu casilla (también el spam).' });
  }

  // ── MAGIC LINK: validar token y crear sesión ───────────────────────
  // POST /api/cotizaciones?action=verify-magic-link  body: { token }
  // Valida el token, lo borra (one-time use), y devuelve sessionToken + datos del usuario.
  // Soporta tipo 'mudancero' (busca perfil) y 'cliente' (acepta sin perfil previo).
  if (action === 'verify-magic-link' && req.method === 'POST') {
    const { token } = req.body || {};
    if (!token || typeof token !== 'string' || token.length !== 64) {
      return res.status(400).json({ error: 'Token inválido' });
    }
    const data = await getJSON(`magiclink:token:${token}`);
    if (!data || !data.email) {
      return res.status(401).json({ error: 'Link inválido o expirado. Pedí uno nuevo.' });
    }
    // Borrar token inmediatamente (one-time use)
    try { await redisCall('DEL', `magiclink:token:${token}`); } catch(e) {}

    const emailNorm = data.email;
    const tipo = data.tipo || 'mudancero'; // tokens viejos = mudancero por default
    const sessionToken = require('crypto').randomBytes(32).toString('hex');
    const ttl = 60 * 60 * 24 * 7; // 7 días

    if (tipo === 'cliente') {
      // Login de cliente: NO requiere perfil previo
      await setJSON(`session:cliente:${emailNorm}`, sessionToken, ttl);
      return res.status(200).json({
        ok: true,
        sessionToken,
        ttl,
        email: emailNorm,
        nombre: data.nombre || emailNorm.split('@')[0],
        tipo: 'cliente'
      });
    }

    // Login de mudancero: requiere perfil registrado
    const perfil = await getJSON(`mudancero:perfil:${emailNorm}`);
    if (!perfil) {
      return res.status(401).json({ error: 'No encontramos tu perfil. Contactanos.' });
    }
    await setJSON(`session:mudancero:${emailNorm}`, sessionToken, ttl);
    return res.status(200).json({
      ok: true,
      sessionToken,
      ttl,
      email: emailNorm,
      nombre: perfil.nombre || '',
      empresa: perfil.empresa || '',
      foto: perfil.foto || '',
      tipo: 'mudancero'
    });
  }

  try {

    if (action === 'publicar' && req.method === 'POST') {
      const { clienteEmail, clienteNombre, desde, hasta, ambientes, fecha, servicios, extras, zonaBase, precio_estimado, clienteWA, tipo, pisoOrigen, pisoDestino, ascOrigen, ascDestino, fotos, refAliado, km, nivel } = req.body;
      if (!clienteEmail || !desde || !hasta) return res.status(400).json({ error: 'Faltan datos' });
      // ── LÍMITES ANTI-SPAM ──────────────────────────────────────────────
      // Límite 1: máximo 2 pedidos activos simultáneos por cliente
      const MAX_ACTIVOS_POR_CLIENTE = 2;
      const idxCliente = await getJSON(`cliente:${clienteEmail}`) || [];
      const ahora = new Date();
      let activosCliente = 0;
      for (const mid of idxCliente) {
        const m = await getJSON(`mudanza:${mid}`);
        if (m && ['buscando', 'cotizaciones_completas'].includes(m.estado) && new Date(m.expira) > ahora) {
          activosCliente++;
        }
      }
      if (activosCliente >= MAX_ACTIVOS_POR_CLIENTE) {
        return res.status(429).json({
          error: `Ya tenés ${activosCliente} pedido${activosCliente > 1 ? 's' : ''} activo${activosCliente > 1 ? 's' : ''}. Esperá a que expiren o cancelá uno antes de publicar otro.`,
          codigo: 'LIMITE_ACTIVOS'
        });
      }

      // Límite 2: cooldown deshabilitado para testing
      // await setJSON(`cliente:ultima-pub:${clienteEmail}`, ahora.toISOString(), 600);

      // Límite 3: máximo diario deshabilitado para testing
      // ── FIN LÍMITES ────────────────────────────────────────────────────

      const id = 'MYA-' + Date.now();
      const { modoCotizacion, mudancerosInvitados } = req.body;
      // modoCotizacion: 'abierto' (primeros 5) | 'dirigido' (cliente elige mudanceros)
      const modo = modoCotizacion || 'abierto';
      const MAX_COT = 5;

      // km viene calculado desde el frontend (Google Maps lado cliente).
      // Si no llega, queda null — la cotización funciona igual sin el desglose por km.
      const kmDistancia = (typeof km === 'number' && km > 0) ? Math.round(km) : (parseInt(km) > 0 ? parseInt(km) : null);

      // Normalizar nivel: 'esencial' | 'integral' | 'llave' | 'flete' | null
      const NIVELES_VALIDOS = ['esencial','integral','llave','flete'];
      const nivelNorm = (typeof nivel === 'string' && NIVELES_VALIDOS.indexOf(nivel) !== -1)
        ? nivel
        : ((tipo || 'mudanza') === 'flete' ? 'flete' : null);

      const mudanza = { id, clienteEmail, clienteNombre, clienteWA: clienteWA||'', desde, hasta, ambientes, fecha, servicios, extras, zonaBase, precio_estimado, tipo: tipo||'mudanza', nivel: nivelNorm, pisoOrigen, pisoDestino, ascOrigen, ascDestino, fotos: fotos||[], km: kmDistancia, estado: 'buscando', modoCotizacion: modo, maxCotizaciones: MAX_COT, mudancerosInvitados: mudancerosInvitados||[], refAliado: refAliado || null, fechaPublicacion: new Date().toISOString(), expira: new Date(Date.now() + 24*60*60*1000).toISOString(), cotizaciones: [] };
      await setJSON(`mudanza:${id}`, mudanza, 604800);
      const clienteIdx = await getJSON(`cliente:${clienteEmail}`) || [];
      if (!clienteIdx.includes(id)) clienteIdx.push(id);
      await setJSON(`cliente:${clienteEmail}`, clienteIdx, 2592000);
      const globalIdx = await getJSON('mudanzas:activas') || [];
      if (!globalIdx.includes(id)) globalIdx.push(id);
      await setJSON('mudanzas:activas', globalIdx, 604800);
      // Índice permanente sin TTL para admin
      const todosIdx = await getJSON('mudanzas:todos') || [];
      if (!todosIdx.includes(id)) todosIdx.push(id);
      await setJSON('mudanzas:todos', todosIdx);
      // Registro centralizado de clientes
      const clientePerfil = await getJSON(`cliente:perfil:${clienteEmail}`) || {
        email: clienteEmail,
        nombre: clienteNombre || '',
        wa: clienteWA || '',
        fechaRegistro: new Date().toISOString(),
        mudanzas: 0,
        estado: 'activo',
      };
      clientePerfil.nombre     = clienteNombre || clientePerfil.nombre;
      clientePerfil.wa         = clienteWA || clientePerfil.wa;
      clientePerfil.mudanzas   = (clientePerfil.mudanzas || 0) + 1;
      clientePerfil.ultimaActividad = new Date().toISOString();
      await setJSON(`cliente:perfil:${clienteEmail}`, clientePerfil);
      const clientesTodos = await getJSON('clientes:todos') || [];
      if (!clientesTodos.includes(clienteEmail)) clientesTodos.push(clienteEmail);
      await setJSON('clientes:todos', clientesTodos);
      try { await notificarMudanceros(mudanza); } catch(e) { console.error(e.message); }
      // ── Hook aliados: crear atribución si el cliente vino por un link de aliado ──
      if (refAliado) {
        try { await hookCrearAtribucion(id, refAliado, tipo || 'mudanza'); } catch(e) { console.warn('Hook aliado publicar:', e.message); }
      }
      return res.status(200).json({ ok: true, id, mudanza });
    }

    if (action === 'cotizar' && req.method === 'POST') {
      const { mudanzaId, mudanceroEmail, mudanceroNombre, mudanceroTel, precio, nota, tiempoEstimado, propuestas } = req.body;
      if (!mudanzaId || !mudanceroEmail) return res.status(400).json({ error: 'Faltan datos' });
      const mudanza = await getJSON(`mudanza:${mudanzaId}`);
      if (!mudanza) return res.status(404).json({ error: 'Mudanza no encontrada' });
      if (mudanza.estado !== 'buscando') return res.status(400).json({ error: 'No acepta más cotizaciones' });
      if (mudanza.cotizaciones.find(c => c.mudanceroEmail === mudanceroEmail)) return res.status(400).json({ error: 'Ya cotizaste esta mudanza' });

      // Modo dirigido: solo pueden cotizar los mudanceros invitados por el cliente
      if (mudanza.modoCotizacion === 'dirigido') {
        const invitados = mudanza.mudancerosInvitados || [];
        if (!invitados.includes(mudanceroEmail)) {
          return res.status(403).json({ error: 'Esta mudanza solo acepta cotizaciones de mudanceros seleccionados por el cliente' });
        }
      }

      // ── Construir array de propuestas ─────────────────────────────────
      // Nueva estructura: una cotización contiene 1-3 propuestas (Esencial/Integral/Llave) + opcional Flete
      // Cada propuesta tiene: { nivel, precio, tiempoEstimado, nota }
      // Compat: si llega solo `precio` plano (modo viejo), se convierte a una sola propuesta con el nivel del pedido
      const NIVELES_VALIDOS = ['esencial','integral','llave','flete'];
      let propuestasNorm = [];
      if (Array.isArray(propuestas) && propuestas.length > 0) {
        // Modo nuevo: propuestas[]
        propuestasNorm = propuestas
          .filter(p => p && NIVELES_VALIDOS.indexOf(p.nivel) !== -1)
          .map(p => ({
            nivel: p.nivel,
            precio: parseInt(String(p.precio||0).replace(/\./g,'').replace(/[^0-9]/g,'')) || 0,
            tiempoEstimado: p.tiempoEstimado || '',
            nota: p.nota || ''
          }))
          .filter(p => p.precio > 0);
      } else if (precio) {
        // Modo viejo: precio plano
        const precioLimpio = parseInt(String(precio).replace(/\./g,'').replace(/[^0-9]/g,'')) || 0;
        if (precioLimpio > 0) {
          const nivelDefault = mudanza.nivel || 'esencial';
          propuestasNorm = [{
            nivel: nivelDefault,
            precio: precioLimpio,
            tiempoEstimado: tiempoEstimado || '',
            nota: nota || ''
          }];
        }
      }
      if (propuestasNorm.length === 0) return res.status(400).json({ error: 'Falta al menos una propuesta con precio' });

      // Para compat con código existente (PDF, listados viejos, etc.):
      // El "precio principal" de la cotización es el del nivel pedido por el cliente, o la primera propuesta.
      const nivelPedido = mudanza.nivel || 'esencial';
      const propMatch = propuestasNorm.find(p => p.nivel === nivelPedido) || propuestasNorm[0];

      const cotizacion = {
        id: 'COT-' + Date.now(),
        mudanzaId,
        mudanceroEmail,
        mudanceroNombre,
        mudanceroTel,
        // Nuevo modelo: array de propuestas
        propuestas: propuestasNorm,
        // Compat con código viejo (no romper): exponer la propuesta principal en el nivel raíz
        precio: propMatch.precio,
        nota: propMatch.nota,
        tiempoEstimado: propMatch.tiempoEstimado,
        fecha: new Date().toISOString(),
        estado: 'pendiente'
      };
      mudanza.cotizaciones.push(cotizacion);

      // Cierre automatico deshabilitado para testing
      await setJSON(`mudanza:${mudanzaId}`, mudanza, 172800);
      const mudIdx = await getJSON(`mudancero:${mudanceroEmail}`) || [];
      if (!mudIdx.includes(mudanzaId)) mudIdx.push(mudanzaId);
      await setJSON(`mudancero:${mudanceroEmail}`, mudIdx, 2592000);
      try { await notificarCliente(mudanza, cotizacion); } catch(e) { console.error(e.message); }
      return res.status(200).json({ ok: true, cotizacion });
    }

    if (action === 'pdf' && req.method === 'GET') {
      const { mudanzaId, cotizacionId, propuestaNivel } = req.query;
      if (!mudanzaId || !cotizacionId) return res.status(400).json({ error: 'Faltan parámetros' });
      const mudanza = await getJSON(`mudanza:${mudanzaId}`);
      if (!mudanza) return res.status(404).json({ error: 'Mudanza no encontrada' });
      const cot = mudanza.cotizaciones.find(c => c.id === cotizacionId);
      if (!cot) return res.status(404).json({ error: 'Cotización no encontrada' });

      // Si la cotización tiene propuestas[] múltiples, elegir cuál mostrar en el PDF
      let precioPDF = cot.precio;
      let notaPDF = cot.nota;
      let tiempoPDF = cot.tiempoEstimado;
      let nivelPDF = cot.nivelAceptado || mudanza.nivel || 'esencial';
      if (Array.isArray(cot.propuestas) && cot.propuestas.length > 0) {
        let prop = null;
        if (propuestaNivel) {
          prop = cot.propuestas.find(p => p.nivel === propuestaNivel);
        }
        if (!prop) {
          // Default: nivel pedido por el cliente o primera propuesta
          prop = cot.propuestas.find(p => p.nivel === (mudanza.nivel || 'esencial')) || cot.propuestas[0];
        }
        if (prop) {
          precioPDF  = prop.precio;
          notaPDF    = prop.nota || cot.nota;
          tiempoPDF  = prop.tiempoEstimado || cot.tiempoEstimado;
          nivelPDF   = prop.nivel;
        }
      }
      const NIVEL_NOMBRES = { esencial:'Esencial', integral:'Integral', llave:'Llave en mano', flete:'Flete' };
      const packNombre = NIVEL_NOMBRES[nivelPDF] || 'Esencial';

      const pdfBase64 = await generarPDFBase64({
        id:                cot.id + (propuestaNivel ? '-' + propuestaNivel : ''),
        fechaEmision:      new Date().toLocaleDateString('es-AR', { day:'numeric', month:'long', year:'numeric' }),
        clienteNombre:     mudanza.clienteNombre,
        clienteEmail:      mudanza.clienteEmail,
        mudanceroNombre:   cot.mudanceroNombre,
        mudancero_initials:(cot.mudanceroNombre||'MV').slice(0,2).toUpperCase(),
        desde:             mudanza.desde,
        hasta:             mudanza.hasta,
        fecha:             mudanza.fecha,
        ambientes:         mudanza.ambientes,
        objetos:           mudanza.servicios,
        extras:            mudanza.extras,
        precio:            precioPDF,
        nota:              notaPDF ? ('Pack: ' + packNombre + (notaPDF ? ' · ' + notaPDF : '')) : ('Pack: ' + packNombre),
        tiempoEstimado:    tiempoPDF,
        pack:              packNombre,
      });
      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="presupuesto-${cot.id}.pdf"`);
      res.setHeader('Content-Length', pdfBuffer.length);
      return res.status(200).end(pdfBuffer);
    }

    if (action === 'aceptar' && req.method === 'POST') {
      const { mudanzaId, cotizacionId, propuestaNivel } = req.body;
      const mudanza = await getJSON(`mudanza:${mudanzaId}`);
      if (!mudanza) return res.status(404).json({ error: 'Mudanza no encontrada' });
      const cot = mudanza.cotizaciones.find(c => c.id === cotizacionId);
      if (!cot) return res.status(404).json({ error: 'Cotización no encontrada' });

      // ── Determinar la propuesta aceptada ─────────────────────────────
      // Si la cotización tiene propuestas[] múltiples y el cliente eligió una específica,
      // se "fija" esa propuesta como la aceptada (pisa precio/nota/tiempoEstimado en el root).
      let propuestaAceptada = null;
      if (Array.isArray(cot.propuestas) && cot.propuestas.length > 0) {
        if (propuestaNivel) {
          propuestaAceptada = cot.propuestas.find(p => p.nivel === propuestaNivel);
        }
        if (!propuestaAceptada) {
          // Fallback: nivel pedido por el cliente, o primera propuesta
          const nivelDef = mudanza.nivel || 'esencial';
          propuestaAceptada = cot.propuestas.find(p => p.nivel === nivelDef) || cot.propuestas[0];
        }
        // Pisar campos de la cotización con los de la propuesta aceptada
        cot.precio          = propuestaAceptada.precio;
        cot.nota            = propuestaAceptada.nota;
        cot.tiempoEstimado  = propuestaAceptada.tiempoEstimado;
        cot.nivelAceptado   = propuestaAceptada.nivel;
      }

      mudanza.estado = 'cotizacion_aceptada';
      mudanza.cotizacionAceptada = cot;
      mudanza.mudanceroAceptado = cot.mudanceroEmail;
      mudanza.montoTotal = cot.precio;
      mudanza.nivelAceptado = cot.nivelAceptado || mudanza.nivel || 'esencial';
      // Agregar datos del cliente para que el mudancero pueda contactarlo
      mudanza.cotizacionAceptada.clienteNombre = mudanza.clienteNombre;
      mudanza.cotizacionAceptada.clienteEmail  = mudanza.clienteEmail;
      cot.estado = 'aceptada';
      await setJSON(`mudanza:${mudanzaId}`, mudanza, 604800);
      try { await enviarEmailAceptacion(mudanza, cot); } catch(e) { console.error('Error email:', e.message); }
      return res.status(200).json({ ok: true, mudanza, cotizacion: cot });
    }

    if (action === 'mis-mudanzas' && req.method === 'GET') {
      const { email } = req.query;
      if (!email) return res.status(400).json({ error: 'Falta email' });
      // ── Verificar sesión si viene token (soft mode hasta integrar frontend) ──
      const token = req.headers['x-session-token'] || req.query.sessionToken;
      if (token) {
        const autenticado = await verificarSesionCliente(email);
        if (!autenticado) return res.status(401).json({ error: 'Sesión inválida' });
      }
      // Sin token: continúa (modo legado — eliminar cuando el frontend esté integrado)
      try {
        const ids = await getJSON(`cliente:${email}`) || [];
        const mudanzas = [];
        for (const id of ids) {
          try {
            const m = await getJSON(`mudanza:${id}`);
            // Excluir mudanzas marcadas como eliminadas (defensa en profundidad)
            if (m && m.estado !== 'eliminada') mudanzas.push(m);
          } catch(e) {}
        }
        return res.status(200).json({ mudanzas });
      } catch(e) { return res.status(200).json({ mudanzas: [] }); }
    }

    // Registrar pago realizado (anticipo o saldo) — llamado desde pago-exitoso
    if (action === 'registrar-pago' && req.method === 'POST') {
      const { mudanzaId, tipoPago, mpPaymentId } = req.body;
      if (!mudanzaId || !tipoPago) return res.status(400).json({ error: 'Faltan datos' });
      // ── Solo se acepta desde la API interna de Mercado Pago (webhook) ──
      // O con un secret interno para el flujo de pago-exitoso
      const internalSecret = req.headers['x-internal-secret'];
      const validSecret = process.env.INTERNAL_API_SECRET;
      if (!validSecret || internalSecret !== validSecret) {
        return res.status(403).json({ error: 'Sin autorización para registrar pagos' });
      }
      const m = await getJSON(`mudanza:${mudanzaId}`);
      if (!m) return res.status(404).json({ error: 'No encontrada' });
      // Verificar que el pago de MP existe y es válido (si viene mpPaymentId)
      if (mpPaymentId && process.env.MP_ACCESS_TOKEN) {
        try {
          const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${mpPaymentId}`, {
            headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` }
          });
          const mpData = await mpRes.json();
          if (mpData.status !== 'approved') {
            return res.status(400).json({ error: 'Pago de MP no aprobado' });
          }
          // Guardar el ID de pago de MP para auditoría
          if (tipoPago === 'anticipo') m.mpAnticipoPagoId = mpPaymentId;
          if (tipoPago === 'saldo')    m.mpSaldoPagoId = mpPaymentId;
        } catch(mpErr) {
          console.warn('No se pudo verificar pago MP:', mpErr.message);
          // Continuar igual — el webhook es la fuente de verdad
        }
      }
      if (tipoPago === 'anticipo') {
        m.anticipoPagado = true;
        // Fecha en que se confirmó el pago del anticipo (para calcular liquidación al mudancero: 15 días hábiles)
        if (!m.fechaPagoAnticipo) m.fechaPagoAnticipo = new Date().toISOString();
        // Guardar el monto exacto del anticipo pagado (50% del precio en ese momento)
        // Esto es crítico si luego hay ajuste de precio: el saldo se calcula como precio - anticipoMonto
        if (!m.anticipoMonto) {
          const cot = m.cotizacionAceptada || {};
          m.anticipoMonto = Math.round((parseInt(cot.precio || 0)) * 0.5);
        }
        // Hook Asesores: si la mudanza vino del Plan Referidos, marcar el pedido-asesor como pagado
        if (m.pedidoAsesorId) {
          try { await hookAsesorPagado(m.pedidoAsesorId, 'anticipo'); } catch(e) { console.warn('Hook asesor anticipo:', e.message); }
        }
      }
      if (tipoPago === 'saldo') {
        m.saldoPagado = true;
        // Fecha en que se confirmó el pago del saldo (para calcular liquidación)
        if (!m.fechaPagoSaldo) m.fechaPagoSaldo = new Date().toISOString();
        // Al pagar el saldo, la mudanza queda completada
        m.estado = 'completada';
        if (!m.fechaCompletada) m.fechaCompletada = new Date().toISOString();
        // Loguear en Sheets
        try { await logPedidoSheets(m); } catch(e) { console.warn('Sheets log error:', e.message); }
        // ── Hook aliados: acreditar comisión (la mudanza está completa + 100% pagada) ──
        try { await hookAcreditarAliado(mudanzaId); } catch(e) { console.warn('Hook aliado acreditar:', e.message); }
        // Hook Asesores: si vino del Plan Referidos, marcar como completado
        if (m.pedidoAsesorId) {
          try { await hookAsesorPagado(m.pedidoAsesorId, 'saldo'); } catch(e) { console.warn('Hook asesor saldo:', e.message); }
        }
      }
      m.ultimoUpdatePago = new Date().toISOString();
      await setJSON(`mudanza:${mudanzaId}`, m, 604800);
      // ── Enviar emails ─────────────────────────────────────────────────
      try { await notificarMudanceroPago(m, tipoPago); } catch(e) { console.warn('Email mudancero pago error:', e.message); }
      if (tipoPago === 'anticipo') {
        try { await notificarClienteAnticipoPagado(m); } catch(e) { console.warn('Email cliente anticipo error:', e.message); }
      }
      return res.status(200).json({ ok: true });
    }
    if (action === 'cambiar-estado' && req.method === 'POST') {
      const { mudanzaId, estado, mudanceroEmail } = req.body;
      const estadosValidos = ['en_curso', 'completada'];
      if (!mudanzaId || !estado || !estadosValidos.includes(estado)) return res.status(400).json({ error: 'Datos inválidos' });
      const m = await getJSON(`mudanza:${mudanzaId}`);
      if (!m) return res.status(404).json({ error: 'No encontrada' });
      // Verificar que este mudancero es el aceptado
      const cot = m.cotizacionAceptada;
      if (!cot || cot.mudanceroEmail !== mudanceroEmail) return res.status(403).json({ error: 'Sin permiso' });
      // Bloquear si el anticipo no fue pagado
      if (!m.anticipoPagado) return res.status(400).json({ error: 'El cliente aún no pagó el anticipo. No podés avanzar hasta que se confirme el pago.' });
      m.estado = estado;
      if (estado === 'completada') {
        m.fechaCompletada = new Date().toISOString();
        // Loguear en Google Sheets cuando se completa
        try { await logPedidoSheets(m); } catch(e) { console.warn('Sheets log error:', e.message); }
        // Email al cliente invitándolo a pagar el saldo
        try { await notificarClienteSaldoPendiente(m); } catch(e) { console.warn('Email saldo error:', e.message); }
      }
      if (estado === 'en_curso') m.fechaInicio = new Date().toISOString();
      await setJSON(`mudanza:${mudanzaId}`, m, 604800);
      return res.status(200).json({ ok: true, estado });
    }

    // ══ AJUSTE DE PRECIO ══════════════════════════════════════════════════
    // 1. Mudancero propone un nuevo precio luego del anticipo pagado
    if (action === 'proponer-ajuste' && req.method === 'POST') {
      const { mudanzaId, mudanceroEmail, nuevoPrecio, motivo } = req.body;
      if (!mudanzaId || !mudanceroEmail || !nuevoPrecio || !motivo) {
        return res.status(400).json({ error: 'Faltan datos (mudanzaId, mudanceroEmail, nuevoPrecio, motivo)' });
      }
      const nuevo = parseInt(String(nuevoPrecio).replace(/\D/g, ''), 10);
      if (!nuevo || nuevo < 1) return res.status(400).json({ error: 'Precio inválido' });
      if (motivo.trim().length < 8) return res.status(400).json({ error: 'El motivo debe tener al menos 8 caracteres' });

      const m = await getJSON(`mudanza:${mudanzaId}`);
      if (!m) return res.status(404).json({ error: 'Mudanza no encontrada' });
      const cot = m.cotizacionAceptada;
      if (!cot || cot.mudanceroEmail !== mudanceroEmail) return res.status(403).json({ error: 'Sin permiso' });
      if (!m.anticipoPagado) return res.status(400).json({ error: 'Solo se puede ajustar después de que el cliente pagó el anticipo' });
      if (m.saldoPagado) return res.status(400).json({ error: 'La mudanza ya está pagada completamente' });
      if (m.ajustePrecio && m.ajustePrecio.estado === 'pendiente_aprobacion') {
        return res.status(400).json({ error: 'Ya hay un ajuste pendiente de aprobación del cliente' });
      }
      if (m.ajustePrecio && (m.ajustePrecio.estado === 'aceptado' || m.ajustePrecio.estado === 'rechazado')) {
        return res.status(400).json({ error: 'Ya se realizó un ajuste en esta mudanza (solo se permite una vez)' });
      }

      const precioOriginal = parseInt(cot.precio || 0);
      const delta = nuevo - precioOriginal;
      const deltaPct = precioOriginal > 0 ? Math.round((delta / precioOriginal) * 100) : 0;

      m.ajustePrecio = {
        propuesto: true,
        montoOriginal: precioOriginal,
        montoNuevo: nuevo,
        delta: delta,
        deltaPct: deltaPct,
        motivo: String(motivo).slice(0, 500),
        propuestoEn: new Date().toISOString(),
        estado: 'pendiente_aprobacion',
        aceptadoEn: null,
        rechazadoEn: null,
        recordatoriosEnviados: 0,
        ultimoRecordatorio: null
      };
      await setJSON(`mudanza:${mudanzaId}`, m, 604800);

      // Alerta admin si +30%
      if (deltaPct > 30) {
        try { await notificarAdminAjusteAlto(m); } catch(e) { console.warn('Alerta admin ajuste:', e.message); }
      }
      // Email al cliente
      try { await notificarClienteAjustePropuesto(m); } catch(e) { console.warn('Email cliente ajuste:', e.message); }

      return res.status(200).json({ ok: true, ajuste: m.ajustePrecio });
    }

    // 2. Cliente acepta el ajuste → se reemplaza el precio, el saldo se recalcula
    if (action === 'aceptar-ajuste' && req.method === 'POST') {
      const { mudanzaId, clienteEmail } = req.body;
      if (!mudanzaId || !clienteEmail) return res.status(400).json({ error: 'Faltan datos' });
      const m = await getJSON(`mudanza:${mudanzaId}`);
      if (!m) return res.status(404).json({ error: 'Mudanza no encontrada' });
      if (m.clienteEmail !== clienteEmail) return res.status(403).json({ error: 'Sin permiso' });
      if (!m.ajustePrecio || m.ajustePrecio.estado !== 'pendiente_aprobacion') {
        return res.status(400).json({ error: 'No hay un ajuste pendiente' });
      }

      // Aplicar el nuevo precio
      m.ajustePrecio.estado = 'aceptado';
      m.ajustePrecio.aceptadoEn = new Date().toISOString();
      m.cotizacionAceptada.precio = m.ajustePrecio.montoNuevo;
      await setJSON(`mudanza:${mudanzaId}`, m, 604800);

      // Email al mudancero avisando que aceptaron
      try { await notificarMudanceroAjusteAceptado(m); } catch(e) { console.warn('Email mudancero aceptado:', e.message); }
      // Email al cliente confirmando
      try { await notificarClienteAjusteAceptado(m); } catch(e) { console.warn('Email cliente aceptado:', e.message); }

      return res.status(200).json({ ok: true });
    }

    // 3. Cliente rechaza el ajuste → cancela mudanza + refund del anticipo
    if (action === 'rechazar-ajuste' && req.method === 'POST') {
      const { mudanzaId, clienteEmail } = req.body;
      if (!mudanzaId || !clienteEmail) return res.status(400).json({ error: 'Faltan datos' });
      const m = await getJSON(`mudanza:${mudanzaId}`);
      if (!m) return res.status(404).json({ error: 'Mudanza no encontrada' });
      if (m.clienteEmail !== clienteEmail) return res.status(403).json({ error: 'Sin permiso' });
      if (!m.ajustePrecio || m.ajustePrecio.estado !== 'pendiente_aprobacion') {
        return res.status(400).json({ error: 'No hay un ajuste pendiente' });
      }

      m.ajustePrecio.estado = 'rechazado';
      m.ajustePrecio.rechazadoEn = new Date().toISOString();
      m.estado = 'cancelada_por_ajuste';
      m.canceladaEn = new Date().toISOString();

      // Intentar refund del anticipo en MP
      let refundOk = false;
      let refundError = null;
      if (m.mpAnticipoPagoId) {
        try {
          const { MercadoPagoConfig, Payment } = require('mercadopago');
          const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
          // Refund total usando fetch directo al endpoint de MP (el SDK no siempre expone refunds bien)
          const r = await fetch(`https://api.mercadopago.com/v1/payments/${m.mpAnticipoPagoId}/refunds`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
              'X-Idempotency-Key': `refund-${mudanzaId}-${Date.now()}`
            }
          });
          const rData = await r.json();
          if (r.ok && (rData.status === 'approved' || rData.id)) {
            refundOk = true;
            m.refundAnticipoId = rData.id;
            m.refundAnticipoEn = new Date().toISOString();
          } else {
            refundError = rData.message || 'Error desconocido de MP';
          }
        } catch(e) {
          refundError = e.message;
          console.error('Error en refund MP:', e.message);
        }
      }

      if (refundError) m.refundError = refundError;
      await setJSON(`mudanza:${mudanzaId}`, m, 604800);

      // Emails
      try { await notificarMudanceroAjusteRechazado(m); } catch(e) { console.warn('Email mudancero rechazado:', e.message); }
      try { await notificarClienteMudanzaCancelada(m, refundOk); } catch(e) { console.warn('Email cliente cancelación:', e.message); }
      if (!refundOk) {
        try { await notificarAdminRefundManual(m, refundError); } catch(e) { console.warn('Email admin refund:', e.message); }
      }

      return res.status(200).json({ ok: true, refundOk: refundOk });
    }

    // 4. Mudancero manda recordatorio al cliente
    if (action === 'recordar-ajuste' && req.method === 'POST') {
      const { mudanzaId, mudanceroEmail } = req.body;
      if (!mudanzaId || !mudanceroEmail) return res.status(400).json({ error: 'Faltan datos' });
      const m = await getJSON(`mudanza:${mudanzaId}`);
      if (!m) return res.status(404).json({ error: 'Mudanza no encontrada' });
      const cot = m.cotizacionAceptada;
      if (!cot || cot.mudanceroEmail !== mudanceroEmail) return res.status(403).json({ error: 'Sin permiso' });
      if (!m.ajustePrecio || m.ajustePrecio.estado !== 'pendiente_aprobacion') {
        return res.status(400).json({ error: 'No hay un ajuste pendiente' });
      }
      // Anti-spam: mínimo 12hs entre recordatorios
      if (m.ajustePrecio.ultimoRecordatorio) {
        const horasDesde = (Date.now() - new Date(m.ajustePrecio.ultimoRecordatorio).getTime()) / 3600000;
        if (horasDesde < 12) {
          return res.status(429).json({ error: 'Podés enviar un recordatorio cada 12hs. Esperá ' + Math.ceil(12 - horasDesde) + 'hs más.' });
        }
      }
      m.ajustePrecio.recordatoriosEnviados = (m.ajustePrecio.recordatoriosEnviados || 0) + 1;
      m.ajustePrecio.ultimoRecordatorio = new Date().toISOString();
      await setJSON(`mudanza:${mudanzaId}`, m, 604800);

      try { await notificarClienteAjustePropuesto(m, true); } catch(e) { console.warn('Email recordatorio:', e.message); }
      return res.status(200).json({ ok: true, recordatoriosEnviados: m.ajustePrecio.recordatoriosEnviados });
    }
    // ══ FIN AJUSTE DE PRECIO ═════════════════════════════════════════════

    if (action === 'calificar' && req.method === 'POST') {
      const { mudanzaId, estrellas, comentario, clienteEmail } = req.body;
      if (!mudanzaId || !estrellas || !clienteEmail) return res.status(400).json({ error: 'Faltan datos' });
      const m = await getJSON(`mudanza:${mudanzaId}`);
      if (!m) return res.status(404).json({ error: 'No encontrada' });
      if (m.clienteEmail !== clienteEmail) return res.status(403).json({ error: 'Sin permiso' });
      if (m.estado !== 'completada' || !m.saldoPagado) return res.status(400).json({ error: 'Solo se puede calificar una mudanza completada y pagada' });
      if (m.calificado) return res.status(400).json({ error: 'Ya calificaste esta mudanza' });
      m.calificado = true;
      m.estrellas = parseInt(estrellas);
      m.comentario = comentario || '';
      m.fechaCalificacion = new Date().toISOString();
      await setJSON(`mudanza:${mudanzaId}`, m, 604800);
      // Guardar reseña en el perfil del mudancero
      try {
        const cot = m.cotizacionAceptada;
        if (cot && cot.mudanceroEmail) {
          const perfil = await getJSON(`mudancero:perfil:${cot.mudanceroEmail}`);
          if (perfil) {
            if (!perfil.resenas) perfil.resenas = [];
            perfil.resenas.push({ estrellas: m.estrellas, comentario: m.comentario, fecha: m.fechaCalificacion, mudanzaId });
            perfil.promedioEstrellas = Math.round((perfil.resenas.reduce((a, r) => a + r.estrellas, 0) / perfil.resenas.length) * 10) / 10;
            // Actualizar también calificacion y nroResenas para el catálogo
            perfil.calificacion = perfil.promedioEstrellas;
            perfil.nroResenas = perfil.resenas.length;
            perfil.trabajosCompletados = (perfil.trabajosCompletados || 0) + 1;
            await setJSON(`mudancero:perfil:${cot.mudanceroEmail}`, perfil);
          }
        }
      } catch(e) { console.warn('Error guardando reseña en perfil:', e.message); }
      return res.status(200).json({ ok: true });
    }

    if (action === 'eliminar' && req.method === 'POST') {
      const { mudanzaId, clienteEmail } = req.body;
      if (!mudanzaId || !clienteEmail) return res.status(400).json({ error: 'Faltan datos' });
      const m = await getJSON(`mudanza:${mudanzaId}`);
      if (!m) return res.status(404).json({ error: 'No encontrada' });
      if (m.clienteEmail !== clienteEmail) return res.status(403).json({ error: 'Sin permiso' });
      // Bloquear si ya pagó algo (para no perder rastro de pagos)
      if (m.anticipoPagado || m.saldoPagado) {
        return res.status(400).json({ error: 'No se puede eliminar una mudanza con pagos realizados. Contactanos para gestionar.' });
      }
      // Marcar como eliminada (cualquier estado anterior)
      m.estado = 'eliminada';
      m.fechaEliminacion = new Date().toISOString();
      await setJSON(`mudanza:${mudanzaId}`, m, 604800);
      // Sacar de la lista activa global
      const activas = await getJSON('mudanzas:activas') || [];
      await setJSON('mudanzas:activas', activas.filter(id => id !== mudanzaId), 604800);
      // Sacar del índice del cliente para que no la traiga `mis-mudanzas`
      const idxCliente = await getJSON(`cliente:${clienteEmail}`) || [];
      await setJSON(`cliente:${clienteEmail}`, idxCliente.filter(id => id !== mudanzaId), 2592000);
      // ── Hook aliados: cancelar atribución si existía ──
      try { await hookCancelarAtribucion(mudanzaId); } catch(e) { console.warn('Hook aliado cancelar:', e.message); }

      // ── Hook asesores: si la mudanza vino del Plan Referidos, marcar el pedido-asesor como cancelado ──
      // El handler interno notifica al asesor por push + email.
      if (m.pedidoAsesorId) {
        try { await hookAsesorCancelado(m.pedidoAsesorId); } catch(e) { console.warn('Hook asesor cancelar:', e.message); }
      }

      // ── NOTIFICAR A LOS MUDANCEROS QUE COTIZARON ──────────────────────
      // Push + email para que sepan que el cliente canceló y no esperen respuesta.
      // OJO: NO sacamos la mudanza del índice del mudancero (mudancero:{email}) — la sigue
      // viendo en su tab "Expirados" con el badge "Cancelada por el cliente".
      try {
        const cotizadores = (m.cotizaciones || [])
          .map(c => c.mudanceroEmail)
          .filter(Boolean);
        // También avisar a los invitados que aún no cotizaron (modo dirigido)
        const invitados = (m.mudancerosInvitados || []).filter(Boolean);
        const todosEmails = Array.from(new Set([...cotizadores, ...invitados]));
        if (todosEmails.length > 0) {
          const rutaTxt = `${(m.desde||'').split(',')[0]} → ${(m.hasta||'').split(',')[0]}`;
          // Push en paralelo (no bloquea el response al cliente)
          Promise.all(todosEmails.map(emailMud =>
            enviarPush(emailMud, {
              titulo: '❌ Mudanza cancelada',
              cuerpo: `El cliente canceló: ${rutaTxt}`,
              link: '/mi-cuenta'
            }).catch(e => console.warn('Push cancelación error:', emailMud, e && e.message))
          )).catch(()=>{});
          // Email simple a cada uno
          if (process.env.RESEND_API_KEY) {
            const resend = new Resend(process.env.RESEND_API_KEY);
            for (const emailMud of todosEmails) {
              try {
                const perfil = await getJSON(`mudancero:perfil:${emailMud}`);
                const nombre = (perfil && perfil.nombre) ? perfil.nombre.split(' ')[0] : 'Mudancero';
                resend.emails.send({
                  from: 'MudateYa <noreply@mudateya.ar>',
                  to: emailMud,
                  subject: `❌ Mudanza cancelada — ${rutaTxt}`,
                  html: `
                    <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;background:#F5F7FA;padding:20px">
                      <div style="background:#003580;padding:18px 24px;border-radius:8px 8px 0 0">
                        <span style="font-family:Georgia,serif;font-size:18px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:18px;font-weight:900;color:#22C36A">Ya</span>
                      </div>
                      <div style="background:#fff;padding:24px;border-radius:0 0 8px 8px">
                        <h2 style="color:#0F1923;font-size:18px;margin:0 0 12px">Hola ${nombre},</h2>
                        <p style="color:#374151;font-size:14px;line-height:1.6">El cliente <b>canceló</b> la siguiente mudanza:</p>
                        <div style="background:#FEE2E2;border-left:4px solid #DC2626;padding:12px 14px;border-radius:6px;margin:16px 0;font-size:14px;color:#7F1D1D">
                          <b>${rutaTxt}</b>
                        </div>
                        <p style="color:#374151;font-size:13px;line-height:1.6">Esta mudanza pasó automáticamente a tu sección <b>Expirados</b> en MudateYa. No hace falta que hagas nada.</p>
                        <p style="color:#64748B;font-size:12px;margin-top:18px">Si tenés dudas, respondé este mail.</p>
                      </div>
                    </div>
                  `
                }).catch(e => console.warn('Email cancelación error:', emailMud, e.message));
              } catch(e) { console.warn('Email cancelación loop:', emailMud, e.message); }
            }
          }
        }
      } catch(e) { console.warn('Notificación cancelación error:', e.message); }

      return res.status(200).json({ ok: true });
    }
    // Modo dirigido: cliente invita a mudanceros específicos
    if (action === 'invitar-mudanceros' && req.method === 'POST') {
      const { mudanzaId, clienteEmail: cEmail, mudancerosEmails } = req.body;
      if (!mudanzaId || !cEmail || !mudancerosEmails?.length) return res.status(400).json({ error: 'Faltan datos' });
      const m = await getJSON(`mudanza:${mudanzaId}`);
      if (!m) return res.status(404).json({ error: 'Mudanza no encontrada' });
      if (m.clienteEmail !== cEmail) return res.status(403).json({ error: 'Sin permiso' });
      // Agregar los nuevos invitados (sin duplicar)
      const actuales = m.mudancerosInvitados || [];
      const nuevos = mudancerosEmails.filter(e => !actuales.includes(e));
      m.mudancerosInvitados = [...actuales, ...nuevos];
      m.modoCotizacion = 'dirigido';
      await setJSON(`mudanza:${mudanzaId}`, m, 604800);
      // Notificar a cada mudancero invitado
      for (const emailMud of nuevos) {
        try {
          const perfil = await getJSON(`mudancero:perfil:${emailMud}`);
          if (perfil) await notificarMudanceroInvitado(m, perfil);
        } catch(e) { console.warn('Error notificando mudancero:', e.message); }
      }
      return res.status(200).json({ ok: true, invitados: m.mudancerosInvitados });
    }

    // ── Admin: listar usuarios/clientes ──────────────────────────────
    if (action === 'admin-usuarios' && req.method === 'GET') {
      const { token } = req.query;
      if (token !== process.env.ADMIN_TOKEN && token !== 'mya-admin-2026') {
        return res.status(401).json({ error: 'Token inválido' });
      }

      // Obtener emails del índice centralizado
      let emails = await getJSON('clientes:todos') || [];

      // Fallback: reconstruir desde KEYS mudanza:* (cubre pedidos históricos)
      if (!emails.length) {
        const emailSet = new Set();

        // Primero intentar con mudanzas:todos
        let ids = await getJSON('mudanzas:todos') || [];

        // Si tampoco hay, usar KEYS como último recurso
        if (!ids.length) {
          try {
            const keysRaw = await redisCall('KEYS', 'mudanza:*');
            if (Array.isArray(keysRaw)) {
              ids = keysRaw.map(k => k.replace('mudanza:', ''));
            }
          } catch(e) { /* ignorar */ }
        }

        for (const id of ids) {
          try {
            const p = await getJSON(`mudanza:${id}`);
            if (p && p.clienteEmail) emailSet.add(p.clienteEmail);
          } catch(e) {}
        }
        emails = Array.from(emailSet);
        if (emails.length) await setJSON('clientes:todos', emails);
      }

      const clientes = [];
      for (const email of emails) {
        let perfil = await getJSON(`cliente:perfil:${email}`);
        if (!perfil) {
          // Reconstruir perfil desde sus pedidos
          const pedidosIds = await getJSON(`cliente:${email}`) || [];
          let nombre = '', wa = '', ultimaActividad = null;
          let totalMudanzas = pedidosIds.length;
          for (const pid of pedidosIds) {
            try {
              const p = await getJSON(`mudanza:${pid}`);
              if (!p) continue;
              if (!nombre && p.clienteNombre) nombre = p.clienteNombre;
              if (!wa && p.clienteWA) wa = p.clienteWA;
              if (!ultimaActividad || p.fechaPublicacion > ultimaActividad) ultimaActividad = p.fechaPublicacion;
            } catch(e) {}
          }
          perfil = { email, nombre, wa, mudanzas: totalMudanzas, ultimaActividad, fechaRegistro: ultimaActividad, estado: 'activo' };
          // Guardar para la próxima vez
          await setJSON(`cliente:perfil:${email}`, perfil);
        }
        clientes.push(perfil);
      }

      clientes.sort(function(a, b) {
        return new Date(b.ultimaActividad || 0) - new Date(a.ultimaActividad || 0);
      });
      return res.status(200).json({ ok: true, clientes, total: clientes.length });
    }

    // ── Admin: listar pagos ───────────────────────────────────────────
    if (action === 'admin-pagos' && req.method === 'GET') {
      const { token } = req.query;
      if (token !== process.env.ADMIN_TOKEN && token !== 'mya-admin-2026') {
        return res.status(401).json({ error: 'Token inválido' });
      }
      const activas = await getJSON('mudanzas:activas') || [];
      const rows = [];
      for (const id of activas) {
        try {
          const m = await getJSON(`mudanza:${id}`);
          if (m && (m.anticipoPagado || m.saldoPagado)) {
            rows.push({
              id: m.id,
              desde: m.desde,
              hasta: m.hasta,
              clienteEmail: m.clienteEmail,
              clienteNombre: m.clienteNombre,
              anticipoPagado: m.anticipoPagado || false,
              saldoPagado: m.saldoPagado || false,
              precio: m.cotizacionAceptada ? (m.cotizacionAceptada.precio || 0) : (m.precio_estimado || 0),
              tipo: m.tipo || 'mudanza',
              mudancero: m.cotizacionAceptada ? (m.cotizacionAceptada.mudanceroNombre || '—') : '—',
              mudanceroEmail: m.cotizacionAceptada ? (m.cotizacionAceptada.mudanceroEmail || '') : '',
              fecha: m.fechaPublicacion || '',
              precio_estimado: m.precio_estimado || 0,
              estado: m.estado,
              fechaPublicacion: m.fechaPublicacion,
            });
          }
        } catch(e) {}
      }
      return res.status(200).json({ rows });
    }


    // ── Admin: listar mudanceros ──────────────────────────────────────
    if (action === 'admin-mudanceros' && req.method === 'GET') {
      const { token } = req.query;
      if (token !== process.env.ADMIN_TOKEN && token !== 'mya-admin-2026') {
        return res.status(401).json({ error: 'Token inválido' });
      }
      const todos = await getJSON('mudanceros:todos') || [];
      const mudanceros = [];
      for (const email of todos) {
        try {
          const p = await getJSON(`mudancero:perfil:${email}`);
          if (p) mudanceros.push(p);
        } catch(e) {}
      }
      return res.status(200).json({ mudanceros });
    }

    // ── Admin: aprobar / rechazar mudancero ──────────────────────────
    if (action === 'admin-editar-mudancero' && req.method === 'POST') {
      const { token, email, cambios } = req.body;
      if (token !== process.env.ADMIN_TOKEN && token !== 'mya-admin-2026') {
        return res.status(401).json({ error: 'Token inválido' });
      }
      if (!email || !cambios) return res.status(400).json({ error: 'Faltan datos' });
      const perfil = await getJSON(`mudancero:perfil:${email}`);
      if (!perfil) return res.status(404).json({ error: 'Mudancero no encontrado' });
      const camposPermitidos = ['nombre','telefono','email','zonaBase','zonasExtra','vehiculo','servicios'];
      camposPermitidos.forEach(function(k) {
        if (cambios[k] !== undefined && cambios[k] !== '') perfil[k] = cambios[k];
      });
      // Precios Pack (Plan Referidos) — objeto {esencial, integral, llave}
      if (cambios.preciosPack && typeof cambios.preciosPack === 'object') {
        var pp = cambios.preciosPack;
        perfil.preciosPack = {
          esencial: Number(pp.esencial) || 0,
          integral: Number(pp.integral) || 0,
          llave:    Number(pp.llave)    || 0
        };
      }
      // Precios Leads Plan Referidos — matriz 5×3 (5 tamaños × 3 packs) + % de cascada
      if (cambios.preciosLeads && typeof cambios.preciosLeads === 'object') {
        var pl = cambios.preciosLeads;
        perfil.preciosLeads = {
          amb1:    { esencial: Number(pl.amb1?.esencial)||0,    integral: Number(pl.amb1?.integral)||0,    llave: Number(pl.amb1?.llave)||0    },
          amb2:    { esencial: Number(pl.amb2?.esencial)||0,    integral: Number(pl.amb2?.integral)||0,    llave: Number(pl.amb2?.llave)||0    },
          amb3:    { esencial: Number(pl.amb3?.esencial)||0,    integral: Number(pl.amb3?.integral)||0,    llave: Number(pl.amb3?.llave)||0    },
          amb4:    { esencial: Number(pl.amb4?.esencial)||0,    integral: Number(pl.amb4?.integral)||0,    llave: Number(pl.amb4?.llave)||0    },
          amb5plus:{ esencial: Number(pl.amb5plus?.esencial)||0,integral: Number(pl.amb5plus?.integral)||0,llave: Number(pl.amb5plus?.llave)||0 },
          pctIntegral: Number(pl.pctIntegral)||0,
          pctLlave:    Number(pl.pctLlave)||0
        };
      }
      perfil.ultimaEdicionAdmin = new Date().toISOString();
      await setJSON(`mudancero:perfil:${email}`, perfil);
      return res.status(200).json({ ok: true });
    }

    if (action === 'admin-aprobar-mudancero' && req.method === 'POST') {
      const { token, email, nuevoEstado, verificadoIdentidad, verificadoVehiculo } = req.body;
      if (token !== process.env.ADMIN_TOKEN && token !== 'mya-admin-2026') {
        return res.status(401).json({ error: 'Token inválido' });
      }
      if (!email || !nuevoEstado) return res.status(400).json({ error: 'Faltan datos' });

      const perfil = await getJSON(`mudancero:perfil:${email}`);
      if (!perfil) return res.status(404).json({ error: 'Mudancero no encontrado' });

      const estadoAnterior = perfil.estado;
      perfil.estado = nuevoEstado;
      perfil.fechaCambioEstado = new Date().toISOString();
      if (nuevoEstado === 'aprobado') {
        perfil.terminosAceptados = perfil.terminosAceptados || false;
        // Setear verificaciones si se pasan explícitamente
        if (verificadoIdentidad !== undefined) perfil.verificadoIdentidad = verificadoIdentidad;
        if (verificadoVehiculo  !== undefined) perfil.verificadoVehiculo  = verificadoVehiculo;
      }
      await setJSON(`mudancero:perfil:${email}`, perfil);

      // Si se acaba de aprobar → mandar email de alta con link de términos
      if (nuevoEstado === 'aprobado' && estadoAnterior !== 'aprobado') {
        try { await enviarEmailAltaMudancero(perfil); } catch(e) { console.error('Email alta error:', e.message); }
        // Push: avisar que ya está aprobado y puede empezar a recibir pedidos
        enviarPush(email, {
          titulo: '✅ Tu perfil fue aprobado',
          cuerpo: 'Ya estás recibiendo pedidos en MudateYa.',
          link: '/mi-cuenta'
        }).catch(function(e){ console.error('Push aprobación error:', email, e && e.message); });
      }

      return res.status(200).json({ ok: true, estado: perfil.estado });
    }

    // ── Verificar todos los aprobados (one-shot) ─────────────────────
    if (action === 'admin-verificar-todos' && req.method === 'POST') {
      const { token } = req.body;
      if (token !== process.env.ADMIN_TOKEN && token !== 'mya-admin-2026') {
        return res.status(401).json({ error: 'Token inválido' });
      }
      const todos = await getJSON('mudanceros:todos') || [];
      var actualizados = [];
      for (const email of todos) {
        const perfil = await getJSON(`mudancero:perfil:${email}`);
        if (!perfil || perfil.estado !== 'aprobado') continue;
        perfil.verificadoIdentidad = true;
        perfil.verificadoVehiculo  = true;
        await setJSON(`mudancero:perfil:${email}`, perfil);
        actualizados.push(email);
      }
      return res.status(200).json({ ok: true, actualizados });
    }

    // ── Admin: listar todas las cotizaciones/pedidos (GET) ───────────
    if (action === 'admin-listar' && req.method === 'GET') {
      const { token } = req.query;
      if (token !== process.env.ADMIN_TOKEN && token !== 'mya-admin-2026') {
        return res.status(401).json({ error: 'Token inválido' });
      }

      // Usar índice permanente. Si no existe aún, hacer KEYS como fallback
      let ids = await getJSON('mudanzas:todos') || [];
      if (!ids.length) {
        // Fallback: buscar todos los keys mudanza:* via KEYS
        try {
          const keysRaw = await redisCall('KEYS', 'mudanza:*');
          if (Array.isArray(keysRaw)) {
            ids = keysRaw.map(k => k.replace('mudanza:', ''));
          }
        } catch(e) { /* ignorar si KEYS falla */ }
      }

      const pedidos = [];
      for (const id of ids) {
        const p = await getJSON(`mudanza:${id}`);
        if (!p) continue;

        // Leer mudancero — de mudanceroAceptado o fallback a cotizacionAceptada
        const mudEmail = p.mudanceroAceptado || (p.cotizacionAceptada && p.cotizacionAceptada.mudanceroEmail) || null;
        const montoVal = p.montoTotal || p.monto || (p.cotizacionAceptada && p.cotizacionAceptada.precio) || null;

        let mudanceroNombre = null;
        if (mudEmail) {
          try {
            const mPerf = await getJSON(`mudancero:perfil:${mudEmail}`);
            if (mPerf) mudanceroNombre = mPerf.nombre || mPerf.empresa || mudEmail;
            else mudanceroNombre = (p.cotizacionAceptada && p.cotizacionAceptada.mudanceroNombre) || mudEmail;
          } catch(e) {
            mudanceroNombre = (p.cotizacionAceptada && p.cotizacionAceptada.mudanceroNombre) || mudEmail;
          }
        }

        pedidos.push({
          id:              p.id || id,
          tipo:            p.tipo || 'mudanza',
          fecha:           p.fechaPublicacion || p.creadoEn || null,
          email:           p.clienteEmail || null,
          nombre:          p.clienteNombre || null,
          desde:           p.desde || null,
          hasta:           p.hasta || null,
          fechaMudanza:    p.fecha || null,
          estado:          p.estado || 'buscando',
          monto:           montoVal,
          mudanceroEmail:  mudEmail,
          mudanceroNombre: mudanceroNombre,
          cotizaciones:    (p.cotizaciones || []).length,
          ambientes:       p.ambientes || null,
        });
      }

      // Ordenar por fecha descendente
      pedidos.sort(function(a, b) {
        return new Date(b.fecha || 0) - new Date(a.fecha || 0);
      });

      return res.status(200).json({ ok: true, pedidos, total: pedidos.length });
    }

    // ── Admin: detalle de un pedido con cotizaciones (GET) ───────────
    if (action === 'admin-pedido' && req.method === 'GET') {
      const { token, id } = req.query;
      if (token !== process.env.ADMIN_TOKEN && token !== 'mya-admin-2026') {
        return res.status(401).json({ error: 'Token inválido' });
      }
      if (!id) return res.status(400).json({ error: 'Falta id' });
      const p = await getJSON(`mudanza:${id}`);
      if (!p) return res.status(404).json({ error: 'Pedido no encontrado' });
      return res.status(200).json({ ok: true, pedido: p });
    }
    if (action === 'verificar-terminos-token' && req.method === 'GET') {
      const { token } = req.query;
      if (!token) return res.status(400).json({ error: 'Falta token' });
      const datos = await getJSON(`terminos:token:${token}`);
      if (!datos) return res.status(400).json({ error: 'Token inválido o expirado' });
      const perfil = await getJSON(`mudancero:perfil:${datos.email}`);
      if (!perfil) return res.status(404).json({ error: 'Perfil no encontrado' });
      return res.status(200).json({
        ok: true,
        nombre: perfil.nombre || '',
        yaAcepto: perfil.terminosAceptados === true
      });
    }


    // ── Aceptar términos y condiciones ───────────────────────────────
    if (action === 'aceptar-terminos' && req.method === 'POST') {
      const { token } = req.body;
      if (!token) return res.status(400).json({ error: 'Falta token' });
      const datos = await getJSON(`terminos:token:${token}`);
      if (!datos) return res.status(400).json({ error: 'Token inválido o expirado' });
      const perfil = await getJSON(`mudancero:perfil:${datos.email}`);
      if (!perfil) return res.status(404).json({ error: 'Perfil no encontrado' });
      perfil.terminosAceptados   = true;
      perfil.fechaAceptoTerminos = new Date().toISOString();
      perfil.versionTerminos     = '1.0';
      await setJSON(`mudancero:perfil:${datos.email}`, perfil);
      await redisCall('DEL', `terminos:token:${token}`);
      return res.status(200).json({ ok: true, nombre: perfil.nombre });
    }


    // Catálogo público de mudanceros verificados (para modo dirigido)
    if (action === 'catalogo' && req.method === 'GET') {
      // Helper: normaliza zonaBase al formato de los filtros del frontend
      function normalizarZona(zonaBase) {
        if (!zonaBase) return zonaBase;
        var z = zonaBase.toLowerCase();
        if (z.startsWith('caba')) return 'CABA';
        if (z.startsWith('gba norte')) return 'GBA Norte';
        if (z.startsWith('gba sur') || z.startsWith('gba este')) return 'GBA Sur';
        if (z.startsWith('gba oeste')) return 'GBA Oeste';
        if (z.includes('rosario')) return 'Rosario';
        if (z.includes('córdoba') || z.includes('cordoba')) return 'Córdoba';
        return zonaBase;
      }
      const { zona, desde, hasta } = req.query;

      function normStr(s) {
        return (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
      }
      var _sw = ['de','del','la','las','los','el','en','y','av','ave','avenida','calle','provincia','ciudad','argentina','ar'];
      function palabrasZona(str) {
        return normStr(str).split(/[\s,]+/).filter(function(p){ return p.length > 2 && !_sw.includes(p); });
      }
      var textoBusqueda = zona || ((desde||'') + ' ' + (hasta||''));
      var palabrasBuscadas = palabrasZona(textoBusqueda);

      // Detectar si la búsqueda es dentro de AMBA
      var kwAmba = ['caba','palermo','belgrano','caballito','flores','almagro','boedo','balvanera',
        'recoleta','retiro','telmo','barracas','mataderos','liniers','devoto','urquiza',
        'coghlan','saavedra','nunez','colegiales','chacarita','paternal','crespo','once',
        'congreso','microcentro','madero','nuñez',
        'isidro','vicente lopez','olivos','martinez','boulogne','beccar','tigre','fernando',
        'quilmes','avellaneda','lanus','zamora','banfield','moron','ituzaingo','castelar',
        'haedo','ramos mejia','san justo','merlo','matanza','varela','berazategui',
        'tres de febrero','maipu','conurbano','amba','gba'];
      var esBusquedaAmba = kwAmba.some(function(kw){ return normStr(textoBusqueda).includes(normStr(kw)); });

      var kwZonaAmba = ['caba','gba norte','gba sur','gba oeste','gba este'];
      function esZonaAmba(perfil) {
        var zb = normStr(perfil.zonaBase||'');
        var ze = normStr(perfil.zonasExtra||'');
        return kwZonaAmba.some(function(kw){ return zb.includes(kw) || ze.includes(kw); });
      }

      function cubreZona(perfil) {
        if (!palabrasBuscadas.length) return true;
        // Si la búsqueda es AMBA, mostrar todos los de CABA o GBA
        if (esBusquedaAmba) return esZonaAmba(perfil);
        var cobertura = normStr((perfil.zonaBase||'') + ' ' + (perfil.zonasExtra||''));
        var palabrasCobertura = palabrasZona(cobertura);
        if (palabrasBuscadas.some(function(p){ return cobertura.includes(p); })) return true;
        if (palabrasCobertura.some(function(pc){ return palabrasBuscadas.some(function(pb){ return pb.includes(pc) || pc.includes(pb); }); })) return true;
        return false;
      }

      const todos = await getJSON('mudanceros:todos') || [];
      const catalogo = [];
      for (const email of todos) {
        try {
          const p = await getJSON(`mudancero:perfil:${email}`);
          if (!p || p.estado !== 'aprobado') continue;
          if (palabrasBuscadas.length > 0 && !cubreZona(p)) continue;

          // ── Filtro: no mostrar mudanceros sin precios cargados ──────────
          // Criterio: tiene que tener al menos UN precio > 0 en cualquier
          // pack/ambiente o en flete. Si todo está en 0/vacío, no aparece.
          function _toNum(v) {
            if (v === null || v === undefined || v === '') return 0;
            return parseInt(String(v).replace(/\./g, '').replace(/[^0-9]/g, ''), 10) || 0;
          }
          function _packTienePrecio(pk) {
            if (!pk || typeof pk !== 'object') return false;
            return _toNum(pk.amb1) > 0 || _toNum(pk.amb2) > 0 || _toNum(pk.amb3) > 0 || _toNum(pk.amb4) > 0;
          }
          var tienePrecioAlguno =
                _packTienePrecio(p.preciosEsencial)
             || _packTienePrecio(p.preciosIntegral)
             || _packTienePrecio(p.preciosLlave)
             || _toNum(p.precioFleteNuevo) > 0
             // Compat con modelo viejo (precios.amb1..amb4 / precios.flete)
             || _toNum(p.precios && p.precios.amb1) > 0
             || _toNum(p.precios && p.precios.amb2) > 0
             || _toNum(p.precios && p.precios.amb3) > 0
             || _toNum(p.precios && p.precios.amb4) > 0
             || _toNum(p.precios && p.precios.flete) > 0;
          if (!tienePrecioAlguno) continue;

          // Devolver solo datos públicos — sin datos bancarios ni fotos de DNI
          catalogo.push({
            email:               p.email,
            nombre:              p.nombre,
            empresa:             p.empresa             || '',
            zonaBase:            normalizarZona(p.zonaBase),
            zonaBaseRaw:         p.zonaBase             || '',
            zonasExtra:          p.zonasExtra           || '',
            vehiculo:            p.vehiculo,
            servicios:           p.servicios            || '',
            calificacion:        p.calificacion         || 0,
            nroResenas:          p.nroResenas           || 0,
            trabajosCompletados: p.trabajosCompletados  || 0,
            verificadoIdentidad: p.verificadoIdentidad  || false,
            verificadoVehiculo:  p.verificadoVehiculo   || false,
            verificadoSeguro:    p.verificadoSeguro      || false,
            foto:                p.foto                 || '',
            fotoCamion:          p.fotoCamion           || '',
            fotosVehiculo:       p.fotosVehiculo        || (p.fotoCamion ? [p.fotoCamion] : []),
            precios:             p.precios              || {},
            horarios:            p.horarios             || '',
            dias:                p.dias                 || '',
            anticipacion:        p.anticipacion         || '',
            extra:               p.extra                || '',
            sitioWeb:            p.sitioWeb             || '',
            añosExp:             p.añosExp              || '',
            // ── Modelo nuevo: niveles de servicio explícitos + precios por nivel ──
            serviciosActivos:    Array.isArray(p.serviciosActivos) ? p.serviciosActivos : null,
            seguroMudanza:       p.seguroMudanza === true,
            preciosEsencial:     p.preciosEsencial      || null,
            preciosIntegral:     p.preciosIntegral      || null,
            preciosLlave:        p.preciosLlave         || null,
            precioFleteNuevo:    p.precioFleteNuevo     || '',
            // Compat: sinEstres del modelo viejo (algunos perfiles aún lo tienen)
            sinEstres:           p.sinEstres === true,
          });
        } catch(e) {}
      }
      // Ordenar por calificación desc
      catalogo.sort((a,b) => (b.calificacion - a.calificacion) || (b.trabajosCompletados - a.trabajosCompletados));
      return res.status(200).json({ mudanceros: catalogo, sinCobertura: catalogo.length === 0 && palabrasBuscadas.length > 0 });
    }

    if (action === 'rechazar' && req.method === 'POST') {
      const { mudanzaId, mudanceroEmail } = req.body;
      if (!mudanzaId || !mudanceroEmail) return res.status(400).json({ error: 'Faltan datos' });
      // Guardar en lista de rechazados del mudancero para no mostrarlo más
      const rechazados = await getJSON(`rechazados:${mudanceroEmail}`) || [];
      if (!rechazados.includes(mudanzaId)) rechazados.push(mudanzaId);
      await setJSON(`rechazados:${mudanceroEmail}`, rechazados, 604800);
      // Si es modo dirigido, marcar la mudanza con quién pasó (para avisar al cliente)
      try {
        const m = await getJSON(`mudanza:${mudanzaId}`);
        if (m && m.modoCotizacion === 'dirigido') {
          m.rechazadosPor = m.rechazadosPor || [];
          if (!m.rechazadosPor.find(r => r.email === mudanceroEmail)) {
            const perfil = await getJSON(`mudancero:perfil:${mudanceroEmail}`);
            m.rechazadosPor.push({
              email: mudanceroEmail,
              nombre: (perfil && (perfil.empresa || perfil.nombre)) || mudanceroEmail.split('@')[0],
              fecha: new Date().toISOString()
            });
            await setJSON(`mudanza:${mudanzaId}`, m, 604800);
          }
        }
      } catch(e) { console.warn('No pude marcar rechazo en mudanza:', e.message); }
      return res.status(200).json({ ok: true });
    }
    if (action === 'republicar-abierto' && req.method === 'POST') {
      const { mudanzaId, clienteEmail } = req.body;
      if (!mudanzaId || !clienteEmail) return res.status(400).json({ error: 'Faltan datos' });
      const m = await getJSON(`mudanza:${mudanzaId}`);
      if (!m) return res.status(404).json({ error: 'Mudanza no encontrada' });
      if (m.clienteEmail !== clienteEmail) return res.status(403).json({ error: 'No autorizado' });
      if (m.estado !== 'buscando') return res.status(400).json({ error: 'La mudanza ya no está en estado de búsqueda' });
      // Convertir a modo abierto y limpiar invitados
      m.modoCotizacion = 'abierto';
      m.mudancerosInvitados = [];
      // Refrescar fecha de expiración 24hs más (le damos otra ventana)
      m.expira = new Date(Date.now() + 24*60*60*1000).toISOString();
      m.republicadaEn = new Date().toISOString();
      await setJSON(`mudanza:${mudanzaId}`, m, 604800);
      return res.status(200).json({ ok: true });
    }

    if (action === 'update-wa' && req.method === 'POST') {
      const { email, clienteWA } = req.body;
      if (!email || !clienteWA) return res.status(400).json({ error: 'Faltan datos' });
      try {
        const ids = await getJSON(`cliente:${email}`) || [];
        for (const id of ids) {
          const m = await getJSON(`mudanza:${id}`);
          if (m) {
            m.clienteWA = clienteWA;
            if (m.cotizacionAceptada) m.cotizacionAceptada.clienteWA = clienteWA;
            await setJSON(`mudanza:${id}`, m, 604800);
          }
        }
        return res.status(200).json({ ok: true, updated: ids.length });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    if (action === 'por-zona' && req.method === 'GET') {
      const { email } = req.query;
      const ids = await getJSON('mudanzas:activas') || [];
      const rechazados = email ? (await getJSON(`rechazados:${email}`) || []) : [];
      const disponibles = [];
      const ahora = new Date();
      for (const id of ids) {
        const m = await getJSON(`mudanza:${id}`);
        if (!m || !['buscando','cotizaciones_completas'].includes(m.estado) || new Date(m.expira) < ahora) continue;
        if (m.estado === 'cotizaciones_completas') continue; // ya tiene 5, no mostrar más
        if (m.modoCotizacion === 'dirigido' && email && !(m.mudancerosInvitados||[]).includes(email)) continue; // modo dirigido: solo invitados
        if (email && m.cotizaciones.find(c => c.mudanceroEmail === email)) continue;
        if (rechazados.includes(id)) continue; // ocultar rechazados
        disponibles.push(m);
      }
      return res.status(200).json({ mudanzas: disponibles });
    }

    if (action === 'mis-cotizaciones' && req.method === 'GET') {
      const { email } = req.query;
      // ── Verificar sesión si viene token (soft mode hasta integrar frontend) ──
      const tokenMud = req.headers['x-session-token'] || req.query.sessionToken;
      if (email && tokenMud) {
        const autMud = await verificarSesionMudancero(email);
        if (!autMud) return res.status(401).json({ error: 'Sesión inválida' });
      }
      // Sin token: continúa (modo legado)
      if (!email) return res.status(400).json({ error: 'Falta email' });
      const ids = await getJSON(`mudancero:${email}`) || [];
      const mudanzas = [];
      for (const id of ids) {
        const m = await getJSON(`mudanza:${id}`);
        if (m) mudanzas.push({ ...m, miCotizacion: m.cotizaciones.find(c => c.mudanceroEmail === email) });
      }
      return res.status(200).json({ mudanzas });
    }

    if (action === 'encuesta' && req.method === 'POST') {
      const { respuesta } = req.body;
      if (respuesta !== 'si' && respuesta !== 'no') return res.status(400).json({ error: 'Respuesta inválida' });
      const total = await redisCall('INCR', 'encuesta:packs:' + respuesta);
      return res.status(200).json({ ok: true, total: parseInt(total) });
    }

    if (action === 'encuesta-stats' && req.method === 'GET') {
      const token = req.query.token;
      if (token !== process.env.ADMIN_TOKEN && token !== 'mya-admin-2026') return res.status(403).json({ error: 'No autorizado' });
      const si = await redisCall('GET', 'encuesta:packs:si');
      const no = await redisCall('GET', 'encuesta:packs:no');
      return res.status(200).json({ si: parseInt(si) || 0, no: parseInt(no) || 0 });
    }

    if (action === 'admin-patch-perfil' && req.method === 'POST') {
      const { token, email, trabajosCompletados, calificacion, nroResenas } = req.body;
      if (token !== process.env.ADMIN_TOKEN && token !== 'mya-admin-2026') return res.status(401).json({ error: 'No autorizado' });
      if (!email) return res.status(400).json({ error: 'Falta email' });
      const perfil = await getJSON(`mudancero:perfil:${email}`);
      if (!perfil) return res.status(404).json({ error: 'Perfil no encontrado' });
      if (trabajosCompletados !== undefined) perfil.trabajosCompletados = parseInt(trabajosCompletados);
      if (calificacion !== undefined) perfil.calificacion = parseFloat(calificacion);
      if (nroResenas !== undefined) perfil.nroResenas = parseInt(nroResenas);
      await setJSON(`mudancero:perfil:${email}`, perfil);
      return res.status(200).json({ ok: true, trabajosCompletados: perfil.trabajosCompletados, calificacion: perfil.calificacion, nroResenas: perfil.nroResenas });
    }

    if (action === 'admin-fix-resena' && req.method === 'POST') {
      const { token, mudanzaId } = req.body;
      if (token !== process.env.ADMIN_TOKEN && token !== 'mya-admin-2026') return res.status(401).json({ error: 'No autorizado' });
      if (!mudanzaId) return res.status(400).json({ error: 'Falta mudanzaId' });
      const m = await getJSON(`mudanza:${mudanzaId}`);
      if (!m) return res.status(404).json({ error: 'Mudanza no encontrada' });
      if (!m.calificado || !m.estrellas) return res.status(400).json({ error: 'Mudanza no tiene calificación' });
      const cot = m.cotizacionAceptada;
      if (!cot || !cot.mudanceroEmail) return res.status(400).json({ error: 'No hay cotización aceptada' });
      const perfil = await getJSON(`mudancero:perfil:${cot.mudanceroEmail}`);
      if (!perfil) return res.status(404).json({ error: 'Perfil mudancero no encontrado' });
      if (!perfil.resenas) perfil.resenas = [];
      // Evitar duplicados
      const yaExiste = perfil.resenas.find(function(r){ return r.mudanzaId === mudanzaId; });
      if (yaExiste) return res.status(200).json({ ok: true, msg: 'La reseña ya estaba guardada', resenas: perfil.resenas.length });
      perfil.resenas.push({ estrellas: m.estrellas, comentario: m.comentario || '', fecha: m.fechaCalificacion, mudanzaId });
      perfil.promedioEstrellas = Math.round((perfil.resenas.reduce((a, r) => a + r.estrellas, 0) / perfil.resenas.length) * 10) / 10;
      perfil.calificacion = perfil.promedioEstrellas;
      perfil.nroResenas = perfil.resenas.length;
      perfil.trabajosCompletados = (perfil.trabajosCompletados || 0) + 1;
      await setJSON(`mudancero:perfil:${cot.mudanceroEmail}`, perfil);
      return res.status(200).json({ ok: true, msg: 'Reseña guardada', estrellas: m.estrellas, mudancero: cot.mudanceroEmail, resenas: perfil.resenas.length });
    }

    if (action === 'admin-fix-estado' && req.method === 'POST') {
      const { token, mudanzaId, forzar } = req.body;
      if (token !== process.env.ADMIN_TOKEN && token !== 'mya-admin-2026') return res.status(401).json({ error: 'No autorizado' });
      const m = await getJSON(`mudanza:${mudanzaId}`);
      if (!m) return res.status(404).json({ error: 'No encontrada' });
      if (!m.saldoPagado && !forzar) return res.status(400).json({ error: 'Saldo no pagado, no se puede completar' });
      m.estado = 'completada';
      m.saldoPagado = true;
      if (!m.fechaCompletada) m.fechaCompletada = new Date().toISOString();
      // Si se forzó la completada sin pasar por el flujo normal de pago, registrar fecha
      if (!m.fechaPagoSaldo) m.fechaPagoSaldo = new Date().toISOString();
      await setJSON(`mudanza:${mudanzaId}`, m, 604800);
      return res.status(200).json({ ok: true, msg: 'Estado actualizado a completada', id: mudanzaId });
    }

    return res.status(400).json({ error: 'Acción no reconocida' });

  } catch(e) {
    console.error('Error en cotizaciones:', e.message);
    return res.status(200).json({ mudanzas: [], error: e.message });
  }
};

// ════════════════════════════════════════════════════
// EMAILS
// ════════════════════════════════════════════════════
async function notificarMudanceros(mudanza) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!process.env.RESEND_API_KEY) return;

  const expira = new Date(mudanza.expira).toLocaleString('es-AR', { day:'numeric', month:'long', hour:'2-digit', minute:'2-digit' });
  const esFlete = mudanza.tipo === 'flete';
  const tipoLabel = esFlete ? '📦 Nuevo flete' : '🚛 Nueva mudanza';
  // Pack/nivel que pidió el cliente — el mudancero necesita saberlo para cotizar correctamente
  const nivelMap = { esencial: '📦 Esencial', integral: '🛠️ Integral', llave: '🔑 Llave en mano', flete: '🚚 Flete' };
  const nivelLabel = esFlete ? '' : (nivelMap[mudanza.nivel] || '');

  const emailHtml = (nombreMudancero) => `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;background:#ffffff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
    <div style="background:#003580;padding:20px 28px"><span style="font-family:Georgia,serif;font-size:20px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:20px;font-weight:900;color:#22C36A">Ya</span><span style="font-size:13px;color:rgba(255,255,255,.7);margin-left:12px">Nuevo pedido disponible</span></div>
    <div style="background:#EEF4FF;border-bottom:1px solid #C7D9FF;padding:12px 28px;font-size:13px;color:#1A6FFF;font-weight:600">${tipoLabel} · ${mudanza.id}</div>
    <div style="padding:28px">
      <p style="font-size:15px;color:#0F1923;margin:0 0 20px">Hola${nombreMudancero ? ' ' + nombreMudancero : ''}, hay un nuevo pedido disponible en tu zona.</p>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="color:#64748B;padding:7px 0;width:35%;font-size:13px">De</td><td style="font-weight:600;color:#0F1923;font-size:13px">${mudanza.desde}</td></tr>
        <tr style="background:#F5F7FA"><td style="color:#64748B;padding:7px 6px;font-size:13px">A</td><td style="font-weight:600;color:#0F1923;font-size:13px;padding:7px 0">${mudanza.hasta}</td></tr>
        <tr><td style="color:#64748B;padding:7px 0;font-size:13px">Tamaño</td><td style="font-size:13px;color:#0F1923">${mudanza.ambientes}</td></tr>
        ${nivelLabel ? `<tr style="background:#F5F7FA"><td style="color:#64748B;padding:7px 6px;font-size:13px">Servicio</td><td style="font-size:13px;color:#0F1923;font-weight:600;padding:7px 0">${nivelLabel}</td></tr>` : ''}
        <tr${nivelLabel ? '' : ' style="background:#F5F7FA"'}><td style="color:#64748B;padding:7px${nivelLabel ? ' 0' : ' 6px'};font-size:13px">Fecha</td><td style="font-size:13px;color:#0F1923${nivelLabel ? '' : ';padding:7px 0'}">${mudanza.fecha}</td></tr>
        <tr${nivelLabel ? ' style="background:#F5F7FA"' : ''}><td style="color:#64748B;padding:7px${nivelLabel ? ' 6px' : ' 0'};font-size:13px">Precio estimado</td><td style="color:#17A356;font-weight:700;font-size:14px${nivelLabel ? ';padding:7px 0' : ''}">$${parseInt(mudanza.precio_estimado||0).toLocaleString('es-AR')}</td></tr>
        <tr${nivelLabel ? '' : ' style="background:#F5F7FA"'}><td style="color:#64748B;padding:7px${nivelLabel ? ' 0' : ' 6px'};font-size:13px">Expira</td><td style="color:#F59E0B;font-weight:600;font-size:13px${nivelLabel ? '' : ';padding:7px 0'}">${expira}</td></tr>
      </table>
      <div style="margin-top:20px">
        <a href="https://mudateya.ar/mi-cuenta" style="display:inline-block;background:#22C36A;color:#003580;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:14px">Cotizar ahora →</a>
      </div>
      <p style="font-size:12px;color:#94A3B8;margin-top:16px">Entrá a tu cuenta para ver los detalles completos y enviar tu cotización.</p>
    </div>
    <div style="background:#F5F7FA;border-top:1px solid #E2E8F0;padding:14px 28px;font-size:11px;color:#94A3B8;font-family:monospace">MudateYa · mudateya.ar</div>
  </div>`;

  // 1. Notificar al admin siempre
  if (adminEmail) {
    try {
      await resend.emails.send({
        from: 'MudateYa <noreply@mudateya.ar>',
        to: adminEmail,
        subject: `${tipoLabel} — ${mudanza.desde} → ${mudanza.hasta} · ${mudanza.id}`,
        html: emailHtml('Admin'),
      });
    } catch(e) { console.error('Email admin error:', e.message); }
  }

  // 2. Notificar a mudanceros aprobados
  // Si es modo dirigido, solo notificar a los invitados
  // Si es abierto, notificar a todos los aprobados
  try {
    const todosEmails = await getJSON('mudanceros:todos') || [];
    const destinatarios = [];

    for (const email of todosEmails) {
      try {
        const p = await getJSON(`mudancero:perfil:${email}`);
        if (!p || p.estado !== 'aprobado') continue;
        if (!p.email) continue;

        // Modo dirigido: solo los invitados
        if (mudanza.modoCotizacion === 'dirigido') {
          if (!(mudanza.mudancerosInvitados || []).includes(email)) continue;
        }

        destinatarios.push({ email: p.email, nombre: p.nombre || '' });
      } catch(e) { /* ignorar errores individuales */ }
    }

    // Enviar en lotes de 5 para no saturar la API
    for (let i = 0; i < destinatarios.length; i += 5) {
      const lote = destinatarios.slice(i, i + 5);
      await Promise.all(lote.map(function(dest) {
        return resend.emails.send({
          from: 'MudateYa <noreply@mudateya.ar>',
          to: dest.email,
          subject: `${tipoLabel} disponible — ${mudanza.desde} → ${mudanza.hasta}`,
          html: emailHtml(dest.nombre),
        }).catch(function(e) { console.error('Email mudancero error:', dest.email, e.message); });
      }));
    }

    // Push notifications a todos los destinatarios (en paralelo)
    const dirigido = mudanza.modoCotizacion === 'dirigido';
    const tituloPush = dirigido ? '⭐ Te eligieron' : tipoLabel;
    const cuerpoPush = `${mudanza.desde?.split(',')[0] || mudanza.desde} → ${mudanza.hasta?.split(',')[0] || mudanza.hasta}`;
    await Promise.all(destinatarios.map(function(dest){
      return enviarPush(dest.email, {
        titulo: tituloPush,
        cuerpo: cuerpoPush,
        link: '/mi-cuenta'
      }).catch(function(e){ console.error('Push mudancero error:', dest.email, e && e.message); });
    }));
  } catch(e) {
    console.error('Error notificando mudanceros:', e.message);
  }
}

async function notificarCliente(mudanza, cotizacion) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  if (!process.env.RESEND_API_KEY) return;

  // Generar PDF con los datos de la cotización
  let attachments = [];
  try {
    const pdfBase64 = await generarPDFBase64({
      id:                cotizacion.id,
      fechaEmision:      new Date().toLocaleDateString('es-AR', { day:'numeric', month:'long', year:'numeric' }),
      clienteNombre:     mudanza.clienteNombre,
      clienteEmail:      mudanza.clienteEmail,
      mudanceroNombre:   cotizacion.mudanceroNombre,
      mudancero_initials:(cotizacion.mudanceroNombre||'MV').slice(0,2).toUpperCase(),
      desde:             mudanza.desde,
      hasta:             mudanza.hasta,
      fecha:             mudanza.fecha,
      ambientes:         mudanza.ambientes,
      objetos:           mudanza.servicios,
      extras:            mudanza.extras,
      precio:            cotizacion.precio,
      nota:              cotizacion.nota,
    });
    attachments = [{ filename: `cotizacion-${cotizacion.id}.pdf`, content: pdfBase64 }];
  } catch(e) {
    console.error('Error generando PDF cotización:', e.message);
  }

  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>',
    to: mudanza.clienteEmail,
    subject: `💰 Cotización de ${cotizacion.mudanceroNombre} — $${String(cotizacion.precio).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`,  
    html: `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;background:#ffffff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <!-- Header -->
      <div style="background:#003580;padding:20px 28px;display:flex;align-items:center">
        <span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#ffffff;letter-spacing:1px">Mudate</span><span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#22C36A;letter-spacing:1px">Ya</span>
      </div>
      <!-- Badge -->
      <div style="background:#F0FFF6;border-bottom:1px solid #BBF7D0;padding:12px 28px;font-size:13px;color:#16A34A;font-weight:600">
        💰 Nueva cotización recibida
      </div>
      <!-- Body -->
      <div style="padding:28px">
        <p style="color:#475569;font-size:15px;margin-bottom:20px;line-height:1.6">
          <strong style="color:#0F1923">${cotizacion.mudanceroNombre}</strong> cotizó tu mudanza<br>
          <span style="color:#1A6FFF;font-weight:600">${mudanza.desde} → ${mudanza.hasta}</span>
        </p>
        <!-- Precio destacado -->
        <div style="background:#F5F7FA;border:1px solid #E2E8F0;border-left:4px solid #22C36A;border-radius:10px;padding:18px 22px;margin:0 0 20px">
          <div style="font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;font-family:monospace">Precio cotizado</div>
          <div style="font-size:2rem;font-weight:700;color:#003580">$${cotizacion.precio.toLocaleString('es-AR')}</div>
          ${cotizacion.tiempoEstimado ? `<div style="color:#64748B;font-size:13px;margin-top:6px">⏱ ${cotizacion.tiempoEstimado}</div>` : ''}
          ${cotizacion.nota ? `<div style="color:#475569;font-size:13px;margin-top:8px;font-style:italic;border-top:1px solid #E2E8F0;padding-top:8px">"${cotizacion.nota}"</div>` : ''}
        </div>
        <!-- Aviso ajuste de precio -->
        <div style="background:#EFF6FF;border:1px solid #93C5FD;border-left:4px solid #1A6FFF;border-radius:10px;padding:14px 18px;margin:0 0 20px">
          <div style="font-size:11px;color:#1E40AF;text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin-bottom:6px;font-family:monospace">💡 Precio sujeto a ajuste</div>
          <div style="color:#1E3A8A;font-size:12.5px;line-height:1.55">
            Si al día de la mudanza hubiera condiciones no previstas (más volumen, accesos complicados, piso sin ascensor, etc.), el mudancero puede proponerte un ajuste justificado. Vos decidís si lo aceptás; si rechazás, <strong>recuperás tu anticipo completo</strong>.
          </div>
        </div>
        <p style="color:#64748B;font-size:13px;margin-bottom:20px">El detalle completo está adjunto en PDF.</p>
        <a href="https://mudateya.ar/mi-mudanza" style="display:inline-block;background:#1A6FFF;color:#ffffff;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:14px">Ver mis cotizaciones →</a>
      </div>
      <!-- Footer -->
      <div style="background:#F5F7FA;border-top:1px solid #E2E8F0;padding:14px 28px;font-size:11px;color:#94A3B8;font-family:monospace">
        MudateYa · mudateya.ar · hola@mudateya.ar
      </div>
    </div>`,
    attachments,
  });
}

async function enviarEmailAceptacion(mudanza, cot) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  if (!process.env.RESEND_API_KEY) return;

  const siteUrl = process.env.SITE_URL || 'https://mudateya.ar';
  const precioTotal = parseInt(cot.precio) || 0;
  const montoAnticipo = Math.round(precioTotal * 0.5); // ← 50% del precio
  const precioFmt = '$' + precioTotal.toLocaleString('es-AR');
  const anticipoFmt = '$' + montoAnticipo.toLocaleString('es-AR');

  // ── 1. Generar link de pago MP por solo el ANTICIPO (50%) ───────────────
  // El otro 50% se paga después, cuando el mudancero marca "completada" y
  // se envía notificarClienteSaldoPendiente con su propio link.
  let linkPago = `${siteUrl}/mi-mudanza`; // fallback
  try {
    const { MercadoPagoConfig, Preference } = require('mercadopago');
    const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
    const preference = new Preference(client);
    const result = await preference.create({ body: {
      items: [{
        id:          `${mudanza.id}-${cot.id}-anticipo`,
        title:       `MudateYa — 50% anticipo · ${cot.mudanceroNombre}`,
        description: `${mudanza.desde} → ${mudanza.hasta} · ${mudanza.ambientes}`,
        quantity:    1,
        unit_price:  montoAnticipo,
        currency_id: 'ARS',
      }],
      back_urls: {
        success: `${siteUrl}/pago-exitoso?mudanzaId=${mudanza.id}&cotizacionId=${cot.id}&monto=${montoAnticipo}&mudancero=${encodeURIComponent(cot.mudanceroNombre)}&tipoPago=anticipo`,
        failure: `${siteUrl}/mi-mudanza?pago=error`,
        pending: `${siteUrl}/mi-mudanza?pago=pendiente`,
      },
      auto_return:          'approved',
      statement_descriptor: 'MUDATEYA',
      external_reference:   `${mudanza.id}-${cot.id}-anticipo`,
      notification_url:     `${siteUrl}/api/webhook-mp`,
      // tipoPago crítico: el webhook lo lee para marcar `m.anticipoPagado=true` (no el saldo)
      metadata:             { mudanzaId: mudanza.id, cotizacionId: cot.id, tipoPago: 'anticipo' },
    }});
    linkPago = result.init_point || result.initPoint || linkPago;
  } catch(e) {
    console.error('Error generando link MP:', e.message);
  }

  // ── 2. Generar PDF ───────────────────────────────
  let attachments = [];
  try {
    const pdfBase64 = await generarPDFBase64({
      id:                mudanza.id,
      fechaEmision:      new Date().toLocaleDateString('es-AR', { day:'numeric', month:'long', year:'numeric' }),
      clienteNombre:     mudanza.clienteNombre,
      clienteEmail:      mudanza.clienteEmail,
      mudanceroNombre:   cot.mudanceroNombre,
      mudancero_initials:(cot.mudanceroNombre||'MV').slice(0,2).toUpperCase(),
      desde:             mudanza.desde,
      hasta:             mudanza.hasta,
      fecha:             mudanza.fecha,
      ambientes:         mudanza.ambientes,
      objetos:           mudanza.servicios,
      extras:            mudanza.extras,
      precio:            cot.precio,
      nota:              cot.nota,
    });
    attachments = [{ filename: `cotizacion-${mudanza.id}.pdf`, content: pdfBase64 }];
  } catch(e) {
    console.error('Error generando PDF:', e.message);
  }

  // ── 3. Email al CLIENTE con botón de pago ────────
  if (mudanza.clienteEmail) {
    await resend.emails.send({
      from: 'MudateYa <noreply@mudateya.ar>',
      to: mudanza.clienteEmail,
      subject: `✅ Aceptaste la cotización — Pagá ahora con Mercado Pago`,
      html: `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;background:#ffffff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
        <!-- Header -->
        <div style="background:#003580;padding:20px 28px">
          <span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#22C36A">Ya</span>
        </div>
        <!-- Badge -->
        <div style="background:#F0FFF6;border-bottom:1px solid #BBF7D0;padding:12px 28px;font-size:13px;color:#16A34A;font-weight:600">
          ✅ ¡Cotización aceptada!
        </div>
        <!-- Body -->
        <div style="padding:28px">
          <p style="color:#475569;font-size:15px;margin-bottom:18px;line-height:1.6">
            Hola <strong style="color:#0F1923">${mudanza.clienteNombre}</strong>, aceptaste la cotización de <strong style="color:#003580">${cot.mudanceroNombre}</strong>. Para confirmar la mudanza, completá el pago.
          </p>
          <!-- Resumen -->
          <div style="background:#F5F7FA;border:1px solid #E2E8F0;border-radius:10px;padding:16px 20px;margin:0 0 20px">
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="color:#64748B;padding:6px 0;width:35%;font-size:13px">Mudancero</td><td style="font-weight:600;color:#0F1923;font-size:13px">${cot.mudanceroNombre}</td></tr>
              <tr><td style="color:#64748B;padding:6px 0;font-size:13px">Teléfono</td><td style="font-size:13px;color:#0F1923">${cot.mudanceroTel || '—'}</td></tr>
              <tr><td style="color:#64748B;padding:6px 0;font-size:13px">Ruta</td><td style="font-size:13px;color:#0F1923">${mudanza.desde} → ${mudanza.hasta}</td></tr>
              <tr><td style="color:#64748B;padding:6px 0;font-size:13px">Fecha</td><td style="font-size:13px;color:#0F1923">${mudanza.fecha}</td></tr>
              <tr><td style="color:#64748B;padding:6px 0;font-size:13px">Ambientes</td><td style="font-size:13px;color:#0F1923">${mudanza.ambientes}</td></tr>
              ${cot.nota ? `<tr><td style="color:#64748B;padding:6px 0;font-size:13px">Nota</td><td style="font-size:13px;color:#475569;font-style:italic">${cot.nota}</td></tr>` : ''}
            </table>
          </div>
          <!-- Precio + pago -->
          <div style="background:#EEF4FF;border:2px solid #1A6FFF;border-radius:12px;padding:22px;margin:0 0 20px;text-align:center">
            <div style="font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;font-family:monospace">Anticipo a pagar ahora (50%)</div>
            <div style="font-size:2.2rem;font-weight:700;color:#003580;margin-bottom:4px">${anticipoFmt}</div>
            <div style="font-size:12px;color:#64748B;margin-bottom:18px">de un total de <strong>${precioFmt}</strong> · saldo al completar la mudanza</div>
            <a href="${linkPago}" style="display:inline-block;background:#009EE3;color:#ffffff;padding:14px 36px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px">💳 Pagar anticipo ${anticipoFmt}</a>
            <p style="color:#64748B;font-size:11px;margin-top:12px;margin-bottom:0">🔒 Pago 100% seguro · MudateYa protege tu dinero hasta confirmar el servicio</p>
          </div>
          <p style="color:#64748B;font-size:13px;margin-bottom:8px">También podés acceder desde <a href="${siteUrl}/mi-mudanza" style="color:#1A6FFF;font-weight:600">tu panel de mudanzas</a>.</p>
          <p style="color:#94A3B8;font-size:12px">Adjuntamos el comprobante en PDF para tus registros.</p>
        </div>
        <!-- Footer -->
        <div style="background:#F5F7FA;border-top:1px solid #E2E8F0;padding:14px 28px;font-size:11px;color:#94A3B8;font-family:monospace">
          MudateYa · mudateya.ar · hola@mudateya.ar
        </div>
      </div>`,
      attachments,
    });
  }

  // ── 4. Email al MUDANCERO ────────────────────────
  if (cot.mudanceroEmail) {
    await resend.emails.send({
      from: 'MudateYa <noreply@mudateya.ar>',
      to: cot.mudanceroEmail,
      subject: `🎉 ¡Aceptaron tu cotización! — ${mudanza.desde} → ${mudanza.hasta}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
        <div style="background:#003580;padding:20px 28px">
          <span style="font-family:Georgia,serif;font-size:20px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:20px;font-weight:900;color:#22C36A">Ya</span>
          <span style="font-size:13px;color:rgba(255,255,255,.7);margin-left:12px">🎉 Te eligieron</span>
        </div>
        <div style="padding:28px">
          <p style="font-size:15px;color:#0F1923;margin-bottom:20px;line-height:1.6">
            <strong>${mudanza.clienteNombre}</strong> aceptó tu cotización. Te avisaremos cuando confirme el pago del anticipo.
          </p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:18px">
            <tr><td style="color:#64748B;padding:7px 0;width:35%;font-size:13px">Ruta</td><td style="font-weight:600;color:#0F1923;font-size:13px">${mudanza.desde} → ${mudanza.hasta}</td></tr>
            <tr style="background:#F5F7FA"><td style="color:#64748B;padding:7px 6px;font-size:13px">Fecha</td><td style="font-weight:600;color:#0F1923;font-size:13px;padding:7px 0">${mudanza.fecha||'—'}</td></tr>
            <tr><td style="color:#64748B;padding:7px 0;font-size:13px">Tamaño</td><td style="font-size:13px;color:#0F1923">${mudanza.ambientes||'—'}</td></tr>
            <tr style="background:#F5F7FA"><td style="color:#64748B;padding:7px 6px;font-size:13px">Precio acordado</td><td style="color:#22C36A;font-weight:700;font-size:15px;padding:7px 0">${precioFmt}</td></tr>
          </table>
          <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:10px;padding:14px 16px;margin-bottom:20px">
            <div style="font-size:13px;color:#15803D;line-height:1.6">
              💡 <strong>¿Cuándo recibís el pago?</strong><br>
              MudateYa procesa las liquidaciones cada <strong>15 días hábiles</strong> una vez confirmada la mudanza.
            </div>
          </div>
          <a href="${siteUrl}/mi-cuenta" style="display:inline-block;background:#003580;color:#fff;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:14px">
            Ver en mi panel →
          </a>
        </div>
        <div style="background:#F5F7FA;border-top:1px solid #E2E8F0;padding:14px 28px;font-size:11px;color:#94A3B8;font-family:monospace">MudateYa · mudateya.ar · ID: ${mudanza.id}</div>
      </div>`,
      attachments,
    });
  }
}

// ════════════════════════════════════════════════════
// EMAIL — MUDANCERO INVITADO (modo dirigido)
// ════════════════════════════════════════════════════
async function notificarMudanceroInvitado(mudanza, perfil) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  if (!process.env.RESEND_API_KEY || !perfil.email) return;
  const siteUrl = process.env.SITE_URL || 'https://mudateya.ar';

  // Push en paralelo con el email
  enviarPush(perfil.email, {
    titulo: '⭐ Un cliente te eligió',
    cuerpo: `${mudanza.clienteNombre || 'Un cliente'}: ${mudanza.desde?.split(',')[0] || mudanza.desde} → ${mudanza.hasta?.split(',')[0] || mudanza.hasta}`,
    link: '/mi-cuenta'
  }).catch(function(e){ console.error('Push invitado error:', perfil.email, e && e.message); });

  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>',
    to:   perfil.email,
    subject: `⭐ Te eligieron — ${mudanza.desde} → ${mudanza.hasta}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <div style="background:#003580;padding:20px 28px">
        <span style="font-family:Georgia,serif;font-size:20px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:20px;font-weight:900;color:#22C36A">Ya</span>
        <span style="font-size:13px;color:rgba(255,255,255,.7);margin-left:12px">⭐ Un cliente te eligió</span>
      </div>
      <div style="padding:28px">
        <p style="font-size:15px;color:#0F1923;margin-bottom:20px;line-height:1.6">
          Hola <strong>${perfil.nombre}</strong>, <strong>${mudanza.clienteNombre || 'un cliente'}</strong> revisó tu perfil y te invitó a cotizar su mudanza.
        </p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:18px">
          <tr><td style="color:#64748B;padding:7px 0;width:35%;font-size:13px">De</td><td style="font-weight:600;color:#0F1923;font-size:13px">${mudanza.desde}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:7px 6px;font-size:13px">A</td><td style="font-weight:600;color:#0F1923;font-size:13px;padding:7px 0">${mudanza.hasta}</td></tr>
          <tr><td style="color:#64748B;padding:7px 0;font-size:13px">Tamaño</td><td style="font-size:13px;color:#0F1923">${mudanza.ambientes || '—'}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:7px 6px;font-size:13px">Fecha</td><td style="font-size:13px;color:#0F1923;padding:7px 0">${mudanza.fecha || '—'}</td></tr>
          ${mudanza.precio_estimado ? `<tr><td style="color:#64748B;padding:7px 0;font-size:13px">Estimado cliente</td><td style="color:#22C36A;font-weight:700;font-size:14px">$${parseInt(mudanza.precio_estimado).toLocaleString('es-AR')}</td></tr>` : ''}
        </table>
        <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:10px;padding:14px 16px;margin-bottom:20px">
          <div style="font-size:13px;color:#15803D;line-height:1.6">
            💡 Esta es una solicitud <strong>directa</strong> — el cliente te eligió a vos específicamente entre los mudanceros disponibles.
          </div>
        </div>
        <a href="${siteUrl}/mi-cuenta" style="display:inline-block;background:#003580;color:#fff;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:14px">
          Enviar cotización →
        </a>
      </div>
      <div style="background:#F5F7FA;border-top:1px solid #E2E8F0;padding:14px 28px;font-size:11px;color:#94A3B8;font-family:monospace">MudateYa · mudateya.ar</div>
    </div>`,
  });
}

// ════════════════════════════════════════════════════
// GOOGLE SHEETS — LOG DE MUDANZAS COMPLETADAS
// ════════════════════════════════════════════════════
async function logPedidoSheets(mudanza) {
  const webhookUrl = process.env.GOOGLE_SHEETS_PEDIDOS_URL;
  if (!webhookUrl) return;

  const cot = mudanza.cotizacionAceptada || {};
  const esFlete = mudanza.tipo === 'flete' || mudanza.ambientes === 'Flete';
  // Plan Referidos (leads de asesores inmobiliarios): 25% flat
  // Mudanzas normales: 15% · Fletes normales: 20%
  const esPlanReferidos = mudanza.origenAsesor === true;
  const feePct = esPlanReferidos ? 0.25 : (esFlete ? 0.20 : 0.15);
  const precio = parseInt(cot.precio || 0);
  const fee = Math.round(precio * feePct);
  const neto = precio - fee;

  const fmt = (n) => n ? '$' + parseInt(n).toLocaleString('es-AR') : '—';
  const fmtFecha = (iso) => iso ? new Date(iso).toLocaleString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires'
  }) : '—';

  const row = {
    ID:                mudanza.id,
    'Fecha publicación': fmtFecha(mudanza.fechaPublicacion),
    'Fecha completada':  fmtFecha(mudanza.fechaCompletada),
    Tipo:              (mudanza.tipo || 'mudanza').toUpperCase(),
    Desde:             mudanza.desde,
    Hasta:             mudanza.hasta,
    Ambientes:         mudanza.ambientes || '—',
    Objeto:            mudanza.servicios || '—',
    Cliente:           mudanza.clienteNombre || '—',
    'Email cliente':   mudanza.clienteEmail || '—',
    'Celular cliente': mudanza.clienteWA || '—',
    Mudancero:         cot.mudanceroNombre || '—',
    'Email mudancero': cot.mudanceroEmail || '—',
    'Tel mudancero':   cot.mudanceroTel || '—',
    'Precio total':    fmt(precio),
    'Fee MudateYa':    fmt(fee),
    'Neto mudancero':  fmt(neto),
    '% Fee':           esPlanReferidos ? '25%' : (esFlete ? '20%' : '15%'),
    'Origen':          esPlanReferidos ? 'PLAN REFERIDOS' : 'DIRECTO',
    'Anticipo pagado': mudanza.anticipoPagado ? 'SI' : 'NO',
    'Saldo pagado':    mudanza.saldoPagado    ? 'SI' : 'NO',
    Estado:            'COMPLETADA',
  };

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(row),
  });
}

async function notificarMudanceroPago(mudanza, tipoPago) {
  if (!process.env.RESEND_API_KEY) return;
  const resend = new Resend(process.env.RESEND_API_KEY);
  const cot = mudanza.cotizacionAceptada;
  if (!cot || !cot.mudanceroEmail) return;

  const esAnticipo = tipoPago === 'anticipo';
  const precioTotal = cot.precio || 0;
  const esFlete = (mudanza.tipo || '').toLowerCase() === 'flete';
  // Plan Referidos: 25% · Mudanza normal: 15% · Flete normal: 20%
  const esPlanReferidos = mudanza.origenAsesor === true;
  const comisionPct = esPlanReferidos ? 0.25 : (esFlete ? 0.20 : 0.15);
  const monto = Math.round(precioTotal * 0.5);
  const montoFmt = '$' + monto.toLocaleString('es-AR');
  const netoMudancero = Math.round(precioTotal * (1 - comisionPct));
  const netoFmt = '$' + netoMudancero.toLocaleString('es-AR');
  const nombre = (cot.mudanceroNombre || 'Mudancero').split(' ')[0];

  // Push notification — paralela al email
  const tituloPush = esAnticipo ? '💰 Anticipo recibido' : '✅ Pago completado';
  const cuerpoPush = esAnticipo
    ? `${montoFmt} acreditado. Coordiná la mudanza.`
    : `${montoFmt} acreditado. Mudanza pagada al 100%.`;
  enviarPush(cot.mudanceroEmail, {
    titulo: tituloPush,
    cuerpo: cuerpoPush,
    link: '/mi-cuenta'
  }).catch(function(e){ console.error('Push pago error:', cot.mudanceroEmail, e && e.message); });

  const subject = esAnticipo
    ? `💰 Anticipo recibido — ${mudanza.desde?.split(',')[0]} → ${mudanza.hasta?.split(',')[0]}`
    : `✅ Saldo final recibido — Mudanza completamente pagada`;

  const mensajePrincipal = esAnticipo
    ? `<strong>${nombre}</strong>, el cliente pagó el anticipo del 50% (${montoFmt}). Ya podés coordinar la mudanza.`
    : `<strong>${nombre}</strong>, el cliente pagó el saldo final (${montoFmt}). La mudanza está completamente pagada. Procesaremos tu liquidación en los próximos días hábiles.`;

  const accion = esAnticipo
    ? `<a href="https://mudateya.ar/mi-cuenta" style="display:inline-block;background:#22C36A;color:#003580;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:14px">Ver en mi cuenta →</a>`
    : `<a href="https://mudateya.ar/mi-cuenta" style="display:inline-block;background:#003580;color:#fff;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:14px">Ver liquidación →</a>`;

  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>',
    to: cot.mudanceroEmail,
    subject,
    html: `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;background:#ffffff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <div style="background:#003580;padding:20px 28px">
        <span style="font-family:Georgia,serif;font-size:20px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:20px;font-weight:900;color:#22C36A">Ya</span>
        <span style="font-size:13px;color:rgba(255,255,255,.7);margin-left:12px">${esAnticipo ? '💰 Anticipo recibido' : '✅ Pago completado'}</span>
      </div>
      <div style="padding:28px">
        <p style="font-size:15px;color:#0F1923;margin-bottom:20px;line-height:1.6">${mensajePrincipal}</p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
          <tr><td style="color:#64748B;padding:7px 0;width:35%;font-size:13px">De</td><td style="font-weight:600;color:#0F1923;font-size:13px">${mudanza.desde || '—'}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:7px 6px;font-size:13px">A</td><td style="font-weight:600;color:#0F1923;font-size:13px;padding:7px 0">${mudanza.hasta || '—'}</td></tr>
          <tr><td style="color:#64748B;padding:7px 0;font-size:13px">Fecha</td><td style="font-size:13px;color:#0F1923">${mudanza.fecha || '—'}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:7px 6px;font-size:13px">${esAnticipo ? 'Anticipo recibido' : 'Saldo recibido'}</td><td style="color:#17A356;font-weight:700;font-size:14px;padding:7px 0">${montoFmt}</td></tr>
          ${!esAnticipo ? `<tr><td style="color:#64748B;padding:7px 0;font-size:13px">A liquidar (neto)</td><td style="color:#17A356;font-weight:700;font-size:14px">${netoFmt}</td></tr>` : ''}
        </table>
        ${accion}
      </div>
      <div style="background:#F5F7FA;border-top:1px solid #E2E8F0;padding:14px 28px;font-size:11px;color:#94A3B8;font-family:monospace">MudateYa · mudateya.ar · ID: ${mudanza.id}</div>
    </div>`,
  });
}


// Calcula el saldo pendiente de pago considerando posibles ajustes de precio.
// Si el cliente aceptó un ajuste: saldo = precio_nuevo - anticipo_pagado (fijo).
// Si no hay ajuste: saldo = precio * 0.5 (50% tradicional).
function calcularSaldo(mudanza) {
  var cot = mudanza.cotizacionAceptada || {};
  var precio = parseInt(cot.precio || 0);
  if (mudanza.anticipoPagado && mudanza.anticipoMonto) {
    return Math.max(0, precio - mudanza.anticipoMonto);
  }
  return Math.round(precio * 0.5);
}

async function notificarClienteAnticipoPagado(mudanza) {
  if (!process.env.RESEND_API_KEY || !mudanza.clienteEmail) return;
  const resend = new Resend(process.env.RESEND_API_KEY);
  const cot = mudanza.cotizacionAceptada || {};
  const saldo = calcularSaldo(mudanza);
  const saldoFmt = '$' + saldo.toLocaleString('es-AR');
  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>',
    to: mudanza.clienteEmail,
    subject: `✅ Anticipo confirmado — ${(mudanza.desde||'').split(',')[0]} → ${(mudanza.hasta||'').split(',')[0]}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <div style="background:#003580;padding:20px 28px"><span style="font-family:Georgia,serif;font-size:20px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:20px;font-weight:900;color:#22C36A">Ya</span><span style="font-size:13px;color:rgba(255,255,255,.7);margin-left:12px">✅ Anticipo confirmado</span></div>
      <div style="padding:28px">
        <p style="font-size:15px;color:#0F1923;margin-bottom:20px;line-height:1.6">Tu anticipo fue acreditado. <strong>${cot.mudanceroNombre || 'Tu mudancero'}</strong> fue notificado y te contactará pronto para coordinar los detalles.</p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
          <tr><td style="color:#64748B;padding:7px 0;width:35%;font-size:13px">De</td><td style="font-weight:600;color:#0F1923;font-size:13px">${mudanza.desde||'—'}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:7px 6px;font-size:13px">A</td><td style="font-weight:600;color:#0F1923;font-size:13px;padding:7px 0">${mudanza.hasta||'—'}</td></tr>
          <tr><td style="color:#64748B;padding:7px 0;font-size:13px">Fecha</td><td style="font-size:13px;color:#0F1923">${mudanza.fecha||'—'}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:7px 6px;font-size:13px">Mudancero</td><td style="font-weight:600;color:#0F1923;font-size:13px;padding:7px 0">${cot.mudanceroNombre||'—'}</td></tr>
          <tr><td style="color:#64748B;padding:7px 0;font-size:13px">Saldo pendiente</td><td style="color:#F59E0B;font-weight:700;font-size:14px">${saldoFmt} al completar</td></tr>
        </table>
        <a href="https://mudateya.ar/mi-mudanza" style="display:inline-block;background:#003580;color:#fff;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:14px">Ver mi mudanza →</a>
      </div>
      <div style="background:#F5F7FA;border-top:1px solid #E2E8F0;padding:14px 28px;font-size:11px;color:#94A3B8;font-family:monospace">MudateYa · mudateya.ar · ID: ${mudanza.id}</div>
    </div>`,
  });
}

async function notificarClienteSaldoPendiente(mudanza) {
  if (!process.env.RESEND_API_KEY || !mudanza.clienteEmail) return;
  const resend = new Resend(process.env.RESEND_API_KEY);
  const cot = mudanza.cotizacionAceptada || {};
  const saldo = calcularSaldo(mudanza);
  const saldoFmt = '$' + saldo.toLocaleString('es-AR');
  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>',
    to: mudanza.clienteEmail,
    subject: `🏁 Mudanza completada — Pagá el saldo final ${saldoFmt}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <div style="background:#003580;padding:20px 28px"><span style="font-family:Georgia,serif;font-size:20px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:20px;font-weight:900;color:#22C36A">Ya</span><span style="font-size:13px;color:rgba(255,255,255,.7);margin-left:12px">🏁 Mudanza completada</span></div>
      <div style="padding:28px">
        <p style="font-size:15px;color:#0F1923;margin-bottom:20px;line-height:1.6"><strong>${cot.mudanceroNombre || 'Tu mudancero'}</strong> marcó la mudanza como completada. Para cerrar el servicio, abonás el saldo final.</p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
          <tr><td style="color:#64748B;padding:7px 0;width:35%;font-size:13px">De</td><td style="font-weight:600;color:#0F1923;font-size:13px">${mudanza.desde||'—'}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:7px 6px;font-size:13px">A</td><td style="font-weight:600;color:#0F1923;font-size:13px;padding:7px 0">${mudanza.hasta||'—'}</td></tr>
          <tr><td style="color:#64748B;padding:7px 0;font-size:13px">Mudancero</td><td style="font-weight:600;color:#0F1923;font-size:13px">${cot.mudanceroNombre||'—'}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:7px 6px;font-size:13px">Saldo a pagar</td><td style="color:#003580;font-weight:700;font-size:16px;padding:7px 0">${saldoFmt}</td></tr>
        </table>
        <a href="https://mudateya.ar/mi-mudanza" style="display:inline-block;background:#22C36A;color:#003580;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:14px">Pagar saldo final →</a>
      </div>
      <div style="background:#F5F7FA;border-top:1px solid #E2E8F0;padding:14px 28px;font-size:11px;color:#94A3B8;font-family:monospace">MudateYa · mudateya.ar · ID: ${mudanza.id}</div>
    </div>`,
  });
}

// ══════════════════════════════════════════════════════════════════════
// EMAILS — Ajuste de precio
// ══════════════════════════════════════════════════════════════════════

// Email al cliente cuando el mudancero propone un nuevo precio (inicial o recordatorio)
async function notificarClienteAjustePropuesto(mudanza, esRecordatorio) {
  if (!process.env.RESEND_API_KEY || !mudanza.clienteEmail) return;
  const resend = new Resend(process.env.RESEND_API_KEY);
  const cot = mudanza.cotizacionAceptada || {};
  const ajuste = mudanza.ajustePrecio || {};
  const origFmt = '$' + (ajuste.montoOriginal || 0).toLocaleString('es-AR');
  const nuevoFmt = '$' + (ajuste.montoNuevo || 0).toLocaleString('es-AR');
  const deltaSigno = ajuste.delta >= 0 ? '+' : '';
  const deltaFmt = deltaSigno + '$' + Math.abs(ajuste.delta || 0).toLocaleString('es-AR') + ' (' + deltaSigno + ajuste.deltaPct + '%)';
  const subject = esRecordatorio
    ? `⏰ Recordatorio: ${cot.mudanceroNombre || 'tu mudancero'} espera tu respuesta sobre el nuevo precio`
    : `⚠️ ${cot.mudanceroNombre || 'Tu mudancero'} propuso un ajuste de precio — ${nuevoFmt}`;
  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>',
    to: mudanza.clienteEmail,
    subject: subject,
    html: `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <div style="background:#F59E0B;padding:20px 28px"><span style="font-family:Georgia,serif;font-size:20px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:20px;font-weight:900;color:#fff">Ya</span><span style="font-size:13px;color:rgba(255,255,255,.9);margin-left:12px">⚠️ Ajuste de precio propuesto</span></div>
      <div style="padding:28px">
        <p style="font-size:15px;color:#0F1923;margin-bottom:16px;line-height:1.6">${esRecordatorio ? 'Este es un recordatorio. ' : ''}<strong>${cot.mudanceroNombre || 'Tu mudancero'}</strong> propuso ajustar el precio de tu mudanza.</p>
        <div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:10px;padding:16px;margin-bottom:16px">
          <div style="font-size:12px;color:#92400E;text-transform:uppercase;letter-spacing:.5px;font-weight:700;margin-bottom:10px">Motivo</div>
          <div style="font-size:14px;color:#0F1923;line-height:1.5">"${(ajuste.motivo||'').replace(/"/g,'&quot;')}"</div>
        </div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
          <tr><td style="color:#64748B;padding:7px 0;font-size:13px">Precio original</td><td style="text-align:right;font-size:13px;color:#0F1923;text-decoration:line-through">${origFmt}</td></tr>
          <tr><td style="color:#64748B;padding:7px 0;font-size:13px">Diferencia</td><td style="text-align:right;font-size:13px;color:#F59E0B;font-weight:700">${deltaFmt}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#003580;padding:10px 6px;font-size:14px;font-weight:700">Nuevo precio</td><td style="text-align:right;color:#003580;font-weight:700;font-size:17px;padding:10px 6px">${nuevoFmt}</td></tr>
        </table>
        <p style="font-size:13px;color:#64748B;margin-bottom:16px;line-height:1.6">El anticipo que ya pagaste se mantiene. Si aceptás, se ajusta solo el saldo pendiente. Si rechazás, se cancela la mudanza y te devolvemos el anticipo.</p>
        <a href="https://mudateya.ar/mi-mudanza" style="display:inline-block;background:#003580;color:#fff;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:14px">Ver y decidir →</a>
      </div>
      <div style="background:#F5F7FA;border-top:1px solid #E2E8F0;padding:14px 28px;font-size:11px;color:#94A3B8;font-family:monospace">MudateYa · mudateya.ar · ID: ${mudanza.id}</div>
    </div>`,
  });
}

// Email al mudancero cuando el cliente acepta el ajuste
async function notificarMudanceroAjusteAceptado(mudanza) {
  if (!process.env.RESEND_API_KEY) return;
  const resend = new Resend(process.env.RESEND_API_KEY);
  const cot = mudanza.cotizacionAceptada || {};
  if (!cot.mudanceroEmail) return;
  const nuevoFmt = '$' + (mudanza.ajustePrecio.montoNuevo || 0).toLocaleString('es-AR');
  const saldo = calcularSaldo(mudanza);
  const saldoFmt = '$' + saldo.toLocaleString('es-AR');
  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>',
    to: cot.mudanceroEmail,
    subject: `✅ El cliente aceptó el ajuste — ${nuevoFmt}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <div style="background:#22C36A;padding:20px 28px"><span style="font-family:Georgia,serif;font-size:20px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:20px;font-weight:900;color:#003580">Ya</span><span style="font-size:13px;color:rgba(255,255,255,.9);margin-left:12px">✅ Ajuste aceptado</span></div>
      <div style="padding:28px">
        <p style="font-size:15px;color:#0F1923;margin-bottom:16px;line-height:1.6"><strong>${mudanza.clienteNombre || 'El cliente'}</strong> aceptó el nuevo precio. Ya podés continuar con la mudanza.</p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
          <tr><td style="color:#64748B;padding:7px 0;font-size:13px">Cliente</td><td style="font-weight:600;color:#0F1923;font-size:13px">${mudanza.clienteNombre||'—'}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:7px 6px;font-size:13px">Nuevo precio</td><td style="color:#22C36A;font-weight:700;font-size:16px;padding:7px 0">${nuevoFmt}</td></tr>
          <tr><td style="color:#64748B;padding:7px 0;font-size:13px">Saldo pendiente</td><td style="color:#F59E0B;font-weight:700;font-size:14px">${saldoFmt}</td></tr>
        </table>
        <a href="https://mudateya.ar/mi-cuenta" style="display:inline-block;background:#003580;color:#fff;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:14px">Ver en mi cuenta →</a>
      </div>
    </div>`,
  });
}

// Email al cliente confirmando que aceptó el ajuste
async function notificarClienteAjusteAceptado(mudanza) {
  if (!process.env.RESEND_API_KEY || !mudanza.clienteEmail) return;
  const resend = new Resend(process.env.RESEND_API_KEY);
  const cot = mudanza.cotizacionAceptada || {};
  const nuevoFmt = '$' + (mudanza.ajustePrecio.montoNuevo || 0).toLocaleString('es-AR');
  const saldo = calcularSaldo(mudanza);
  const saldoFmt = '$' + saldo.toLocaleString('es-AR');
  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>',
    to: mudanza.clienteEmail,
    subject: `✅ Ajuste confirmado — Saldo ajustado a ${saldoFmt}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <div style="background:#003580;padding:20px 28px"><span style="font-family:Georgia,serif;font-size:20px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:20px;font-weight:900;color:#22C36A">Ya</span><span style="font-size:13px;color:rgba(255,255,255,.7);margin-left:12px">✅ Ajuste confirmado</span></div>
      <div style="padding:28px">
        <p style="font-size:15px;color:#0F1923;margin-bottom:16px;line-height:1.6">Confirmamos el nuevo precio de tu mudanza con <strong>${cot.mudanceroNombre || 'tu mudancero'}</strong>.</p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
          <tr><td style="color:#64748B;padding:7px 0;font-size:13px">Nuevo precio total</td><td style="color:#003580;font-weight:700;font-size:16px">${nuevoFmt}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:7px 6px;font-size:13px">Ya abonaste (anticipo)</td><td style="color:#0F1923;font-size:13px;padding:7px 0">$${(mudanza.anticipoMonto||0).toLocaleString('es-AR')}</td></tr>
          <tr><td style="color:#64748B;padding:7px 0;font-size:13px">Saldo a pagar al completar</td><td style="color:#F59E0B;font-weight:700;font-size:14px">${saldoFmt}</td></tr>
        </table>
        <p style="font-size:13px;color:#64748B;line-height:1.6">Cuando tu mudancero marque la mudanza como completada, vas a poder pagar el saldo desde tu panel.</p>
      </div>
    </div>`,
  });
}

// Email al mudancero cuando el cliente rechaza el ajuste
async function notificarMudanceroAjusteRechazado(mudanza) {
  if (!process.env.RESEND_API_KEY) return;
  const resend = new Resend(process.env.RESEND_API_KEY);
  const cot = mudanza.cotizacionAceptada || {};
  if (!cot.mudanceroEmail) return;
  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>',
    to: cot.mudanceroEmail,
    subject: `❌ El cliente rechazó el ajuste — Mudanza cancelada`,
    html: `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <div style="background:#DC2626;padding:20px 28px"><span style="font-family:Georgia,serif;font-size:20px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:20px;font-weight:900;color:#fff">Ya</span><span style="font-size:13px;color:rgba(255,255,255,.9);margin-left:12px">❌ Ajuste rechazado</span></div>
      <div style="padding:28px">
        <p style="font-size:15px;color:#0F1923;margin-bottom:16px;line-height:1.6"><strong>${mudanza.clienteNombre || 'El cliente'}</strong> rechazó el ajuste de precio que propusiste. La mudanza queda cancelada y le devolvemos el anticipo.</p>
        <p style="font-size:13px;color:#64748B;margin-bottom:16px;line-height:1.6">No te preocupes, esto no afecta tu calificación. Seguí cotizando otras mudanzas en tu panel.</p>
        <a href="https://mudateya.ar/mi-cuenta" style="display:inline-block;background:#003580;color:#fff;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:14px">Ver panel →</a>
      </div>
    </div>`,
  });
}

// Email al cliente confirmando cancelación + refund
async function notificarClienteMudanzaCancelada(mudanza, refundOk) {
  if (!process.env.RESEND_API_KEY || !mudanza.clienteEmail) return;
  const resend = new Resend(process.env.RESEND_API_KEY);
  const cot = mudanza.cotizacionAceptada || {};
  const anticipoFmt = '$' + (mudanza.anticipoMonto || 0).toLocaleString('es-AR');
  const mensaje = refundOk
    ? `Procesamos el reintegro de <strong>${anticipoFmt}</strong>. Vas a ver el acreditado en 5 a 10 días hábiles en tu medio de pago original.`
    : `Estamos procesando el reintegro de <strong>${anticipoFmt}</strong>. Te vamos a contactar dentro de las próximas 24 horas para completar la devolución.`;
  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>',
    to: mudanza.clienteEmail,
    subject: `Mudanza cancelada — Reintegro en proceso`,
    html: `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <div style="background:#003580;padding:20px 28px"><span style="font-family:Georgia,serif;font-size:20px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:20px;font-weight:900;color:#22C36A">Ya</span><span style="font-size:13px;color:rgba(255,255,255,.7);margin-left:12px">Mudanza cancelada</span></div>
      <div style="padding:28px">
        <p style="font-size:15px;color:#0F1923;margin-bottom:16px;line-height:1.6">Cancelamos tu mudanza con <strong>${cot.mudanceroNombre || 'el mudancero'}</strong> como solicitaste.</p>
        <p style="font-size:14px;color:#0F1923;margin-bottom:20px;line-height:1.6">${mensaje}</p>
        <p style="font-size:13px;color:#64748B;line-height:1.6">Si necesitás ayuda con una nueva mudanza, podés publicar un nuevo pedido cuando quieras.</p>
        <a href="https://mudateya.ar" style="display:inline-block;margin-top:12px;background:#22C36A;color:#003580;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:14px">Nueva mudanza →</a>
      </div>
    </div>`,
  });
}

// Alerta al admin cuando hay un ajuste muy alto (+30%)
async function notificarAdminAjusteAlto(mudanza) {
  if (!process.env.RESEND_API_KEY) return;
  const admin = process.env.ADMIN_EMAIL || 'jgalozaldivar@gmail.com';
  const resend = new Resend(process.env.RESEND_API_KEY);
  const cot = mudanza.cotizacionAceptada || {};
  const ajuste = mudanza.ajustePrecio || {};
  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>',
    to: admin,
    subject: `⚠️ Ajuste alto (+${ajuste.deltaPct}%) en ${mudanza.id}`,
    html: `<div style="font-family:Arial,sans-serif;padding:20px">
      <h3>Ajuste de precio alto detectado</h3>
      <p><strong>Mudanza:</strong> ${mudanza.id}</p>
      <p><strong>Cliente:</strong> ${mudanza.clienteNombre} (${mudanza.clienteEmail})</p>
      <p><strong>Mudancero:</strong> ${cot.mudanceroNombre} (${cot.mudanceroEmail})</p>
      <p><strong>Original:</strong> $${(ajuste.montoOriginal||0).toLocaleString('es-AR')}</p>
      <p><strong>Nuevo:</strong> $${(ajuste.montoNuevo||0).toLocaleString('es-AR')} (+${ajuste.deltaPct}%)</p>
      <p><strong>Motivo:</strong> "${ajuste.motivo||''}"</p>
      <p><a href="https://mudateya.ar/admin">Ver admin →</a></p>
    </div>`,
  });
}

// Aviso al admin si el refund automático falla
async function notificarAdminRefundManual(mudanza, error) {
  if (!process.env.RESEND_API_KEY) return;
  const admin = process.env.ADMIN_EMAIL || 'jgalozaldivar@gmail.com';
  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>',
    to: admin,
    subject: `🚨 Refund manual requerido — ${mudanza.id}`,
    html: `<div style="font-family:Arial,sans-serif;padding:20px">
      <h3>El refund automático falló — Hay que procesarlo manualmente</h3>
      <p><strong>Mudanza:</strong> ${mudanza.id}</p>
      <p><strong>Cliente:</strong> ${mudanza.clienteNombre} (${mudanza.clienteEmail})</p>
      <p><strong>Monto a reintegrar:</strong> $${(mudanza.anticipoMonto||0).toLocaleString('es-AR')}</p>
      <p><strong>Payment ID MP:</strong> ${mudanza.mpAnticipoPagoId || '—'}</p>
      <p><strong>Error:</strong> ${error || 'desconocido'}</p>
      <p>Hay que hacer el refund a mano desde el panel de MP.</p>
    </div>`,
  });
}
