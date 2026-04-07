// api/cotizaciones.js — Upstash Redis + PDF con pdfmake
const { Resend } = require('resend');

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
  doc.text('PRESUPUESTO OFICIAL  -  Valido 24hs', ML, Y + 8);

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

  doc.font('Helvetica-Bold').fontSize(36).fillColor(C_NAVY);
  doc.text(precioFmt, ML + 20, Y + 10, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(7).fillColor(C_TEXT3);
  doc.text('PRECIO TOTAL', ML + 20, Y + 52);
  doc.font('Helvetica').fontSize(8).fillColor(C_TEXT2);
  doc.text('Pago 100% por Mercado Pago.  Seguro y protegido.', ML + 180, Y + 28, { width: CW - 190 });

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
  doc.text('Valida 24hs  |  ' + nro, 0, Y, { width: PW - MR, align: 'right' });

  doc.end();

  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
    doc.on('error', reject);
  });
}


// ════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ════════════════════════════════════════════════════
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
  const RATE_LIMITED_ACTIONS = ['publicar', 'cotizar', 'analizar-foto', 'crear-sesion'];
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

  try {

    if (action === 'publicar' && req.method === 'POST') {
      const { clienteEmail, clienteNombre, desde, hasta, ambientes, fecha, servicios, extras, zonaBase, precio_estimado, clienteWA, tipo, pisoOrigen, pisoDestino, ascOrigen, ascDestino, fotos } = req.body;
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

      // Límite 2: cooldown de 10 minutos entre publicaciones
      const ultimaPublicacion = await getJSON(`cliente:ultima-pub:${clienteEmail}`);
      if (ultimaPublicacion) {
        const diffMs = ahora - new Date(ultimaPublicacion);
        const COOLDOWN_MS = 10 * 60 * 1000;
        if (diffMs < COOLDOWN_MS) {
          const restaMin = Math.ceil((COOLDOWN_MS - diffMs) / 60000);
          return res.status(429).json({
            error: `Publicaste hace menos de 10 minutos. Esperá ${restaMin} minuto${restaMin > 1 ? 's' : ''} antes de publicar otro pedido.`,
            codigo: 'COOLDOWN'
          });
        }
      }
      await setJSON(`cliente:ultima-pub:${clienteEmail}`, ahora.toISOString(), 600);

      // Límite 3: máximo 10 pedidos en 24hs
      const MAX_POR_DIA = 10;
      const hace24hs = new Date(ahora - 24 * 60 * 60 * 1000);
      let publicadosHoy = 0;
      for (const mid of idxCliente) {
        const m = await getJSON(`mudanza:${mid}`);
        if (m && new Date(m.fechaPublicacion) > hace24hs) publicadosHoy++;
      }
      if (publicadosHoy >= MAX_POR_DIA) {
        return res.status(429).json({
          error: 'Alcanzaste el límite de 10 publicaciones por día. Intentá mañana.',
          codigo: 'LIMITE_DIARIO'
        });
      }
      // ── FIN LÍMITES ────────────────────────────────────────────────────

      const id = 'MYA-' + Date.now();
      const { modoCotizacion, mudancerosInvitados } = req.body;
      // modoCotizacion: 'abierto' (primeros 5) | 'dirigido' (cliente elige mudanceros)
      const modo = modoCotizacion || 'abierto';
      const MAX_COT = 5;
      const mudanza = { id, clienteEmail, clienteNombre, clienteWA: clienteWA||'', desde, hasta, ambientes, fecha, servicios, extras, zonaBase, precio_estimado, tipo: tipo||'mudanza', pisoOrigen, pisoDestino, ascOrigen, ascDestino, fotos: fotos||[], estado: 'buscando', modoCotizacion: modo, maxCotizaciones: MAX_COT, mudancerosInvitados: mudancerosInvitados||[], fechaPublicacion: new Date().toISOString(), expira: new Date(Date.now() + 24*60*60*1000).toISOString(), cotizaciones: [] };
      await setJSON(`mudanza:${id}`, mudanza, 604800);
      const clienteIdx = await getJSON(`cliente:${clienteEmail}`) || [];
      if (!clienteIdx.includes(id)) clienteIdx.push(id);
      await setJSON(`cliente:${clienteEmail}`, clienteIdx, 2592000);
      const globalIdx = await getJSON('mudanzas:activas') || [];
      if (!globalIdx.includes(id)) globalIdx.push(id);
      await setJSON('mudanzas:activas', globalIdx, 604800);
      try { await notificarMudanceros(mudanza); } catch(e) { console.error(e.message); }
      return res.status(200).json({ ok: true, id, mudanza });
    }

    if (action === 'cotizar' && req.method === 'POST') {
      const { mudanzaId, mudanceroEmail, mudanceroNombre, mudanceroTel, precio, nota, tiempoEstimado } = req.body;
      if (!mudanzaId || !mudanceroEmail || !precio) return res.status(400).json({ error: 'Faltan datos' });
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

      // Limite deshabilitado para testing

      const precioLimpio = parseInt(String(precio).replace(/\./g,'').replace(/[^0-9]/g,'')) || 0;
      const cotizacion = { id: 'COT-' + Date.now(), mudanzaId, mudanceroEmail, mudanceroNombre, mudanceroTel, precio: precioLimpio, nota: nota||'', tiempoEstimado: tiempoEstimado||'', fecha: new Date().toISOString(), estado: 'pendiente' };
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
      const { mudanzaId, cotizacionId } = req.query;
      if (!mudanzaId || !cotizacionId) return res.status(400).json({ error: 'Faltan parámetros' });
      const mudanza = await getJSON(`mudanza:${mudanzaId}`);
      if (!mudanza) return res.status(404).json({ error: 'Mudanza no encontrada' });
      const cot = mudanza.cotizaciones.find(c => c.id === cotizacionId);
      if (!cot) return res.status(404).json({ error: 'Cotización no encontrada' });
      const pdfBase64 = await generarPDFBase64({
        id:                cot.id,
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
        tiempoEstimado:    cot.tiempoEstimado,
      });
      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="presupuesto-${cot.id}.pdf"`);
      res.setHeader('Content-Length', pdfBuffer.length);
      return res.status(200).end(pdfBuffer);
    }

    if (action === 'aceptar' && req.method === 'POST') {
      const { mudanzaId, cotizacionId } = req.body;
      const mudanza = await getJSON(`mudanza:${mudanzaId}`);
      if (!mudanza) return res.status(404).json({ error: 'Mudanza no encontrada' });
      const cot = mudanza.cotizaciones.find(c => c.id === cotizacionId);
      if (!cot) return res.status(404).json({ error: 'Cotización no encontrada' });
      mudanza.estado = 'cotizacion_aceptada';
      mudanza.cotizacionAceptada = cot;
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
          try { const m = await getJSON(`mudanza:${id}`); if (m) mudanzas.push(m); } catch(e) {}
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
      if (tipoPago === 'anticipo') m.anticipoPagado = true;
      if (tipoPago === 'saldo')    m.saldoPagado = true;
      m.ultimoUpdatePago = new Date().toISOString();
      await setJSON(`mudanza:${mudanzaId}`, m, 604800);
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
      }
      if (estado === 'en_curso') m.fechaInicio = new Date().toISOString();
      await setJSON(`mudanza:${mudanzaId}`, m, 604800);
      return res.status(200).json({ ok: true, estado });
    }
    if (action === 'eliminar' && req.method === 'POST') {
      const { mudanzaId, clienteEmail } = req.body;
      if (!mudanzaId || !clienteEmail) return res.status(400).json({ error: 'Faltan datos' });
      const m = await getJSON(`mudanza:${mudanzaId}`);
      if (!m) return res.status(404).json({ error: 'No encontrada' });
      if (m.clienteEmail !== clienteEmail) return res.status(403).json({ error: 'Sin permiso' });
      if (m.estado !== 'buscando') return res.status(400).json({ error: 'Solo se pueden eliminar mudanzas buscando cotizaciones' });
      // Marcar como eliminada
      m.estado = 'eliminada';
      await setJSON(`mudanza:${mudanzaId}`, m, 604800);
      // Sacar de la lista activa
      const activas = await getJSON('mudanzas:activas') || [];
      await setJSON('mudanzas:activas', activas.filter(id => id !== mudanzaId), 604800);
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

    // Catálogo público de mudanceros verificados (para modo dirigido)
    if (action === 'catalogo' && req.method === 'GET') {
      const { zona } = req.query;
      const todos = await getJSON('mudanceros:todos') || [];
      const catalogo = [];
      for (const email of todos) {
        try {
          const p = await getJSON(`mudancero:perfil:${email}`);
          if (!p || p.estado !== 'aprobado') continue;
          // Filtrar por zona si se especifica
          if (zona && p.zonaBase && !p.zonaBase.toLowerCase().includes(zona.toLowerCase()) &&
              !(p.zonasExtra||'').toLowerCase().includes(zona.toLowerCase())) continue;
          // Devolver solo datos públicos — sin datos bancarios ni fotos de DNI
          catalogo.push({
            email:              p.email,
            nombre:             p.nombre,
            empresa:            p.empresa       || '',
            zonaBase:           p.zonaBase,
            zonasExtra:         p.zonasExtra    || '',
            vehiculo:           p.vehiculo,
            servicios:          p.servicios     || '',
            calificacion:       p.calificacion  || 0,
            nroResenas:         p.nroResenas    || 0,
            trabajosCompletados: p.trabajosCompletados || 0,
            verificadoIdentidad: p.verificadoIdentidad || false,
            verificadoVehiculo:  p.verificadoVehiculo  || false,
            verificadoSeguro:    p.verificadoSeguro     || false,
            foto:               p.foto          || '',
            fotoCamion:         p.fotoCamion    || '',
            precios:            p.precios       || {},
            horarios:           p.horarios      || '',
            dias:               p.dias          || '',
            anticipacion:       p.anticipacion  || '',
            extra:              p.extra         || '',
          });
        } catch(e) {}
      }
      // Ordenar por calificación desc
      catalogo.sort((a,b) => (b.calificacion - a.calificacion) || (b.trabajosCompletados - a.trabajosCompletados));
      return res.status(200).json({ mudanceros: catalogo });
    }

    if (action === 'rechazar' && req.method === 'POST') {
      const { mudanzaId, mudanceroEmail } = req.body;
      if (!mudanzaId || !mudanceroEmail) return res.status(400).json({ error: 'Faltan datos' });
      // Guardar en lista de rechazados del mudancero para no mostrarlo más
      const rechazados = await getJSON(`rechazados:${mudanceroEmail}`) || [];
      if (!rechazados.includes(mudanzaId)) rechazados.push(mudanzaId);
      await setJSON(`rechazados:${mudanceroEmail}`, rechazados, 604800);
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
  if (!process.env.RESEND_API_KEY || !adminEmail) return;
  const expira = new Date(mudanza.expira).toLocaleString('es-AR', { day:'numeric', month:'long', hour:'2-digit', minute:'2-digit' });
  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>',
    to: adminEmail,
    subject: `🚛 Nueva mudanza — ${mudanza.desde} → ${mudanza.hasta} · ${mudanza.id}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;background:#ffffff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <div style="background:#003580;padding:20px 28px"><span style="font-family:Georgia,serif;font-size:20px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:20px;font-weight:900;color:#22C36A">Ya</span><span style="font-size:13px;color:rgba(255,255,255,.7);margin-left:12px">Admin · Nuevo pedido</span></div>
      <div style="background:#EEF4FF;border-bottom:1px solid #C7D9FF;padding:12px 28px;font-size:13px;color:#1A6FFF;font-weight:600">🚛 Nueva mudanza · ${mudanza.id}</div>
      <div style="padding:28px">
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="color:#64748B;padding:7px 0;width:35%;font-size:13px">De</td><td style="font-weight:600;color:#0F1923;font-size:13px">${mudanza.desde}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:7px 6px;font-size:13px">A</td><td style="font-weight:600;color:#0F1923;font-size:13px;padding:7px 0">${mudanza.hasta}</td></tr>
          <tr><td style="color:#64748B;padding:7px 0;font-size:13px">Tamaño</td><td style="font-size:13px;color:#0F1923">${mudanza.ambientes}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:7px 6px;font-size:13px">Fecha</td><td style="font-size:13px;color:#0F1923;padding:7px 0">${mudanza.fecha}</td></tr>
          <tr><td style="color:#64748B;padding:7px 0;font-size:13px">Estimado</td><td style="color:#17A356;font-weight:700;font-size:14px">$${parseInt(mudanza.precio_estimado||0).toLocaleString('es-AR')}</td></tr>
          <tr style="background:#F5F7FA"><td style="color:#64748B;padding:7px 6px;font-size:13px">Expira</td><td style="color:#F59E0B;font-weight:600;font-size:13px;padding:7px 0">${expira}</td></tr>
        </table>
        <div style="margin-top:20px">
          <a href="https://mudateya.ar/mi-cuenta" style="display:inline-block;background:#22C36A;color:#003580;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:14px">Cotizar →</a>
        </div>
      </div>
      <div style="background:#F5F7FA;border-top:1px solid #E2E8F0;padding:14px 28px;font-size:11px;color:#94A3B8;font-family:monospace">MudateYa · mudateya.ar</div>
    </div>`,
  });
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
  const precioFmt = '$' + parseInt(cot.precio).toLocaleString('es-AR');

  // ── 1. Generar link de pago MP ───────────────────
  let linkPago = `${siteUrl}/mi-mudanza`; // fallback
  try {
    const { MercadoPagoConfig, Preference } = require('mercadopago');
    const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
    const preference = new Preference(client);
    const result = await preference.create({ body: {
      items: [{
        id:          `${mudanza.id}-${cot.id}`,
        title:       `MudateYa — Mudanza con ${cot.mudanceroNombre}`,
        description: `${mudanza.desde} → ${mudanza.hasta} · ${mudanza.ambientes}`,
        quantity:    1,
        unit_price:  Number(cot.precio),
        currency_id: 'ARS',
      }],
      back_urls: {
        success: `${siteUrl}/pago-exitoso?mudanzaId=${mudanza.id}&cotizacionId=${cot.id}&monto=${cot.precio}&mudancero=${encodeURIComponent(cot.mudanceroNombre)}`,
        failure: `${siteUrl}/mi-mudanza?pago=error`,
        pending: `${siteUrl}/mi-mudanza?pago=pendiente`,
      },
      auto_return:          'approved',
      statement_descriptor: 'MUDATEYA',
      external_reference:   `${mudanza.id}-${cot.id}`,
      notification_url:     `${siteUrl}/api/webhook-mp`,
      metadata:             { mudanzaId: mudanza.id, cotizacionId: cot.id },
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
            <div style="font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;font-family:monospace">Total a pagar</div>
            <div style="font-size:2.2rem;font-weight:700;color:#003580;margin-bottom:18px">${precioFmt}</div>
            <a href="${linkPago}" style="display:inline-block;background:#009EE3;color:#ffffff;padding:14px 36px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px">💳 Pagar con Mercado Pago</a>
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
      html: `<div style="font-family:Arial,sans-serif;max-width:580px;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden">
        <div style="background:#22C36A;padding:18px 22px">
          <h2 style="margin:0;color:#041A0E">🎉 ¡Te eligieron!</h2>
        </div>
        <div style="padding:22px">
          <p style="color:#7AADA0;line-height:1.7">
            <strong style="color:#E8F5EE">${mudanza.clienteNombre}</strong> aceptó tu cotización.
            Te avisaremos cuando confirme el pago.
          </p>
          <div style="background:#172018;border-radius:10px;padding:14px 18px;margin:14px 0">
            <table style="width:100%">
              <tr><td style="color:#7AADA0;padding:5px 0;width:35%">Ruta</td><td>${mudanza.desde} → ${mudanza.hasta}</td></tr>
              <tr><td style="color:#7AADA0;padding:5px 0">Fecha</td><td>${mudanza.fecha}</td></tr>
              <tr><td style="color:#7AADA0;padding:5px 0">Tamaño</td><td>${mudanza.ambientes}</td></tr>
              <tr><td style="color:#7AADA0;padding:5px 0">Precio acordado</td><td style="color:#22C36A;font-weight:700">${precioFmt}</td></tr>
            </table>
          </div>
          <div style="background:#0D2018;border:1px solid #1E3028;border-radius:10px;padding:14px 18px;margin-bottom:14px">
            <p style="color:#7AADA0;font-size:13px;margin:0">
              💡 <strong style="color:#E8F5EE">¿Cuándo recibís el pago?</strong><br>
              MudateYa procesa las liquidaciones cada <strong style="color:#22C36A">15 días hábiles</strong>
              una vez confirmada la mudanza.
            </p>
          </div>
          <a href="${siteUrl}/mi-cuenta" style="display:inline-block;background:#22C36A;color:#041A0E;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">
            Ver en mi panel →
          </a>
        </div>
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
  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>',
    to:   perfil.email,
    subject: `⭐ Te eligieron — ${mudanza.desde} → ${mudanza.hasta}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:580px;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden">
      <div style="background:#22C36A;padding:18px 22px">
        <h2 style="margin:0;color:#041A0E">⭐ ¡Un cliente te eligió!</h2>
      </div>
      <div style="padding:22px">
        <p style="color:#7AADA0;line-height:1.7">
          Hola <strong style="color:#E8F5EE">${perfil.nombre}</strong>,<br>
          <strong style="color:#E8F5EE">${mudanza.clienteNombre || 'Un cliente'}</strong> revisó tu perfil y te invitó a cotizar su mudanza.
        </p>
        <div style="background:#172018;border-radius:10px;padding:14px 18px;margin:14px 0">
          <table style="width:100%">
            <tr><td style="color:#7AADA0;padding:5px 0;width:35%">De</td><td><strong>${mudanza.desde}</strong></td></tr>
            <tr><td style="color:#7AADA0;padding:5px 0">A</td><td><strong>${mudanza.hasta}</strong></td></tr>
            <tr><td style="color:#7AADA0;padding:5px 0">Tamaño</td><td>${mudanza.ambientes || '—'}</td></tr>
            <tr><td style="color:#7AADA0;padding:5px 0">Fecha</td><td>${mudanza.fecha || '—'}</td></tr>
            ${mudanza.precio_estimado ? `<tr><td style="color:#7AADA0;padding:5px 0">Estimado cliente</td><td style="color:#22C36A;font-weight:700">$${parseInt(mudanza.precio_estimado).toLocaleString('es-AR')}</td></tr>` : ''}
          </table>
        </div>
        <div style="background:#0D2018;border:1px solid rgba(34,195,106,.3);border-radius:10px;padding:12px 16px;margin-bottom:16px">
          <p style="color:#7AADA0;font-size:13px;margin:0">
            💡 Esta es una solicitud <strong style="color:#E8F5EE">directa</strong> — el cliente te eligió a vos específicamente entre los mudanceros disponibles.
          </p>
        </div>
        <a href="${siteUrl}/mi-cuenta" style="display:inline-block;background:#22C36A;color:#041A0E;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">
          Enviar cotización →
        </a>
      </div>
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
  const feePct = esFlete ? 0.20 : 0.15;
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
    '% Fee':           esFlete ? '20%' : '15%',
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

