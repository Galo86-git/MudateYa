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
// GENERADOR PDF con pdfmake
// ════════════════════════════════════════════════════
async function generarPDFBase64(datos) {
  const PdfPrinter = require('pdfmake');

  const fonts = {
    Helvetica: {
      normal:      'Helvetica',
      bold:        'Helvetica-Bold',
      italics:     'Helvetica-Oblique',
      bolditalics: 'Helvetica-BoldOblique',
    },
  };
  const printer = new PdfPrinter(fonts);

  // ── PALETA BLANCA / BOOKING ──────────────────────
  const WHITE    = '#FFFFFF';
  const BG       = '#F4F6F9';
  const NAVY     = '#003580';
  const BLUE     = '#1A6FFF';
  const BLUE_LT  = '#EEF4FF';
  const BLUE_BD  = '#C7D9FF';
  const TEXT     = '#0F1923';
  const TEXT2    = '#475569';
  const TEXT3    = '#94A3B8';
  const BORDER_C = '#E2E8F0';
  const BORDER2  = '#CBD5E1';
  const GREEN    = '#16A34A';
  const GREEN_LT = '#F0FFF4';
  const GREEN_BD = '#BBF7D0';

  const nro           = datos.id || 'COT-0001';
  const fechaEmision  = datos.fechaEmision || new Date().toLocaleDateString('es-AR', { day:'numeric', month:'long', year:'numeric' });
  const clienteNombre = datos.clienteNombre || '-';
  const clienteEmail  = datos.clienteEmail  || '-';
  const mudNombre     = datos.mudanceroNombre || '-';
  const mudInits      = (datos.mudancero_initials || datos.mudanceroNombre || 'MV').slice(0,2).toUpperCase();
  const estrellas     = parseFloat(datos.estrellas || 4.8);
  const nroResenas    = datos.nro_resenas || '';
  const vehiculo      = datos.vehiculo || '';
  const desde         = datos.desde || '-';
  const hasta         = datos.hasta || '-';
  const fechaMud      = datos.fecha || datos.fecha_mudanza || '-';
  const ambientes     = datos.ambientes || '-';
  const objetos       = datos.objetos || datos.servicios || '-';
  const extras        = datos.extras || '';
  const nota          = datos.nota || '';
  const precio        = parseInt(datos.precio || datos.precio_total || 0);
  const esFlete       = datos.ambientes === 'Flete' || datos.tipo === 'flete';
  const fmt           = (n) => '$' + n.toLocaleString('es-AR');
  const starLabel     = `${estrellas} / 5${nroResenas ? '  |  ' + nroResenas + ' resenas' : ''}`;

  function cardLayout(fillC, borderC) {
    return {
      fillColor:    () => fillC,
      hLineColor:   () => borderC,
      vLineColor:   () => borderC,
      hLineWidth:   () => 0.6,
      vLineWidth:   () => 0.6,
      paddingLeft:  () => 16,
      paddingRight: () => 16,
      paddingTop:   () => 14,
      paddingBottom:() => 14,
    };
  }

  function pillLayout(fillC, borderC) {
    return {
      fillColor:    () => fillC,
      hLineColor:   () => borderC,
      vLineColor:   () => borderC,
      hLineWidth:   () => 0.5,
      vLineWidth:   () => 0.5,
      paddingLeft:  () => 7,
      paddingRight: () => 7,
      paddingTop:   () => 3,
      paddingBottom:() => 3,
    };
  }

  function divider() {
    return { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 467, y2: 0, lineWidth: 0.5, lineColor: BORDER_C }] };
  }

  function detalleRow(lbl, val, isLast) {
    return {
      stack: [
        {
          columns: [
            { text: lbl.toUpperCase(), bold: true, fontSize: 7.5, color: TEXT3, width: 130, characterSpacing: 0.4 },
            { text: String(val || '-'), fontSize: 9, color: TEXT, width: '*' },
          ],
        },
        isLast ? { text: '' } : { margin: [0, 5, 0, 0], ...divider() },
      ],
      margin: [0, 6, 0, isLast ? 0 : 6],
    };
  }

  function numBadge(num) {
    return {
      table: { widths: [20], body: [[{ text: num, bold: true, fontSize: 10, color: BLUE, alignment: 'center' }]] },
      layout: {
        fillColor: () => BLUE_LT, hLineColor: () => BLUE_BD, vLineColor: () => BLUE_BD,
        hLineWidth: () => 0.6, vLineWidth: () => 0.6,
        paddingLeft: () => 4, paddingRight: () => 4, paddingTop: () => 5, paddingBottom: () => 5,
      },
      margin: [0, 0, 0, 6],
      alignment: 'center',
    };
  }

  const filasDet = [
    ['Desde',     desde],
    ['Hasta',     hasta],
    ['Fecha',     fechaMud],
    ['Tipo',      esFlete ? 'Flete' : 'Mudanza'],
    ['Ambientes', ambientes],
    ['Objetos',   objetos],
  ];
  if (extras) filasDet.push(['Servicios adicionales', extras]);
  if (nota)   filasDet.push(['Nota del mudancero', nota]);

  const dd = {
    pageSize: 'A4',
    pageMargins: [40, 42, 40, 40],

    // Franja azul navy arriba
    background: () => [
      { canvas: [{ type: 'rect', x: 0, y: 0, w: 595, h: 96, color: NAVY }] },
    ],

    defaultStyle: { font: 'Helvetica', fontSize: 9.5, color: TEXT, lineHeight: 1.3 },

    content: [

      // ── HEADER (sobre la franja navy) ────────────
      {
        columns: [
          { stack: [
            { columns: [
              { text: 'Mudate', bold: true, fontSize: 22, color: WHITE, width: 'auto' },
              { text: 'Ya',     bold: true, fontSize: 22, color: '#4ADE80', width: 'auto' },
            ], columnGap: 0 },
            { text: 'El marketplace de mudanzas de Argentina', fontSize: 8, color: '#aac4e0', margin: [0,2,0,0] },
          ]},
          { stack: [
            { text: nro, bold: true, fontSize: 13, color: WHITE, alignment: 'right' },
            { text: 'COTIZACION OFICIAL', bold: true, fontSize: 7, color: '#aac4e0', alignment: 'right', characterSpacing: 0.6, margin: [0,3,0,2] },
            { text: fechaEmision, fontSize: 8, color: '#aac4e0', alignment: 'right' },
          ]},
        ],
        margin: [0, 0, 0, 20],
      },

      // ── BADGE "válido 24hs" ──────────────────────
      {
        columns: [
          {
            table: { body: [[{ text: 'PRESUPUESTO OFICIAL  |  valido 24 horas', bold: true, fontSize: 7.5, color: BLUE, characterSpacing: 0.3 }]] },
            layout: pillLayout(BLUE_LT, BLUE_BD),
            width: 'auto',
          },
          { text: '', width: '*' },
        ],
        margin: [0, 0, 0, 12],
      },

      // ── CLIENTE + MUDANCERO ──────────────────────
      {
        columns: [
          { width: '48%', table: { widths: ['*'], body: [[{ stack: [
            { text: 'CLIENTE', bold: true, fontSize: 7, color: TEXT3, characterSpacing: 0.8, margin: [0,0,0,8] },
            { text: clienteNombre, bold: true, fontSize: 12, color: TEXT },
            { text: clienteEmail, fontSize: 8.5, color: TEXT2, margin: [0,3,0,0] },
          ]}]]}, layout: cardLayout(WHITE, BORDER_C) },
          { width: '4%', text: '' },
          { width: '48%', table: { widths: ['*'], body: [[{ stack: [
            { text: 'MUDANCERO', bold: true, fontSize: 7, color: TEXT3, characterSpacing: 0.8, margin: [0,0,0,8] },
            { columns: [
              { width: 36, stack: [
                { table: { body: [[{ text: mudInits, bold: true, fontSize: 11, color: WHITE, alignment: 'center' }]] },
                  layout: {
                    fillColor: () => NAVY, hLineColor: () => NAVY, vLineColor: () => NAVY,
                    hLineWidth: () => 0, vLineWidth: () => 0,
                    paddingLeft: () => 6, paddingRight: () => 6, paddingTop: () => 7, paddingBottom: () => 7,
                  }
                },
              ], margin: [0, 0, 10, 0] },
              { stack: [
                { text: mudNombre, bold: true, fontSize: 12, color: TEXT },
                { text: 'Calificacion: ' + starLabel, fontSize: 8, color: TEXT2, margin: [0,3,0,4] },
                { table: { body: [[{ text: 'VERIFICADO', bold: true, fontSize: 6.5, color: GREEN }]] },
                  layout: pillLayout(GREEN_LT, GREEN_BD), width: 'auto' },
              ]},
            ], columnGap: 0 },
            vehiculo ? { text: vehiculo, fontSize: 8, color: TEXT3, margin: [0, 6, 0, 0] } : { text: '' },
          ]}]]}, layout: cardLayout(WHITE, BORDER_C) },
        ],
        columnGap: 0,
        margin: [0, 0, 0, 8],
      },

      // ── DETALLE MUDANZA ──────────────────────────
      {
        table: { widths: ['*'], body: [[{ stack: [
          { text: 'DETALLE DEL SERVICIO', bold: true, fontSize: 7, color: TEXT3, characterSpacing: 0.8, margin: [0,0,0,8] },
          divider(),
          { text: '', margin: [0, 2, 0, 0] },
          ...filasDet.map(([lbl, val], i) => detalleRow(lbl, val, i === filasDet.length - 1)),
        ]}]]},
        layout: cardLayout(WHITE, BORDER_C),
        margin: [0, 0, 0, 8],
      },

      // ── PRECIO DESTACADO ─────────────────────────
      {
        table: { widths: ['*', 'auto'], body: [[
          { stack: [
            { text: fmt(precio), bold: true, fontSize: 32, color: BLUE },
            { text: 'PRECIO TOTAL', bold: true, fontSize: 7.5, color: TEXT3, characterSpacing: 0.5, margin: [0,4,0,2] },
            { text: 'Pago 100% por Mercado Pago. Seguro y protegido.', fontSize: 8, color: TEXT2 },
          ]},
          { stack: [
            { table: { body: [[{ text: 'Mercado Pago', bold: true, fontSize: 8, color: NAVY }]] },
              layout: pillLayout(BLUE_LT, BLUE_BD) },
          ], alignment: 'right', margin: [0, 4, 0, 0] },
        ]]},
        layout: {
          fillColor:    () => BG,
          hLineColor:   () => BORDER2,
          vLineColor:   () => BORDER2,
          hLineWidth:   () => 0.8,
          vLineWidth:   () => 0.8,
          paddingLeft:  () => 16, paddingRight:  () => 16,
          paddingTop:   () => 16, paddingBottom: () => 16,
        },
        margin: [0, 0, 0, 8],
      },

      // ── PROXIMOS PASOS ───────────────────────────
      {
        table: { widths: ['*'], body: [[{ stack: [
          { text: 'PROXIMOS PASOS', bold: true, fontSize: 7, color: TEXT3, characterSpacing: 0.8, margin: [0,0,0,12] },
          { columns: [
            { width: '25%', stack: [
              { columns: [{ width: '*', text: '' }, numBadge('1'), { width: '*', text: '' }] },
              { text: 'Aceptar cotizacion en MudateYa', fontSize: 7.5, color: TEXT2, alignment: 'center' },
            ]},
            { width: '25%', stack: [
              { columns: [{ width: '*', text: '' }, numBadge('2'), { width: '*', text: '' }] },
              { text: 'Pagar con Mercado Pago', fontSize: 7.5, color: TEXT2, alignment: 'center' },
            ]},
            { width: '25%', stack: [
              { columns: [{ width: '*', text: '' }, numBadge('3'), { width: '*', text: '' }] },
              { text: 'Coordinar fecha y horario', fontSize: 7.5, color: TEXT2, alignment: 'center' },
            ]},
            { width: '25%', stack: [
              { columns: [{ width: '*', text: '' }, numBadge('4'), { width: '*', text: '' }] },
              { text: 'Mudanza realizada', fontSize: 7.5, color: TEXT2, alignment: 'center' },
            ]},
          ], columnGap: 8 },
        ]}]]},
        layout: cardLayout(WHITE, BORDER_C),
        margin: [0, 0, 0, 8],
      },

      // ── GARANTIAS ────────────────────────────────
      {
        columns: [
          { label: 'Pago seguro',     sub: 'Mercado Pago' },
          { label: 'Verificado',      sub: 'Identidad confirmada' },
          { label: 'Bien calificado', sub: '4.8 promedio' },
          { label: 'Sin sorpresas',   sub: 'Precio acordado' },
        ].map(function(g) { return {
          width: '25%',
          table: { widths: ['*'], body: [[{ stack: [
            { text: g.label, bold: true, fontSize: 8, color: NAVY,  alignment: 'center', margin: [0,0,0,3] },
            { text: g.sub,   fontSize: 7, color: TEXT3, alignment: 'center' },
          ]}]]},
          layout: {
            fillColor: () => BLUE_LT, hLineColor: () => BLUE_BD, vLineColor: () => BLUE_BD,
            hLineWidth: () => 0.5, vLineWidth: () => 0.5,
            paddingLeft: () => 6, paddingRight: () => 6, paddingTop: () => 10, paddingBottom: () => 10,
          },
        }; }),
        columnGap: 5,
        margin: [0, 0, 0, 14],
      },

      // ── FOOTER ───────────────────────────────────
      divider(),
      { margin: [0, 8, 0, 0], columns: [
        { columns: [
          { text: 'MudateYa', bold: true, fontSize: 9, color: NAVY, width: 'auto' },
          { text: '  |  El marketplace de mudanzas de Argentina  |  mudateya.com.ar', fontSize: 8, color: TEXT3, width: '*', margin: [0,1,0,0] },
        ]},
        { text: 'Valida 24hs  |  ' + nro, fontSize: 7.5, color: TEXT3, alignment: 'right', margin: [0,1,0,0] },
      ]},
    ],
  };

  return new Promise((resolve, reject) => {
    try {
      const pdfDoc = printer.createPdfKitDocument(dd);
      const chunks = [];
      pdfDoc.on('data', chunk => chunks.push(chunk));
      pdfDoc.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
      pdfDoc.on('error', reject);
      pdfDoc.end();
    } catch(e) { reject(e); }
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

      // Modo abierto: máximo 5 cotizaciones, después se cierra
      const maxCot = mudanza.maxCotizaciones || 5;
      if (mudanza.modoCotizacion !== 'dirigido' && mudanza.cotizaciones.length >= maxCot) {
        mudanza.estado = 'cotizaciones_completas';
        await setJSON(`mudanza:${mudanzaId}`, mudanza, 172800);
        return res.status(400).json({ error: 'Esta mudanza ya recibió las 5 cotizaciones. Llegaste tarde.' });
      }

      const cotizacion = { id: 'COT-' + Date.now(), mudanzaId, mudanceroEmail, mudanceroNombre, mudanceroTel, precio: parseInt(precio), nota: nota||'', tiempoEstimado: tiempoEstimado||'', fecha: new Date().toISOString(), estado: 'pendiente' };
      mudanza.cotizaciones.push(cotizacion);

      // Si con esta cotización llegamos al límite, cerramos automáticamente
      if (mudanza.modoCotizacion !== 'dirigido' && mudanza.cotizaciones.length >= maxCot) {
        mudanza.estado = 'cotizaciones_completas';
      }
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
    from: 'MudateYa <onboarding@resend.dev>',
    to: adminEmail,
    subject: `🚛 Nueva mudanza — ${mudanza.desde} → ${mudanza.hasta} · ${mudanza.id}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:580px;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden">
      <div style="background:#22C36A;padding:18px 22px"><h2 style="margin:0;color:#041A0E">🚛 Nueva mudanza · ${mudanza.id}</h2></div>
      <div style="padding:22px">
        <table style="width:100%">
          <tr><td style="color:#7AADA0;padding:6px 0;width:35%">De</td><td><strong>${mudanza.desde}</strong></td></tr>
          <tr><td style="color:#7AADA0;padding:6px 0">A</td><td><strong>${mudanza.hasta}</strong></td></tr>
          <tr><td style="color:#7AADA0;padding:6px 0">Tamaño</td><td>${mudanza.ambientes}</td></tr>
          <tr><td style="color:#7AADA0;padding:6px 0">Fecha</td><td>${mudanza.fecha}</td></tr>
          <tr><td style="color:#7AADA0;padding:6px 0">Estimado</td><td style="color:#22C36A;font-weight:700">$${parseInt(mudanza.precio_estimado||0).toLocaleString('es-AR')}</td></tr>
          <tr><td style="color:#7AADA0;padding:6px 0">Expira</td><td style="color:#FFB300">${expira}</td></tr>
        </table>
        <a href="https://mudateya.vercel.app/mi-cuenta" style="display:inline-block;margin-top:16px;background:#22C36A;color:#041A0E;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Cotizar →</a>
      </div>
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
    from: 'MudateYa <onboarding@resend.dev>',
    to: mudanza.clienteEmail,
    subject: `💰 Cotización de ${cotizacion.mudanceroNombre} — $${cotizacion.precio.toLocaleString('es-AR')}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:580px;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden">
      <div style="background:#22C36A;padding:18px 22px"><h2 style="margin:0;color:#041A0E">💰 Nueva cotización recibida</h2></div>
      <div style="padding:22px">
        <p style="color:#7AADA0"><strong style="color:#E8F5EE">${cotizacion.mudanceroNombre}</strong> cotizó tu mudanza <strong>${mudanza.desde} → ${mudanza.hasta}</strong></p>
        <div style="background:#172018;border-radius:10px;padding:14px 18px;margin:14px 0">
          <div style="font-size:1.8rem;color:#22C36A;font-weight:700">$${cotizacion.precio.toLocaleString('es-AR')}</div>
          ${cotizacion.tiempoEstimado ? `<div style="color:#7AADA0;font-size:12px;margin-top:4px">⏱ ${cotizacion.tiempoEstimado}</div>` : ''}
          ${cotizacion.nota ? `<div style="color:#7AADA0;font-size:12px;margin-top:8px;font-style:italic">"${cotizacion.nota}"</div>` : ''}
        </div>
        <p style="color:#7AADA0;font-size:13px">Adjuntamos el detalle completo en PDF.</p>
        <a href="https://mudateya.vercel.app/mi-mudanza" style="display:inline-block;background:#22C36A;color:#041A0E;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Ver todas las cotizaciones →</a>
      </div>
    </div>`,
    attachments,
  });
}

async function enviarEmailAceptacion(mudanza, cot) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  if (!process.env.RESEND_API_KEY) return;

  const siteUrl = process.env.SITE_URL || 'https://mudateya.vercel.app';
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
      from: 'MudateYa <onboarding@resend.dev>',
      to: mudanza.clienteEmail,
      subject: `✅ Aceptaste la cotización — Pagá ahora con Mercado Pago`,
      html: `<div style="font-family:Arial,sans-serif;max-width:580px;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden">
        <div style="background:#22C36A;padding:18px 22px">
          <h2 style="margin:0;color:#041A0E">✅ ¡Cotización aceptada!</h2>
        </div>
        <div style="padding:22px">
          <p style="color:#7AADA0;line-height:1.7">Hola <strong style="color:#E8F5EE">${mudanza.clienteNombre}</strong>,</p>
          <p style="color:#7AADA0;line-height:1.7">
            Aceptaste la cotización de <strong style="color:#E8F5EE">${cot.mudanceroNombre}</strong>.
            Para confirmar la mudanza, completá el pago.
          </p>

          <!-- Resumen -->
          <div style="background:#172018;border-radius:10px;padding:14px 18px;margin:14px 0">
            <table style="width:100%">
              <tr><td style="color:#7AADA0;padding:5px 0;width:35%">Mudancero</td><td><strong>${cot.mudanceroNombre}</strong></td></tr>
              <tr><td style="color:#7AADA0;padding:5px 0">Teléfono</td><td>${cot.mudanceroTel || '—'}</td></tr>
              <tr><td style="color:#7AADA0;padding:5px 0">Ruta</td><td>${mudanza.desde} → ${mudanza.hasta}</td></tr>
              <tr><td style="color:#7AADA0;padding:5px 0">Fecha</td><td>${mudanza.fecha}</td></tr>
              <tr><td style="color:#7AADA0;padding:5px 0">Ambientes</td><td>${mudanza.ambientes}</td></tr>
              ${cot.nota ? `<tr><td style="color:#7AADA0;padding:5px 0">Nota</td><td style="font-style:italic">${cot.nota}</td></tr>` : ''}
            </table>
          </div>

          <!-- Precio + botón de pago -->
          <div style="background:#0D2018;border:2px solid #22C36A;border-radius:12px;padding:20px;margin:20px 0;text-align:center">
            <div style="font-size:13px;color:#5A8A78;margin-bottom:6px;text-transform:uppercase;letter-spacing:1px">Total a pagar</div>
            <div style="font-size:2.5rem;font-weight:700;color:#22C36A;margin-bottom:16px">${precioFmt}</div>
            <a href="${linkPago}"
               style="display:inline-block;background:#009EE3;color:white;padding:14px 36px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px;letter-spacing:.3px">
              💳 Pagar con Mercado Pago
            </a>
            <p style="color:#3D6458;font-size:11px;margin-top:12px;margin-bottom:0">
              🔒 Pago 100% seguro · MudateYa retiene el monto hasta confirmar el servicio
            </p>
          </div>

          <p style="color:#7AADA0;font-size:13px">
            También podés acceder desde
            <a href="${siteUrl}/mi-mudanza" style="color:#22C36A">tu panel de mudanzas</a>.
          </p>
          <p style="color:#3D6458;font-size:11px">
            Adjuntamos el comprobante de cotización en PDF para tus registros.
          </p>
        </div>
      </div>`,
      attachments,
    });
  }

  // ── 4. Email al MUDANCERO ────────────────────────
  if (cot.mudanceroEmail) {
    await resend.emails.send({
      from: 'MudateYa <onboarding@resend.dev>',
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
  const siteUrl = process.env.SITE_URL || 'https://mudateya.vercel.app';
  await resend.emails.send({
    from: 'MudateYa <onboarding@resend.dev>',
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

