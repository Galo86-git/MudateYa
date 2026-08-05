// api/cotizaciones.js — Upstash Redis + PDF con pdfmake

var { esAdmin } = require('./_auth');
var { vencimientoHabilISO } = require('./_habiles');
// Matching por zona (mismo criterio que match-mudanceros.js) — lo usa
// notificarMudanceros para filtrar a quién avisar en pedidos del bot.
var { coincideZona, palabrasZona } = require('./match-mudanceros');

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
// Lock atómico (SET NX EX): evita que dos requests concurrentes procesen la misma
// acción crítica (aceptar cotización, registrar pago). TTL corto: se libera solo
// si algo falla. Fail-open ante error de Redis.
async function adquirirLock(key, ttl) {
  try { return (await redisCall('SET', key, '1', 'EX', String(ttl || 25), 'NX')) === 'OK'; }
  catch (e) { return true; }
}

// ════════════════════════════════════════════════════
// GATE DE CONTACTO — los celulares se liberan con el anticipo
// ════════════════════════════════════════════════════
// Regla de negocio: el celular del cliente (clienteWA) y el del mudancero
// (mudanceroTel) solo viajan en el payload cuando el anticipo del 50% está
// efectivamente pagado, y solo entre las dos partes de la cotización aceptada.
//
// Por qué se hace acá y no en el front: ocultar el dato en el HTML no sirve,
// el JSON de la respuesta queda visible en devtools / Network. Si el número
// no tiene que verse todavía, no tiene que salir del servidor.
//
// Los handlers de admin NO pasan por acá: el panel sigue viendo todo.

function contactoLiberado(m) {
  return !!(m && m.anticipoPagado === true);
}

// Los campos de arriba (clienteWA/Email, mudanceroTel) ya se ocultan hasta
// que se paga el anticipo — pero eso no evita que alguien cuele su teléfono
// o mail DENTRO de un campo de texto libre que sí se muestra antes de eso
// (la nota de una cotización, el comentario del pedido). Esto lo tapa ahí.
// Best-effort, no perfecto: es una segunda capa además de que el prompt de
// Emi ya evita ofrecerlo/repetirlo — no depende de que la IA se acuerde.
function sinContacto(texto) {
  if (!texto) return texto;
  let t = String(texto);
  // Teléfonos: corridas de 8+ dígitos, con separadores típicos (espacio, guion,
  // punto, paréntesis) pero NO "/" (para no comerse fechas tipo 15/03/2026).
  t = t.replace(/\+?\d[\d\s.()-]{6,}\d/g, (m) => ((m.match(/\d/g) || []).length >= 8 ? '[contacto oculto]' : m));
  // Emails.
  t = t.replace(/[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}/g, '[contacto oculto]');
  return t;
}

// Devuelve true si este mudancero es el que ganó el pedido.
function esMudanceroAceptado(m, emailMudancero) {
  if (!m || !emailMudancero) return false;
  if (m.mudanceroAceptado) return m.mudanceroAceptado === emailMudancero;
  return !!(m.cotizacionAceptada && m.cotizacionAceptada.mudanceroEmail === emailMudancero);
}

// Vista para el MUDANCERO (por-zona, mis-cotizaciones).
// - clienteWA: solo si ganó el pedido Y el anticipo está pagado.
// - mudanceroTel de OTROS mudanceros: nunca (no tiene por qué ver a la competencia).
function sanitizarParaMudancero(m, emailMudancero) {
  if (!m) return m;
  const copia = JSON.parse(JSON.stringify(m));
  if (!(esMudanceroAceptado(copia, emailMudancero) && contactoLiberado(copia))) {
    // Datos de contacto del cliente: NO se liberan hasta ganar el pedido Y pagar
    // el anticipo. El email y el nombre son canales de contacto directos igual que
    // el WhatsApp — dejarlos pasar permitiría contactar al cliente salteándose la
    // comisión. Los datos para cotizar (desde/hasta, ambientes, fotos) sí quedan.
    delete copia.clienteWA;
    delete copia.clienteEmail;
    delete copia.clienteNombre;
    if (copia.cotizacionAceptada) {
      delete copia.cotizacionAceptada.clienteWA;
      delete copia.cotizacionAceptada.clienteEmail;
    }
  }
  if (Array.isArray(copia.cotizaciones)) {
    copia.cotizaciones = copia.cotizaciones.map(function(c) {
      if (!c || c.mudanceroEmail === emailMudancero) return c;
      const cc = Object.assign({}, c);
      delete cc.mudanceroTel;
      return cc;
    });
  }
  return copia;
}

// Vista para el CLIENTE (mis-mudanzas, respuesta de aceptar).
// - mudanceroTel: solo el de la cotización aceptada Y con anticipo pagado.
// - clienteWA no se toca: es su propio número.
function sanitizarParaCliente(m) {
  if (!m) return m;
  const copia = JSON.parse(JSON.stringify(m));
  const liberado = contactoLiberado(copia);
  const idAceptada = copia.cotizacionAceptada ? copia.cotizacionAceptada.id : null;
  if (Array.isArray(copia.cotizaciones)) {
    copia.cotizaciones = copia.cotizaciones.map(function(c) {
      if (!c) return c;
      if (liberado && idAceptada && c.id === idAceptada) return c;
      const cc = Object.assign({}, c);
      delete cc.mudanceroTel;
      return cc;
    });
  }
  if (copia.cotizacionAceptada && !liberado) delete copia.cotizacionAceptada.mudanceroTel;
  return copia;
}

// ════════════════════════════════════════════════════
// HELPERS DE FECHA
// ════════════════════════════════════════════════════
// El campo `fecha` se guarda como string ISO simple ("2026-05-19") tal cual
// lo manda el input type="date" del HTML. Para mostrarlo a usuarios argentinos
// lo convertimos a "19/05/2026" (formato dd/mm/yyyy). Acepta también ISO con
// hora ("2026-05-19T10:00:00"), de la que descarta todo después de la T.
// Si llega vacío o malformado devuelve '—' para no romper el render del email.
function fmtFechaAR(fecha) {
  if (!fecha || typeof fecha !== 'string') return '—';
  const soloFecha = fecha.split('T')[0];
  const m = soloFecha.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return fecha; // si ya viene en otro formato, devolverlo crudo
  return `${m[3]}/${m[2]}/${m[1]}`;
}

// ════════════════════════════════════════════════════
// Vencimiento del pedido, formateado para mostrarle al mudancero.
//
// Devuelve algo como "lunes 3 de agosto, 15:00 hs".
//
// DOS COSAS IMPORTANTES:
// 1. timeZone explícito. Vercel corre en UTC; sin esto toLocaleString
//    mostraba la hora tres horas adelantada y, cerca de medianoche,
//    directamente el día equivocado.
// 2. Se incluye el día de la semana. Desde que la vigencia se cuenta en
//    horas hábiles, un pedido del viernes vence el lunes: decir sólo
//    "3 de agosto" obliga al mudancero a ir a mirar el calendario.
// ════════════════════════════════════════════════════
// VALIDEZ DEL PRESUPUESTO
//
// Una cotización vale 7 días CORRIDOS desde que el mudancero la emitió
// (cot.fecha). Pasado ese plazo el cliente ya no la puede aceptar: el
// precio quedó viejo y el mudancero no puede quedar obligado a sostenerlo.
//
// El número está acá y en ningún otro lado. El PDF, el bot y la validación
// del backend leen todos de la misma constante, para que no vuelva a pasar
// que un documento diga 7 días y otro diga 24 horas.
const DIAS_VALIDEZ_COTIZACION = 7;

// Estados de la mudanza en los que TODAVÍA se puede aceptar una cotización.
// Única fuente de verdad para action=aceptar y action=detalle-cotizacion —
// si divergen, el mail muestra un botón "Elegir y pagar" que la API rechaza.
const ESTADOS_ACEPTABLES = ['buscando', 'cotizaciones_completas', 'vencido_con_cotizaciones'];

// Devuelve el Date en que vence una cotización, o null si no se puede saber.
function vencimientoCotizacion(cot, mudanza) {
  const base = (cot && cot.fecha) || (mudanza && mudanza.fechaPublicacion);
  if (!base) return null;
  const d = new Date(base);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getTime() + DIAS_VALIDEZ_COTIZACION * 24 * 60 * 60 * 1000);
}

// true si ya venció. Si no se puede determinar la fecha (cotizaciones viejas
// sin el campo), devuelve false: preferimos dejar pasar antes que bloquear
// a un cliente por un dato que falta.
function cotizacionVencida(cot, mudanza) {
  const v = vencimientoCotizacion(cot, mudanza);
  if (!v) return false;
  return Date.now() > v.getTime();
}

// "martes 4 de agosto de 2026" — para imprimir en el PDF.
function fmtValidezAR(cot, mudanza) {
  const v = vencimientoCotizacion(cot, mudanza);
  if (!v) return '';
  return v.toLocaleDateString('es-AR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    timeZone: 'America/Argentina/Buenos_Aires'
  });
}

function fmtVencimientoAR(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-AR', {
    weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: 'America/Argentina/Buenos_Aires'
  }) + ' hs';
}

// ════════════════════════════════════════════════════
// GENERADOR PDF con PDFKit
// ════════════════════════════════════════════════════
async function generarPDFBase64(datos) {
  const PDFDocument = require('pdfkit');

  // ── DATOS ────────────────────────────────────────────────────────
  const nro           = datos.id || 'MYA-0001';
  const validoHasta   = datos.validoHasta || '';
  const esPorHora     = datos.modalidad === 'hora' && datos.horasIncluidas > 0;
  const horasIncl     = parseInt(datos.horasIncluidas) || 0;
  const valorHoraAd   = parseInt(datos.valorHoraAdicional) || 0;
  const fechaDoc      = datos.fechaEmision || new Date().toLocaleDateString('es-AR', { day:'numeric', month:'long', year:'numeric', timeZone:'America/Argentina/Buenos_Aires' });
  const clienteNombre = datos.clienteNombre || '—';
  const clienteEmail  = datos.clienteEmail  || '—';
  const mudNombre     = datos.mudanceroNombre || '—';
  const mudInits      = (datos.mudanceroNombre || 'MV').slice(0,2).toUpperCase();
  const desde         = datos.desde || '—';
  const hasta         = datos.hasta || '—';
  const fechaMud      = fmtFechaAR(datos.fecha);
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
  doc.text(validoHasta ? ('PRESUPUESTO OFICIAL  -  Valido hasta el ' + validoHasta) : 'PRESUPUESTO OFICIAL', ML, Y + 8);

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

  const kmPdf = parseInt(datos.km) || 0;
  const filas = [
    ['DESDE',      desde    ],
    ['HASTA',      hasta    ],
  ];
  if (kmPdf > 0) filas.push(['DISTANCIA', kmPdf + ' km aprox.']);
  filas.push(['FECHA',      fechaMud ]);
  filas.push(['AMBIENTES',  ambientes]);
  filas.push(['OBJETOS',    objetos  ]);
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
    doc.text('Pago por Mercado Pago o transferencia.\nSeguro y protegido.', fraseStartX, Y + 22, { width: fraseAvailWidth, align: 'left' });
  } else if (fraseAvailWidth >= 60) {
    // Espacio justo: tipografía más chica
    doc.font('Helvetica').fontSize(7).fillColor(C_TEXT2);
    doc.text('Pago seguro\nMP o transf.', fraseStartX, Y + 24, { width: fraseAvailWidth, align: 'left' });
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
    ['2', 'Pagar\nanticipo'],
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
    { icon: 'MP',   titulo: 'Pago seguro',    sub: 'MP o transferencia' },
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

  // ── 8-bis. CONDICIONES DE COBRO POR HORA ──────────────────────────
  // Va antes del aviso de ajuste porque es el marco que evita necesitarlo:
  // si las horas extra estan pactadas aca, que el trabajo se estire no es un
  // imprevisto y no hace falta renegociar el precio.
  if (esPorHora) {
    const horaH = 58;
    fillRect(ML, Y, CW, horaH, '#F0F9FF', 5);
    strokeRect(ML, Y, CW, horaH, '#1A6FFF', 0.5, 5);
    fillRect(ML, Y, 4, horaH, '#1A6FFF', 0);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#1E40AF')
       .text('MODALIDAD: COBRO POR HORA', ML + 12, Y + 8);
    doc.font('Helvetica').fontSize(7.5).fillColor('#334155')
       .text(horasIncl + ' horas estimadas x $' + valorHoraAd.toLocaleString('es-AR') + ' por hora = $'
             + (horasIncl * valorHoraAd).toLocaleString('es-AR') + '.', ML + 12, Y + 20, { width: CW - 24, lineGap: 1.5 })
       .text('Al terminar se liquidan las horas reales trabajadas a esa misma tarifa. Si se extiende, cada hora'
             + ' adicional se cobra $' + valorHoraAd.toLocaleString('es-AR') + '; si termina antes, se cobra menos.',
             ML + 12, Y + 30, { width: CW - 24, lineGap: 1.5 });
    Y += horaH + 10;
  }

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
  doc.text((validoHasta ? ('Valido hasta el ' + validoHasta + '  |  ') : '') + nro, 0, Y, { width: PW - MR, align: 'right' });

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
// enviarEmailAltaMudancero se retiró: era una copia pegada de
// enviarEmailAltaExitosa (api/admin-aprobar.js) con la tabla de comisiones
// desactualizada (le faltaba Plan Referidos) y sin la lista de "qué falta"
// para aprobaciones manuales con perfil incompleto -- exactamente el tipo de
// bug que dejó este día: se arregló UNA copia y la que de verdad usa el
// botón "Aprobar" del panel (admin-aprobar-mudancero, acá abajo) seguía
// vieja. Ahora hay una sola función (exportada de admin-aprobar.js), usada
// por los dos caminos de aprobación (manual y automática).

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
  const RATE_LIMITED_ACTIONS = ['publicar', 'cotizar', 'analizar-foto', 'crear-sesion', 'request-magic-link', 'request-magic-link-cliente', 'detalle-cotizacion', 'aceptar'];
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
        from:    'MudateYa <noreply@mudateya.ar>', reply_to:'hola@mudateya.ar',
        to:      emailNorm,
        subject: '🔑 Tu link de acceso a MudateYa',
        html: '<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">' +
          '<div style="background:#003580;padding:28px 32px"><div style="font-size:30px;font-weight:900;color:#fff">Mudate<span style="color:#22C36A">Ya</span></div></div>' +
          '<div style="background:#22C36A;padding:4px"></div>' +
          '<div style="padding:32px">' +
            '<div style="font-size:40px;text-align:center;margin-bottom:12px">🔑</div>' +
            '<h2 style="font-size:26px;color:#003580;margin:0 0 8px;text-align:center">Hola ' + nombre + ',</h2>' +
            '<p style="font-size:17px;color:#475569;text-align:center;margin:0 0 24px;line-height:1.5">Hacé click en el botón para entrar a tu cuenta de MudateYa.<br/>Este link es válido por <b>15 minutos</b> y se puede usar una sola vez.</p>' +
            '<div style="text-align:center;margin:24px 0">' +
              '<a href="' + link + '" style="display:inline-block;background:#22C36A;color:#fff;font-weight:700;font-size:18px;padding:14px 32px;border-radius:10px;text-decoration:none">Ingresar a mi cuenta</a>' +
            '</div>' +
            '<p style="font-size:15px;color:#64748B;text-align:center;margin:20px 0 0;line-height:1.5">Si el botón no funciona, copiá y pegá este link en tu navegador:<br/><span style="font-family:monospace;font-size:14px;word-break:break-all;color:#475569">' + link + '</span></p>' +
            '<div style="margin-top:28px;padding-top:20px;border-top:1px solid #E2E8F0">' +
              '<p style="font-size:14px;color:#94A3B8;text-align:center;margin:0;line-height:1.5">Si vos no pediste este link, podés ignorar este email.<br/>Por seguridad, el link expira en 15 minutos.</p>' +
            '</div>' +
          '</div>' +
          '<div style="background:#F5F7FA;padding:16px 32px;text-align:center;font-size:14px;color:#94A3B8">© MudateYa · <a href="https://mudateya.ar" style="color:#1A6FFF;text-decoration:none">mudateya.ar</a></div>' +
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
        from:    'MudateYa <noreply@mudateya.ar>', reply_to:'hola@mudateya.ar',
        to:      emailNorm,
        subject: '🔑 Tu link para publicar tu mudanza en MudateYa',
        html: '<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">' +
          '<div style="background:#003580;padding:28px 32px"><div style="font-size:30px;font-weight:900;color:#fff">Mudate<span style="color:#22C36A">Ya</span></div></div>' +
          '<div style="background:#22C36A;padding:4px"></div>' +
          '<div style="padding:32px">' +
            '<div style="font-size:40px;text-align:center;margin-bottom:12px">📦</div>' +
            '<h2 style="font-size:26px;color:#003580;margin:0 0 8px;text-align:center">Hola ' + nombreEsc + ',</h2>' +
            '<p style="font-size:17px;color:#475569;text-align:center;margin:0 0 24px;line-height:1.5">Hacé click para volver a MudateYa y completar tu pedido de mudanza.<br/>El link es válido por <b>15 minutos</b> y se puede usar una sola vez.</p>' +
            '<div style="text-align:center;margin:24px 0">' +
              '<a href="' + link + '" style="display:inline-block;background:#22C36A;color:#fff;font-weight:700;font-size:18px;padding:14px 32px;border-radius:10px;text-decoration:none">Ingresar y publicar mi mudanza</a>' +
            '</div>' +
            '<p style="font-size:15px;color:#64748B;text-align:center;margin:20px 0 0;line-height:1.5">Si el botón no funciona, copiá este link:<br/><span style="font-family:monospace;font-size:14px;word-break:break-all;color:#475569">' + link + '</span></p>' +
            '<div style="margin-top:28px;padding-top:20px;border-top:1px solid #E2E8F0">' +
              '<p style="font-size:14px;color:#94A3B8;text-align:center;margin:0;line-height:1.5">Si vos no pediste este link, podés ignorar este email.<br/>Por seguridad, expira en 15 minutos.</p>' +
            '</div>' +
          '</div>' +
          '<div style="background:#F5F7FA;padding:16px 32px;text-align:center;font-size:14px;color:#94A3B8">© MudateYa · <a href="https://mudateya.ar" style="color:#1A6FFF;text-decoration:none">mudateya.ar</a></div>' +
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
    // NOTA: el token NO se borra al usarse. Vive sus 15 min de TTL completos y
    // permite clicks ilimitados durante esa ventana. Esto resuelve un bug con
    // clientes de mail corporativos (Outlook + Microsoft Defender, Mimecast,
    // Proofpoint) que escanean el link antes de entregarlo, consumiéndolo si
    // fuera one-time. Pasados los 15 min Redis lo borra solo por expiración.
    // Trade-off de seguridad: si alguien con acceso al mail clickea dentro de
    // los 15 min, también puede loguearse. Aceptable para mudanceros B2B.

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
      const { clienteEmail, clienteNombre, desde, hasta, ambientes, fecha, servicios, extras, zonaBase, precio_estimado, clienteWA, tipo, pisoOrigen, pisoDestino, ascOrigen, ascDestino, fotos, refAliado, km, nivel, partner, partnerAsesor, partnerPropiedad, detallesAdicionales, tipoOrigen, tipoDestino, deptoOrigen, deptoDestino, horaOrigen, tipoOperacion, urgente } = req.body;
      if (!clienteEmail || !desde || !hasta) return res.status(400).json({ error: 'Faltan datos' });
      // ── LÍMITES ANTI-SPAM ──────────────────────────────────────────────
      // Límite 1: máximo 2 pedidos activos simultáneos por cliente
      const MAX_ACTIVOS_POR_CLIENTE = 10;
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
      const MAX_COT = 50;
      // Vigencia del pedido en HORAS HÁBILES (ver api/_habiles.js):
      // el reloj se pausa los fines de semana y feriados.
      // Urgente (hoy/mañana/1-2 días): mismo criterio que ya usa el bot con
      // clientes directos (crearPedido en whatsapp.js) — 3 horas CORRIDAS en
      // vez de 24hs hábiles, para no mostrarle a los mudanceros un plazo largo
      // mientras el equipo ya lo está resolviendo a mano.
      const urgenteNorm = urgente === true;
      const HORAS_VIGENCIA = 24;

      // km viene calculado desde el frontend (Google Maps lado cliente).
      // Si no llega, queda null — la cotización funciona igual sin el desglose por km.
      const kmDistancia = (typeof km === 'number' && km > 0) ? Math.round(km) : (parseInt(km) > 0 ? parseInt(km) : null);

      // Normalizar nivel: 'esencial' | 'integral' | 'llave' | 'flete' | null
      const NIVELES_VALIDOS = ['esencial','integral','llave','flete'];
      const nivelNorm = (typeof nivel === 'string' && NIVELES_VALIDOS.indexOf(nivel) !== -1)
        ? nivel
        : ((tipo || 'mudanza') === 'flete' ? 'flete' : null);

      // Normalizar partner: aceptamos 'mudafy' (legacy hardcoded) o cualquier slug
      // de inmobiliaria que exista en Redis bajo inmobiliaria:{slug} y esté activa.
      // Estos campos los lee el admin (badge "Vía Mudafy") y los templates de mail.
      let partnerNorm = null;
      let comisionInmobiliariaPct = 0;
      // Slug tal como llegó, SIN validar contra Redis. partnerNorm se descarta
      // cuando la inmobiliaria no está registrada, y con él se perdía la única
      // evidencia de que la mudanza vino de un canal: quedaba indistinguible de
      // una orgánica y se facturaba al 15%. Este campo es solo trazabilidad.
      const partnerSlugCrudo = (typeof partner === 'string' && partner.trim())
        ? partner.trim().toLowerCase().slice(0, 60) : '';
      if (typeof partner === 'string' && partner.length > 0 && partner.length < 60) {
        const partnerLower = partner.toLowerCase();
        // Whitelist legacy: mudafy queda hardcoded para no romper su flujo actual.
        if (partnerLower === 'mudafy') {
          partnerNorm = 'mudafy';
        } else if (/^[a-z0-9-]+$/.test(partnerLower)) {
          // Slug válido → buscar en Redis si es una inmobiliaria activa
          try {
            const inmoCfg = await getJSON('inmobiliaria:' + partnerLower);
            if (inmoCfg && inmoCfg.activa !== false) {
              partnerNorm = partnerLower;
              comisionInmobiliariaPct = parseFloat(inmoCfg.comisionInmobiliaria) || 0;
            } else {
              // El slug llegó pero no está configurado. La mudanza IGUAL es de
              // canal (ver origenCanal abajo); lo único que no se puede calcular
              // es cuánto pagarle a la inmobiliaria, porque ese % no existe.
              console.warn('[partner] slug no registrado o inactivo:', partnerLower,
                           '— la mudanza se marca como de canal igual, pero sin comisión a la inmobiliaria');
            }
          } catch(e) {
            console.warn('No se pudo verificar inmobiliaria:', partnerLower, e.message);
          }
        }
      }

      // ── Origen de canal ────────────────────────────────────────────────
      // La comisión de MudateYa es 25% para TODA mudanza que llega por un canal
      // (inmobiliaria, asesor, aliado) y 15%/20% solo para las orgánicas.
      //
      // Este flag NO depende de que el slug esté registrado en Redis. Antes el
      // 25% se deducía de `partner`, que se descartaba si la inmobiliaria no
      // estaba cargada: una mudanza de RE/MAX con el slug mal escrito se
      // facturaba al 15% sin que nadie se enterara.
      // OJO: origenAsesor NO se destructura arriba (no lo manda el cliente, lo
      // setea asesores.js en su propio flujo). Se lee de req.body directamente:
      // referenciarlo como variable suelta tira ReferenceError y rompe TODA la
      // publicación desde canal.
      const origenCanal = !!(
        (typeof partner === 'string' && partner.trim()) ||
        (typeof partnerAsesor === 'string' && partnerAsesor.trim()) ||
        refAliado || req.body.origenAsesor === true
      );
      const partnerAsesorNorm    = (typeof partnerAsesor === 'string' && partnerAsesor.length < 100) ? partnerAsesor : '';
      const partnerPropiedadNorm = (typeof partnerPropiedad === 'string' && partnerPropiedad.length < 100) ? partnerPropiedad : '';
      // Tipo de operación inmobiliaria que originó la mudanza. Solo interno (NO va al PDF).
      // Define el régimen: 'compraventa' → sin comisión de referido + regalo especial al cliente;
      // 'alquiler' → con comisión de referido. La lógica de comisión/regalo se aplica aparte.
      const tipoOperacionNorm = (tipoOperacion === 'alquiler' || tipoOperacion === 'compraventa') ? tipoOperacion : '';

      // Sanitizar detalles del cliente. Modelo nuevo:
      //   detallesAdicionales = { detallesOrigen, detallesDestino, comentario, fotos }
      // Compat con modelo viejo (pedidos previos al cambio de mayo/2026):
      //   detallesAdicionales = { ascensor, izaje, ..., comentario, fotos } (flags planos)
      // Si reconocemos el modelo nuevo, los lados se guardan como detallesOrigen y detallesDestino
      // top-level en la mudanza, y detallesAdicionales queda con solo {comentario, fotos}.
      const FLAGS = ['ascensor','izaje','soga','balconTerraza','pasilloAngosto','escaleras','cocheraGarage','estDificil','mascotaEspecial'];

      function _sanitizarLado(src) {
        if (!src || typeof src !== 'object') return null;
        const out = {};
        FLAGS.forEach(function(k) { if (src[k] === true) out[k] = true; });
        if (src.escalerasPisos) {
          const p = parseInt(src.escalerasPisos);
          if (p > 0 && p <= 20) out.escalerasPisos = p;
        }
        return Object.keys(out).length > 0 ? out : null;
      }

      let detallesOrigenNorm  = null;
      let detallesDestinoNorm = null;
      let detallesNorm = null; // solo comentario + fotos (compartido)
      if (detallesAdicionales && typeof detallesAdicionales === 'object') {
        const tieneModeloNuevo = !!(detallesAdicionales.detallesOrigen || detallesAdicionales.detallesDestino);
        if (tieneModeloNuevo) {
          // Modelo nuevo: lados separados
          detallesOrigenNorm  = _sanitizarLado(detallesAdicionales.detallesOrigen);
          detallesDestinoNorm = _sanitizarLado(detallesAdicionales.detallesDestino);
          // Compartido: solo comentario + fotos
          const tmp = {};
          if (typeof detallesAdicionales.comentario === 'string') {
            const c = sinContacto(detallesAdicionales.comentario.trim().slice(0, 500));
            if (c.length) tmp.comentario = c;
          }
          if (Array.isArray(detallesAdicionales.fotos)) {
            const fs = detallesAdicionales.fotos
              .filter(function(u) { return typeof u === 'string' && u.startsWith('http') && u.length < 600; })
              .slice(0, 5);
            if (fs.length) tmp.fotos = fs;
          }
          if (Object.keys(tmp).length > 0) detallesNorm = tmp;
        } else {
          // Modelo viejo: flags planos + comentario + fotos. Lo guardamos tal cual en detallesAdicionales.
          const tmp = {};
          FLAGS.forEach(function(k) { if (detallesAdicionales[k] === true) tmp[k] = true; });
          if (detallesAdicionales.escalerasPisos) {
            const p = parseInt(detallesAdicionales.escalerasPisos);
            if (p > 0 && p <= 20) tmp.escalerasPisos = p;
          }
          if (typeof detallesAdicionales.comentario === 'string') {
            const c = sinContacto(detallesAdicionales.comentario.trim().slice(0, 500));
            if (c.length) tmp.comentario = c;
          }
          if (Array.isArray(detallesAdicionales.fotos)) {
            const fs = detallesAdicionales.fotos
              .filter(function(u) { return typeof u === 'string' && u.startsWith('http') && u.length < 600; })
              .slice(0, 5);
            if (fs.length) tmp.fotos = fs;
          }
          if (Object.keys(tmp).length > 0) detallesNorm = tmp;
        }
      }

      // Sanitizar tipo de lugar (casa/depto) y depto opcional.
      // Estos campos vienen del modal de detalles (obligatorios) o del form principal Mudafy.
      const TIPOS_VALIDOS = ['casa', 'departamento'];
      const tipoOrigenNorm  = (typeof tipoOrigen  === 'string' && TIPOS_VALIDOS.indexOf(tipoOrigen)  !== -1) ? tipoOrigen  : null;
      const tipoDestinoNorm = (typeof tipoDestino === 'string' && TIPOS_VALIDOS.indexOf(tipoDestino) !== -1) ? tipoDestino : null;
      const deptoOrigenNorm  = (typeof deptoOrigen  === 'string' && deptoOrigen.length  <= 20) ? deptoOrigen.trim()  : '';
      const deptoDestinoNorm = (typeof deptoDestino === 'string' && deptoDestino.length <= 20) ? deptoDestino.trim() : '';
      // Piso solo se acepta si el tipo es departamento; si es casa lo vaciamos para coherencia.
      const pisoOrigenNorm  = (tipoOrigenNorm  === 'departamento' && typeof pisoOrigen  === 'string') ? pisoOrigen.trim().slice(0,10)  : (tipoOrigenNorm  === 'casa' ? '' : (pisoOrigen  || ''));
      const pisoDestinoNorm = (tipoDestinoNorm === 'departamento' && typeof pisoDestino === 'string') ? pisoDestino.trim().slice(0,10) : (tipoDestinoNorm === 'casa' ? '' : (pisoDestino || ''));

      // Hora aproximada de inicio (solo origen). Aceptamos formato "HH:MM" 24h.
      // Si no llega o es inválida, queda vacío — el campo es opcional.
      let horaOrigenNorm = '';
      if (typeof horaOrigen === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(horaOrigen.trim())) {
        horaOrigenNorm = horaOrigen.trim();
      }

      const mudanza = { id, clienteEmail, clienteNombre, clienteWA: clienteWA||'', desde, hasta, ambientes, fecha, servicios, extras, zonaBase, precio_estimado, tipo: tipo||'mudanza', nivel: nivelNorm, tipoOrigen: tipoOrigenNorm, tipoDestino: tipoDestinoNorm, pisoOrigen: pisoOrigenNorm, pisoDestino: pisoDestinoNorm, deptoOrigen: deptoOrigenNorm, deptoDestino: deptoDestinoNorm, horaOrigen: horaOrigenNorm, urgente: urgenteNorm, ascOrigen, ascDestino, fotos: fotos||[], km: kmDistancia, estado: 'buscando', modoCotizacion: modo, maxCotizaciones: MAX_COT, mudancerosInvitados: mudancerosInvitados||[], refAliado: refAliado || null, partner: partnerNorm, partnerAsesor: partnerAsesorNorm, partnerPropiedad: partnerPropiedadNorm, tipoOperacion: tipoOperacionNorm, comisionInmobiliariaPct: comisionInmobiliariaPct, comisionInmobiliariaPagar: 0, comisionInmobiliariaLiquidada: false, detallesOrigen: detallesOrigenNorm, detallesDestino: detallesDestinoNorm, detallesAdicionales: detallesNorm, fechaPublicacion: new Date().toISOString(), expira: urgenteNorm ? new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString() : vencimientoHabilISO(HORAS_VIGENCIA), cotizaciones: [] };
      mudanza.origenCanal = origenCanal;
      // Se guarda solo si difiere del validado: si partnerNorm quedó null pero
      // el cliente llegó por /inmobiliaria/{slug}, acá queda cuál era.
      if (partnerSlugCrudo && partnerSlugCrudo !== partnerNorm) {
        mudanza.partnerSlugCrudo = partnerSlugCrudo;
      }
      await setJSON(`mudanza:${id}`, mudanza, 604800);
      // Aviso al asesor que derivo al cliente. Va despues de guardar: si el
      // mail falla, el pedido ya quedo publicado igual.
      if (mudanza.partnerAsesor) {
        try { await notificarAsesorPedidoPublicado(mudanza); }
        catch(e) { console.warn('Email asesor publicado:', e.message); }
        // Índice inverso {prefijo}:asesor:{codigo}:mudanzas — para que Emi
        // (WhatsApp) pueda listar los pedidos referidos de un asesor sin
        // escanear mudanzas:todos. Se resuelve el canal igual que el mail de
        // arriba (resolverAsesor prueba el canal declarado y, si no está, los
        // 4 conocidos) para no indexar bajo un prefijo equivocado.
        try {
          const a = await resolverAsesor(mudanza);
          if (a && CLAVES_ASESOR[a.canal]) {
            const idxKey = `${CLAVES_ASESOR[a.canal]}${mudanza.partnerAsesor}:mudanzas`;
            const idxAsesor = await getJSON(idxKey) || [];
            if (!idxAsesor.includes(id)) {
              idxAsesor.push(id);
              await setJSON(idxKey, idxAsesor);
            }
          }
        } catch(e) { console.warn('Índice mudanzas asesor:', e.message); }
      }
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
      // Índice teléfono→email (últimos 8 dígitos, mismo criterio que mudanceros)
      // para que el bot pueda encontrar este pedido cuando el cliente responda
      // algo por WhatsApp (ajuste de precio, calificación) aunque haya cargado
      // el pedido por la web, no por el bot.
      if (clienteWA) {
        try {
          const _tel8 = String(clienteWA).replace(/\D/g, '').slice(-8);
          if (_tel8.length === 8) await redisCall('HSET', 'clientes:tel8-idx', _tel8, clienteEmail);
        } catch (e) { console.warn('Índice clientes:tel8-idx:', e.message); }
      }
      try { await notificarMudanceros(mudanza); } catch(e) { console.error(e.message); }
      // Mail de confirmación al cliente con resumen del pedido
      try { await notificarClienteNuevoPedido(mudanza); } catch(e) { console.error('Email cliente confirmación:', e.message); }
      // WhatsApp de confirmación (cliente de la web con WA cargado) — además de
      // avisarle, esta es la PRIMERA plantilla que le llega, así que "abre" la
      // conversación de WhatsApp para que los avisos siguientes entren en la
      // ventana de 24hs. Sin fallback de texto libre a propósito: es plantilla
      // nueva (pedido_recibido_cliente), gated hasta que Meta la apruebe — no
      // manda nada mientras tanto (mismo patrón ya usado para otras plantillas).
      if (clienteWA) {
        try {
          const { enviarPlantilla } = require('./_plantillas');
          const nomCli = (clienteNombre || '').split(' ')[0] || 'Hola';
          await enviarPlantilla(clienteWA, 'pedido_recibido_cliente', { 1: nomCli, 2: tipo || 'mudanza', 3: desde, 4: hasta });
        } catch (e) { console.warn('WhatsApp confirmación pedido (web):', e.message); }
      }
      // ── Hook aliados: crear atribución si el cliente vino por un link de aliado ──
      if (refAliado) {
        try { await hookCrearAtribucion(id, refAliado, tipo || 'mudanza'); } catch(e) { console.warn('Hook aliado publicar:', e.message); }
      }
      return res.status(200).json({ ok: true, id, mudanza });
    }

    if (action === 'cotizar' && req.method === 'POST') {
      const { mudanzaId, mudanceroEmail, mudanceroNombre, mudanceroTel, precio, nota, tiempoEstimado, propuestas,
              modalidad, horasIncluidas, valorHoraAdicional } = req.body;
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
            tiempoEstimado: sinContacto(p.tiempoEstimado || ''),
            nota: sinContacto(p.nota || '')
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
            tiempoEstimado: sinContacto(tiempoEstimado || ''),
            nota: sinContacto(nota || '')
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
        estado: 'pendiente',
        // Modalidad de cobro. Con 'hora', las condiciones de horas extra quedan
        // pactadas en el presupuesto que acepta el cliente: si el trabajo se
        // estira no hace falta un ajuste de precio (que ante rechazo cancela la
        // mudanza y reembolsa el anticipo).
        modalidad:          modalidad === 'hora' ? 'hora' : 'cerrado',
        horasIncluidas:     parseInt(horasIncluidas) || 0,
        valorHoraAdicional: parseInt(valorHoraAdicional) || 0
      };
      mudanza.cotizaciones.push(cotizacion);

      // Cierre automatico deshabilitado para testing.
      // TTL de 7 días (igual que al publicar): antes se re-guardaba con 2 días,
      // lo que hacía DESAPARECER el pedido (con sus cotizaciones) antes de tiempo.
      await setJSON(`mudanza:${mudanzaId}`, mudanza, 604800);
      const mudIdx = await getJSON(`mudancero:${mudanceroEmail}`) || [];
      if (!mudIdx.includes(mudanzaId)) mudIdx.push(mudanzaId);
      await setJSON(`mudancero:${mudanceroEmail}`, mudIdx, 2592000);
      // Señal de actividad del mudancero: cotizar cuenta como "entró". Lo usa
      // cron-recordar-perfil para NO marcarlo "dormido" si sigue trabajando.
      try {
        const _pm = await getJSON(`mudancero:perfil:${mudanceroEmail}`);
        if (_pm) { _pm.ultimaActividad = new Date().toISOString(); await setJSON(`mudancero:perfil:${mudanceroEmail}`, _pm); }
      } catch(_) {}
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

      // El PDF es un comprobante: se puede descargar siempre, en cualquier
      // estado de la mudanza. No lleva validaciones de vigencia ni de estado.

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
        validoHasta:       fmtValidezAR(cot, mudanza),
        modalidad:         cot.modalidad || 'cerrado',
        horasIncluidas:    cot.horasIncluidas || 0,
        valorHoraAdicional: cot.valorHoraAdicional || 0,
        fechaEmision:      new Date().toLocaleDateString('es-AR', { day:'numeric', month:'long', year:'numeric', timeZone:'America/Argentina/Buenos_Aires' }),
        clienteNombre:     mudanza.clienteNombre,
        clienteEmail:      mudanza.clienteEmail,
        mudanceroNombre:   cot.mudanceroNombre,
        mudancero_initials:(cot.mudanceroNombre||'MV').slice(0,2).toUpperCase(),
        desde:             mudanza.desde,
        hasta:             mudanza.hasta,
        km:                mudanza.km,
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

    // PDF "Detalles del pedido" para el mudancero/fletero (sin datos de contacto
    // del cliente). Público (Twilio lo baja como adjunto de WhatsApp), igual que
    // el PDF de cotización.
    if (action === 'pedido-pdf' && req.method === 'GET') {
      const { mudanzaId } = req.query;
      if (!mudanzaId) return res.status(400).json({ error: 'Falta mudanzaId' });
      const mudanza = await getJSON(`mudanza:${mudanzaId}`);
      if (!mudanza) return res.status(404).json({ error: 'Pedido no encontrado' });
      const pdfBase64 = await generarPDFDetallesBase64(mudanza);
      if (!pdfBase64) return res.status(404).json({ error: 'Sin datos para el PDF' });
      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="pedido-${mudanzaId}.pdf"`);
      res.setHeader('Content-Length', pdfBuffer.length);
      return res.status(200).end(pdfBuffer);
    }

    // Detalle público y mínimo de UNA cotización puntual, para la página de
    // confirmación /elegir (link "Elegir y pagar" del mail de vencimiento).
    // Mismo modelo de confianza que /pagar/:id (api/pagar.js): mudanzaId +
    // cotizacionId ya funcionan como bearer implícito en este código — no se
    // agrega una capa de auth nueva, solo se acota lo que se expone (nada de
    // otras cotizaciones, ni datos del cliente).
    if (action === 'detalle-cotizacion' && req.method === 'GET') {
      const { mudanzaId, cotizacionId } = req.query;
      if (!mudanzaId || !cotizacionId) return res.status(400).json({ error: 'Faltan datos' });
      const mudanza = await getJSON(`mudanza:${mudanzaId}`);
      if (!mudanza) return res.status(404).json({ error: 'Pedido no encontrado' });
      const cot = (mudanza.cotizaciones || []).find(c => c.id === cotizacionId);
      if (!cot) return res.status(404).json({ error: 'Presupuesto no encontrado' });
      const yaAceptada = ['cotizacion_aceptada', 'en_curso', 'completada'].includes(mudanza.estado);
      const vencida = cotizacionVencida(cot, mudanza);
      return res.status(200).json({
        ok: true,
        mudanceroNombre: cot.mudanceroNombre || 'Mudancero',
        precio: cot.precio || 0,
        tiempoEstimado: cot.tiempoEstimado || '',
        nota: cot.nota || '',
        desde: mudanza.desde || '',
        hasta: mudanza.hasta || '',
        tipo: mudanza.tipo || 'mudanza',
        yaAceptada,
        esLaElegida: yaAceptada && !!mudanza.cotizacionAceptada && mudanza.cotizacionAceptada.id === cot.id,
        vencida,
        puedeElegir: !yaAceptada && !vencida && ESTADOS_ACEPTABLES.includes(mudanza.estado),
      });
    }

    if (action === 'aceptar' && req.method === 'POST') {
      const { mudanzaId, cotizacionId, propuestaNivel } = req.body;
      // Lock: evita doble aceptación concurrente (doble email + doble link de pago).
      if (mudanzaId && !(await adquirirLock(`lock:aceptar:${mudanzaId}`, 25))) {
        return res.status(409).json({ error: 'Se está procesando una aceptación para este pedido. Probá de nuevo en unos segundos.' });
      }
      const mudanza = await getJSON(`mudanza:${mudanzaId}`);
      if (!mudanza) return res.status(404).json({ error: 'Mudanza no encontrada' });
      const cot = mudanza.cotizaciones.find(c => c.id === cotizacionId);
      if (!cot) return res.status(404).json({ error: 'Cotización no encontrada' });

      // ── La mudanza tiene que seguir abierta ──────────────────────────
      // Sin esto se puede aceptar una segunda cotización sobre una mudanza
      // ya adjudicada, pisando cotizacionAceptada/montoTotal cuando el
      // anticipo del primer mudancero ya se cobró.
      // OJO: 'vencido_con_cotizaciones' SÍ se puede aceptar — las 24hs son
      // solo la ventana para RECIBIR cotizaciones nuevas; cada cotización ya
      // recibida sigue siendo válida por DIAS_VALIDEZ_COTIZACION (7 días
      // corridos, chequeado abajo con cotizacionVencida). Sin esto, un
      // cliente que tardó más de 24hs en elegir quedaba bloqueado aunque el
      // presupuesto que quería aceptar todavía estuviera vigente.
      if (mudanza.estado && ESTADOS_ACEPTABLES.indexOf(mudanza.estado) === -1) {
        return res.status(409).json({
          error: 'Esta mudanza ya no está abierta para aceptar cotizaciones.',
          estado: mudanza.estado
        });
      }

      // ── El presupuesto tiene que estar vigente ───────────────────────
      if (cotizacionVencida(cot, mudanza)) {
        return res.status(410).json({
          error: 'Este presupuesto venció. Los presupuestos tienen una validez de ' +
                 DIAS_VALIDEZ_COTIZACION + ' días. Podés volver a publicar el pedido para recibir precios actualizados.',
          vencida: true,
          vencioEl: fmtValidezAR(cot, mudanza)
        });
      }

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

      // Calcular comisión que MudateYa le debe a la inmobiliaria por el viaje cerrado.
      // El % se fijó al publicar el pedido (snapshot en mudanza.comisionInmobiliariaPct)
      // para que cambios futuros en la config de la inmo no afecten viajes ya cerrados.
      // El monto a pagar se calcula sobre el precio final aceptado.
      // RÉGIMEN por tipo de operación: en COMPRAVENTA la inmobiliaria ya cobró su
      // comisión de venta, así que MudateYa NO paga comisión de referido (queda en $0
      // y el cliente recibe un regalo especial aparte). En ALQUILER sí se paga.
      // Se paga a TODA operación de canal, no solo a las que tienen la
      // inmobiliaria cargada en Redis: si el slug no estaba registrado el monto
      // quedaba en cero y el asesor no aparecía como acreedor en ningún lado.
      // El % de la config manda si existe; si no, rige el default del canal.
      const _esCanalAsesor = !!(mudanza.partner || mudanza.partnerSlugCrudo || mudanza.partnerAsesor);
      if (_esCanalAsesor && mudanza.tipoOperacion !== 'compraventa') {
        const precioFinal = parseFloat(cot.precio) || 0;
        const pctCfg = parseFloat(mudanza.comisionInmobiliariaPct);
        const pct = pctCfg > 0 ? pctCfg : COMISION_ASESOR_DEFAULT;
        mudanza.comisionInmobiliariaPct = pct;   // snapshot efectivo
        mudanza.comisionInmobiliariaPagar = Math.round(precioFinal * pct / 100);
      } else if (mudanza.tipoOperacion === 'compraventa') {
        // En compraventa no hay comisión: el cliente recibe el regalo.
        mudanza.comisionInmobiliariaPagar = 0;
      }

      await setJSON(`mudanza:${mudanzaId}`, mudanza, 604800);
      try { await enviarEmailAceptacion(mudanza, cot); } catch(e) { console.error('Error email:', e.message); }
      // Avisar a los OTROS mudanceros que cotizaron que el cliente eligió a otro.
      try { await notificarMudancerosNoElegidos(mudanza, cot.mudanceroEmail); } catch(e) { console.warn('Aviso no-elegidos:', e.message); }
      // Gate de contacto: al aceptar todavía no hay anticipo pagado, así que
      // la respuesta sale sin el teléfono del mudancero.
      const mudanzaSegura = sanitizarParaCliente(mudanza);
      const cotSegura = (mudanzaSegura.cotizaciones || []).find(c => c.id === cot.id) || mudanzaSegura.cotizacionAceptada;
      return res.status(200).json({ ok: true, mudanza: mudanzaSegura, cotizacion: cotSegura });
    }

    // Avisa a los mudanceros NO elegidos. Idempotente y solo sobre un pedido ya
    // adjudicado (no se puede abusar para spamear). Lo usa el bot cuando el
    // cliente acepta por WhatsApp (el aceptar del web ya lo hace inline).
    if (action === 'avisar-no-elegidos' && req.method === 'POST') {
      const { mudanzaId } = req.body || {};
      if (!mudanzaId) return res.status(400).json({ error: 'Falta mudanzaId' });
      const m = await getJSON(`mudanza:${mudanzaId}`);
      if (!m) return res.status(404).json({ error: 'No encontrada' });
      if (m.estado !== 'cotizacion_aceptada') return res.status(200).json({ ok: false, motivo: 'no_adjudicada' });
      if (m.avisoNoElegidosEnviado) return res.status(200).json({ ok: true, yaEnviado: true });
      const ganador = m.mudanceroAceptado || (m.cotizacionAceptada && m.cotizacionAceptada.mudanceroEmail);
      await notificarMudancerosNoElegidos(m, ganador);
      m.avisoNoElegidosEnviado = true;
      await setJSON(`mudanza:${mudanzaId}`, m, 604800);
      return res.status(200).json({ ok: true });
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
            // Gate de contacto: mudanceroTel solo con anticipo pagado
            if (m && m.estado !== 'eliminada') mudanzas.push(sanitizarParaCliente(m));
          } catch(e) {}
        }
        return res.status(200).json({ mudanzas });
      } catch(e) { return res.status(200).json({ mudanzas: [] }); }
    }

    // Registrar pago realizado (anticipo o saldo) — llamado desde pago-exitoso
    if (action === 'registrar-pago' && req.method === 'POST') {
      const { mudanzaId, tipoPago, mpPaymentId } = req.body;
      if (!mudanzaId || !tipoPago) return res.status(400).json({ error: 'Faltan datos' });
      // Lock: mismo key que el webhook de MP → no se acredita el mismo pago dos veces
      // aunque el webhook y la página de éxito lleguen a la vez.
      if (!(await adquirirLock(`lock:pago:${mudanzaId}:${tipoPago}`, 25))) {
        return res.status(200).json({ status: 'en_proceso' });
      }
      const m = await getJSON(`mudanza:${mudanzaId}`);
      if (!m) return res.status(404).json({ error: 'No encontrada' });

      // AUTORIZACIÓN según el origen del llamado:
      //  - CON mpPaymentId (flujo pago-exitoso del cliente): la autorización ES la
      //    verificación del pago contra Mercado Pago. No alcanza un secreto: el pago
      //    debe existir, estar aprobado, corresponder a ESTA mudanza/tramo y cubrir el
      //    monto esperado. Así el endpoint es seguro aunque el secreto se filtre.
      //  - SIN mpPaymentId (server-to-server; transferencias ya verificó contra Talo):
      //    exige el secreto interno fuerte (INTERNAL_API_SECRET, solo del servidor).
      let montoRealMP = null;
      if (mpPaymentId) {
        if (!process.env.MP_ACCESS_TOKEN) return res.status(500).json({ error: 'MP no configurado' });
        let mpData;
        try {
          const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(mpPaymentId)}`, {
            headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` }
          });
          mpData = await mpRes.json();
        } catch (mpErr) {
          console.warn('No se pudo verificar pago MP:', mpErr.message);
          return res.status(502).json({ error: 'No se pudo verificar el pago' });
        }
        if (!mpData || mpData.status !== 'approved') {
          return res.status(400).json({ error: 'Pago de MP no aprobado' });
        }
        // El pago tiene que corresponder a ESTA mudanza y tramo.
        const metaMud  = mpData.metadata && (mpData.metadata.mudanzaId || mpData.metadata.mudanza_id);
        const metaTipo = mpData.metadata && (mpData.metadata.tipoPago || mpData.metadata.tipo_pago);
        const ref = String(mpData.external_reference || '');
        const correspondeMeta = String(metaMud || '') === String(mudanzaId) && String(metaTipo || '') === String(tipoPago);
        const correspondeRef  = ref.indexOf(String(mudanzaId)) === 0;
        if (!correspondeMeta && !correspondeRef) {
          return res.status(400).json({ error: 'El pago no corresponde a este pedido' });
        }
        montoRealMP = Math.round(Number(mpData.transaction_amount) || 0);
        // Validar que cubre lo esperado (evita liberar el tramo pagando de menos).
        const cotE = m.cotizacionAceptada || {};
        const totalE = parseInt(cotE.precio || m.montoTotal || 0) || 0;
        let esperado = 0;
        if (totalE) {
          esperado = tipoPago === 'anticipo'
            ? Math.round(totalE * 0.5)
            : Math.max(0, totalE - (parseInt(m.anticipoMonto || Math.round(totalE * 0.5)) || 0));
        }
        if (esperado && montoRealMP < Math.round(esperado * 0.99)) {
          return res.status(400).json({ error: 'Monto insuficiente' });
        }
        if (tipoPago === 'anticipo') m.mpAnticipoPagoId = mpPaymentId;
        if (tipoPago === 'saldo')    m.mpSaldoPagoId = mpPaymentId;
      } else {
        const internalSecret = req.headers['x-internal-secret'];
        const validSecret = process.env.INTERNAL_API_SECRET;
        if (!validSecret || internalSecret !== validSecret) {
          return res.status(403).json({ error: 'Sin autorización para registrar pagos' });
        }
      }
      if (tipoPago === 'anticipo') {
        m.anticipoPagado = true;
        // Fecha en que se confirmó el pago del anticipo (para calcular liquidación al mudancero: 15 días hábiles)
        if (!m.fechaPagoAnticipo) m.fechaPagoAnticipo = new Date().toISOString();
        // Guardar el monto REAL del anticipo cobrado por MP (fuente de verdad).
        // Si MP no respondió, fallback al 50% del precio (compat).
        if (montoRealMP) {
          m.anticipoMonto = montoRealMP;
        } else if (!m.anticipoMonto) {
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
        // Guardar el monto REAL del saldo cobrado por MP.
        //
        // El fallback NO es el 50% del precio: si hubo un ajuste, el saldo es
        // el precio final MENOS el anticipo que ya se cobró. Ej: se acepta en
        // 1.000.000, se paga 500.000 de anticipo, se ajusta a 1.200.000 → el
        // saldo es 700.000, no 600.000.
        //
        // Sin este fallback, los pagos por transferencia (que no traen
        // montoRealMP) dejaban saldoMonto vacío y la liquidación al mudancero
        // se calculaba sobre un importe inventado.
        if (montoRealMP) {
          m.saldoMonto = montoRealMP;
        } else if (!m.saldoMonto) {
          const cotS = m.cotizacionAceptada || {};
          const precioS = parseInt(cotS.precio || m.montoTotal || 0) || 0;
          const antS = parseInt(m.anticipoMonto || 0) || 0;
          m.saldoMonto = Math.max(0, precioS - antS);
        }
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
      // Cierre para el asesor: comision si fue alquiler, regalo si compraventa.
      if (tipoPago === 'saldo' && m.partnerAsesor) {
        try { await notificarAsesorMudanzaCompletada(m); }
        catch(e) { console.warn('Email asesor completada:', e.message); }
      }
      if (tipoPago === 'anticipo') {
        try { await notificarClienteAnticipoPagado(m); } catch(e) { console.warn('Email cliente anticipo error:', e.message); }
        // Aviso por WhatsApp: cliente (reservada) + mudancero elegido (ganó). Solo
        // avisa al cliente si el pedido vino por WhatsApp; al mudancero por su tel.
        try { const { avisarSenaConfirmada } = require('./_whatsapp'); await avisarSenaConfirmada(m); }
        catch(e) { console.warn('WhatsApp seña error:', e.message); }
        if (m.partnerAsesor) {
          try { await notificarAsesorAnticipoPagado(m); }
          catch(e) { console.warn('Email asesor anticipo:', e.message); }
        }
      }
      if (tipoPago === 'saldo') {
        // Saldo acreditado → mudanza 100% paga: avisar al cliente + invitar a calificar.
        try { const { avisarMudanzaPagadaCompleta } = require('./_whatsapp'); await avisarMudanzaPagadaCompleta(m); }
        catch(e) { console.warn('WhatsApp saldo completa error:', e.message); }
      }
      return res.status(200).json({ ok: true });
    }

    // ── REENVIAR AVISO DE SEÑA POR WHATSAPP (admin) ─────────────────
    // Dispara a mano avisarSenaConfirmada para una mudanza (o para el último
    // pedido pagado de un WhatsApp). Útil si la seña se confirmó pero el aviso
    // no salió. Devuelve diagnóstico (canal, clienteWA, mudanceroTel).
    if (action === 'reenviar-aviso-sena' && req.method === 'POST') {
      if (!esAdmin(req)) return res.status(403).json({ error: 'No autorizado' });
      let { mudanzaId, waId } = req.body || {};
      let m = null;
      if (mudanzaId) {
        m = await getJSON(`mudanza:${mudanzaId}`);
      } else if (waId) {
        const ids = (await getJSON(`cliente:pedidos:${waId}`)) || [];
        for (const id of ids.slice().reverse()) {
          const p = await getJSON(`mudanza:${id}`);
          if (p && p.anticipoPagado) { m = p; break; }
        }
      }
      if (!m) return res.status(404).json({ error: 'No encontré la mudanza (pasá mudanzaId o waId)' });
      const cot = m.cotizacionAceptada || {};
      const diag = {
        mudanzaId: m.id, canal: m.canal || null, clienteWA: m.clienteWA || null,
        mudanceroTel: cot.mudanceroTel || null, anticipoPagado: !!m.anticipoPagado,
      };
      try {
        const { avisarSenaConfirmada } = require('./_whatsapp');
        await avisarSenaConfirmada(m);
      } catch (e) {
        return res.status(200).json({ ok: false, error: e.message, diag });
      }
      return res.status(200).json({ ok: true, enviado: true, diag });
    }

    // ── LIQUIDAR HORAS (solo cotizaciones por hora) ─────────────────
    //
    // No es un ajuste de precio: es aplicar la tarifa que el cliente ya aceptó
    // en el presupuesto. Por eso no se rechaza. Lo que sí se hace es evitar que
    // sea la palabra del mudancero: las horas las calcula el sistema entre
    // fechaInicio y el momento de completar, y el mudancero solo CONFIRMA.
    //
    // Puede bajar el número (si tardó menos, o si se olvidó de marcar "en curso"
    // a tiempo), nunca subirlo por encima de lo que registró el sistema.
    if (action === 'liquidar-horas' && req.method === 'POST') {
      const { mudanzaId, mudanceroEmail, horasConfirmadas } = req.body;
      if (!mudanzaId || !mudanceroEmail) return res.status(400).json({ error: 'Datos inválidos' });

      const m = await getJSON(`mudanza:${mudanzaId}`);
      if (!m) return res.status(404).json({ error: 'Mudanza no encontrada' });
      const cot = m.cotizacionAceptada;
      if (!cot || cot.mudanceroEmail !== mudanceroEmail) return res.status(403).json({ error: 'Sin permiso' });
      if (cot.modalidad !== 'hora' || !cot.valorHoraAdicional) {
        return res.status(400).json({ error: 'Esta cotización no es por hora' });
      }
      if (!m.anticipoPagado) return res.status(400).json({ error: 'Todavía no está pago el anticipo' });
      if (m.saldoPagado)     return res.status(400).json({ error: 'La mudanza ya está pagada completamente' });
      if (m.horasLiquidadas) return res.status(400).json({ error: 'Las horas de esta mudanza ya se liquidaron' });
      if (!m.fechaInicio)    return res.status(400).json({ error: 'Falta marcar la mudanza como iniciada' });

      // Horas registradas por el sistema, redondeadas a media hora.
      const ms = Date.now() - new Date(m.fechaInicio).getTime();
      const horasSistema = Math.max(0, Math.round((ms / 3600000) * 2) / 2);

      // El mudancero puede declarar mas o menos que lo que registro el sistema:
      // puede haber marcado "en curso" tarde, o haber arrancado sin marcar. Se
      // guardan LAS DOS cifras y la diferencia, que es lo que permite auditar
      // despues. Bloquear generaba mas friccion que proteccion.
      let horas = parseFloat(horasConfirmadas);
      if (isNaN(horas) || horas <= 0) horas = horasSistema;
      if (horas > 24) return res.status(400).json({ error: 'Revisá las horas: más de 24 en una mudanza no parece correcto.' });

      const diferencia = Math.round((horas - horasSistema) * 10) / 10;
      // Umbral de revision: hasta 1 hora de diferencia es normal (se marco tarde
      // el inicio o el fin). Por encima de eso queda marcado para que lo mires.
      const requiereRevision = diferencia > 1;

      const incluidas = parseInt(cot.horasIncluidas) || 0;
      const tarifa    = parseInt(cot.valorHoraAdicional) || 0;
      const extra     = Math.max(0, horas - incluidas);
      const cargo     = Math.round(extra * tarifa);

      const precioBase = parseInt(cot.precio || m.montoTotal || 0) || 0;
      const precioNuevo = precioBase + cargo;

      m.horasLiquidadas = {
        horasSistema:  horasSistema,
        horasCobradas: horas,
        diferencia:      diferencia,
        requiereRevision: requiereRevision,
        horasIncluidas: incluidas,
        horasExtra:    extra,
        tarifa:        tarifa,
        cargo:         cargo,
        precioAnterior: precioBase,
        precioFinal:   precioNuevo,
        liquidadoEn:   new Date().toISOString()
      };

      // Se aplica sobre las MISMAS claves que usa el ajuste de precio, para que
      // el saldo, la liquidación al mudancero y el panel lean un solo número.
      if (cargo > 0) {
        m.cotizacionAceptada.precio = precioNuevo;
        m.montoTotal = precioNuevo;
        if ((m.partner || m.partnerSlugCrudo || m.partnerAsesor) && m.tipoOperacion !== 'compraventa') {
          const _pctH = parseFloat(m.comisionInmobiliariaPct) > 0 ? parseFloat(m.comisionInmobiliariaPct) : COMISION_ASESOR_DEFAULT;
          m.comisionInmobiliariaPct = _pctH;
          m.comisionInmobiliariaPagar = Math.round(precioNuevo * _pctH / 100);
        }
        try {
          await redisCall('DEL', `talo:pago:${mudanzaId}:saldo`);
        } catch (e) { console.warn('Limpiar pago transferencia:', e.message); }
      }

      await setJSON(`mudanza:${mudanzaId}`, m, 604800);

      // Si declaro mas horas de las registradas, avisar. No se bloquea el cobro,
      // pero alguien tiene que poder revisarlo antes de liquidarle al mudancero.
      if (requiereRevision && process.env.RESEND_API_KEY && process.env.ADMIN_EMAIL) {
        try {
          const resendRev = new Resend(process.env.RESEND_API_KEY);
          await resendRev.emails.send({
            from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
            to: process.env.ADMIN_EMAIL,
            subject: `⚠️ Horas declaradas por encima del registro · ${m.id}`,
            html: `<div style="font-family:Arial,sans-serif;max-width:560px">
              <h2 style="color:#B45309;margin:0 0 12px">Revisar liquidación de horas</h2>
              <p style="font-size:16px;line-height:1.7">
                <strong>${cot.mudanceroNombre || cot.mudanceroEmail}</strong> declaró
                <strong>${horas} horas</strong> en el pedido ${m.id}, pero el sistema registró
                <strong>${horasSistema}</strong> entre el inicio y el fin.
              </p>
              <p style="font-size:16px;line-height:1.7">
                Diferencia: <strong>+${diferencia} horas</strong> · Se le cobró de más al cliente:
                <strong>$${Math.round(diferencia * tarifa).toLocaleString('es-AR')}</strong>
              </p>
              <p style="font-size:15px;color:#64748B;line-height:1.6">
                Puede ser legítimo (marcó el inicio tarde) o no. El cobro ya se aplicó al saldo;
                si corresponde corregirlo, hay que hacerlo antes de liquidarle.
              </p>
            </div>`
          });
        } catch (e) { console.warn('Aviso revisión horas:', e.message); }
      }

      return res.status(200).json({
        ok: true,
        horasSistema: horasSistema,
        horasCobradas: horas,
        diferencia: diferencia,
        requiereRevision: requiereRevision,
        horasExtra: extra,
        cargo: cargo,
        precioFinal: precioNuevo
      });
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
        // WhatsApp: avisar el saldo con MP + transferencia (a cualquier cliente
        // que haya dejado su WhatsApp, venga del bot o de la web).
        if (m.clienteWA && !m.saldoPagado) {
          try {
            const base = process.env.SITE_URL || 'https://mudateya.ar';
            const cotA = m.cotizacionAceptada || {};
            const total = parseInt(cotA.precio || m.montoTotal || 0) || 0;
            const ant   = parseInt(m.anticipoMonto || Math.round(total * 0.5)) || 0;
            const saldo = Math.max(0, total - ant);
            // Link de Mercado Pago para el saldo.
            let linkMP = null;
            try {
              const rMP = await fetch(`${base}/api/crear-preferencia`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mudanceroNombre: cotA.mudanceroNombre, monto: saldo, desde: m.desde, hasta: m.hasta, ambientes: m.ambientes, mudanzaId: m.id, cotizacionId: cotA.id, tipoPago: 'saldo' }),
              });
              if (rMP.ok) { const dMP = await rMP.json(); linkMP = dMP.init_point || dMP.sandbox_url || null; }
            } catch (_) {}
            // Datos de transferencia (Talo: CVU único para el saldo).
            let transf = null;
            try {
              const rT = await fetch(`${base}/api/transferencias?action=datos&mudanzaId=${encodeURIComponent(m.id)}&tipoPago=saldo`);
              if (rT.ok) { const dT = await rT.json(); if (dT && dT.ok && dT.banco) transf = Object.assign({}, dT.banco, { automatico: !!dT.automatico, checkoutUrl: dT.checkoutUrl || '' }); }
            } catch (_) {}
            const { avisarSaldoPendiente } = require('./_whatsapp');
            await avisarSaldoPendiente(m, saldo, linkMP, transf);
          } catch (e) { console.warn('WhatsApp saldo error:', e.message); }
        }
      }
      if (estado === 'en_curso') {
        m.fechaInicio = new Date().toISOString();
        // El boton del mudancero ya le promete al cliente que se le avisa.
        // Y en cotizaciones por hora este es el momento en que arranca el reloj:
        // el cliente tiene que enterarse ahora, no al recibir la liquidacion.
        try { await notificarClienteMudanzaIniciada(m); } catch(e) { console.warn('Email inicio error:', e.message); }
        // WhatsApp: avisar el inicio (bot o web, si dejó su WhatsApp).
        if (m.clienteWA) {
          try { const { avisarMudanzaIniciada } = require('./_whatsapp'); await avisarMudanzaIniciada(m); }
          catch(e) { console.warn('WhatsApp inicio error:', e.message); }
        }
      }
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

      // montoTotal tiene que seguir al precio aceptado. Antes solo se escribía
      // al aceptar la cotización y quedaba con el importe viejo después de un
      // ajuste, así que el saldo a cobrar y los reportes del panel mostraban
      // el número anterior.
      m.montoTotal = m.ajustePrecio.montoNuevo;

      // La comisión del asesor se calcula sobre el precio final: si el precio
      // cambió, el monto a pagarle también. El porcentaje es el snapshot que se
      // fijó al publicar y no se toca.
      if ((m.partner || m.partnerSlugCrudo || m.partnerAsesor) && m.tipoOperacion !== 'compraventa') {
        const _pctAj = parseFloat(m.comisionInmobiliariaPct) > 0 ? parseFloat(m.comisionInmobiliariaPct) : COMISION_ASESOR_DEFAULT;
        m.comisionInmobiliariaPct = _pctAj;
        m.comisionInmobiliariaPagar = Math.round((parseFloat(m.ajustePrecio.montoNuevo) || 0) * _pctAj / 100);
      }

      // Invalidar el pago de transferencia ya generado: se había creado con el
      // importe anterior. Al borrarlo, el próximo intento genera un CVU nuevo
      // por el monto correcto. Sin esto el cliente transfiere de menos y el
      // pago queda en UNDERPAID, o sea sin acreditar.
      try {
        await redisCall('DEL', `talo:pago:${mudanzaId}:anticipo`);
        await redisCall('DEL', `talo:pago:${mudanzaId}:saldo`);
      } catch (e) { console.warn('Limpiar pago transferencia:', e.message); }
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

    // 3b. Cliente cancela su pedido directamente (NO por rechazo de un ajuste
    // — ese caso ya se maneja arriba en rechazar-ajuste). Si ya había pagado
    // la seña, intenta el refund automático en MP; si falla (o pagó por
    // transferencia, que no se puede reintegrar por API), avisa al ADMIN para
    // que lo procese a mano — antes esto no existía: el cliente cancelaba y
    // la plata quedaba pagada sin que nadie se enterara de reintegrarla.
    if (action === 'cancelar-pedido' && req.method === 'POST') {
      const { mudanzaId, clienteEmail } = req.body;
      if (!mudanzaId || !clienteEmail) return res.status(400).json({ error: 'Faltan datos' });
      const m = await getJSON(`mudanza:${mudanzaId}`);
      if (!m) return res.status(404).json({ error: 'Mudanza no encontrada' });
      if (m.clienteEmail !== clienteEmail) return res.status(403).json({ error: 'Sin permiso' });
      if (['cancelado', 'cancelada_por_ajuste', 'completada'].includes(m.estado)) {
        return res.status(400).json({ error: 'Este pedido ya no está activo' });
      }
      // Con la mudanza YA iniciada no se puede cancelar sola con reembolso
      // automático — el mudancero puede haber hecho parte o todo el trabajo.
      // Cualquier problema en este punto necesita que lo mire una persona.
      if (m.estado === 'en_curso') {
        return res.status(400).json({ error: 'La mudanza ya está en curso, no se puede cancelar automáticamente. Si hay un problema, contactá al equipo.', requiereHumano: true });
      }

      const teniaSeñaPagada = !!m.anticipoPagado;
      m.estado = 'cancelado';
      m.canceladaEn = new Date().toISOString();

      let refundOk = false;
      let refundError = null;
      if (teniaSeñaPagada && m.mpAnticipoPagoId) {
        try {
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
        } catch (e) {
          refundError = e.message;
          console.error('Error en refund MP (cancelar-pedido):', e.message);
        }
      } else if (teniaSeñaPagada) {
        refundError = 'Pagó por transferencia (sin ID de MP) — no se puede reintegrar por API.';
      }

      if (refundError) m.refundError = refundError;
      await setJSON(`mudanza:${mudanzaId}`, m, 604800);

      try {
        if (teniaSeñaPagada) await notificarClienteMudanzaCancelada(m, refundOk);
      } catch (e) { console.warn('Email cliente cancelación (cancelar-pedido):', e.message); }
      try {
        if (m.cotizacionAceptada) await notificarMudanceroPedidoCancelado(m);
      } catch (e) { console.warn('Email mudancero cancelación:', e.message); }
      if (teniaSeñaPagada && !refundOk) {
        try { await notificarAdminRefundManual(m, refundError); } catch (e) { console.warn('Email admin refund (cancelar-pedido):', e.message); }
      }

      return res.status(200).json({ ok: true, refundOk: refundOk, teniaSeñaPagada: teniaSeñaPagada });
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
                  from: 'MudateYa <noreply@mudateya.ar>', reply_to:'hola@mudateya.ar',
                  to: emailMud,
                  subject: `❌ Mudanza cancelada — ${rutaTxt}`,
                  html: `
                    <div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;background:#F5F7FA;padding:20px">
                      <div style="background:#003580;padding:18px 24px;border-radius:8px 8px 0 0">
                        <span style="font-family:Georgia,serif;font-size:18px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:18px;font-weight:900;color:#22C36A">Ya</span>
                      </div>
                      <div style="background:#fff;padding:24px;border-radius:0 0 8px 8px">
                        <h2 style="color:#0F1923;font-size:18px;margin:0 0 12px">Hola ${nombre},</h2>
                        <p style="color:#374151;font-size:17px;line-height:1.7">El cliente <b>canceló</b> la siguiente mudanza:</p>
                        <div style="background:#FEE2E2;border-left:4px solid #DC2626;padding:12px 14px;border-radius:6px;margin:16px 0;font-size:17px;color:#7F1D1D">
                          <b>${rutaTxt}</b>
                        </div>
                        <p style="color:#374151;font-size:16px;line-height:1.7">Esta mudanza pasó automáticamente a tu sección <b>Expirados</b> en MudateYa. No hace falta que hagas nada.</p>
                        <p style="color:#64748B;font-size:15px;margin-top:18px">Si tenés dudas, escribinos a <a href="mailto:hola&#64;mudateya.ar" style="color:#1A6FFF;text-decoration:none;font-weight:600">hola&#64;mudateya.ar</a>.</p>
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
      if (!esAdmin(req)) {
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
      if (!esAdmin(req)) {
        return res.status(401).json({ error: 'Token inválido' });
      }
      const activas = await getJSON('mudanzas:activas') || [];
      const rows = [];
      for (const id of activas) {
        try {
          const m = await getJSON(`mudanza:${id}`);
          if (!m) continue;
          if (!(m.anticipoPagado || m.saldoPagado)) continue;
          // Calcular comisión: 25% Plan Referidos / 20% flete / 15% mudanza normal
          // "Plan Referidos" se activa para: asesores inmobiliarios, refAliado, Mudafy
          // y cualquier inmobiliaria asociada (partner truthy → vino de un canal pago).
          const esFlete = (m.tipo || '').toLowerCase() === 'flete';
          // 25% para toda mudanza de canal, 15%/20% solo para las orgánicas.
          // origenCanal cubre los casos donde el slug de la inmobiliaria no
          // estaba registrado y `partner` quedaba vacío: la mudanza venía de un
          // canal igual. Se mantienen los campos viejos para pedidos anteriores.
          const esPlanReferidos = !!(m.origenCanal === true || m.origenAsesor === true || m.refAliado || m.partner || m.partnerAsesor || m.partnerSlugCrudo);
          const feePct = esPlanReferidos ? 0.25 : (esFlete ? 0.20 : 0.15);
          const feePctLabel = (feePct * 100).toFixed(0) + '%';
          const cot = m.cotizacionAceptada || {};
          const precioBase = parseInt(cot.precio || m.precio_estimado || 0);
          const baseRow = {
            mudanzaId: m.id,
            id: m.id,
            desde: m.desde,
            hasta: m.hasta,
            clienteEmail: m.clienteEmail,
            clienteNombre: m.clienteNombre,
            mudancero: cot.mudanceroNombre || '—',
            mudanceroEmail: cot.mudanceroEmail || '',
            tipo: m.tipo || 'mudanza',
            estado: m.estado,
            precio: precioBase,
            feePct: feePct,
            feePctLabel: feePctLabel,
            esPlanReferidos: esPlanReferidos,
            fechaPublicacion: m.fechaPublicacion,
            // Método real de cada tramo: desde que hay transferencia, no todo
            // pasa por Mercado Pago y el panel tiene que poder distinguirlo.
            // Lo que MudateYa le debe al asesor por esta operación. Solo
            // alquiler: en compraventa el beneficio va al cliente.
            comisionAsesor:     parseInt(m.comisionInmobiliariaPagar) || 0,
            comisionAsesorPct:  parseFloat(m.comisionInmobiliariaPct) || 0,
            asesorCodigo:       m.partnerAsesor || '',
            tipoOperacion:      m.tipoOperacion || '',
            metodoPagoAnticipo: m.metodoPagoAnticipo || 'mercadopago',
            metodoPagoSaldo:    m.metodoPagoSaldo    || 'mercadopago',
          };
          // Una fila por cada pago realizado (anticipo y saldo son pagos separados,
          // cada uno tiene su propia fecha y por ende su propia ventana de liquidación)
          if (m.anticipoPagado) {
            const montoPagado = parseInt(m.anticipoMonto) || Math.round(precioBase * 0.5);
            const fee = Math.round(montoPagado * feePct);
            const neto = montoPagado - fee;
            rows.push(Object.assign({}, baseRow, {
              tipoPago: 'anticipo',
              montoPagado: montoPagado,
              fee: fee,
              neto: neto,
              fechaPago: m.fechaPagoAnticipo || null,
              liquidadoEn: m.liquidadoAnticipoEn || null,
              mpPagoId: m.mpAnticipoPagoId || null,
            }));
          }
          if (m.saldoPagado) {
            // Mismo criterio que registrar-pago: el saldo es el precio final
            // menos el anticipo cobrado, no la mitad del precio. Con un ajuste
            // de precio esas dos cosas dejan de coincidir.
            const antPagado = parseInt(m.anticipoMonto || 0) || 0;
            const montoPagado = parseInt(m.saldoMonto) || Math.max(0, precioBase - antPagado) || Math.round(precioBase * 0.5);
            const fee = Math.round(montoPagado * feePct);
            const neto = montoPagado - fee;
            rows.push(Object.assign({}, baseRow, {
              tipoPago: 'saldo',
              montoPagado: montoPagado,
              fee: fee,
              neto: neto,
              fechaPago: m.fechaPagoSaldo || null,
              liquidadoEn: m.liquidadoSaldoEn || null,
              mpPagoId: m.mpSaldoPagoId || null,
            }));
          }
        } catch(e) { console.warn('admin-pagos error mudanza', id, e.message); }
      }
      // Ordenar por fecha de pago descendente (más reciente primero)
      rows.sort(function(a,b){
        return new Date(b.fechaPago||0) - new Date(a.fechaPago||0);
      });
      return res.status(200).json({ rows });
    }


    // ── Admin: listar mudanceros ──────────────────────────────────────
    if (action === 'admin-mudanceros' && req.method === 'GET') {
      const { token } = req.query;
      if (!esAdmin(req)) {
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
      if (!esAdmin(req)) {
        return res.status(401).json({ error: 'Token inválido' });
      }
      if (!email || !cambios) return res.status(400).json({ error: 'Faltan datos' });
      const perfil = await getJSON(`mudancero:perfil:${email}`);
      if (!perfil) return res.status(404).json({ error: 'Mudancero no encontrado' });

      // ── Campos string simples (no se sobrescriben con string vacío) ───────
      // Comportamiento original: si admin manda '' lo ignoramos (no borra el dato existente).
      const camposPermitidos = [
        'nombre','telefono','email','empresa','zonaBase','zonasExtra','vehiculo','servicios',
        'extra','foto','fotoCamion','horarios','dias','anticipacion','sitioWeb','añosExp',
        'precioFleteNuevo',
        // Campos administrativos / de contacto que el admin edita desde el modal
        'cuil','cantVehiculos','equipo','distancia',
        // Datos de cobro
        'metodoCobro','cbu','emailMP','titularCuenta'
      ];
      camposPermitidos.forEach(function(k) {
        if (cambios[k] !== undefined && cambios[k] !== '') perfil[k] = cambios[k];
      });

      // ── Boolean flags ────────────────────────────────────────────────────
      // Estos NO pueden filtrarse por '' porque false es un valor válido de admin
      // (admin puede DESactivar el flag). Solo persistimos si admin envía true/false explícito.
      if (typeof cambios.seguroMudanza === 'boolean')    perfil.seguroMudanza    = cambios.seguroMudanza;
      if (typeof cambios.verificadoSeguro === 'boolean') perfil.verificadoSeguro = cambios.verificadoSeguro;
      if (typeof cambios.sinEstres === 'boolean')        perfil.sinEstres        = cambios.sinEstres;

      // ── Servicios activos (array de niveles) ────────────────────────────
      // Es un array tipo ['esencial','integral','llave','flete']. Si admin envía
      // un array vacío [] significa "este mudancero no ofrece nada", también es válido.
      if (Array.isArray(cambios.serviciosActivos)) {
        var SERVICIOS_VALIDOS = ['esencial','integral','llave','flete'];
        perfil.serviciosActivos = cambios.serviciosActivos.filter(function(s) {
          return typeof s === 'string' && SERVICIOS_VALIDOS.indexOf(s) !== -1;
        });
      }

      // ── Precios por nivel × ambiente (modelo nuevo) ────────────────────
      // Estructura: { amb1: '50000', amb2: '70000', amb3: '90000', amb4: '110000' }
      // Admin puede enviar null para indicar "este nivel no ofrece" (limpiar).
      function _persistirPrecioNivel(claveNivel, claveCambio) {
        if (cambios[claveCambio] === null) {
          // Limpiar el nivel
          delete perfil[claveNivel];
        } else if (cambios[claveCambio] && typeof cambios[claveCambio] === 'object') {
          var p = cambios[claveCambio];
          perfil[claveNivel] = {
            amb1: String(p.amb1 || ''),
            amb2: String(p.amb2 || ''),
            amb3: String(p.amb3 || ''),
            amb4: String(p.amb4 || '')
          };
        }
      }
      _persistirPrecioNivel('preciosEsencial', 'preciosEsencial');
      _persistirPrecioNivel('preciosIntegral', 'preciosIntegral');
      _persistirPrecioNivel('preciosLlave',    'preciosLlave');

      // ── Compat modelo viejo: precio1amb..precio4amb + precioFlete ──────
      // Algunos perfiles antiguos siguen usando perfil.precios.{amb1..amb4, flete}.
      // Si admin manda los valores nuevos, los reflejamos también ahí para no romper
      // dashboards/lecturas legacy que aún consulten ese subobjeto.
      var precioFields = ['precio1amb','precio2amb','precio3amb','precio4amb','precioFlete'];
      var hayPreciosLegacy = precioFields.some(function(k){ return cambios[k] !== undefined; });
      if (hayPreciosLegacy) {
        perfil.precios = perfil.precios || {};
        if (cambios.precio1amb !== undefined) perfil.precios.amb1  = String(cambios.precio1amb || '');
        if (cambios.precio2amb !== undefined) perfil.precios.amb2  = String(cambios.precio2amb || '');
        if (cambios.precio3amb !== undefined) perfil.precios.amb3  = String(cambios.precio3amb || '');
        if (cambios.precio4amb !== undefined) perfil.precios.amb4  = String(cambios.precio4amb || '');
        if (cambios.precioFlete !== undefined) perfil.precios.flete = String(cambios.precioFlete || '');
      }

      // Tipo de cobro: 'porHora' o 'fijo'. Editable solo desde admin.
      // Permite el string vacío como "limpiar" (para volver al fallback heurístico).
      if (cambios.tipoCobro !== undefined) {
        if (cambios.tipoCobro === 'porHora' || cambios.tipoCobro === 'fijo') {
          perfil.tipoCobro = cambios.tipoCobro;
        } else if (cambios.tipoCobro === '' || cambios.tipoCobro === null) {
          delete perfil.tipoCobro;
        }
      }
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
      var _now = new Date().toISOString();
      perfil.ultimaEdicionAdmin = _now;
      perfil.ultimaActualizacion = _now;  // mismo timestamp para que la tabla del admin lo vea
      await setJSON(`mudancero:perfil:${email}`, perfil);
      return res.status(200).json({ ok: true });
    }

    if (action === 'admin-aprobar-mudancero' && req.method === 'POST') {
      const { token, email, nuevoEstado, verificadoIdentidad, verificadoVehiculo } = req.body;
      if (!esAdmin(req)) {
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
        try { await require('./admin-aprobar').enviarEmailAltaExitosa(perfil); } catch(e) { console.error('Email alta error:', e.message); }
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
      if (!esAdmin(req)) {
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
      if (!esAdmin(req)) {
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
          // Origen del pedido (para badges + cálculo comisión 25% en admin)
          partner:          p.partner || null,
          partnerAsesor:    p.partnerAsesor || null,
          partnerPropiedad: p.partnerPropiedad || null,
          origenAsesor:     p.origenAsesor === true,
          refAliado:        p.refAliado || null,
          asesorEmail:      p.asesorEmail || null,
          // Detalles adicionales que cargó el cliente (ascensor, fotos, etc) — para mostrar en admin/mi-cuenta
          detallesAdicionales: p.detallesAdicionales || null,
          // Modelo nuevo: detalles separados por lado (origen/destino)
          detallesOrigen:  p.detallesOrigen  || null,
          detallesDestino: p.detallesDestino || null,
          // Tipo de lugar (casa/depto) y datos de depto si aplica — vienen del modal nuevo
          tipoOrigen:    p.tipoOrigen    || null,
          tipoDestino:   p.tipoDestino   || null,
          pisoOrigen:    p.pisoOrigen    || '',
          pisoDestino:   p.pisoDestino   || '',
          deptoOrigen:   p.deptoOrigen   || '',
          deptoDestino:  p.deptoDestino  || '',
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
      if (!esAdmin(req)) {
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

      // ── Notificar al admin que se firmaron los TyC ──────────────────
      // Si falla el envío, no rompe el flujo: la firma del mudancero
      // ya quedó guardada en Redis arriba.
      try {
        const adminEmail = process.env.ADMIN_EMAIL || 'jgalozaldivar@gmail.com';
        if (adminEmail && process.env.RESEND_API_KEY) {
          const resendTyC = new Resend(process.env.RESEND_API_KEY);
          const fechaFmt = new Date(perfil.fechaAceptoTerminos).toLocaleString('es-AR', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires'
          });
          await resendTyC.emails.send({
            from: 'MudateYa <noreply@mudateya.ar>', reply_to:'hola@mudateya.ar',
            to: adminEmail,
            subject: `[ADMIN] ✅ TyC firmados — ${perfil.nombre || datos.email}`,
            html: `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="margin:0;padding:0"><div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
              <div style="background:#003580;padding:20px 28px"><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#22C36A">Ya</span><span style="font-size:16px;color:rgba(255,255,255,.7);margin-left:12px">📋 Panel admin</span></div>
              <div style="background:#F0FDF4;border-bottom:1px solid #BBF7D0;padding:12px 28px;font-size:16px;color:#15803D;font-weight:600">✅ Mudancero activo · TyC firmados</div>
              <div style="padding:28px">
                <p style="font-size:18px;color:#0F1923;margin:0 0 16px">Hola Admin, un mudancero acaba de aceptar los Términos y Condiciones. Su cuenta ya está activa y aparece en el catálogo.</p>

                <div style="font-size:14px;color:#64748B;font-weight:700;letter-spacing:1.5px;margin:14px 0 8px">DATOS DEL MUDANCERO</div>
                <table style="width:100%;border-collapse:collapse;margin-bottom:18px">
                  <tr><td style="color:#64748B;padding:11px 0;width:35%;font-size:16px">Nombre</td><td style="font-weight:600;color:#0F1923;font-size:16px;padding:11px 0">${perfil.nombre || '—'}</td></tr>
                  ${perfil.empresa ? `<tr style="background:#F5F7FA"><td style="color:#64748B;padding:7px 8px;font-size:16px">Empresa</td><td style="font-weight:600;color:#0F1923;font-size:16px;padding:11px 0">${perfil.empresa}</td></tr>` : ''}
                  <tr${perfil.empresa ? '' : ' style="background:#F5F7FA"'}><td style="color:#64748B;padding:7px ${perfil.empresa ? '0' : '8px'};font-size:16px">Email</td><td style="font-size:16px;color:#0F1923;padding:11px 0"><a href="mailto:${datos.email}" style="color:#003580;text-decoration:none">${datos.email}</a></td></tr>
                  ${perfil.telefono ? `<tr${perfil.empresa ? ' style="background:#F5F7FA"' : ''}><td style="color:#64748B;padding:7px ${perfil.empresa ? '8px' : '0'};font-size:16px">WhatsApp</td><td style="font-size:16px;color:#0F1923;padding:11px 0"><a href="https://wa.me/${String(perfil.telefono).replace(/\D/g,'')}" style="color:#22C36A;text-decoration:none;font-weight:600">${perfil.telefono}</a></td></tr>` : ''}
                  ${perfil.zonaBase ? `<tr><td style="color:#64748B;padding:11px 0;font-size:16px">Zona base</td><td style="font-size:16px;color:#0F1923;padding:11px 0">${perfil.zonaBase}</td></tr>` : ''}
                </table>

                <div style="font-size:14px;color:#64748B;font-weight:700;letter-spacing:1.5px;margin:14px 0 8px">FIRMA</div>
                <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
                  <tr><td style="color:#64748B;padding:11px 0;width:35%;font-size:16px">Fecha y hora</td><td style="font-weight:600;color:#0F1923;font-size:16px;padding:11px 0">${fechaFmt}</td></tr>
                  <tr style="background:#F5F7FA"><td style="color:#64748B;padding:7px 8px;font-size:16px">Versión TyC</td><td style="font-size:16px;color:#0F1923;padding:11px 0">v${perfil.versionTerminos}</td></tr>
                </table>

                <div style="margin-top:8px">
                  <a href="https://mudateya.ar/admin" style="display:inline-block;background:#003580;color:#fff;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:17px">Ver en panel admin →</a>
                </div>
              </div>
              <div style="background:#F5F7FA;border-top:1px solid #E2E8F0;padding:14px 28px;font-size:14px;color:#94A3B8;font-family:monospace">MudateYa · mudateya.ar · ${datos.email}</div>
            </div></body></html>`,
          });
        }
      } catch(e) { console.error('Email admin TyC firmados error:', e && e.message); }

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
          // EXCEPCIÓN: mudanceros con seguro de mudanza activo aparecen igual
          // (con "A consultar" en frontend). Esto es para que admin pueda activar
          // el seguro sin estar obligado a cargar precios todavía.
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
          // Mudanceros con seguro de mudanza activo entran al catálogo aunque
          // no tengan precios. El frontend muestra "A consultar" en su lugar.
          var tieneSeguroActivo = !!p.seguroMudanza
             || !!p.verificadoSeguro
             || (p.servicios && String(p.servicios).toLowerCase().indexOf('seguro') !== -1);
          if (!tienePrecioAlguno && !tieneSeguroActivo) continue;

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
            // Tipo de cobro: 'porHora' | 'fijo' | undefined (fallback heurístico en frontend)
            tipoCobro:           p.tipoCobro            || '',
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
      m.expira = vencimientoHabilISO(24);
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
        // Gate de contacto: acá el pedido siempre está en 'buscando', así que
        // el celular del cliente nunca sale. Se sanitiza igual por defensa.
        disponibles.push(sanitizarParaMudancero(m, email));
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
        if (!m) continue;
        // Gate de contacto: clienteWA solo si ganó el pedido y pagó el anticipo
        const seguro = sanitizarParaMudancero(m, email);
        mudanzas.push({ ...seguro, miCotizacion: (seguro.cotizaciones || []).find(c => c.mudanceroEmail === email) });
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
      if (!esAdmin(req)) return res.status(403).json({ error: 'No autorizado' });
      const si = await redisCall('GET', 'encuesta:packs:si');
      const no = await redisCall('GET', 'encuesta:packs:no');
      return res.status(200).json({ si: parseInt(si) || 0, no: parseInt(no) || 0 });
    }

    if (action === 'admin-patch-perfil' && req.method === 'POST') {
      const { token, email, trabajosCompletados, calificacion, nroResenas } = req.body;
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
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
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
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
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
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

    // ── Admin: Research de competencia con Google Places API ─────────────
    // Proxy al Places API para que el browser pueda llamar sin problemas de CORS.
    // La API key vive solo en Vercel env vars, nunca se expone al cliente.
    // type='nearby' → nearbysearch (descubrir por zona, paginado)
    // type='details' → place details
    // type='textsearch' → textsearch (buscar por nombre)
    if (action === 'places-research' && req.method === 'GET') {
      const { token, type } = req.query;
      if (!esAdmin(req)) {
        return res.status(401).json({ error: 'No autorizado' });
      }
      const apiKey = process.env.GOOGLE_PLACES_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: 'GOOGLE_PLACES_API_KEY no configurada en Vercel' });
      }
      try {
        let url;
        if (type === 'nearby') {
          const { location, radius, keyword, pagetoken } = req.query;
          url = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json'
            + '?language=es&key=' + encodeURIComponent(apiKey);
          if (pagetoken) {
            url += '&pagetoken=' + encodeURIComponent(pagetoken);
          } else {
            if (!location || !radius || !keyword) return res.status(400).json({ error: 'Faltan params: location, radius, keyword' });
            url += '&location=' + encodeURIComponent(location)
              + '&radius=' + encodeURIComponent(radius)
              + '&keyword=' + encodeURIComponent(keyword);
          }
        } else if (type === 'textsearch') {
          const { query } = req.query;
          if (!query) return res.status(400).json({ error: 'Falta query' });
          url = 'https://maps.googleapis.com/maps/api/place/textsearch/json'
            + '?query=' + encodeURIComponent(query)
            + '&region=ar&language=es&key=' + encodeURIComponent(apiKey);
        } else if (type === 'details') {
          const { place_id } = req.query;
          if (!place_id) return res.status(400).json({ error: 'Falta place_id' });
          const fields = 'name,rating,user_ratings_total,formatted_address,formatted_phone_number,international_phone_number,website,url,business_status';
          url = 'https://maps.googleapis.com/maps/api/place/details/json'
            + '?place_id=' + encodeURIComponent(place_id)
            + '&fields=' + encodeURIComponent(fields)
            + '&language=es&key=' + encodeURIComponent(apiKey);
        } else {
          return res.status(400).json({ error: 'type debe ser nearby, textsearch o details' });
        }
        const r = await fetch(url);
        const d = await r.json();
        return res.status(200).json(d);
      } catch (e) {
        console.error('Error en places-research:', e.message);
        return res.status(500).json({ error: e.message });
      }
    }

    // ── Admin: Scrape de emails desde webs de mudanceros ──────────────────
    // Toma una URL, hace fetch al HTML, extrae emails con regex.
    // Cachea el resultado en Redis 30 días para no re-scrapear cada vez.
    if (action === 'scrape-email' && req.method === 'GET') {
      const { token, url, force } = req.query;
      if (!esAdmin(req)) {
        return res.status(401).json({ error: 'No autorizado' });
      }
      if (!url) return res.status(400).json({ error: 'Falta url' });

      // Helper local: validar email
      const isValidEmail = (e) => {
        if (!e || e.length > 80 || e.length < 6) return false;
        if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(e)) return false;
        return true;
      };

      // Validar URL
      let parsedUrl;
      try {
        parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Protocolo inválido');
      } catch(e) {
        return res.status(400).json({ error: 'URL inválida: ' + e.message });
      }

      // Cache en Redis: scrape:email:v2:{hash} → 30 días
      // v2 = versión multi-página + redes sociales + teléfonos. Invalida cachés v1.
      const cacheKey = `scrape:email:v2:${Buffer.from(url).toString('base64').slice(0, 60)}`;
      if (!force) {
        try {
          const cached = await getJSON(cacheKey);
          if (cached) return res.status(200).json({ ...cached, fromCache: true });
        } catch(e) {}
      }

      // Helpers de extracción
      const extraerDeHtml = (html, accumEmails, accumPhones, accumSocial) => {
        let m;
        // Emails: mailto + texto + ofuscados
        const mailtoRegex = /mailto:([^"'?\s>]+)/gi;
        while ((m = mailtoRegex.exec(html)) !== null) {
          const e = decodeURIComponent(m[1]).split(/[?,;]/)[0].trim().toLowerCase();
          if (isValidEmail(e)) accumEmails.add(e);
        }
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
        while ((m = emailRegex.exec(html)) !== null) {
          const e = m[0].toLowerCase();
          if (isValidEmail(e)) accumEmails.add(e);
        }
        const obfuscatedRegex = /([a-zA-Z0-9._%+-]+)\s*[\[\(]\s*at\s*[\]\)]\s*([a-zA-Z0-9.-]+)\s*[\[\(]\s*dot\s*[\]\)]\s*([a-zA-Z]{2,})/gi;
        while ((m = obfuscatedRegex.exec(html)) !== null) {
          const e = (m[1] + '@' + m[2] + '.' + m[3]).toLowerCase();
          if (isValidEmail(e)) accumEmails.add(e);
        }
        // Teléfonos en formato AR
        const telRegex = /(?:tel:|telephone:)?\+?\s*(?:54[\s\-]?9?[\s\-]?)?(?:0?11|0?15)?[\s\-\.\(\)]*\d{2,4}[\s\-\.\)]*\d{3,4}[\s\-\.]*\d{3,4}/g;
        while ((m = telRegex.exec(html)) !== null) {
          const tel = m[0].replace(/[^\d+]/g, '');
          if (tel.length >= 8 && tel.length <= 15) accumPhones.add(tel);
        }
        // Redes sociales
        const socialPatterns = [
          { rx: /(?:https?:)?\/\/(?:www\.)?(?:wa\.me|api\.whatsapp\.com\/send|chat\.whatsapp\.com)\/[^\s"'<>]+/gi, type: 'whatsapp' },
          { rx: /(?:https?:)?\/\/(?:www\.)?instagram\.com\/[a-zA-Z0-9._]+\/?/gi, type: 'instagram' },
          { rx: /(?:https?:)?\/\/(?:www\.)?facebook\.com\/[a-zA-Z0-9._-]+\/?/gi, type: 'facebook' },
          { rx: /(?:https?:)?\/\/(?:www\.)?linkedin\.com\/(?:in|company)\/[a-zA-Z0-9._-]+\/?/gi, type: 'linkedin' },
        ];
        for (const sp of socialPatterns) {
          while ((m = sp.rx.exec(html)) !== null) {
            let val = m[0];
            if (val.startsWith('//')) val = 'https:' + val;
            // Filtrar URLs genéricas (sin handle)
            if (sp.type === 'instagram' && /instagram\.com\/?$/i.test(val)) continue;
            if (sp.type === 'facebook' && /facebook\.com\/(sharer|share|tr|plugins|dialog|pages?|profile)/i.test(val)) continue;
            if (sp.type === 'whatsapp' && val.length < 25) continue;
            accumSocial.add(sp.type + '|' + val);
          }
        }
      };

      const fetchHtml = async (u) => {
        try {
          const ctrl = new AbortController();
          const timeout = setTimeout(() => ctrl.abort(), 6000);
          const resp = await fetch(u, {
            signal: ctrl.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; MudateYa-research/1.0; +https://mudateya.ar)',
              'Accept': 'text/html,application/xhtml+xml',
            },
            redirect: 'follow'
          });
          clearTimeout(timeout);
          if (!resp.ok) return null;
          let html = await resp.text();
          if (html.length > 500000) html = html.slice(0, 500000);
          return html;
        } catch(e) {
          return null;
        }
      };

      try {
        const allEmails = new Set();
        const allPhones = new Set();
        const allSocial = new Set();
        const visitadas = [];
        const errores = [];

        // 1) Visitar la home
        const homeHtml = await fetchHtml(url);
        if (!homeHtml) {
          const result = { url, emails: [], phones: [], social: [], error: 'No se pudo acceder a la home' };
          await setJSON(cacheKey, result, 86400);
          return res.status(200).json(result);
        }
        visitadas.push(url);
        extraerDeHtml(homeHtml, allEmails, allPhones, allSocial);

        // 2) Buscar links a páginas de contacto/sobre nosotros en la home
        // Patrones comunes en español e inglés
        const candidatos = new Set();
        const linkRegex = /<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi;
        let lm;
        const palabrasContacto = /contacto|contact|nosotros|about|empresa|institucional|sobre/i;
        while ((lm = linkRegex.exec(homeHtml)) !== null) {
          const href = lm[1];
          const texto = lm[2] || '';
          // Coincide si el path o el texto del link contienen palabras clave
          if (palabrasContacto.test(href) || palabrasContacto.test(texto)) {
            try {
              const absoluteUrl = new URL(href, url).href;
              // Solo URLs del mismo dominio
              const cand = new URL(absoluteUrl);
              if (cand.hostname.replace(/^www\./, '') === parsedUrl.hostname.replace(/^www\./, '')) {
                candidatos.add(absoluteUrl.split('#')[0]);
              }
            } catch(e) {}
          }
        }
        // Si no encontró links explícitos, probar paths comunes
        if (candidatos.size === 0) {
          const paths = ['/contacto', '/contact', '/nosotros', '/about', '/about-us', '/empresa'];
          for (const p of paths) {
            try {
              candidatos.add(new URL(p, url).href);
            } catch(e) {}
          }
        }

        // 3) Visitar hasta 3 candidatos (limitar para no demorar mucho)
        const aVisitar = [...candidatos].slice(0, 3);
        for (const cu of aVisitar) {
          if (visitadas.includes(cu)) continue;
          const html = await fetchHtml(cu);
          if (html) {
            visitadas.push(cu);
            extraerDeHtml(html, allEmails, allPhones, allSocial);
          } else {
            errores.push('No se pudo acceder a ' + cu);
          }
        }

        // Filtrar emails de imágenes/assets/falsos positivos comunes
        const blacklist = [
          /\.(png|jpg|jpeg|gif|svg|webp|css|js|woff|ttf|ico|pdf)$/i,
          /^(noreply|no-reply|mailer-daemon|postmaster|abuse|donotreply|do-not-reply)@/i,
          /@(wixpress\.com|wixsite\.com|godaddy\.com|sentry\.io|google-analytics\.com|facebook\.com|gstatic\.com|googleusercontent\.com|cdn\.|example\.com|domain\.com|email\.com|sentry-next\.wixpress\.com|wpforms\.com|elementor\.com|test\.com)$/i,
          /^(u00|u003e|u0040)/i,
          /^[a-f0-9]{20,}@/i, // hashes (típico de Sentry)
        ];
        const filtered = [...allEmails].filter(e => !blacklist.some(rx => rx.test(e)));

        // Priorizar emails del mismo dominio que la web
        const domain = parsedUrl.hostname.replace(/^www\./, '');
        const priority = filtered.filter(e => e.endsWith('@' + domain) || e.endsWith('.' + domain));
        const others = filtered.filter(e => !priority.includes(e));
        const sortedEmails = [...priority, ...others];

        // Procesar redes sociales: dedup por tipo+url
        const socialList = [...allSocial].map(s => {
          const [type, ...rest] = s.split('|');
          return { type, url: rest.join('|') };
        });

        const result = {
          url,
          emails: sortedEmails,
          phones: [...allPhones].slice(0, 5),
          social: socialList,
          encontrados: sortedEmails.length,
          dominio: domain,
          paginasVisitadas: visitadas.length,
          paginas: visitadas
        };
        await setJSON(cacheKey, result, 86400 * 30);
        return res.status(200).json(result);

      } catch(e) {
        const errMsg = e.name === 'AbortError' ? 'Timeout (8s)' : e.message;
        const result = { url, emails: [], error: errMsg };
        // Cachear errores menos tiempo (1 día) por si la web está caída temporal
        try { await setJSON(cacheKey, result, 86400); } catch(_) {}
        return res.status(200).json(result);
      }
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
// ════════════════════════════════════════════════════
// PDF DETALLES ADICIONALES DEL PEDIDO
// Genera un PDF con las características del lugar que cargó el cliente
// (ascensor, izaje, escaleras, etc), el comentario libre y las fotos
// adjuntas. Se adjunta al mail del mudancero como base64.
// Devuelve null si no hay datos para generar (no incluye PDF al mail).
// ════════════════════════════════════════════════════
async function generarPDFDetallesBase64(mudanza) {
  if (!mudanza) return null;
  const d = mudanza.detallesAdicionales || {};
  const tieneTipo = !!(mudanza.tipoOrigen || mudanza.tipoDestino);
  const tieneLados = !!(mudanza.detallesOrigen || mudanza.detallesDestino);
  const tieneCompartido = Object.keys(d).length > 0; // comentario o fotos (o flags legacy)
  // Generar si hay tipo (modelo nuevo siempre obligatorio), si hay detalles por lado,
  // o si el modelo viejo tenía algo en detallesAdicionales (compat).
  if (!tieneTipo && !tieneLados && !tieneCompartido) return null;

  const PDFDocument = require('pdfkit');

  // Labels legibles de las flags (compat: si llega un pedido viejo con flags planos
  // dentro de detallesAdicionales, también los mostramos).
  const LABELS = {
    ascensor:        'Hay ascensor en origen y/o destino',
    izaje:           'Necesita izaje',
    soga:            'Necesita soga',
    balconTerraza:   'Hay balcón / terraza',
    pasilloAngosto:  'Pasillo angosto o difícil acceso',
    escaleras:       'Hay escaleras',
    cocheraGarage:   'Tiene puerta de cochera / garage',
    estDificil:      'Estacionamiento difícil en la cuadra',
    mascotaEspecial: 'Mascota o algo especial'
  };

  // Pre-fetch de las fotos a buffer (PDFKit necesita buffers, no URLs)
  // En el modelo nuevo, las fotos están en detallesAdicionales.fotos (compartido).
  // En el viejo, también. En ambos casos se renderizan al final, debajo de las columnas.
  const fotosBuffers = [];
  if (Array.isArray(d.fotos)) {
    for (let i = 0; i < d.fotos.length; i++) {
      try {
        const r = await fetch(d.fotos[i]);
        if (r.ok) {
          const ab = await r.arrayBuffer();
          fotosBuffers.push(Buffer.from(ab));
        }
      } catch(e) { /* ignorar foto que falla */ }
    }
  }

  return new Promise(function(resolve, reject) {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 50, bottom: 50, left: 50, right: 50 },
        info: { Title: 'Detalles del pedido · ' + (mudanza.id || '') }
      });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', function() {
        resolve(Buffer.concat(chunks).toString('base64'));
      });
      doc.on('error', reject);

      const PW = 595.28;
      const MARGIN = 50;
      const CONTENT_W = PW - MARGIN * 2;

      // ── Header navy con logo
      doc.rect(0, 0, PW, 70).fill('#003580');
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(22)
         .text('MudateYa', MARGIN, 28);
      doc.fontSize(11).fillColor('#FFFFFF').opacity(0.7)
         .text('Detalles del pedido', MARGIN, 50)
         .opacity(1);

      let y = 100;

      // ── ID del pedido
      doc.fillColor('#94A3B8').font('Helvetica').fontSize(9)
         .text('PEDIDO', MARGIN, y);
      doc.fillColor('#0F1923').font('Helvetica-Bold').fontSize(14)
         .text(mudanza.id || '—', MARGIN, y + 12);
      y += 45;

      // ── Vencimiento: caja ámbar, bien visible ──
      // El mudancero necesita saber hasta cuándo puede cotizar sin tener
      // que volver al email. Se muestra con día de la semana porque la
      // vigencia corre en horas hábiles y puede caer varios días después.
      if (mudanza.expira) {
        const boxH = 42;
        doc.roundedRect(MARGIN, y, CONTENT_W, boxH, 8)
           .fillAndStroke('#FFF8EC', '#F59E0B');
        doc.fillColor('#92400E').font('Helvetica').fontSize(8)
           .text('PODÉS COTIZAR HASTA', MARGIN + 12, y + 9);
        doc.fillColor('#0F1923').font('Helvetica-Bold').fontSize(12)
           .text(fmtVencimientoAR(mudanza.expira), MARGIN + 12, y + 21);
        y += boxH + 16;
      }

      // ── Datos del pedido
      doc.fillColor('#1A6FFF').font('Helvetica-Bold').fontSize(11)
         .text('DATOS DEL PEDIDO', MARGIN, y);
      y += 18;
      doc.fillColor('#0F1923').font('Helvetica').fontSize(10);
      function row(label, val) {
        doc.fillColor('#64748B').font('Helvetica').fontSize(9)
           .text(label, MARGIN, y, { width: 100 });
        doc.fillColor('#0F1923').font('Helvetica-Bold').fontSize(10)
           .text(val || '—', MARGIN + 110, y, { width: CONTENT_W - 110 });
        y += 18;
      }
      row('Origen', mudanza.desde);
      row('Destino', mudanza.hasta);
      if (parseInt(mudanza.km) > 0) row('Distancia', parseInt(mudanza.km) + ' km aprox.');
      row('Tamaño', mudanza.ambientes);
      row('Fecha', fmtFechaAR(mudanza.fecha));
      y += 14;

      // ── 2 columnas: ORIGEN | DESTINO ──
      // Cada columna muestra: tipo de lugar (casa/depto con piso/depto si aplica)
      // + checkboxes marcados para ese lado.
      const LABELS_CORTOS = {
        ascensor:        'Con ascensor',
        izaje:           'Necesita izaje',
        soga:            'Necesita soga',
        balconTerraza:   'Balcón / terraza',
        pasilloAngosto:  'Pasillo angosto',
        escaleras:       'Hay escaleras',
        cocheraGarage:   'Puerta de cochera',
        estDificil:      'Estac. difícil',
        mascotaEspecial: 'Mascota / especial'
      };
      const COL_W = (CONTENT_W - 12) / 2;
      const COL_X_O = MARGIN;
      const COL_X_D = MARGIN + COL_W + 12;

      function dibujarColumna(xCol, titulo, emoji, tipo, piso, depto, detallesLado, hora) {
        let cy = y;
        // Caja con borde amarillo
        const startY = cy;
        // Header de la columna — el "emoji" puede venir vacío (sin símbolo)
        // porque muchos glifos Unicode no están en WinAnsi y se renderizan como basura.
        const headerTxt = emoji ? (emoji + '  ' + titulo) : titulo;
        doc.fillColor('#78350F').font('Helvetica-Bold').fontSize(11)
           .text(headerTxt, xCol + 10, cy + 10);
        cy += 32;

        // Tipo de lugar
        if (tipo) {
          doc.fillColor('#64748B').font('Helvetica').fontSize(8)
             .text('TIPO DE LUGAR', xCol + 10, cy);
          cy += 11;
          let txt;
          if (tipo === 'casa') {
            txt = 'Casa';
          } else {
            txt = 'Departamento';
            if (piso)  txt += ' · Piso ' + piso;
            if (depto) txt += ' · Depto ' + depto;
          }
          doc.fillColor('#0F1923').font('Helvetica-Bold').fontSize(10)
             .text(txt, xCol + 10, cy, { width: COL_W - 20 });
          cy = doc.y + 8;
        } else {
          doc.fillColor('#94A3B8').font('Helvetica-Oblique').fontSize(9)
             .text('Tipo de lugar: no indicado', xCol + 10, cy, { width: COL_W - 20 });
          cy += 14;
        }

        // Hora aproximada de inicio — solo aparece si vino cargada (típicamente solo
        // en la columna ORIGEN; el cliente puede o no haberla puesto, es opcional).
        if (hora) {
          doc.fillColor('#64748B').font('Helvetica').fontSize(8)
             .text('HORA APROX. DE INICIO', xCol + 10, cy);
          cy += 11;
          doc.fillColor('#0F1923').font('Helvetica-Bold').fontSize(10)
             .text(hora + ' hs', xCol + 10, cy);
          cy += 18;
        }

        // Checkboxes marcados
        const flagsLado = detallesLado
          ? Object.keys(LABELS_CORTOS).filter(function(k) { return detallesLado[k] === true; })
          : [];
        if (flagsLado.length > 0) {
          doc.fillColor('#64748B').font('Helvetica').fontSize(8)
             .text('CARACTERÍSTICAS', xCol + 10, cy);
          cy += 11;
          flagsLado.forEach(function(k) {
            let lbl = LABELS_CORTOS[k];
            if (k === 'escaleras' && detallesLado.escalerasPisos) {
              lbl += ' (' + detallesLado.escalerasPisos + ' piso' + (detallesLado.escalerasPisos > 1 ? 's' : '') + ')';
            }
            doc.fillColor('#22C36A').font('Helvetica-Bold').fontSize(13).text('\u2022', xCol + 10, cy - 2);
            doc.fillColor('#0F1923').font('Helvetica').fontSize(9).text(lbl, xCol + 22, cy, { width: COL_W - 32 });
            cy += 13;
          });
        } else if (tipo) {
          doc.fillColor('#94A3B8').font('Helvetica-Oblique').fontSize(9)
             .text('Sin características adicionales', xCol + 10, cy, { width: COL_W - 20 });
          cy += 14;
        }

        // Border de la caja (calculado al final con la altura real)
        const altura = Math.max(cy - startY + 10, 80);
        doc.lineWidth(1).strokeColor('#FDE68A')
           .rect(xCol, startY, COL_W, altura).stroke();
        // Borde izquierdo grueso naranja
        doc.lineWidth(3).strokeColor('#F59E0B')
           .moveTo(xCol + 1.5, startY).lineTo(xCol + 1.5, startY + altura).stroke();
        return startY + altura;
      }

      const yFinO = dibujarColumna(COL_X_O, 'ORIGEN',  '', mudanza.tipoOrigen,  mudanza.pisoOrigen,  mudanza.deptoOrigen,  mudanza.detallesOrigen,  mudanza.horaOrigen || '');
      const yFinD = dibujarColumna(COL_X_D, 'DESTINO', '', mudanza.tipoDestino, mudanza.pisoDestino, mudanza.deptoDestino, mudanza.detallesDestino, '');
      y = Math.max(yFinO, yFinD) + 16;

      // ── Comentario libre (compartido)
      if (d.comentario) {
        doc.fillColor('#1A6FFF').font('Helvetica-Bold').fontSize(11)
           .text('COMENTARIO DEL CLIENTE', MARGIN, y);
        y += 18;
        doc.fillColor('#F8FAFC').rect(MARGIN, y - 4, CONTENT_W, 6).fill();
        doc.fillColor('#0F1923').font('Helvetica').fontSize(10)
           .text(d.comentario, MARGIN + 4, y, { width: CONTENT_W - 8, lineGap: 3 });
        y = doc.y + 16;
      }

      // ── Fotos
      if (fotosBuffers.length > 0) {
        // Si nos queda poco espacio en la página, saltamos a la siguiente
        if (y > 600) { doc.addPage(); y = 50; }
        doc.fillColor('#1A6FFF').font('Helvetica-Bold').fontSize(11)
           .text('FOTOS DEL LUGAR', MARGIN, y);
        y += 18;
        // 2 fotos por fila, cada una ~240px ancho
        const fotoW = (CONTENT_W - 10) / 2;
        const fotoH = 180;
        let col = 0;
        let rowY = y;
        fotosBuffers.forEach(function(buf, idx) {
          const x = MARGIN + col * (fotoW + 10);
          try {
            doc.image(buf, x, rowY, { width: fotoW, height: fotoH, fit: [fotoW, fotoH], align: 'center' });
          } catch(e) { /* foto inválida, skip */ }
          col++;
          if (col >= 2) {
            col = 0;
            rowY += fotoH + 10;
            if (rowY > 700 && idx < fotosBuffers.length - 1) {
              doc.addPage();
              rowY = 50;
            }
          }
        });
      }

      // ── Footer
      const FH = doc.page.height;
      doc.fillColor('#94A3B8').font('Helvetica').fontSize(8)
         .text('Generado por MudateYa · mudateya.ar', MARGIN, FH - 30, { width: CONTENT_W, align: 'center' });

      doc.end();
    } catch(err) {
      reject(err);
    }
  });
}

async function notificarMudanceros(mudanza) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!process.env.RESEND_API_KEY) return;

  const expira = fmtVencimientoAR(mudanza.expira);
  const esFlete = mudanza.tipo === 'flete';
  const tipoLabel = esFlete ? '📦 Nuevo flete' : '🚛 Nueva mudanza';
  // Pack/nivel que pidió el cliente — el mudancero necesita saberlo para cotizar correctamente
  const nivelMap = { esencial: '📦 Esencial', integral: '🛠️ Integral', llave: '🔑 Llave en mano', flete: '🚚 Flete' };
  const nivelLabel = esFlete ? '' : (nivelMap[mudanza.nivel] || '');

  // ── Resolver info del partner (Mudafy o inmobiliaria asociada) ──
  // Mudafy queda hardcoded por legacy. Para cualquier otro slug, leemos la config
  // de Redis (inmobiliaria:{slug}) para mostrar el nombre real en el mail. Si la
  // inmobiliaria no existe o se borró, fallback al slug crudo para no romper.
  let partnerInfo = null;
  if (mudanza.partner) {
    if (mudanza.partner === 'mudafy') {
      partnerInfo = { slug: 'mudafy', nombre: 'Mudafy', esPartner: true };
    } else {
      try {
        const inmoCfg = await getJSON('inmobiliaria:' + mudanza.partner);
        if (inmoCfg) {
          partnerInfo = { slug: mudanza.partner, nombre: inmoCfg.nombre || mudanza.partner, esPartner: true };
        } else {
          partnerInfo = { slug: mudanza.partner, nombre: mudanza.partner, esPartner: true };
        }
      } catch(e) {
        partnerInfo = { slug: mudanza.partner, nombre: mudanza.partner, esPartner: true };
      }
    }
  }

  // Banner para el MUDANCERO - le aclara que es un lead premium (con comisión 25%).
  // Esto es importante: que sepa de antemano que la comisión sobre este pedido será
  // mayor que la normal del 15%. Aplica tanto a Mudafy como a inmobiliarias nuevas.
  const bannerMudafyMudancero = partnerInfo
    ? `<div style="background:#FFF0F0;border-bottom:1px solid rgba(255,107,107,0.3);padding:11px 28px;font-size:16px;color:#E85555;font-weight:700;display:flex;align-items:center"><span style="background:#FF6B6B;color:#fff;width:22px;height:22px;display:inline-block;line-height:22px;text-align:center;border-radius:6px;margin-right:10px;font-size:16px">🤝</span>Cliente de ${partnerInfo.nombre} · Comisión 25%</div>`
    : '';

  // Banner detalles adicionales — aparece si el cliente cargó detalles antes de enviar
  // Banner detalles del lugar — aparece si el pedido tiene tipo de lugar, detalles por lado o detalles adicionales
  const tieneInfoExtra = !!(mudanza.tipoOrigen || mudanza.tipoDestino) ||
    !!(mudanza.detallesOrigen || mudanza.detallesDestino) ||
    !!(mudanza.detallesAdicionales && Object.keys(mudanza.detallesAdicionales).length > 0);
  const bannerDetalles = tieneInfoExtra
    ? `<div style="background:#EEF4FF;border-bottom:1px solid #C7D9FF;padding:11px 28px;font-size:16px;color:#1A6FFF;font-weight:600;display:flex;align-items:center"><span style="background:#1A6FFF;color:#fff;width:22px;height:22px;display:inline-block;line-height:22px;text-align:center;border-radius:6px;margin-right:10px;font-size:16px">📋</span>Detalles del lugar adjuntos en PDF</div>`
    : '';

  // Banner URGENTE — el pedido tiene una ventana corta (3hs corridas, ver
  // action=publicar) en vez de las 24hs hábiles normales. Necesita destacarse
  // bien arriba para que el mudancero sepa que tiene que responder ya, no
  // "cuando pueda" como cualquier otro pedido.
  const bannerUrgente = mudanza.urgente
    ? `<div style="background:#FEE2E2;border-bottom:1px solid #FCA5A5;padding:11px 28px;font-size:16px;color:#B91C1C;font-weight:700;display:flex;align-items:center"><span style="background:#DC2626;color:#fff;width:22px;height:22px;display:inline-block;line-height:22px;text-align:center;border-radius:6px;margin-right:10px;font-size:16px">🚨</span>URGENTE · Necesitan mudarse ya, respondé lo antes posible</div>`
    : '';

  const emailHtml = (nombreMudancero) => `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="margin:0;padding:0"><div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
    <div style="background:#003580;padding:20px 28px"><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#22C36A">Ya</span><span style="font-size:16px;color:rgba(255,255,255,.7);margin-left:12px">Nuevo pedido disponible</span></div>
    ${bannerMudafyMudancero}
    ${bannerDetalles}
    <div style="background:#EEF4FF;border-bottom:1px solid #C7D9FF;padding:12px 28px;font-size:16px;color:#1A6FFF;font-weight:600">${tipoLabel} · ${mudanza.id}</div>
    <div style="padding:28px">
      <p style="font-size:18px;color:#0F1923;margin:0 0 20px">Hola${nombreMudancero ? ' ' + nombreMudancero : ''}, hay un nuevo pedido disponible en tu zona.</p>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="color:#64748B;padding:12px 0;width:35%;font-size:16px">De</td><td style="font-weight:600;color:#0F1923;font-size:16px;padding:12px 0">${mudanza.desde}</td></tr>
        <tr style="background:#F5F7FA"><td style="color:#64748B;padding:8px 8px;font-size:16px">A</td><td style="font-weight:600;color:#0F1923;font-size:16px;padding:12px 0">${mudanza.hasta}</td></tr>
        <tr><td style="color:#64748B;padding:12px 0;font-size:16px">Tamaño</td><td style="font-size:16px;color:#0F1923;font-weight:600;padding:12px 0">${mudanza.ambientes}</td></tr>
        ${nivelLabel ? `<tr style="background:#F5F7FA"><td style="color:#64748B;padding:8px 8px;font-size:16px">Servicio</td><td style="font-size:16px;color:#0F1923;font-weight:600;padding:12px 0">${nivelLabel}</td></tr>` : ''}
        ${mudanza.km ? `<tr><td style="color:#64748B;padding:12px 0;font-size:16px">Distancia</td><td style="font-size:16px;color:#0F1923;font-weight:600;padding:12px 0">${parseInt(mudanza.km)} km</td></tr>` : ''}
        <tr style="background:#F5F7FA"><td style="color:#64748B;padding:8px 8px;font-size:16px">Fecha</td><td style="font-size:16px;color:#0F1923;padding:12px 0">${fmtFechaAR(mudanza.fecha)}</td></tr>
        ${mudanza.horaOrigen ? `<tr><td style="color:#64748B;padding:12px 0;font-size:16px">Hora aprox.</td><td style="font-size:16px;color:#0F1923;font-weight:700;padding:12px 0">⏰ ${mudanza.horaOrigen} hs</td></tr>` : ''}
        <tr${mudanza.horaOrigen ? ' style="background:#F5F7FA"' : ''}><td style="color:#64748B;padding:8px${mudanza.horaOrigen ? ' 8px' : ' 0'};font-size:16px">Expira</td><td style="color:#F59E0B;font-weight:600;font-size:16px;padding:12px 0">${expira}</td></tr>
      </table>
      <p style="font-size:15px;color:#64748B;margin:14px 0 0;line-height:1.75;background:#FFF7ED;border-left:3px solid #F59E0B;padding:9px 12px;border-radius:6px">💡 El precio lo cotizás vos según tu tarifa. Entrá a tu cuenta para enviar tu propuesta.</p>
      <div style="margin-top:20px">
        <a href="https://mudateya.ar/mi-cuenta" style="display:inline-block;background:#22C36A;color:#003580;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:17px">Cotizar ahora →</a>
      </div>
    </div>
    <div style="background:#F5F7FA;border-top:1px solid #E2E8F0;padding:14px 28px;font-size:14px;color:#94A3B8;font-family:monospace">MudateYa · mudateya.ar</div>
  </div></body></html>`;

  // Banner para el ADMIN — banner arriba + bloque "Origen del lead" en el cuerpo.
  // Para el admin SÍ mostramos asesor + propiedad (Mudafy) o comisión a liquidar (inmo nueva).
  const bannerMudafyAdmin = partnerInfo
    ? `<div style="background:#FFF0F0;border-bottom:1px solid rgba(255,107,107,0.3);padding:11px 28px;font-size:16px;color:#E85555;font-weight:700;display:flex;align-items:center"><span style="background:#FF6B6B;color:#fff;width:22px;height:22px;display:inline-block;line-height:22px;text-align:center;border-radius:6px;margin-right:10px;font-size:16px">🏠</span>Lead vino de ${partnerInfo.nombre} · Conversión B2B</div>`
    : '';

  // Bloque "Origen del lead" en el cuerpo del mail al admin.
  // Mudafy: muestra asesor + propiedad (info de CRM que viene en el URL).
  // Inmobiliaria nueva: muestra el % de comisión a liquidar.
  const comisionInmoPct = parseFloat(mudanza.comisionInmobiliariaPct) || 0;
  const bloqueOrigenAdmin = partnerInfo
    ? `<div style="font-size:14px;color:#E85555;font-weight:700;letter-spacing:1.5px;margin:8px 0 8px">🏠 ORIGEN DEL LEAD — ${partnerInfo.nombre.toUpperCase()}</div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:18px;background:#FFF5F5;border-radius:8px;overflow:hidden">
        <tr><td style="color:#64748B;padding:9px 12px;width:35%;font-size:16px">Partner</td><td style="font-weight:700;color:#E85555;font-size:16px;padding:13px 0">🏠 ${partnerInfo.nombre}</td></tr>
        ${mudanza.partnerAsesor ? `<tr><td style="color:#64748B;padding:9px 12px;font-size:16px;border-top:1px solid rgba(255,107,107,0.15)">Asesor</td><td style="font-family:monospace;color:#0F1923;font-size:16px;padding:13px 0;border-top:1px solid rgba(255,107,107,0.15)">${mudanza.partnerAsesor}</td></tr>` : ''}
        ${mudanza.partnerPropiedad ? `<tr><td style="color:#64748B;padding:9px 12px;font-size:16px;border-top:1px solid rgba(255,107,107,0.15)">Propiedad</td><td style="font-family:monospace;color:#0F1923;font-size:16px;padding:13px 0;border-top:1px solid rgba(255,107,107,0.15)">${mudanza.partnerPropiedad}</td></tr>` : ''}
        ${comisionInmoPct > 0 ? `<tr><td style="color:#64748B;padding:9px 12px;font-size:16px;border-top:1px solid rgba(255,107,107,0.15)">Comisión a liquidar</td><td style="font-weight:700;color:#78350F;font-size:16px;padding:13px 0;border-top:1px solid rgba(255,107,107,0.15)">${comisionInmoPct}% del precio final</td></tr>` : ''}
      </table>`
    : '';

  // ── Template SEPARADO para el ADMIN ─────────────────────
  // Se diferencia visualmente con header amarillo, muestra datos del
  // cliente (nombre/email/WA) y el botón apunta al panel admin (no a cotizar).
  const emailHtmlAdmin = () => `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="margin:0;padding:0"><div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
    <div style="background:#003580;padding:20px 28px"><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#22C36A">Ya</span><span style="font-size:16px;color:rgba(255,255,255,.7);margin-left:12px">📋 Panel admin</span></div>
    ${bannerMudafyAdmin}
    <div style="background:#FFF7ED;border-bottom:1px solid #FED7AA;padding:12px 28px;font-size:16px;color:#B45309;font-weight:600">⚙️ Notificación admin · ${tipoLabel} · ${mudanza.id}</div>
    <div style="padding:28px">
      <p style="font-size:18px;color:#0F1923;margin:0 0 16px">Hola Admin, se publicó un nuevo pedido en la plataforma.</p>

      <div style="font-size:14px;color:#64748B;font-weight:700;letter-spacing:1.5px;margin:8px 0 8px">DATOS DEL PEDIDO</div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:18px">
        <tr><td style="color:#64748B;padding:11px 0;width:35%;font-size:16px">De</td><td style="font-weight:600;color:#0F1923;font-size:16px;padding:11px 0">${mudanza.desde}</td></tr>
        <tr style="background:#F5F7FA"><td style="color:#64748B;padding:7px 8px;font-size:16px">A</td><td style="font-weight:600;color:#0F1923;font-size:16px;padding:11px 0">${mudanza.hasta}</td></tr>
        <tr><td style="color:#64748B;padding:11px 0;font-size:16px">Tamaño</td><td style="font-size:16px;color:#0F1923;font-weight:600;padding:11px 0">${mudanza.ambientes}</td></tr>
        ${nivelLabel ? `<tr style="background:#F5F7FA"><td style="color:#64748B;padding:7px 8px;font-size:16px">Servicio</td><td style="font-size:16px;color:#0F1923;font-weight:600;padding:11px 0">${nivelLabel}</td></tr>` : ''}
        ${mudanza.km ? `<tr><td style="color:#64748B;padding:11px 0;font-size:16px">Distancia</td><td style="font-size:16px;color:#0F1923;font-weight:600;padding:11px 0">${parseInt(mudanza.km)} km</td></tr>` : ''}
        <tr style="background:#F5F7FA"><td style="color:#64748B;padding:7px 8px;font-size:16px">Fecha</td><td style="font-size:16px;color:#0F1923;padding:11px 0">${fmtFechaAR(mudanza.fecha)}</td></tr>
        <tr><td style="color:#64748B;padding:11px 0;font-size:16px">Modo</td><td style="font-size:16px;color:#0F1923;padding:11px 0">${mudanza.modoCotizacion === 'dirigido' ? '🎯 Dirigido' : '📢 Abierto'}</td></tr>
      </table>

      <div style="font-size:14px;color:#64748B;font-weight:700;letter-spacing:1.5px;margin:8px 0 8px">DATOS DEL CLIENTE</div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:18px">
        <tr><td style="color:#64748B;padding:11px 0;width:35%;font-size:16px">Nombre</td><td style="font-weight:600;color:#0F1923;font-size:16px;padding:11px 0">${mudanza.clienteNombre || '—'}</td></tr>
        <tr style="background:#F5F7FA"><td style="color:#64748B;padding:7px 8px;font-size:16px">Email</td><td style="font-size:16px;color:#0F1923;padding:11px 0"><a href="mailto:${mudanza.clienteEmail || ''}" style="color:#003580;text-decoration:none">${mudanza.clienteEmail || '—'}</a></td></tr>
        <tr><td style="color:#64748B;padding:11px 0;font-size:16px">WhatsApp</td><td style="font-size:16px;color:#0F1923;padding:11px 0">${mudanza.clienteWA ? `<a href="https://wa.me/${String(mudanza.clienteWA).replace(/\D/g,'')}" style="color:#22C36A;text-decoration:none;font-weight:600">${mudanza.clienteWA}</a>` : '—'}</td></tr>
      </table>

      ${bloqueOrigenAdmin}

      <div style="margin-top:20px">
        <a href="https://mudateya.ar/admin" style="display:inline-block;background:#003580;color:#fff;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:17px">Ver en panel admin →</a>
      </div>
    </div>
    <div style="background:#F5F7FA;border-top:1px solid #E2E8F0;padding:14px 28px;font-size:14px;color:#94A3B8;font-family:monospace">MudateYa · mudateya.ar · ID: ${mudanza.id}</div>
  </div></body></html>`;

  // 1. Notificar al admin siempre (con su propio template)
  if (adminEmail) {
    try {
      await resend.emails.send({
        from: 'MudateYa <noreply@mudateya.ar>', reply_to:'hola@mudateya.ar',
        to: adminEmail,
        subject: `[ADMIN] ${tipoLabel} — ${mudanza.desde} → ${mudanza.hasta} · ${mudanza.id}`,
        html: emailHtmlAdmin(),
      });
    } catch(e) { console.error('Email admin error:', e.message); }
  }

  // 2. Notificar a mudanceros — REGLA:
  //    - modoCotizacion 'dirigido' (el cliente eligió mudanceros puntuales,
  //      ej. desde /m/{slug}, el perfil de un mudancero): SOLO a esos, sea
  //      cual sea el canal. Esto ya funcionaba así, no se tocó.
  //    - Cualquier pedido en modo abierto (WEB o BOT): a los que cubren la
  //      ZONA del pedido (mismo matching de zona de match-mudanceros.js).
  //      Antes esto SOLO se aplicaba a los pedidos del bot -- el botón "Pedile
  //      presupuesto a todos" de la web mandaba a TODOS los aprobados sin
  //      importar dónde estuvieran (ej. un mudancero de Mendoza se enteraba
  //      de un pedido CABA↔GBA). Unificado: mismo criterio para los dos canales.
  try {
    const todosEmails = await getJSON('mudanceros:todos') || [];
    const destinatarios = [];
    const palabrasZonaPedido = palabrasZona(`${mudanza.origen || mudanza.desde || ''} ${mudanza.destino || mudanza.hasta || ''}`);

    for (const email of todosEmails) {
      try {
        const p = await getJSON(`mudancero:perfil:${email}`);
        if (!p || p.estado !== 'aprobado') continue;
        if (!p.email) continue;

        if (mudanza.modoCotizacion === 'dirigido') {
          if (!(mudanza.mudancerosInvitados || []).includes(email)) continue;
        } else {
          const cobertura = `${p.zonaBase || ''} ${p.zonasExtra || ''}`;
          if (!coincideZona(cobertura, palabrasZonaPedido)) continue;
        }

        destinatarios.push({ email: p.email, nombre: p.nombre || '', tel: p.telefono || '' });
      } catch(e) { /* ignorar errores individuales */ }
    }

    // ── Generar PDF de detalles del pedido (una sola vez para todos los mudanceros) ──
    // Se genera siempre que haya tipo de lugar (caso nuevo) o detallesAdicionales (compat).
    // La función decide internamente si vale la pena generar.
    let pdfDetallesBase64 = null;
    let pdfDetallesNombre = null;
    try {
      pdfDetallesBase64 = await generarPDFDetallesBase64(mudanza);
      if (pdfDetallesBase64) {
        pdfDetallesNombre = 'Detalles-' + (mudanza.id || 'pedido') + '.pdf';
      }
    } catch(e) {
      console.warn('Error generando PDF detalles:', e.message);
    }

    // Enviar en lotes de 5 para no saturar la API
    for (let i = 0; i < destinatarios.length; i += 5) {
      const lote = destinatarios.slice(i, i + 5);
      await Promise.all(lote.map(function(dest) {
        const params = {
          from: 'MudateYa <noreply@mudateya.ar>', reply_to:'hola@mudateya.ar',
          to: dest.email,
          subject: `${tipoLabel} disponible — ${mudanza.desde} → ${mudanza.hasta}`,
          html: emailHtml(dest.nombre),
        };
        if (pdfDetallesBase64) {
          params.attachments = [{
            filename: pdfDetallesNombre,
            content:  pdfDetallesBase64,
          }];
        }
        return resend.emails.send(params).catch(function(e) { console.error('Email mudancero error:', dest.email, e.message); });
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

    // WhatsApp a los mudanceros (plantilla nuevo_pedido_mudancero → "entrá a
    // mi-cuenta a cotizar"). GATED por aprobación de Meta: enviarPlantilla solo
    // manda si la plantilla está 'approved'. Mientras esté pending NO manda nada
    // (el aviso sigue por email + push). Cuando Meta la apruebe, se activa solo.
    // Respeta modo dirigido (destinatarios ya viene filtrado).
    try {
      const { enviarPlantilla } = require('./_plantillas');
      const conTel = destinatarios.filter(function(d){ return d.tel; });
      const fechaTxt = fmtFechaAR(mudanza.fecha) || 'a coordinar';
      for (let i = 0; i < conTel.length; i += 5) {
        const lote = conTel.slice(i, i + 5);
        await Promise.all(lote.map(function(dest){
          const nom = (dest.nombre || '').split(' ')[0] || 'Hola';
          // Sin texto de fallback a propósito: mientras la plantilla esté 'pending',
          // enviarPlantilla no hace ninguna llamada a Twilio (gate limpio). Se activa
          // sola cuando Meta la apruebe.
          return enviarPlantilla(
            dest.tel, 'nuevo_pedido_mudancero',
            { 1: nom, 2: mudanza.desde, 3: mudanza.hasta, 4: fechaTxt }
          ).catch(function(e){ console.error('WhatsApp mudancero error:', dest.tel, e && e.message); });
        }));
      }
    } catch(e) { console.warn('Aviso WhatsApp mudanceros:', e.message); }
  } catch(e) {
    console.error('Error notificando mudanceros:', e.message);
  }
}
// Se exporta para reusarla desde el bot de WhatsApp (whatsapp.js): mismo email al
// mudancero + PDF de detalles del pedido adjunto, respetando el modo 'dirigido'.
module.exports.notificarMudanceros = notificarMudanceros;
// El bot también usa el generador de PDF de detalles directamente (para su aviso
// de prueba a mudatest, que no exige que el perfil esté 'aprobado').
module.exports.generarPDFDetallesBase64 = generarPDFDetallesBase64;
// Exportados para los tests automáticos (tests/cotizaciones-validez.test.js) —
// la ventana de validez de 7 días de una cotización, ver DIAS_VALIDEZ_COTIZACION.
module.exports.cotizacionVencida = cotizacionVencida;
module.exports.vencimientoCotizacion = vencimientoCotizacion;
module.exports.DIAS_VALIDEZ_COTIZACION = DIAS_VALIDEZ_COTIZACION;

// ════════════════════════════════════════════════════════════════════
// Mail de confirmación al cliente cuando publica un pedido nuevo.
// Se dispara al final de la action 'publicar'. NO incluye PDF (a propósito):
// el PDF lo recibe cuando una cotización es aceptada (notificarCliente).
// Acá solo confirmamos que el pedido se publicó + resumen para que el cliente
// tenga el ID en su mail y sepa cómo sigue el proceso.
// ════════════════════════════════════════════════════════════════════
async function notificarClienteNuevoPedido(mudanza) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  if (!process.env.RESEND_API_KEY) return;
  if (!mudanza.clienteEmail) return;

  const esFlete = mudanza.tipo === 'flete';
  const tipoLabel = esFlete ? 'flete' : 'mudanza';
  const expira = fmtVencimientoAR(mudanza.expira);
  const nivelMap = { esencial: '📦 Esencial', integral: '🛠️ Integral', llave: '🔑 Llave en mano', flete: '🚚 Flete' };
  const nivelLabel = esFlete ? '' : (nivelMap[mudanza.nivel] || '');

  // Resolver info del partner (mismo patrón que en notificarMudanceros).
  // Si vino de Mudafy o de una inmobiliaria asociada, lo aclaramos en el header.
  let partnerNombre = null;
  if (mudanza.partner) {
    if (mudanza.partner === 'mudafy') partnerNombre = 'Mudafy';
    else {
      try {
        const inmoCfg = await getJSON('inmobiliaria:' + mudanza.partner);
        partnerNombre = (inmoCfg && inmoCfg.nombre) || mudanza.partner;
      } catch(e) { partnerNombre = mudanza.partner; }
    }
  }

  // Banner que aclara el origen del pedido al cliente
  const bannerPartner = partnerNombre
    ? `<div style="background:#FFF7ED;border-bottom:1px solid #FED7AA;padding:11px 28px;font-size:16px;color:#9A3412;font-weight:600;display:flex;align-items:center"><span style="background:#F59E0B;color:#fff;width:22px;height:22px;display:inline-block;line-height:22px;text-align:center;border-radius:6px;margin-right:10px;font-size:16px">🏠</span>Pedido enviado vía ${partnerNombre}</div>`
    : '';

  // Helpers para formatear detalles por lado (origen/destino).
  // Reusamos los mismos LABELS_CORTOS que el PDF para mantener consistencia.
  const LABELS_LADO = {
    ascensor:        'Con ascensor',
    izaje:           'Necesita izaje',
    soga:            'Necesita soga',
    balconTerraza:   'Balcón / terraza',
    pasilloAngosto:  'Pasillo angosto',
    escaleras:       'Hay escaleras',
    cocheraGarage:   'Puerta de cochera',
    estDificil:      'Estac. difícil',
    mascotaEspecial: 'Mascota / especial'
  };

  function formatTipoLado(tipo, piso, depto) {
    if (!tipo) return '<span style="color:#94A3B8;font-style:italic">No indicado</span>';
    if (tipo === 'casa') return 'Casa';
    let txt = 'Departamento';
    if (piso)  txt += ' · Piso ' + piso;
    if (depto) txt += ' · Depto ' + depto;
    return txt;
  }

  function formatDetallesLado(detallesLado) {
    if (!detallesLado) return '';
    const items = [];
    Object.keys(LABELS_LADO).forEach(function(k) {
      if (detallesLado[k] === true) {
        let lbl = LABELS_LADO[k];
        if (k === 'escaleras' && detallesLado.escalerasPisos) {
          lbl += ' (' + detallesLado.escalerasPisos + ' piso' + (detallesLado.escalerasPisos > 1 ? 's' : '') + ')';
        }
        items.push(lbl);
      }
    });
    if (!items.length) return '';
    return '<div style="margin-top:6px;font-size:15px;color:#475569;line-height:1.7">' +
      items.map(function(it) { return '• ' + it; }).join('<br>') +
      '</div>';
  }

  // Bloque "Detalles del lugar" en 2 columnas (origen / destino), solo si hay datos.
  const tieneDetallesLado = !!(mudanza.tipoOrigen || mudanza.tipoDestino || mudanza.detallesOrigen || mudanza.detallesDestino);
  const bloqueDetallesLado = tieneDetallesLado ? `
    <div style="margin-top:18px;background:#FFFBEB;border:1px solid #FDE68A;border-radius:10px;padding:14px 16px">
      <div style="font-size:14px;color:#92400E;font-weight:700;letter-spacing:1px;margin-bottom:10px">DETALLES DEL LUGAR</div>
      <table style="width:100%;border-collapse:collapse">
        <tr style="vertical-align:top">
          <td style="width:50%;padding-right:8px">
            <div style="font-size:14px;color:#92400E;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Origen</div>
            <div style="font-size:16px;color:#0F1923;font-weight:600">${formatTipoLado(mudanza.tipoOrigen, mudanza.pisoOrigen, mudanza.deptoOrigen)}</div>
            ${mudanza.horaOrigen ? `<div style="margin-top:4px;font-size:15px;color:#92400E;font-weight:600">⏰ Inicio aprox: ${mudanza.horaOrigen} hs</div>` : ''}
            ${formatDetallesLado(mudanza.detallesOrigen)}
          </td>
          <td style="width:50%;padding-left:8px;border-left:1px solid #FDE68A">
            <div style="font-size:14px;color:#92400E;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;padding-left:8px">Destino</div>
            <div style="font-size:16px;color:#0F1923;font-weight:600;padding-left:8px">${formatTipoLado(mudanza.tipoDestino, mudanza.pisoDestino, mudanza.deptoDestino)}</div>
            <div style="padding-left:8px">${formatDetallesLado(mudanza.detallesDestino)}</div>
          </td>
        </tr>
      </table>
    </div>` : '';

  // Comentario libre si el cliente lo cargó
  const comentario = mudanza.detallesAdicionales && mudanza.detallesAdicionales.comentario;
  const bloqueComentario = comentario ? `
    <div style="margin-top:14px;background:#EEF4FF;border:1px solid #C7D9FF;border-radius:10px;padding:12px 14px">
      <div style="font-size:14px;color:#1A6FFF;font-weight:700;letter-spacing:1px;margin-bottom:6px">TU COMENTARIO</div>
      <div style="font-size:16px;color:#0F1923;line-height:1.5">${String(comentario).replace(/</g, '&lt;')}</div>
    </div>` : '';

  // Cantidad de fotos cargadas (no las adjuntamos al mail, solo lo mencionamos)
  const fotosCount = (mudanza.fotos && mudanza.fotos.length) ||
    (mudanza.detallesAdicionales && mudanza.detallesAdicionales.fotos && mudanza.detallesAdicionales.fotos.length) || 0;
  const bloqueFotos = fotosCount > 0 ? `
    <div style="margin-top:10px;font-size:15px;color:#64748B;background:#F5F7FA;border-radius:8px;padding:9px 12px">📷 Cargaste ${fotosCount} foto${fotosCount > 1 ? 's' : ''} — los mudanceros las van a ver al cotizar.</div>` : '';

  const primerNombre = (mudanza.clienteNombre || '').split(' ')[0] || 'Hola';

  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#F5F7FA">
<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
  <div style="background:#003580;padding:20px 28px"><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#22C36A">Ya</span><span style="font-size:16px;color:rgba(255,255,255,.7);margin-left:12px">Tu pedido fue publicado</span></div>
  ${bannerPartner}
  <div style="background:#EEF4FF;border-bottom:1px solid #C7D9FF;padding:12px 28px;font-size:16px;color:#1A6FFF;font-weight:600">${esFlete ? '📦 Flete' : '🚛 Mudanza'} · ${mudanza.id}</div>
  <div style="padding:28px">
    <p style="font-size:18px;color:#0F1923;margin:0 0 8px"><strong>${primerNombre}</strong>, tu pedido fue publicado correctamente.</p>
    <p style="font-size:17px;color:#475569;margin:0 0 20px;line-height:1.7">Los mudanceros verificados de tu zona ya recibieron tu solicitud. En las próximas horas vas a empezar a recibir cotizaciones. <strong>Cuando aceptes una y abones el anticipo</strong>, se habilitan los datos de contacto y vas a poder coordinar el detalle con ese mudancero por WhatsApp.</p>

    <div style="font-size:14px;color:#94A3B8;font-weight:700;letter-spacing:1px;margin-bottom:8px">RESUMEN DEL PEDIDO</div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:6px">
      <tr><td style="color:#64748B;padding:12px 0;width:35%;font-size:16px">De</td><td style="font-weight:600;color:#0F1923;font-size:16px;padding:12px 0">${mudanza.desde || '—'}</td></tr>
      <tr style="background:#F5F7FA"><td style="color:#64748B;padding:8px 8px;font-size:16px">A</td><td style="font-weight:600;color:#0F1923;font-size:16px;padding:12px 0">${mudanza.hasta || '—'}</td></tr>
      <tr><td style="color:#64748B;padding:12px 0;font-size:16px">Tamaño</td><td style="font-size:16px;color:#0F1923;font-weight:600;padding:12px 0">${mudanza.ambientes || '—'}</td></tr>
      ${nivelLabel ? `<tr style="background:#F5F7FA"><td style="color:#64748B;padding:8px 8px;font-size:16px">Pack</td><td style="font-size:16px;color:#0F1923;font-weight:600;padding:12px 0">${nivelLabel}</td></tr>` : ''}
      <tr><td style="color:#64748B;padding:12px 0;font-size:16px">Fecha</td><td style="font-size:16px;color:#0F1923;font-weight:600;padding:12px 0">${fmtFechaAR(mudanza.fecha)}</td></tr>
      ${mudanza.km ? `<tr style="background:#F5F7FA"><td style="color:#64748B;padding:8px 8px;font-size:16px">Distancia</td><td style="font-size:16px;color:#0F1923;padding:12px 0">${parseInt(mudanza.km)} km</td></tr>` : ''}
      <tr><td style="color:#64748B;padding:12px 0;font-size:16px">Pedido publicado hasta</td><td style="color:#F59E0B;font-weight:600;font-size:16px;padding:12px 0">${expira}</td></tr>
    </table>

    ${bloqueDetallesLado}
    ${bloqueComentario}
    ${bloqueFotos}

    <div style="margin-top:22px;text-align:center">
      <a href="https://mudateya.ar/mi-mudanza" style="display:inline-block;background:#22C36A;color:#003580;padding:13px 28px;border-radius:9px;text-decoration:none;font-weight:700;font-size:17px">Ver mis pedidos →</a>
    </div>

    <div style="margin-top:24px;padding:14px 16px;background:#F5F7FA;border-radius:10px;font-size:15px;color:#475569;line-height:1.7">
      <strong style="color:#0F1923">¿Dudas o algún cambio?</strong><br>
      Escribinos a <a href="mailto:hola&#64;mudateya.ar" style="color:#003580;font-weight:600;text-decoration:none">hola&#64;mudateya.ar</a> mencionando el ID de tu pedido: <code style="background:#fff;padding:1px 6px;border-radius:4px;font-family:monospace;font-size:14px">${mudanza.id}</code>
    </div>
  </div>
  <div style="background:#F5F7FA;border-top:1px solid #E2E8F0;padding:14px 28px;font-size:14px;color:#94A3B8;font-family:monospace;text-align:center">MudateYa · Marketplace de mudanzas verificadas · mudateya.ar</div>
</div>
</body></html>`;

  try {
    await resend.emails.send({
      from: 'MudateYa <noreply@mudateya.ar>',
      to: mudanza.clienteEmail,
      subject: `✅ Tu ${tipoLabel} ${mudanza.id} fue publicada · Mudanceros cotizando`,
      html: html,
      reply_to: 'hola@mudateya.ar'
    });
  } catch(e) {
    console.error('Error enviando confirmación a cliente:', e.message);
  }
}

// Detecta si la nota de una cotización pide un relevamiento/visita presencial
// para dar el precio final — para sugerirle al cliente mandar fotos en cambio
// (evita perder el pedido por la fricción de coordinar una visita).
function pideVisitaPresencial(nota) {
  return /relevamiento|visitar|visita\s+(presencial|domiciliaria)|recorrer\s+el\s+(lugar|domicilio)|pasar\s+a\s+ver|ir\s+a\s+ver\s+(el|la)|necesita(mos)?\s+ver\s+el\s+lugar/i.test(String(nota || ''));
}

async function notificarCliente(mudanza, cotizacion) {
  const esBot = mudanza.canal === 'whatsapp';

  // Pedido originado por WhatsApp (bot Emi): el cliente NO tiene email real
  // (usa uno sintético), así que se le avisa SOLO por WhatsApp. Solo se
  // entrega si la charla está dentro de la ventana de 24hs de WhatsApp.
  if (esBot && mudanza.clienteWA) {
    const { enviarWhatsAppTexto } = require('./_whatsapp');
    const { enviarPlantilla } = require('./_plantillas');
    const nomCli = (mudanza.clienteNombre || '').split(' ')[0] || 'Hola';
    const precioFmt = '$' + Number(cotizacion.precio || 0).toLocaleString('es-AR');
    const texto =
      `💰 ¡Llegó una cotización para tu ${mudanza.tipo || 'mudanza'}!\n` +
      `${cotizacion.mudanceroNombre || 'Un mudancero'} cotizó ${mudanza.desde} → ${mudanza.hasta} en ${precioFmt}` +
      (cotizacion.tiempoEstimado ? ` (${cotizacion.tiempoEstimado})` : '') + '.\n' +
      (cotizacion.nota ? `"${cotizacion.nota}"\n` : '') +
      `Respondeme por acá y te ayudo a verla y elegir 🙂`;
    // 1) Aviso: plantilla presupuestos_cliente si está aprobada, si no texto libre.
    try { await enviarPlantilla(mudanza.clienteWA, 'presupuestos_cliente', { 1: nomCli, 2: mudanza.desde || '', 3: mudanza.hasta || '' }, texto); }
    catch (e) { console.error('notificarCliente WhatsApp:', e.message); }
    // 2) PDF como adjunto (solo llega dentro de la ventana; fuera, el cliente lo pide a Emi).
    try {
      const pdfUrl = `https://mudateya.ar/api/cotizaciones?action=pdf&mudanzaId=${encodeURIComponent(mudanza.id)}&cotizacionId=${encodeURIComponent(cotizacion.id)}`;
      await enviarWhatsAppTexto(mudanza.clienteWA, '📄 Te paso el presupuesto en PDF:', pdfUrl);
    } catch (e) { console.error('notificarCliente WhatsApp pdf:', e.message); }
    // 3) Si el mudancero pidió relevamiento/visita, sugerirle fotos como alternativa.
    if (pideVisitaPresencial(cotizacion.nota)) {
      try {
        const textoSugerencia = `¡Hola ${nomCli}! ${cotizacion.mudanceroNombre || 'El mudancero'} te cotizó tu ${mudanza.tipo || 'mudanza'}, pero pidió visitarte para confirmar el precio final.\n\nSi querés evitarte la visita, respondeme por acá con fotos de lo que hay que mudar o contame más detalles por escrito — se los paso al mudancero para que ajuste el precio sin necesidad de ir. 📷`;
        await enviarPlantilla(mudanza.clienteWA, 'sugerencia_fotos_relevamiento', { 1: nomCli, 2: cotizacion.mudanceroNombre || 'El mudancero', 3: mudanza.tipo || 'mudanza' }, textoSugerencia);
      } catch (e) { console.warn('sugerencia fotos relevamiento:', e.message); }
    }
    return; // no seguimos con el mail: el email del cliente WhatsApp es sintético
  }

  // Cliente de la web: además del mail de siempre (abajo), avisale también
  // por WhatsApp si dejó su número. A diferencia del cliente del bot, acá NO
  // se corta el mail: son dos canales sumados, no uno u otro. Es un aviso que
  // no espera respuesta (a diferencia de ajuste de precio / calificación,
  // que por ahora siguen solo para clientes del bot — ver nota en el código).
  let sugerenciaFotosEntregada = false; // por WhatsApp — define si hace falta el respaldo por mail
  if (!esBot && mudanza.clienteWA) {
    try {
      const { enviarPlantilla } = require('./_plantillas');
      const nomCli = (mudanza.clienteNombre || '').split(' ')[0] || 'Hola';
      const precioFmt = '$' + Number(cotizacion.precio || 0).toLocaleString('es-AR');
      const texto =
        `💰 ¡Llegó una cotización para tu ${mudanza.tipo || 'mudanza'}!\n` +
        `${cotizacion.mudanceroNombre || 'Un mudancero'} cotizó ${mudanza.desde} → ${mudanza.hasta} en ${precioFmt}` +
        (cotizacion.tiempoEstimado ? ` (${cotizacion.tiempoEstimado})` : '') + '.\n' +
        `Entrá a mudateya.ar/mi-mudanza para verla y elegir.`;
      await enviarPlantilla(mudanza.clienteWA, 'presupuestos_cliente', { 1: nomCli, 2: mudanza.desde || '', 3: mudanza.hasta || '' }, texto);

      // Si el mudancero pidió relevamiento/visita, sugerirle fotos como alternativa.
      if (pideVisitaPresencial(cotizacion.nota)) {
        const textoSugerencia = `¡Hola ${nomCli}! ${cotizacion.mudanceroNombre || 'El mudancero'} te cotizó tu ${mudanza.tipo || 'mudanza'}, pero pidió visitarte para confirmar el precio final.\n\nSi querés evitarte la visita, respondeme por acá con fotos de lo que hay que mudar o contame más detalles por escrito — se los paso al mudancero para que ajuste el precio sin necesidad de ir. 📷`;
        try {
          const r = await enviarPlantilla(mudanza.clienteWA, 'sugerencia_fotos_relevamiento', { 1: nomCli, 2: cotizacion.mudanceroNombre || 'El mudancero', 3: mudanza.tipo || 'mudanza' }, textoSugerencia);
          sugerenciaFotosEntregada = !!(r && r.enviado);
        } catch (e) { console.warn('sugerencia fotos relevamiento (web):', e.message); }
      }
    } catch (e) { console.error('notificarCliente WhatsApp (web):', e.message); }
  }

  // Respaldo por mail de la sugerencia de fotos — SOLO si el WhatsApp no se
  // pudo entregar (sin número, fuera de la ventana de 24hs y sin plantilla
  // aprobada). No es un segundo aviso duplicado, es el respaldo garantizado
  // para cuando el canal principal no llega. Solo aplica a clientes web (los
  // del bot no tienen email real).
  if (!esBot && !sugerenciaFotosEntregada && pideVisitaPresencial(cotizacion.nota)) {
    try { await avisarSugerenciaFotosPorMail(mudanza, cotizacion); }
    catch (e) { console.warn('sugerencia fotos relevamiento (mail):', e.message); }
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  if (!process.env.RESEND_API_KEY) return;

  // Generar PDF con los datos de la cotización
  let attachments = [];
  try {
    const pdfBase64 = await generarPDFBase64({
      id:                cotizacion.id,
      validoHasta:       fmtValidezAR(cotizacion, mudanza),
      fechaEmision:      new Date().toLocaleDateString('es-AR', { day:'numeric', month:'long', year:'numeric', timeZone:'America/Argentina/Buenos_Aires' }),
      clienteNombre:     mudanza.clienteNombre,
      clienteEmail:      mudanza.clienteEmail,
      mudanceroNombre:   cotizacion.mudanceroNombre,
      mudancero_initials:(cotizacion.mudanceroNombre||'MV').slice(0,2).toUpperCase(),
      desde:             mudanza.desde,
      hasta:             mudanza.hasta,
      km:                mudanza.km,
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
    from: 'MudateYa <noreply@mudateya.ar>', reply_to:'hola@mudateya.ar',
    to: mudanza.clienteEmail,
    subject: `💰 Cotización de ${cotizacion.mudanceroNombre} — $${String(cotizacion.precio).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`,  
    html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <!-- Header -->
      <div style="background:#003580;padding:20px 28px;display:flex;align-items:center">
        <span style="font-family:Georgia,serif;font-size:28px;font-weight:900;color:#ffffff;letter-spacing:1px">Mudate</span><span style="font-family:Georgia,serif;font-size:28px;font-weight:900;color:#22C36A;letter-spacing:1px">Ya</span>
      </div>
      <!-- Badge -->
      <div style="background:#F0FFF6;border-bottom:1px solid #BBF7D0;padding:12px 28px;font-size:16px;color:#16A34A;font-weight:600">
        💰 Nueva cotización recibida
      </div>
      <!-- Body -->
      <div style="padding:28px">
        <p style="color:#475569;font-size:18px;margin-bottom:20px;line-height:1.7">
          <strong style="color:#0F1923">${cotizacion.mudanceroNombre}</strong> cotizó tu mudanza<br>
          <span style="color:#1A6FFF;font-weight:600">${mudanza.desde} → ${mudanza.hasta}</span>
        </p>
        <!-- Precio destacado -->
        <div style="background:#F5F7FA;border:1px solid #E2E8F0;border-left:4px solid #22C36A;border-radius:10px;padding:18px 22px;margin:0 0 20px">
          <div style="font-size:14px;color:#64748B;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;font-family:monospace">Precio cotizado</div>
          <div style="font-size:2rem;font-weight:700;color:#003580">$${cotizacion.precio.toLocaleString('es-AR')}</div>
          ${cotizacion.tiempoEstimado ? `<div style="color:#64748B;font-size:16px;margin-top:6px">⏱ ${cotizacion.tiempoEstimado}</div>` : ''}
          ${cotizacion.nota ? `<div style="color:#475569;font-size:16px;margin-top:8px;font-style:italic;border-top:1px solid #E2E8F0;padding-top:8px">"${cotizacion.nota}"</div>` : ''}
        </div>
        <!-- Aviso ajuste de precio -->
        <div style="background:#EFF6FF;border:1px solid #93C5FD;border-left:4px solid #1A6FFF;border-radius:10px;padding:14px 18px;margin:0 0 20px">
          <div style="font-size:14px;color:#1E40AF;text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin-bottom:6px;font-family:monospace">💡 Precio sujeto a ajuste</div>
          <div style="color:#1E3A8A;font-size:12.5px;line-height:1.55">
            Si al día de la mudanza hubiera condiciones no previstas (más volumen, accesos complicados, piso sin ascensor, etc.), el mudancero puede proponerte un ajuste justificado. Vos decidís si lo aceptás; si rechazás, <strong>recuperás tu anticipo completo</strong>.
          </div>
        </div>
        <p style="color:#64748B;font-size:16px;margin-bottom:20px">El detalle completo está adjunto en PDF.</p>
        <a href="https://mudateya.ar/mi-mudanza" style="display:inline-block;background:#1A6FFF;color:#ffffff;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:17px">Ver mis cotizaciones →</a>
      </div>
      <!-- Footer -->
      <div style="background:#F5F7FA;border-top:1px solid #E2E8F0;padding:14px 28px;font-size:14px;color:#94A3B8;font-family:monospace">
        MudateYa · mudateya.ar · hola@mudateya.ar
      </div>
    </div>`,
    attachments,
  });
}

// Mail (respaldo garantizado, sin restricción de ventana de WhatsApp) avisando
// que un mudancero pidió relevamiento/visita y sugiriendo mandarle fotos a Emi
// por WhatsApp en vez de coordinar una visita. Tono directo, no de plantilla.
async function avisarSugerenciaFotosPorMail(mudanza, cotizacion) {
  if (!process.env.RESEND_API_KEY || !mudanza.clienteEmail) return;
  const resend = new Resend(process.env.RESEND_API_KEY);
  const nomCli = (mudanza.clienteNombre || '').split(' ')[0] || 'Hola';
  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
    to: mudanza.clienteEmail,
    subject: `${cotizacion.mudanceroNombre || 'Un mudancero'} pidió visitarte antes de confirmar el precio`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <div style="background:#003580;padding:20px 28px">
        <span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#22C36A">Ya</span>
      </div>
      <div style="padding:28px">
        <p style="color:#0F1923;font-size:16px;line-height:1.7;margin:0 0 16px">Hola ${nomCli}, ¿cómo va?</p>
        <p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 16px"><strong>${cotizacion.mudanceroNombre || 'El mudancero'}</strong> te cotizó tu ${mudanza.tipo || 'mudanza'}, pero para confirmar el precio final pidió pasar a ver el lugar.</p>
        <p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 20px">Si te resulta más cómodo evitarte la visita, escribile a Emi (nuestra asistente) por WhatsApp con fotos de lo que hay que mudar, o contale un poco más por escrito — se lo pasamos al mudancero para que ajuste el precio sin necesidad de ir.</p>
        <div style="text-align:center;margin:20px 0">
          <a href="https://wa.me/12399462954?text=Hola%2C%20quiero%20mandar%20fotos%20de%20mi%20mudanza%20para%20evitar%20la%20visita" style="display:inline-block;background:#25D366;color:#fff;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:14px">Escribirle a Emi por WhatsApp →</a>
        </div>
        <div style="text-align:center;margin:4px 0 20px">
          <a href="https://mudateya.ar/mi-mudanza" style="display:inline-block;background:#F5F7FA;color:#003580;border:1px solid #E2E8F0;padding:11px 22px;border-radius:9px;text-decoration:none;font-weight:700;font-size:13px">Ver mi pedido →</a>
        </div>
        <p style="color:#94A3B8;font-size:11px;margin:0">Cualquier cosa, escribinos a <a href="mailto:hola&#64;mudateya.ar" style="color:#1A6FFF;font-weight:600">hola&#64;mudateya.ar</a></p>
      </div>
    </div>`,
  });
}

// Mail al cliente cuando vence el plazo de 24hs hábiles sin que haya elegido
// mudancero — con el DETALLE real de las cotizaciones que llegó a recibir
// (antes solo salía un WhatsApp genérico "tenés N presupuestos", sin decir
// cuáles ni a qué precio, y ni siquiera eso les llegaba a los clientes web
// sin WhatsApp cargado). Se exporta para que cron-cerrar-pedidos.js la llame.
async function avisarVencimientoPorMail(mudanza, cots) {
  if (!process.env.RESEND_API_KEY || !mudanza.clienteEmail || mudanza.canal === 'whatsapp') return false;
  const resend = new Resend(process.env.RESEND_API_KEY);
  const nomCli = (mudanza.clienteNombre || '').split(' ')[0] || 'Hola';
  const tipoLabel = mudanza.tipo === 'flete' ? 'flete' : 'mudanza';

  const SITE = process.env.SITE_URL || 'https://mudateya.ar';
  const filas = cots.map((c) => {
    const precio = c.precio || (Array.isArray(c.propuestas) && c.propuestas[0] && c.propuestas[0].precio) || 0;
    const elegirHref = `${SITE}/elegir?m=${encodeURIComponent(mudanza.id)}&cot=${encodeURIComponent(c.id)}`;
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 0;border-top:1px solid #E2E8F0">
      <div>
        <div style="font-size:15px;font-weight:600;color:#0F1923">${c.mudanceroNombre || 'Mudancero'}</div>
        <div style="font-size:16px;font-weight:700;color:#003580;margin-top:2px">$${Number(precio).toLocaleString('es-AR')}</div>
      </div>
      <a href="${elegirHref}" style="flex:none;display:inline-block;background:#22C36A;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px;white-space:nowrap">Elegir y pagar →</a>
    </div>`;
  }).join('');

  const subject = cots.length
    ? `Venció el plazo para elegir — tenías ${cots.length} presupuesto${cots.length > 1 ? 's' : ''}`
    : 'Venció el plazo — no llegamos a conseguirte presupuestos';

  const mensaje = cots.length
    ? `El plazo de 24hs hábiles para elegir tu ${tipoLabel} venció, pero estos son los presupuestos que llegaste a recibir. Elegí uno y te llevamos directo a pagar la seña:`
    : `No llegamos a conseguirte presupuestos a tiempo para tu ${tipoLabel}.`;

  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
    to: mudanza.clienteEmail,
    subject,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <div style="background:#003580;padding:20px 28px">
        <span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#22C36A">Ya</span>
      </div>
      <div style="padding:28px">
        <p style="color:#0F1923;font-size:16px;line-height:1.7;margin:0 0 16px">Hola ${nomCli},</p>
        <p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 8px">${mensaje}</p>
        ${cots.length ? `<div style="margin:8px 0 20px">${filas}</div>` : ''}
        <p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 20px">Si preferís ver todo junto o publicar un nuevo pedido, podés hacerlo desde tu cuenta.</p>
        <div style="text-align:center;margin:20px 0">
          <a href="https://mudateya.ar/mi-mudanza" style="display:inline-block;background:#22C36A;color:#003580;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:14px">Ver mi pedido →</a>
        </div>
        <p style="color:#94A3B8;font-size:11px;margin:0">Cualquier cosa, escribinos a <a href="mailto:hola&#64;mudateya.ar" style="color:#1A6FFF;font-weight:600">hola&#64;mudateya.ar</a></p>
      </div>
    </div>`,
  });
  return true;
}
module.exports.avisarVencimientoPorMail = avisarVencimientoPorMail;

// ════════════════════════════════════════════════════
// HELPER — Precio del PERFIL del mudancero según ambientes/tipo
// El monto del mail al mudancero seleccionado debe coincidir
// con el precio publicado en su perfil al momento de la elección.
// Soporta los dos modelos coexistentes en Redis:
//   • perfil.preciosLeads.{amb1..amb4,amb5plus}.{esencial,integral,llave}  (modelo nuevo)
//   • perfil.precios.{amb1..amb4} → número O {esencial,integral,llave}     (modelo viejo)
//   • perfil.precios.flete → número plano (siempre)
// Devuelve un Number con el precio. Si no encuentra precio configurado,
// devuelve null para que el caller pueda hacer fallback.
// ════════════════════════════════════════════════════
async function obtenerPrecioPerfil(mudanceroEmail, mudanza) {
  if (!mudanceroEmail) return null;
  try {
    var perfil = await getJSON('mudancero:perfil:' + mudanceroEmail);
    if (!perfil) return null;

    var esFlete = mudanza.tipo === 'flete' || mudanza.ambientes === 'Flete';

    // Caso flete: precio plano en perfil.precios.flete
    if (esFlete) {
      var pf = perfil.precios && perfil.precios.flete;
      var fleteNum = parseInt(pf) || 0;
      return fleteNum > 0 ? fleteNum : null;
    }

    // Caso mudanza: parsear "X ambientes" → "1".."4" o "5plus"
    // Formato esperado del wizard: "1 ambientes", "2 ambientes", ...
    var match = String(mudanza.ambientes || '').match(/^(\d+)/);
    var n = match ? parseInt(match[1]) : 0;
    if (n < 1) return null;

    // Mapeo a key de la matriz de precios
    var ambKey;
    if (n === 1) ambKey = 'amb1';
    else if (n === 2) ambKey = 'amb2';
    else if (n === 3) ambKey = 'amb3';
    else if (n === 4) ambKey = 'amb4';
    else ambKey = 'amb5plus'; // 5+ ambientes

    // Nivel del cliente: 'esencial' | 'integral' | 'llave'
    var nivel = mudanza.nivel || 'esencial';
    if (nivel !== 'esencial' && nivel !== 'integral' && nivel !== 'llave') {
      nivel = 'esencial';
    }

    // 1) Modelo nuevo: perfil.preciosLeads (matriz 5×3)
    if (perfil.preciosLeads && perfil.preciosLeads[ambKey]) {
      var pln = parseInt(perfil.preciosLeads[ambKey][nivel]) || 0;
      if (pln > 0) return pln;
    }

    // 2) Modelo viejo: perfil.precios (solo amb1..amb4, no amb5plus)
    var ambKeyViejo = (ambKey === 'amb5plus') ? 'amb4' : ambKey; // 5+ cae a amb4 en modelo viejo
    if (perfil.precios && perfil.precios[ambKeyViejo] != null) {
      var raw = perfil.precios[ambKeyViejo];
      // Puede ser número plano o {esencial,integral,llave}
      if (typeof raw === 'object' && raw !== null) {
        var v = parseInt(raw[nivel]) || 0;
        if (v > 0) return v;
      } else {
        var nv = parseInt(raw) || 0;
        if (nv > 0) return nv;
      }
    }

    return null;
  } catch (e) {
    console.error('obtenerPrecioPerfil error:', e && e.message);
    return null;
  }
}

// Avisa a los mudanceros que cotizaron (MENOS el ganador) que el cliente eligió
// otra propuesta, para que no sigan esperando. Push + email. No bloquea (fail-soft).
async function notificarMudancerosNoElegidos(mudanza, emailGanador) {
  try {
    const ganador = String(emailGanador || '').toLowerCase();
    const cotizadores = (mudanza.cotizaciones || []).map(c => c.mudanceroEmail).filter(Boolean);
    const invitados = (mudanza.mudancerosInvitados || []).filter(Boolean);
    const perdedores = Array.from(new Set([...cotizadores, ...invitados]))
      .filter(e => String(e).toLowerCase() !== ganador);
    if (!perdedores.length) return;
    const rutaTxt = `${(mudanza.desde||'').split(',')[0]} → ${(mudanza.hasta||'').split(',')[0]}`;
    // Push (no bloquea)
    Promise.all(perdedores.map(emailMud =>
      enviarPush(emailMud, {
        titulo: 'Pedido adjudicado a otro mudancero',
        cuerpo: `El cliente eligió otra propuesta: ${rutaTxt}`,
        link: '/mi-cuenta'
      }).catch(()=>{})
    )).catch(()=>{});
    // Email + WhatsApp a cada uno
    const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
    const { enviarPlantilla } = require('./_plantillas');
    for (const emailMud of perdedores) {
      try {
        const perfil = await getJSON(`mudancero:perfil:${emailMud}`);
        const nombre = (perfil && perfil.nombre) ? perfil.nombre.split(' ')[0] : 'Mudancero';

        if (resend) {
          resend.emails.send({
            from: 'MudateYa <noreply@mudateya.ar>', reply_to:'hola@mudateya.ar',
            to: emailMud,
            subject: `Pedido ya adjudicado — ${rutaTxt}`,
            html: `
              <div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;background:#F5F7FA;padding:20px">
                <div style="background:#003580;padding:18px 24px;border-radius:8px 8px 0 0">
                  <span style="font-family:Georgia,serif;font-size:18px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:18px;font-weight:900;color:#22C36A">Ya</span>
                </div>
                <div style="background:#fff;padding:24px;border-radius:0 0 8px 8px">
                  <h2 style="color:#0F1923;font-size:18px;margin:0 0 12px">Hola ${nombre},</h2>
                  <p style="color:#374151;font-size:17px;line-height:1.7">El cliente ya <b>eligió otra propuesta</b> para este pedido:</p>
                  <div style="background:#EEF2F7;border-left:4px solid #64748B;padding:12px 14px;border-radius:6px;margin:16px 0;font-size:17px;color:#334155">
                    <b>${rutaTxt}</b>
                  </div>
                  <p style="color:#374151;font-size:16px;line-height:1.7">Gracias por cotizar. Este pedido pasó a tu sección <b>Expirados</b>. ¡Seguí atento que vienen más!</p>
                </div>
              </div>
            `
          }).catch(e => console.warn('Email no-elegido:', emailMud, e.message));
        }

        if (perfil && perfil.telefono) {
          const textoLibre = `Hola ${nombre}, el cliente ya eligió otra propuesta para el pedido ${rutaTxt}. Este pedido pasó a tu sección Expirados. ¡Gracias por cotizar, seguí atento que vienen más! 🚚`;
          enviarPlantilla(perfil.telefono, 'mudancero_no_elegido', { 1: nombre, 2: rutaTxt }, textoLibre)
            .catch(e => console.warn('WhatsApp no-elegido:', emailMud, e.message));
        }
      } catch(e) { console.warn('Aviso no-elegido loop:', emailMud, e.message); }
    }
  } catch(e) { console.warn('notificarMudancerosNoElegidos:', e.message); }
}

async function enviarEmailAceptacion(mudanza, cot) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  if (!process.env.RESEND_API_KEY) return;

  const siteUrl = process.env.SITE_URL || 'https://mudateya.ar';
  // FIX: el monto del mail debe ser el precio del PERFIL del mudancero al
  // momento que el cliente lo eligió, no el cot.precio (que puede no existir
  // en flujo dirigido o estar desactualizado). Fallback defensivo a cot.precio.
  const precioPerfil = await obtenerPrecioPerfil(cot.mudanceroEmail, mudanza);
  const precioTotal = precioPerfil || parseInt(cot.precio) || 0;
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
      fechaEmision:      new Date().toLocaleDateString('es-AR', { day:'numeric', month:'long', year:'numeric', timeZone:'America/Argentina/Buenos_Aires' }),
      clienteNombre:     mudanza.clienteNombre,
      validoHasta:       fmtValidezAR(cot, mudanza),
      clienteEmail:      mudanza.clienteEmail,
      mudanceroNombre:   cot.mudanceroNombre,
      mudancero_initials:(cot.mudanceroNombre||'MV').slice(0,2).toUpperCase(),
      desde:             mudanza.desde,
      hasta:             mudanza.hasta,
      km:                mudanza.km,
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
      from: 'MudateYa <noreply@mudateya.ar>', reply_to:'hola@mudateya.ar',
      to: mudanza.clienteEmail,
      subject: `✅ Aceptaste la cotización — Pagá ahora el anticipo`,
      html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
        <!-- Header -->
        <div style="background:#003580;padding:20px 28px">
          <span style="font-family:Georgia,serif;font-size:28px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:28px;font-weight:900;color:#22C36A">Ya</span>
        </div>
        <!-- Badge -->
        <div style="background:#F0FFF6;border-bottom:1px solid #BBF7D0;padding:12px 28px;font-size:16px;color:#16A34A;font-weight:600">
          ✅ ¡Cotización aceptada!
        </div>
        <!-- Body -->
        <div style="padding:28px">
          <p style="color:#475569;font-size:18px;margin-bottom:18px;line-height:1.7">
            Hola <strong style="color:#0F1923">${mudanza.clienteNombre}</strong>, aceptaste la cotización de <strong style="color:#003580">${cot.mudanceroNombre}</strong>. Para confirmar la mudanza, completá el pago.
          </p>
          <!-- Resumen -->
          <div style="background:#F5F7FA;border:1px solid #E2E8F0;border-radius:10px;padding:16px 20px;margin:0 0 20px">
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="color:#64748B;padding:10px 0;width:35%;font-size:16px">Mudancero</td><td style="font-weight:600;color:#0F1923;font-size:16px">${cot.mudanceroNombre}</td></tr>
              <tr><td style="color:#64748B;padding:10px 0;font-size:16px">Contacto</td><td style="font-size:16px;color:#94A3B8">🔒 Se habilita con el anticipo</td></tr>
              <tr><td style="color:#64748B;padding:10px 0;font-size:16px">Ruta</td><td style="font-size:16px;color:#0F1923">${mudanza.desde} → ${mudanza.hasta}</td></tr>
              <tr><td style="color:#64748B;padding:10px 0;font-size:16px">Fecha</td><td style="font-size:16px;color:#0F1923">${fmtFechaAR(mudanza.fecha)}</td></tr>
              <tr><td style="color:#64748B;padding:10px 0;font-size:16px">Ambientes</td><td style="font-size:16px;color:#0F1923">${mudanza.ambientes}</td></tr>
              ${cot.nota ? `<tr><td style="color:#64748B;padding:10px 0;font-size:16px">Nota</td><td style="font-size:16px;color:#475569;font-style:italic">${cot.nota}</td></tr>` : ''}
            </table>
          </div>
          <!-- Precio + pago -->
          <div style="background:#EEF4FF;border:2px solid #1A6FFF;border-radius:12px;padding:22px;margin:0 0 20px;text-align:center">
            <div style="font-size:14px;color:#64748B;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;font-family:monospace">Anticipo a pagar ahora (50%)</div>
            <div style="font-size:2.2rem;font-weight:700;color:#003580;margin-bottom:4px">${anticipoFmt}</div>
            <div style="font-size:15px;color:#64748B;margin-bottom:18px">de un total de <strong>${precioFmt}</strong> · saldo al completar la mudanza</div>
            <a href="${linkPago}" style="display:inline-block;background:#009EE3;color:#ffffff;padding:14px 36px;border-radius:10px;text-decoration:none;font-weight:700;font-size:18px">💳 Pagar anticipo ${anticipoFmt} con Mercado Pago</a>
            <p style="color:#64748B;font-size:14px;margin-top:12px;margin-bottom:0">🔒 Pago 100% seguro (Mercado Pago o transferencia bancaria) · MudateYa protege tu dinero hasta confirmar el servicio</p>
          </div>
          <p style="color:#64748B;font-size:16px;margin-bottom:8px">¿Preferís pagar por transferencia? Entrá a <a href="${siteUrl}/mi-mudanza" style="color:#1A6FFF;font-weight:600">tu panel de mudanzas</a> y elegí esa opción — es igual de segura, con CVU único por pago.</p>
          <p style="color:#94A3B8;font-size:15px">Adjuntamos el comprobante en PDF para tus registros.</p>
        </div>
        <!-- Footer -->
        <div style="background:#F5F7FA;border-top:1px solid #E2E8F0;padding:14px 28px;font-size:14px;color:#94A3B8;font-family:monospace">
          MudateYa · mudateya.ar · hola@mudateya.ar
        </div>
      </div>`,
      attachments,
    });
  }

  // ── 4. Email al MUDANCERO ────────────────────────
  if (cot.mudanceroEmail) {
    await resend.emails.send({
      from: 'MudateYa <noreply@mudateya.ar>', reply_to:'hola@mudateya.ar',
      to: cot.mudanceroEmail,
      subject: `🎉 ¡Aceptaron tu cotización! — ${mudanza.desde} → ${mudanza.hasta}`,
      html: `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="margin:0;padding:0"><div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
        <div style="background:#003580;padding:20px 28px">
          <span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#22C36A">Ya</span>
          <span style="font-size:16px;color:rgba(255,255,255,.7);margin-left:12px">🎉 Te eligieron</span>
        </div>
        <div style="padding:28px">
          <p style="font-size:18px;color:#0F1923;margin-bottom:20px;line-height:1.7">
            <strong>${mudanza.clienteNombre}</strong> aceptó tu cotización. Te avisaremos cuando confirme el pago del anticipo.
          </p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:18px">
            <tr><td style="color:#64748B;padding:11px 0;width:35%;font-size:16px">Ruta</td><td style="font-weight:600;color:#0F1923;font-size:16px">${mudanza.desde} → ${mudanza.hasta}</td></tr>
            <tr style="background:#F5F7FA"><td style="color:#64748B;padding:11px 8px;font-size:16px">Fecha</td><td style="font-weight:600;color:#0F1923;font-size:16px;padding:11px 0">${fmtFechaAR(mudanza.fecha)}</td></tr>
            <tr><td style="color:#64748B;padding:11px 0;font-size:16px">Tamaño</td><td style="font-size:16px;color:#0F1923">${mudanza.ambientes||'—'}</td></tr>
            <tr style="background:#F5F7FA"><td style="color:#64748B;padding:11px 8px;font-size:16px">Precio acordado</td><td style="color:#22C36A;font-weight:700;font-size:18px;padding:11px 0">${precioFmt}</td></tr>
          </table>
          <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:10px;padding:14px 16px;margin-bottom:20px">
            <div style="font-size:16px;color:#15803D;line-height:1.7">
              💡 <strong>¿Cuándo recibís el pago?</strong><br>
              MudateYa procesa las liquidaciones cada <strong>15 días hábiles</strong> una vez confirmada la mudanza.
            </div>
          </div>
          <a href="${siteUrl}/mi-cuenta" style="display:inline-block;background:#003580;color:#fff;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:17px">
            Ver en mi panel →
          </a>
        </div>
        <div style="background:#F5F7FA;border-top:1px solid #E2E8F0;padding:14px 28px;font-size:14px;color:#94A3B8;font-family:monospace">MudateYa · mudateya.ar · ID: ${mudanza.id}</div>
      </div></body></html>`,
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
    from: 'MudateYa <noreply@mudateya.ar>', reply_to:'hola@mudateya.ar',
    to:   perfil.email,
    subject: `⭐ Te eligieron — ${mudanza.desde} → ${mudanza.hasta}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <div style="background:#003580;padding:20px 28px">
        <span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#22C36A">Ya</span>
        <span style="font-size:16px;color:rgba(255,255,255,.7);margin-left:12px">⭐ Un cliente te eligió</span>
      </div>
      <div style="padding:28px">
        <p style="font-size:18px;color:#0F1923;margin-bottom:20px;line-height:1.7">
          Hola <strong>${perfil.nombre}</strong>, <strong>${mudanza.clienteNombre || 'un cliente'}</strong> revisó tu perfil y te invitó a cotizar su mudanza.
        </p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:18px">
          <tr><td style="color:#64748B;padding:11px 0;width:35%;font-size:16px">De</td><td style="font-weight:600;color:#0F1923;font-size:16px">${mudanza.desde}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:11px 8px;font-size:16px">A</td><td style="font-weight:600;color:#0F1923;font-size:16px;padding:11px 0">${mudanza.hasta}</td></tr>
          <tr><td style="color:#64748B;padding:11px 0;font-size:16px">Tamaño</td><td style="font-size:16px;color:#0F1923">${mudanza.ambientes || '—'}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:11px 8px;font-size:16px">Fecha</td><td style="font-size:16px;color:#0F1923;padding:11px 0">${fmtFechaAR(mudanza.fecha)}</td></tr>
          ${mudanza.precio_estimado ? `<tr><td style="color:#64748B;padding:11px 0;font-size:16px">Estimado cliente</td><td style="color:#22C36A;font-weight:700;font-size:17px">$${parseInt(mudanza.precio_estimado).toLocaleString('es-AR')}</td></tr>` : ''}
          <tr style="background:#FFF8EC"><td style="color:#92400E;padding:11px 8px;font-size:16px">Cotizá hasta</td><td style="color:#B45309;font-weight:700;font-size:16px;padding:11px 0">${fmtVencimientoAR(mudanza.expira)}</td></tr>
        </table>
        <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:10px;padding:14px 16px;margin-bottom:20px">
          <div style="font-size:16px;color:#15803D;line-height:1.7">
            💡 Esta es una solicitud <strong>directa</strong> — el cliente te eligió a vos específicamente entre los mudanceros disponibles.
          </div>
        </div>
        <a href="${siteUrl}/mi-cuenta" style="display:inline-block;background:#003580;color:#fff;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:17px">
          Enviar cotización →
        </a>
      </div>
      <div style="background:#F5F7FA;border-top:1px solid #E2E8F0;padding:14px 28px;font-size:14px;color:#94A3B8;font-family:monospace">MudateYa · mudateya.ar</div>
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
  // Plan Referidos (leads de asesores inmobiliarios, partner Mudafy o cualquier
  // inmobiliaria asociada): 25% flat. Mudanzas normales: 15% · Fletes normales: 20%
  // 25% para toda mudanza de canal, 15%/20% solo para las orgánicas.
  const esPlanReferidos = !!(mudanza.origenCanal === true || mudanza.origenAsesor === true || mudanza.refAliado || mudanza.partner || mudanza.partnerAsesor || mudanza.partnerSlugCrudo);
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
  // Plan Referidos: 25% si vino por asesor (origenAsesor), por link de aliado (refAliado),
  // por partner Mudafy, o por cualquier inmobiliaria asociada (partner truthy).
  // Coincide con la detección de mi-cuenta.html → _esPlanReferidos()
  // 25% para toda mudanza de canal, 15%/20% solo para las orgánicas.
  const esPlanReferidos = !!(mudanza.origenCanal === true || mudanza.origenAsesor === true || mudanza.refAliado || mudanza.partner || mudanza.partnerAsesor || mudanza.partnerSlugCrudo);
  const comisionPct = esPlanReferidos ? 0.25 : (esFlete ? 0.20 : 0.15);
  // Usar el monto REAL cobrado guardado por el webhook (fuente de verdad).
  // Fallback al 50% del precio solo si por algún motivo no se guardó (compat con pagos viejos).
  // El saldo NO es la mitad del precio cuando hubo un ajuste: es el precio
  // final menos el anticipo ya cobrado. Ej: acepta en 1.000.000, paga 500.000,
  // se ajusta a 1.200.000 → el saldo es 700.000, no 600.000. Con el fallback
  // viejo el mail le informaba al mudancero un cobro y un neto menores a los
  // reales, que además no coincidían con lo que muestra el panel.
  const monto = esAnticipo
    ? (parseInt(mudanza.anticipoMonto) || Math.round(precioTotal * 0.5))
    : (parseInt(mudanza.saldoMonto)   || calcularSaldo(mudanza));
  const montoFmt = '$' + monto.toLocaleString('es-AR');
  // Neto al mudancero: descuento la comisión sobre el monto REAL cobrado, no sobre el precio total.
  // Así el cálculo es coherente: si pagó $100, le quedan $85 (15% de fee), no un número arbitrario.
  const netoMudancero = Math.round(monto * (1 - comisionPct));
  const netoFmt = '$' + netoMudancero.toLocaleString('es-AR');
  const comisionFmt = '$' + (monto - netoMudancero).toLocaleString('es-AR');
  const precioFmt = '$' + (parseInt(precioTotal) || 0).toLocaleString('es-AR');
  // Fecha estimada de liquidación: 15 días hábiles desde el cobro. Se calcula
  // con el mismo módulo que usa la vigencia de los pedidos, así que descuenta
  // fines de semana y feriados igual que el resto del sistema.
  let fechaLiquidacionFmt = '';
  try {
    const iso = vencimientoHabilISO(15 * 24);
    fechaLiquidacionFmt = new Date(iso).toLocaleDateString('es-AR', {
      weekday: 'long', day: 'numeric', month: 'long',
      timeZone: 'America/Argentina/Buenos_Aires'
    });
  } catch (e) { fechaLiquidacionFmt = ''; }
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
    ? `<a href="https://mudateya.ar/mi-cuenta" style="display:inline-block;background:#22C36A;color:#003580;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:17px">Ver en mi cuenta →</a>`
    : `<a href="https://mudateya.ar/mi-cuenta" style="display:inline-block;background:#003580;color:#fff;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:17px">Ver liquidación →</a>`;

  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>', reply_to:'hola@mudateya.ar',
    to: cot.mudanceroEmail,
    subject,
    html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <div style="background:#003580;padding:20px 28px">
        <span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#22C36A">Ya</span>
        <span style="font-size:16px;color:rgba(255,255,255,.7);margin-left:12px">${esAnticipo ? '💰 Anticipo recibido' : '✅ Pago completado'}</span>
      </div>
      <div style="padding:28px">
        <p style="font-size:18px;color:#0F1923;margin-bottom:20px;line-height:1.7">${mensajePrincipal}</p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
          <tr><td style="color:#64748B;padding:11px 0;width:35%;font-size:16px">De</td><td style="font-weight:600;color:#0F1923;font-size:16px">${mudanza.desde || '—'}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:11px 8px;font-size:16px">A</td><td style="font-weight:600;color:#0F1923;font-size:16px;padding:11px 0">${mudanza.hasta || '—'}</td></tr>
          <tr><td style="color:#64748B;padding:11px 0;font-size:16px">Fecha</td><td style="font-size:16px;color:#0F1923">${fmtFechaAR(mudanza.fecha)}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:11px 8px;font-size:16px">Precio total de la mudanza</td><td style="font-weight:600;color:#0F1923;font-size:16px;padding:11px 0">${precioFmt}</td></tr>
        </table>

        <div style="background:#F0FFF6;border:1px solid #BBF7D0;border-radius:12px;padding:20px 22px;margin-bottom:22px">
          <div style="font-size:14px;color:#166534;font-weight:700;letter-spacing:1.5px;margin-bottom:14px">${esAnticipo ? '💰 DETALLE DE ESTE COBRO' : '💰 DETALLE DEL COBRO FINAL'}</div>
          <table style="width:100%;border-collapse:collapse">
            <tr>
              <td style="color:#475569;font-size:16px;padding:9px 0">${esAnticipo ? 'Anticipo cobrado al cliente' : 'Saldo cobrado al cliente'}</td>
              <td style="text-align:right;font-weight:700;color:#0F1923;font-size:18px;padding:9px 0">${montoFmt}</td>
            </tr>
            <tr>
              <td style="color:#475569;font-size:16px;padding:9px 0;border-top:1px solid #BBF7D0">Comisión MudateYa (${(comisionPct*100).toFixed(0)}%)</td>
              <td style="text-align:right;color:#B45309;font-size:17px;padding:9px 0;border-top:1px solid #BBF7D0">− ${comisionFmt}</td>
            </tr>
            <tr>
              <td style="color:#166534;font-size:17px;font-weight:700;padding:12px 0;border-top:2px solid #17A356">Te transferimos</td>
              <td style="text-align:right;color:#17A356;font-weight:800;font-size:24px;padding:12px 0;border-top:2px solid #17A356">${netoFmt}</td>
            </tr>
          </table>
          <div style="font-size:15px;color:#475569;margin-top:14px;line-height:1.6">
            La transferencia sale a los <strong>15 días hábiles</strong> desde hoy${fechaLiquidacionFmt ? `, o sea alrededor del <strong>${fechaLiquidacionFmt}</strong>` : ''}.
          </div>
        </div>
        ${esAnticipo ? `<div style="background:#F0FFF6;border:1px solid #BBF7D0;border-radius:10px;padding:16px 20px;margin-bottom:20px">
          <div style="font-size:14px;color:#166534;font-weight:700;letter-spacing:1.5px;margin-bottom:10px">🔓 CONTACTO HABILITADO</div>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="color:#64748B;padding:5px 0;width:35%;font-size:16px">Cliente</td><td style="font-weight:600;color:#0F1923;font-size:16px">${mudanza.clienteNombre || '—'}</td></tr>
            ${mudanza.clienteWA ? `<tr><td style="color:#64748B;padding:5px 0;font-size:16px">WhatsApp</td><td style="font-size:16px"><a href="https://wa.me/54${String(mudanza.clienteWA).replace(/\D/g,'')}" style="color:#22C36A;text-decoration:none;font-weight:700">${mudanza.clienteWA}</a></td></tr>` : `<tr><td style="color:#64748B;padding:5px 0;font-size:16px">Email</td><td style="font-size:16px;color:#0F1923">${mudanza.clienteEmail || '—'}</td></tr>`}
          </table>
        </div>` : ''}
        ${accion}
      </div>
      <div style="background:#F5F7FA;border-top:1px solid #E2E8F0;padding:14px 28px;font-size:14px;color:#94A3B8;font-family:monospace">MudateYa · mudateya.ar · ID: ${mudanza.id}</div>
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
    from: 'MudateYa <noreply@mudateya.ar>', reply_to:'hola@mudateya.ar',
    to: mudanza.clienteEmail,
    subject: `✅ Anticipo confirmado — ${(mudanza.desde||'').split(',')[0]} → ${(mudanza.hasta||'').split(',')[0]}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <div style="background:#003580;padding:20px 28px"><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#22C36A">Ya</span><span style="font-size:16px;color:rgba(255,255,255,.7);margin-left:12px">✅ Anticipo confirmado</span></div>
      <div style="padding:28px">
        <p style="font-size:18px;color:#0F1923;margin-bottom:20px;line-height:1.7">Tu anticipo fue acreditado. <strong>${cot.mudanceroNombre || 'Tu mudancero'}</strong> fue notificado y te contactará pronto para coordinar los detalles.</p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
          <tr><td style="color:#64748B;padding:11px 0;width:35%;font-size:16px">De</td><td style="font-weight:600;color:#0F1923;font-size:16px">${mudanza.desde||'—'}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:11px 8px;font-size:16px">A</td><td style="font-weight:600;color:#0F1923;font-size:16px;padding:11px 0">${mudanza.hasta||'—'}</td></tr>
          <tr><td style="color:#64748B;padding:11px 0;font-size:16px">Fecha</td><td style="font-size:16px;color:#0F1923">${fmtFechaAR(mudanza.fecha)}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:11px 8px;font-size:16px">Mudancero</td><td style="font-weight:600;color:#0F1923;font-size:16px;padding:11px 0">${cot.mudanceroNombre||'—'}</td></tr>
          ${cot.mudanceroTel ? `<tr><td style="color:#64748B;padding:11px 0;font-size:16px">WhatsApp</td><td style="font-size:16px;padding:11px 0"><a href="https://wa.me/54${String(cot.mudanceroTel).replace(/\D/g,'')}" style="color:#22C36A;text-decoration:none;font-weight:700">${cot.mudanceroTel}</a></td></tr>` : ''}
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:11px 8px;font-size:16px">Saldo pendiente</td><td style="color:#F59E0B;font-weight:700;font-size:17px;padding:11px 0">${saldoFmt} al completar</td></tr>
        </table>
        ${cot.mudanceroTel ? `<div style="background:#F0FFF6;border:1px solid #BBF7D0;border-radius:10px;padding:14px 18px;margin-bottom:20px">
          <p style="margin:0;font-size:16px;color:#166534;line-height:1.7">🔓 Con el anticipo confirmado ya tenés habilitado el contacto directo de ${cot.mudanceroNombre||'tu mudancero'}.</p>
        </div>` : ''}
        <a href="https://mudateya.ar/mi-mudanza" style="display:inline-block;background:#003580;color:#fff;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:17px">Ver mi mudanza →</a>
      </div>
      <div style="background:#F5F7FA;border-top:1px solid #E2E8F0;padding:14px 28px;font-size:14px;color:#94A3B8;font-family:monospace">MudateYa · mudateya.ar · ID: ${mudanza.id}</div>
    </div>`,
  });
}

async function notificarClienteMudanzaIniciada(mudanza) {
  if (!process.env.RESEND_API_KEY || !mudanza.clienteEmail) return;
  const resend = new Resend(process.env.RESEND_API_KEY);
  const cot = mudanza.cotizacionAceptada || {};
  const saldo = calcularSaldo(mudanza);
  const saldoFmt = '$' + saldo.toLocaleString('es-AR');

  // En cotizaciones por hora el reloj arranca ahora, asi que el cliente tiene
  // que saberlo en el momento y no enterarse recien en la factura final.
  const porHora = cot.modalidad === 'hora' && parseInt(cot.valorHoraAdicional) > 0;
  const horaInicio = new Date().toLocaleString('es-AR', {
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: 'America/Argentina/Buenos_Aires'
  });

  const bloqueHoras = porHora ? `
        <div style="background:#F0F9FF;border-left:4px solid #1A6FFF;border-radius:10px;padding:16px 18px;margin:20px 0">
          <div style="font-size:14px;color:#1E40AF;font-weight:700;letter-spacing:1px;margin-bottom:8px">⏱ EMPEZÓ A CONTAR EL TIEMPO</div>
          <div style="font-size:16px;color:#334155;line-height:1.7">
            Tu presupuesto incluye <strong>${parseInt(cot.horasIncluidas) || 0} horas</strong> de trabajo, contadas desde las <strong>${horaInicio} hs</strong>.
            Si la mudanza se extiende, cada hora adicional se cobra <strong>$${(parseInt(cot.valorHoraAdicional) || 0).toLocaleString('es-AR')}</strong>,
            tal como figura en el presupuesto que aceptaste. Si termina antes, pagás menos.
          </div>
        </div>` : '';

  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>', reply_to:'hola@mudateya.ar',
    to: mudanza.clienteEmail,
    subject: `🚛 ${cot.mudanceroNombre || 'Tu mudancero'} arrancó con tu mudanza`,
    html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <div style="background:#003580;padding:20px 28px"><span style="font-family:Georgia,serif;font-size:30px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:30px;font-weight:900;color:#22C36A">Ya</span><span style="font-size:19px;color:rgba(255,255,255,.7);margin-left:12px">🚛 Mudanza en curso</span></div>
      <div style="padding:28px">
        <p style="font-size:17px;color:#0F1923;line-height:1.7;margin:0 0 18px">
          Hola <strong>${mudanza.clienteNombre || ''}</strong>, <strong>${cot.mudanceroNombre || 'el mudancero'}</strong> marcó tu mudanza como iniciada. Ya está en marcha.
        </p>

        <table style="width:100%;border-collapse:collapse;margin-bottom:6px">
          <tr><td style="color:#64748B;padding:11px 8px;font-size:16px">Desde</td><td style="font-weight:600;color:#0F1923;font-size:16px;padding:11px 0">${mudanza.desde || '—'}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:11px 8px;font-size:16px">Hasta</td><td style="font-weight:600;color:#0F1923;font-size:16px;padding:11px 0">${mudanza.hasta || '—'}</td></tr>
          <tr><td style="color:#64748B;padding:11px 8px;font-size:16px">Inicio</td><td style="font-weight:600;color:#0F1923;font-size:16px;padding:11px 0">${horaInicio} hs</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:11px 8px;font-size:16px">Saldo a pagar al terminar</td><td style="color:#F59E0B;font-weight:700;font-size:17px;padding:11px 0">${saldoFmt}</td></tr>
        </table>
        ${bloqueHoras}
        <p style="font-size:16px;color:#475569;line-height:1.7;margin:18px 0 0">
          Cuando termine, te avisamos para que pagues el saldo. Cualquier cosa que necesites, escribinos a
          <a href="mailto:hola&#64;mudateya.ar" style="color:#1A6FFF;text-decoration:none;font-weight:600">hola&#64;mudateya.ar</a>.
        </p>
      </div>
      <div style="background:#F8FAFC;padding:16px 28px;font-size:14px;color:#94A3B8">MudateYa · mudateya.ar · ID: ${mudanza.id}</div>
    </div>`
  });
}

// ═══════════════════════════════════════════════════════════════════
// AVISOS AL ASESOR QUE DERIVÓ AL CLIENTE
// ═══════════════════════════════════════════════════════════════════
//
// Cuando el cliente llega por el link de un asesor, la mudanza guarda su código
// en partnerAsesor. El email del asesor NO viaja en la mudanza: se resuelve acá
// leyendo su ficha en Redis.
//
// RÉGIMEN (definido en las páginas de beneficios):
//   ALQUILER    → el asesor cobra comisión sobre el precio final.
//   COMPRAVENTA → no cobra comisión; su cliente recibe un regalo que escala
//                 con el valor de la mudanza.
// Por eso el mail de cierre es distinto según el tipo de operación: mandarle
// "tu comisión es $0" a alguien de compraventa sería un error.

// Comisión por defecto del canal. La config de cada inmobiliaria en Redis puede
// pisarla (mudanza.comisionInmobiliariaPct), pero si no está cargada el asesor
// cobra igual: antes quedaba en 0 y no se le liquidaba nada.
const COMISION_ASESOR_DEFAULT = 5;

const CLAVES_ASESOR = {
  independientes: 'indep:asesor:',
  mudafy:         'mudafy:asesor:',
  remax:          'remax:asesor:',
  c21:            'c21:asesor:'
};

async function resolverAsesor(mudanza) {
  const cod = String((mudanza && mudanza.partnerAsesor) || '').trim();
  if (!cod) return null;
  const slug = mudanza.partner || mudanza.partnerSlugCrudo || '';
  // Si se conoce el canal se prueba primero; si no, se prueban todos.
  const orden = CLAVES_ASESOR[slug]
    ? [slug].concat(Object.keys(CLAVES_ASESOR).filter(k => k !== slug))
    : Object.keys(CLAVES_ASESOR);
  for (const canal of orden) {
    try {
      const a = await getJSON(CLAVES_ASESOR[canal] + cod);
      if (a && a.email && a.activo !== false) {
        return { email: a.email, nombre: a.nombre || '', inmobiliaria: a.inmobiliaria || '', canal: canal };
      }
    } catch (e) { /* sigue con el próximo canal */ }
  }
  return null;
}

// Tramos del regalo de compraventa. Tiene que coincidir con lo publicado en
// beneficios-*.html: si cambian ahí, cambian acá.
function regaloCompraventa(precio) {
  const p = parseInt(precio) || 0;
  if (p >= 4000000) return 'Limpieza en ambos hogares + Big Box';
  if (p >= 3000000) return 'Limpieza en ambos hogares';
  if (p >= 2000000) return 'Limpieza en origen o destino';
  if (p >= 1000000) return 'Big Box';
  return null;
}

function _asesorHead(sub) {
  return `<div style="background:#003580;padding:20px 28px"><span style="font-family:Georgia,serif;font-size:30px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:30px;font-weight:900;color:#22C36A">Ya</span><span style="font-size:19px;color:rgba(255,255,255,.7);margin-left:12px">${sub}</span></div>`;
}
function _asesorPie(m) {
  return `<div style="background:#F8FAFC;padding:16px 28px;font-size:14px;color:#94A3B8">MudateYa · mudateya.ar · Pedido ${m.id}</div>`;
}
function _asesorRuta(m) {
  return `<table style="width:100%;border-collapse:collapse;margin-bottom:6px">
      <tr><td style="color:#64748B;padding:11px 8px;font-size:16px">Cliente</td><td style="font-weight:600;color:#0F1923;font-size:16px;padding:11px 0">${m.clienteNombre || '—'}</td></tr>
      <tr style="background:#F5F7FA"><td style="color:#64748B;padding:11px 8px;font-size:16px">Desde</td><td style="font-weight:600;color:#0F1923;font-size:16px;padding:11px 0">${m.desde || '—'}</td></tr>
      <tr><td style="color:#64748B;padding:11px 8px;font-size:16px">Hasta</td><td style="font-weight:600;color:#0F1923;font-size:16px;padding:11px 0">${m.hasta || '—'}</td></tr>
    </table>`;
}

// ── 1. El cliente publicó el pedido ────────────────────────────────
async function notificarAsesorPedidoPublicado(mudanza) {
  if (!process.env.RESEND_API_KEY) return;
  const a = await resolverAsesor(mudanza);
  if (!a) return;
  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
    to: a.email,
    subject: `📦 ${mudanza.clienteNombre || 'Tu cliente'} publicó su mudanza`,
    html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      ${_asesorHead('📦 Pedido publicado')}
      <div style="padding:28px">
        <p style="font-size:17px;color:#0F1923;line-height:1.7;margin:0 0 18px">
          Hola <strong>${a.nombre || ''}</strong>, el cliente que derivaste ya publicó su mudanza. Los mudanceros verificados de la zona están cotizando.
        </p>
        ${_asesorRuta(mudanza)}
        <p style="font-size:16px;color:#475569;line-height:1.7;margin:18px 0 0">
          Te avisamos en cada paso: cuando reserve, y cuando la mudanza esté terminada.
        </p>
      </div>
      ${_asesorPie(mudanza)}
    </div>`
  });
}

// ── 2. Pagó la seña ────────────────────────────────────────────────
async function notificarAsesorAnticipoPagado(mudanza) {
  if (!process.env.RESEND_API_KEY) return;
  const a = await resolverAsesor(mudanza);
  if (!a) return;
  const cot = mudanza.cotizacionAceptada || {};
  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
    to: a.email,
    subject: `✅ ${mudanza.clienteNombre || 'Tu cliente'} reservó su mudanza`,
    html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      ${_asesorHead('✅ Mudanza reservada')}
      <div style="padding:28px">
        <p style="font-size:17px;color:#0F1923;line-height:1.7;margin:0 0 18px">
          Hola <strong>${a.nombre || ''}</strong>, tu cliente pagó la seña y la mudanza quedó confirmada con <strong>${cot.mudanceroNombre || 'el mudancero'}</strong>.
        </p>
        ${_asesorRuta(mudanza)}
        <p style="font-size:16px;color:#475569;line-height:1.7;margin:18px 0 0">
          Cuando la mudanza esté terminada te escribimos de nuevo.
        </p>
      </div>
      ${_asesorPie(mudanza)}
    </div>`
  });
}

// ── 3. Mudanza completada: comisión o regalo ───────────────────────
async function notificarAsesorMudanzaCompletada(mudanza) {
  if (!process.env.RESEND_API_KEY) return;
  const a = await resolverAsesor(mudanza);
  if (!a) return;
  const cot = mudanza.cotizacionAceptada || {};
  const precio = parseInt(cot.precio || mudanza.montoTotal || 0) || 0;
  const esCompraventa = mudanza.tipoOperacion === 'compraventa';
  const resend = new Resend(process.env.RESEND_API_KEY);

  let bloque;
  if (esCompraventa) {
    const regalo = regaloCompraventa(precio);
    bloque = `<div style="background:#F0FFF6;border:1px solid #BBF7D0;border-radius:12px;padding:20px 22px;margin:20px 0">
        <div style="font-size:14px;color:#166534;font-weight:700;letter-spacing:1.5px;margin-bottom:10px">🎁 EL REGALO DE TU CLIENTE</div>
        ${regalo
          ? `<div style="font-size:22px;font-weight:800;color:#0F1923;margin-bottom:8px">${regalo}</div>
             <div style="font-size:16px;color:#475569;line-height:1.7">Por ser una operación de compraventa, tu cliente recibe este beneficio sin costo. Nos contactamos con él para coordinarlo.</div>`
          : `<div style="font-size:16px;color:#475569;line-height:1.7">Esta operación no alcanza el monto mínimo para el regalo. Nos ponemos en contacto con tu cliente si corresponde algún beneficio.</div>`}
      </div>`;
  } else {
    const pct = parseFloat(mudanza.comisionInmobiliariaPct) > 0
      ? parseFloat(mudanza.comisionInmobiliariaPct)
      : COMISION_ASESOR_DEFAULT;
    const monto = Math.round(precio * pct / 100);
    bloque = `<div style="background:#F0FFF6;border:1px solid #BBF7D0;border-radius:12px;padding:20px 22px;margin:20px 0">
        <div style="font-size:14px;color:#166534;font-weight:700;letter-spacing:1.5px;margin-bottom:14px">💰 TU COMISIÓN</div>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="color:#475569;font-size:16px;padding:9px 0">Valor de la mudanza</td><td style="text-align:right;font-weight:600;color:#0F1923;font-size:16px;padding:9px 0">$${precio.toLocaleString('es-AR')}</td></tr>
          <tr><td style="color:#166534;font-size:17px;font-weight:700;padding:12px 0;border-top:2px solid #17A356">Tu comisión (${pct}%)</td><td style="text-align:right;color:#17A356;font-weight:800;font-size:24px;padding:12px 0;border-top:2px solid #17A356">$${monto.toLocaleString('es-AR')}</td></tr>
        </table>
        <div style="font-size:15px;color:#475569;margin-top:14px;line-height:1.6">Nos contactamos con vos para coordinar el pago.</div>
      </div>`;
  }

  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
    to: a.email,
    subject: esCompraventa
      ? `🎁 Mudanza terminada — el regalo para ${mudanza.clienteNombre || 'tu cliente'}`
      : `💰 Mudanza terminada — tu comisión`,
    html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      ${_asesorHead('🏁 Mudanza completada')}
      <div style="padding:28px">
        <p style="font-size:17px;color:#0F1923;line-height:1.7;margin:0 0 18px">
          Hola <strong>${a.nombre || ''}</strong>, la mudanza de <strong>${mudanza.clienteNombre || 'tu cliente'}</strong> se completó. Gracias por la derivación.
        </p>
        ${_asesorRuta(mudanza)}
        ${bloque}
      </div>
      ${_asesorPie(mudanza)}
    </div>`
  });
}

async function notificarClienteSaldoPendiente(mudanza) {
  if (!process.env.RESEND_API_KEY || !mudanza.clienteEmail) return;
  const resend = new Resend(process.env.RESEND_API_KEY);
  const cot = mudanza.cotizacionAceptada || {};
  const saldo = calcularSaldo(mudanza);
  const saldoFmt = '$' + saldo.toLocaleString('es-AR');
  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>', reply_to:'hola@mudateya.ar',
    to: mudanza.clienteEmail,
    subject: `🏁 Mudanza completada — Pagá el saldo final ${saldoFmt}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <div style="background:#003580;padding:20px 28px"><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#22C36A">Ya</span><span style="font-size:16px;color:rgba(255,255,255,.7);margin-left:12px">🏁 Mudanza completada</span></div>
      <div style="padding:28px">
        <p style="font-size:18px;color:#0F1923;margin-bottom:20px;line-height:1.7"><strong>${cot.mudanceroNombre || 'Tu mudancero'}</strong> marcó la mudanza como completada. Para cerrar el servicio, abonás el saldo final.</p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
          <tr><td style="color:#64748B;padding:11px 0;width:35%;font-size:16px">De</td><td style="font-weight:600;color:#0F1923;font-size:16px">${mudanza.desde||'—'}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:11px 8px;font-size:16px">A</td><td style="font-weight:600;color:#0F1923;font-size:16px;padding:11px 0">${mudanza.hasta||'—'}</td></tr>
          <tr><td style="color:#64748B;padding:11px 0;font-size:16px">Mudancero</td><td style="font-weight:600;color:#0F1923;font-size:16px">${cot.mudanceroNombre||'—'}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:11px 8px;font-size:16px">Saldo a pagar</td><td style="color:#003580;font-weight:700;font-size:19px;padding:11px 0">${saldoFmt}</td></tr>
        </table>
        <a href="https://mudateya.ar/mi-mudanza" style="display:inline-block;background:#22C36A;color:#003580;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:17px">Pagar saldo final →</a>
      </div>
      <div style="background:#F5F7FA;border-top:1px solid #E2E8F0;padding:14px 28px;font-size:14px;color:#94A3B8;font-family:monospace">MudateYa · mudateya.ar · ID: ${mudanza.id}</div>
    </div>`,
  });
}

// ══════════════════════════════════════════════════════════════════════
// EMAILS — Ajuste de precio
// ══════════════════════════════════════════════════════════════════════

// Email al cliente cuando el mudancero propone un nuevo precio (inicial o recordatorio)
async function notificarClienteAjustePropuesto(mudanza, esRecordatorio) {
  const esBot = mudanza.canal === 'whatsapp';

  // Pedido por WhatsApp: avisar SOLO por WhatsApp (el cliente responde
  // "acepto"/"rechazo"; su email es sintético, no tiene sentido mandarle mail).
  if (esBot && mudanza.clienteWA) {
    const _cot = mudanza.cotizacionAceptada || {};
    const _aj = mudanza.ajustePrecio || {};
    const _nuevoNum = Number(_aj.montoNuevo || 0).toLocaleString('es-AR');
    const nomCli = (mudanza.clienteNombre || '').split(' ')[0] || 'Hola';
    const texto =
      `${esRecordatorio ? '⏰ Recordatorio: ' : '⚠️ '}${_cot.mudanceroNombre || 'Tu mudancero'} propuso ajustar el precio de tu ${mudanza.tipo || 'mudanza'} a $${_nuevoNum}.\n` +
      (_aj.motivo ? `Motivo: ${_aj.motivo}\n` : '') +
      `Respondeme "acepto" o "rechazo". Si rechazás, se cancela y te devolvemos la seña.`;
    try {
      const { enviarPlantilla } = require('./_plantillas');
      await enviarPlantilla(mudanza.clienteWA, 'ajuste_precio_propuesto',
        { 1: nomCli, 2: _cot.mudanceroNombre || 'Tu mudancero', 3: mudanza.tipo || 'mudanza', 4: _nuevoNum, 5: _aj.motivo || 'ajuste de precio' }, texto);
    } catch (e) { console.warn('ajuste WhatsApp:', e.message); }
    return;
  }

  // Cliente de la web con WhatsApp cargado: mail de siempre (abajo) + WhatsApp
  // sumado, mismo texto que el del bot ("acepto"/"rechazo" ya se puede
  // responder porque el pedido quedó indexado por teléfono, ver clientes:tel8-idx).
  if (!esBot && mudanza.clienteWA) {
    try {
      const { enviarPlantilla } = require('./_plantillas');
      const _cot = mudanza.cotizacionAceptada || {};
      const _aj = mudanza.ajustePrecio || {};
      const _nuevoNum = Number(_aj.montoNuevo || 0).toLocaleString('es-AR');
      const nomCli = (mudanza.clienteNombre || '').split(' ')[0] || 'Hola';
      const texto =
        `${esRecordatorio ? '⏰ Recordatorio: ' : '⚠️ '}${_cot.mudanceroNombre || 'Tu mudancero'} propuso ajustar el precio de tu ${mudanza.tipo || 'mudanza'} a $${_nuevoNum}.\n` +
        (_aj.motivo ? `Motivo: ${_aj.motivo}\n` : '') +
        `Respondeme "acepto" o "rechazo". Si rechazás, se cancela y te devolvemos la seña.`;
      await enviarPlantilla(mudanza.clienteWA, 'ajuste_precio_propuesto',
        { 1: nomCli, 2: _cot.mudanceroNombre || 'Tu mudancero', 3: mudanza.tipo || 'mudanza', 4: _nuevoNum, 5: _aj.motivo || 'ajuste de precio' }, texto);
    } catch (e) { console.warn('ajuste WhatsApp (web):', e.message); }
  }

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
    from: 'MudateYa <noreply@mudateya.ar>', reply_to:'hola@mudateya.ar',
    to: mudanza.clienteEmail,
    subject: subject,
    html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <div style="background:#F59E0B;padding:20px 28px"><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#fff">Ya</span><span style="font-size:16px;color:rgba(255,255,255,.9);margin-left:12px">⚠️ Ajuste de precio propuesto</span></div>
      <div style="padding:28px">
        <p style="font-size:18px;color:#0F1923;margin-bottom:16px;line-height:1.7">${esRecordatorio ? 'Este es un recordatorio. ' : ''}<strong>${cot.mudanceroNombre || 'Tu mudancero'}</strong> propuso ajustar el precio de tu mudanza.</p>
        <div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:10px;padding:16px;margin-bottom:16px">
          <div style="font-size:15px;color:#92400E;text-transform:uppercase;letter-spacing:.5px;font-weight:700;margin-bottom:10px">Motivo</div>
          <div style="font-size:17px;color:#0F1923;line-height:1.5">"${(ajuste.motivo||'').replace(/"/g,'&quot;')}"</div>
        </div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
          <tr><td style="color:#64748B;padding:11px 0;font-size:16px">Precio original</td><td style="text-align:right;font-size:16px;color:#0F1923;text-decoration:line-through">${origFmt}</td></tr>
          <tr><td style="color:#64748B;padding:11px 0;font-size:16px">Diferencia</td><td style="text-align:right;font-size:16px;color:#F59E0B;font-weight:700">${deltaFmt}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#003580;padding:10px 6px;font-size:17px;font-weight:700">Nuevo precio</td><td style="text-align:right;color:#003580;font-weight:700;font-size:20px;padding:10px 6px">${nuevoFmt}</td></tr>
        </table>
        <p style="font-size:16px;color:#64748B;margin-bottom:16px;line-height:1.7">El anticipo que ya pagaste se mantiene. Si aceptás, se ajusta solo el saldo pendiente. Si rechazás, se cancela la mudanza y te devolvemos el anticipo.</p>
        <a href="https://mudateya.ar/mi-mudanza" style="display:inline-block;background:#003580;color:#fff;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:17px">Ver y decidir →</a>
      </div>
      <div style="background:#F5F7FA;border-top:1px solid #E2E8F0;padding:14px 28px;font-size:14px;color:#94A3B8;font-family:monospace">MudateYa · mudateya.ar · ID: ${mudanza.id}</div>
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
    from: 'MudateYa <noreply@mudateya.ar>', reply_to:'hola@mudateya.ar',
    to: cot.mudanceroEmail,
    subject: `✅ El cliente aceptó el ajuste — ${nuevoFmt}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <div style="background:#22C36A;padding:20px 28px"><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#003580">Ya</span><span style="font-size:16px;color:rgba(255,255,255,.9);margin-left:12px">✅ Ajuste aceptado</span></div>
      <div style="padding:28px">
        <p style="font-size:18px;color:#0F1923;margin-bottom:16px;line-height:1.7"><strong>${mudanza.clienteNombre || 'El cliente'}</strong> aceptó el nuevo precio. Ya podés continuar con la mudanza.</p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
          <tr><td style="color:#64748B;padding:11px 0;font-size:16px">Cliente</td><td style="font-weight:600;color:#0F1923;font-size:16px">${mudanza.clienteNombre||'—'}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:11px 8px;font-size:16px">Nuevo precio</td><td style="color:#22C36A;font-weight:700;font-size:19px;padding:11px 0">${nuevoFmt}</td></tr>
          <tr><td style="color:#64748B;padding:11px 0;font-size:16px">Saldo pendiente</td><td style="color:#F59E0B;font-weight:700;font-size:17px">${saldoFmt}</td></tr>
        </table>
        <a href="https://mudateya.ar/mi-cuenta" style="display:inline-block;background:#003580;color:#fff;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:17px">Ver en mi cuenta →</a>
      </div>
    </div>`,
  });
}

// Email al cliente confirmando que aceptó el ajuste
async function notificarClienteAjusteAceptado(mudanza) {
  const cot = mudanza.cotizacionAceptada || {};
  const saldo = calcularSaldo(mudanza);

  if (mudanza.clienteWA) {
    try {
      const { enviarPlantilla } = require('./_plantillas');
      const nomCli = (mudanza.clienteNombre || '').split(' ')[0] || 'Hola';
      const nuevoNum = Number(mudanza.ajustePrecio.montoNuevo || 0).toLocaleString('es-AR');
      const saldoNum = Number(saldo).toLocaleString('es-AR');
      const texto =
        `¡Hola ${nomCli}! Confirmamos el nuevo precio de tu ${mudanza.tipo || 'mudanza'} con ${cot.mudanceroNombre || 'tu mudancero'}: $${nuevoNum}.\n` +
        `Te queda un saldo de $${saldoNum} a pagar cuando se complete el trabajo. ¡Gracias!`;
      await enviarPlantilla(mudanza.clienteWA, 'ajuste_aceptado_cliente',
        { 1: nomCli, 2: mudanza.tipo || 'mudanza', 3: cot.mudanceroNombre || 'tu mudancero', 4: nuevoNum, 5: saldoNum }, texto);
    } catch (e) { console.warn('notificarClienteAjusteAceptado WhatsApp:', e.message); }
  }

  if (!process.env.RESEND_API_KEY || !mudanza.clienteEmail) return;
  const resend = new Resend(process.env.RESEND_API_KEY);
  const nuevoFmt = '$' + (mudanza.ajustePrecio.montoNuevo || 0).toLocaleString('es-AR');
  const saldoFmt = '$' + saldo.toLocaleString('es-AR');
  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>', reply_to:'hola@mudateya.ar',
    to: mudanza.clienteEmail,
    subject: `✅ Ajuste confirmado — Saldo ajustado a ${saldoFmt}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <div style="background:#003580;padding:20px 28px"><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#22C36A">Ya</span><span style="font-size:16px;color:rgba(255,255,255,.7);margin-left:12px">✅ Ajuste confirmado</span></div>
      <div style="padding:28px">
        <p style="font-size:18px;color:#0F1923;margin-bottom:16px;line-height:1.7">Confirmamos el nuevo precio de tu mudanza con <strong>${cot.mudanceroNombre || 'tu mudancero'}</strong>.</p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
          <tr><td style="color:#64748B;padding:11px 0;font-size:16px">Nuevo precio total</td><td style="color:#003580;font-weight:700;font-size:19px">${nuevoFmt}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:11px 8px;font-size:16px">Ya abonaste (anticipo)</td><td style="color:#0F1923;font-size:16px;padding:11px 0">$${(mudanza.anticipoMonto||0).toLocaleString('es-AR')}</td></tr>
          <tr><td style="color:#64748B;padding:11px 0;font-size:16px">Saldo a pagar al completar</td><td style="color:#F59E0B;font-weight:700;font-size:17px">${saldoFmt}</td></tr>
        </table>
        <p style="font-size:16px;color:#64748B;line-height:1.7">Cuando tu mudancero marque la mudanza como completada, vas a poder pagar el saldo desde tu panel.</p>
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
    from: 'MudateYa <noreply@mudateya.ar>', reply_to:'hola@mudateya.ar',
    to: cot.mudanceroEmail,
    subject: `❌ El cliente rechazó el ajuste — Mudanza cancelada`,
    html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <div style="background:#DC2626;padding:20px 28px"><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#fff">Ya</span><span style="font-size:16px;color:rgba(255,255,255,.9);margin-left:12px">❌ Ajuste rechazado</span></div>
      <div style="padding:28px">
        <p style="font-size:18px;color:#0F1923;margin-bottom:16px;line-height:1.7"><strong>${mudanza.clienteNombre || 'El cliente'}</strong> rechazó el ajuste de precio que propusiste. La mudanza queda cancelada y le devolvemos el anticipo.</p>
        <p style="font-size:16px;color:#64748B;margin-bottom:16px;line-height:1.7">No te preocupes, esto no afecta tu calificación. Seguí cotizando otras mudanzas en tu panel.</p>
        <a href="https://mudateya.ar/mi-cuenta" style="display:inline-block;background:#003580;color:#fff;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:17px">Ver panel →</a>
      </div>
    </div>`,
  });
}

// Email al mudancero cuando el cliente cancela directamente (no por rechazo
// de un ajuste — esa es notificarMudanceroAjusteRechazado, con otro texto).
async function notificarMudanceroPedidoCancelado(mudanza) {
  if (!process.env.RESEND_API_KEY) return;
  const resend = new Resend(process.env.RESEND_API_KEY);
  const cot = mudanza.cotizacionAceptada || {};
  if (!cot.mudanceroEmail) return;
  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
    to: cot.mudanceroEmail,
    subject: `❌ El cliente canceló la mudanza — ${mudanza.id}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <div style="background:#DC2626;padding:20px 28px"><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#fff">Ya</span><span style="font-size:16px;color:rgba(255,255,255,.9);margin-left:12px">❌ Mudanza cancelada</span></div>
      <div style="padding:28px">
        <p style="font-size:18px;color:#0F1923;margin-bottom:16px;line-height:1.7"><strong>${mudanza.clienteNombre || 'El cliente'}</strong> canceló la ${mudanza.tipo || 'mudanza'} que tenías reservada (${mudanza.desde || ''} → ${mudanza.hasta || ''}).</p>
        <p style="font-size:16px;color:#64748B;margin-bottom:16px;line-height:1.7">No te preocupes, esto no afecta tu calificación. Seguí cotizando otras mudanzas en tu panel.</p>
        <a href="https://mudateya.ar/mi-cuenta" style="display:inline-block;background:#003580;color:#fff;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:17px">Ver panel →</a>
      </div>
    </div>`,
  });
}

// Email al cliente confirmando cancelación + refund
async function notificarClienteMudanzaCancelada(mudanza, refundOk) {
  const cot = mudanza.cotizacionAceptada || {};
  const anticipoFmt = '$' + (mudanza.anticipoMonto || 0).toLocaleString('es-AR');

  if (mudanza.clienteWA) {
    try {
      const { enviarPlantilla } = require('./_plantillas');
      const nomCli = (mudanza.clienteNombre || '').split(' ')[0] || 'Hola';
      const mensajeWA = refundOk
        ? `Procesamos el reintegro de ${anticipoFmt}. Vas a verlo acreditado en 5 a 10 días hábiles en tu medio de pago original.`
        : `Estamos procesando el reintegro de ${anticipoFmt}. Te vamos a contactar dentro de las próximas 24 horas para completar la devolución.`;
      const texto =
        `¡Hola ${nomCli}! Cancelamos tu ${mudanza.tipo || 'mudanza'} con ${cot.mudanceroNombre || 'el mudancero'} como solicitaste.\n` +
        `${mensajeWA}\n¿Necesitás una nueva mudanza? Entrá a mudateya.ar cuando quieras.`;
      await enviarPlantilla(mudanza.clienteWA, 'mudanza_cancelada_cliente',
        { 1: nomCli, 2: mudanza.tipo || 'mudanza', 3: cot.mudanceroNombre || 'el mudancero', 4: mensajeWA }, texto);
    } catch (e) { console.warn('notificarClienteMudanzaCancelada WhatsApp:', e.message); }
  }

  if (!process.env.RESEND_API_KEY || !mudanza.clienteEmail) return;
  const resend = new Resend(process.env.RESEND_API_KEY);
  const mensaje = refundOk
    ? `Procesamos el reintegro de <strong>${anticipoFmt}</strong>. Vas a ver el acreditado en 5 a 10 días hábiles en tu medio de pago original.`
    : `Estamos procesando el reintegro de <strong>${anticipoFmt}</strong>. Te vamos a contactar dentro de las próximas 24 horas para completar la devolución.`;
  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>', reply_to:'hola@mudateya.ar',
    to: mudanza.clienteEmail,
    subject: `Mudanza cancelada — Reintegro en proceso`,
    html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <div style="background:#003580;padding:20px 28px"><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:26px;font-weight:900;color:#22C36A">Ya</span><span style="font-size:16px;color:rgba(255,255,255,.7);margin-left:12px">Mudanza cancelada</span></div>
      <div style="padding:28px">
        <p style="font-size:18px;color:#0F1923;margin-bottom:16px;line-height:1.7">Cancelamos tu mudanza con <strong>${cot.mudanceroNombre || 'el mudancero'}</strong> como solicitaste.</p>
        <p style="font-size:17px;color:#0F1923;margin-bottom:20px;line-height:1.7">${mensaje}</p>
        <p style="font-size:16px;color:#64748B;line-height:1.7">Si necesitás ayuda con una nueva mudanza, podés publicar un nuevo pedido cuando quieras.</p>
        <a href="https://mudateya.ar" style="display:inline-block;margin-top:12px;background:#22C36A;color:#003580;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:17px">Nueva mudanza →</a>
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
    from: 'MudateYa <noreply@mudateya.ar>', reply_to:'hola@mudateya.ar',
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
    from: 'MudateYa <noreply@mudateya.ar>', reply_to:'hola@mudateya.ar',
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
