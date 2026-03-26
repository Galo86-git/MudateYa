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

  const VERDE     = '#22C36A';
  const VERDE_BG  = '#0D2018';
  const VERDE_DIM = '#1A9A52';
  const BG        = '#0A1410';
  const CARD      = '#101C16';
  const CARD2     = '#152018';
  const WHITE     = '#E8F5EE';
  const MUTED     = '#5A8A78';
  const DIM       = '#2E4A3A';
  const GOLD      = '#F5A623';
  const BORDER_C  = '#1E3028';

  const nro          = datos.id || 'MYA-0001';
  const fechaEmision = datos.fechaEmision || new Date().toLocaleDateString('es-AR', { day:'numeric', month:'long', year:'numeric' });
  const clienteNombre = datos.clienteNombre || '—';
  const clienteEmail  = datos.clienteEmail  || '—';
  const mudNombre     = datos.mudanceroNombre || '—';
  const mudInits      = (datos.mudancero_initials || datos.mudanceroNombre || 'MV').slice(0,2).toUpperCase();
  const estrellas     = parseFloat(datos.estrellas || 4.8);
  const nroResenas    = datos.nro_resenas || '';
  const vehiculo      = datos.vehiculo || '';
  const desde         = datos.desde || '—';
  const hasta         = datos.hasta || '—';
  const fechaMud      = datos.fecha || datos.fecha_mudanza || '—';
  const ambientes     = datos.ambientes || '—';
  const objetos       = datos.objetos || datos.servicios || '—';
  const extras        = datos.extras || '';
  const nota          = datos.nota || '';
  const precio        = parseInt(datos.precio || datos.precio_total || 0);
  const fee           = Math.round(precio * 0.10 / 500) * 500;
  const resto         = precio - fee;
  const fmt           = (n) => '$' + n.toLocaleString('es-AR');
  const starStr       = '★'.repeat(Math.floor(estrellas)) + '☆'.repeat(5 - Math.floor(estrellas));

  function rowBorder() {
    return { canvas: [{ type: 'line', x1: 0, y1: 4, x2: 467, y2: 4, lineWidth: 0.3, lineColor: BORDER_C }] };
  }

  function detalleRow(lbl, val, isLast) {
    return {
      stack: [
        {
          columns: [
            { text: lbl.toUpperCase(), font: 'Helvetica', bold: true, fontSize: 7.5, color: MUTED, width: 90 },
            { text: String(val || '—'), font: 'Helvetica', fontSize: 8.5, color: WHITE, width: '*' },
          ],
        },
        isLast ? { text: '' } : rowBorder(),
      ],
      margin: [0, 5, 0, isLast ? 0 : 5],
    };
  }

  const filasDet = [
    ['Desde',     desde],
    ['Hasta',     hasta],
    ['Fecha',     fechaMud],
    ['Ambientes', ambientes],
    ['Objetos',   objetos],
  ];
  if (extras) filasDet.push(['Servicios', extras]);
  if (nota)   filasDet.push(['Nota del mudancero', nota]);

  function cardLayout(fillC, borderC) {
    return {
      fillColor:    () => fillC,
      hLineColor:   () => borderC,
      vLineColor:   () => borderC,
      hLineWidth:   () => 0.5,
      vLineWidth:   () => 0.5,
      paddingLeft:  () => 14,
      paddingRight: () => 14,
      paddingTop:   () => 12,
      paddingBottom:() => 12,
    };
  }

  function badgeLayout(fillC, borderC) {
    return {
      fillColor:    () => fillC,
      hLineColor:   () => borderC,
      vLineColor:   () => borderC,
      hLineWidth:   () => 0.5,
      vLineWidth:   () => 0.5,
      paddingLeft:  () => 6,
      paddingRight: () => 6,
      paddingTop:   () => 2,
      paddingBottom:() => 2,
    };
  }

  function numBadge(num) {
    return {
      table: { body: [[{ text: num, bold: true, fontSize: 10, color: VERDE, alignment: 'center' }]] },
      layout: {
        fillColor: () => VERDE_BG, hLineColor: () => VERDE_DIM, vLineColor: () => VERDE_DIM,
        hLineWidth: () => 0.6, vLineWidth: () => 0.6,
        paddingLeft: () => 8, paddingRight: () => 8, paddingTop: () => 4, paddingBottom: () => 4,
      },
      margin: [0, 0, 0, 5],
    };
  }

  const dd = {
    pageSize: 'A4',
    pageMargins: [36, 36, 36, 36],
    background: () => [
      { canvas: [{ type: 'rect', x: 0, y: 0, w: 595, h: 842, color: BG }] },
      { canvas: [{ type: 'rect', x: 0, y: 0, w: 4,   h: 842, color: VERDE }] },
    ],
    defaultStyle: { font: 'Helvetica', fontSize: 9, color: WHITE },

    content: [

      // ── HEADER ──────────────────────────────────
      {
        table: { widths: ['*', 'auto'], body: [[
          { stack: [
            { columns: [
              { text: 'Mudate', bold: true, fontSize: 24, color: WHITE, width: 'auto' },
              { text: 'Ya',     bold: true, fontSize: 24, color: VERDE,  width: 'auto' },
            ], columnGap: 0 },
            { text: 'El marketplace de mudanzas de Argentina', fontSize: 8, color: MUTED, margin: [0, 3, 0, 6] },
            { table: { body: [[{ text: '● PRESUPUESTO OFICIAL  ·  válido 24hs', bold: true, fontSize: 7, color: VERDE }]] },
              layout: badgeLayout(VERDE_BG, VERDE_DIM), margin: [0,0,0,0] },
          ]},
          { stack: [
            { text: nro, bold: true, fontSize: 14, color: VERDE, alignment: 'right' },
            { text: 'COTIZACIÓN', bold: true, fontSize: 7, color: MUTED, alignment: 'right', characterSpacing: 0.8, margin: [0, 3, 0, 2] },
            { text: fechaEmision, fontSize: 8, color: MUTED, alignment: 'right' },
          ], alignment: 'right' },
        ]]},
        layout: cardLayout(CARD, BORDER_C),
        margin: [0, 0, 0, 8],
      },

      // ── CLIENTE + MUDANCERO ──────────────────────
      {
        columns: [
          { width: '48%', table: { widths: ['*'], body: [[{ stack: [
            { text: 'CLIENTE', bold: true, fontSize: 7, color: MUTED, characterSpacing: 0.8, margin: [0,0,0,8] },
            { text: clienteNombre, bold: true, fontSize: 11, color: WHITE },
            { text: clienteEmail, fontSize: 8, color: MUTED, margin: [0,3,0,0] },
          ]}]]}, layout: cardLayout(CARD2, BORDER_C) },
          { width: '4%', text: '' },
          { width: '48%', table: { widths: ['*'], body: [[{ stack: [
            { text: 'MUDANCERO', bold: true, fontSize: 7, color: MUTED, characterSpacing: 0.8, margin: [0,0,0,8] },
            { columns: [
              { width: 34, stack: [
                { table: { body: [[{ text: mudInits, bold: true, fontSize: 10, color: VERDE, alignment: 'center' }]] },
                  layout: { fillColor: () => VERDE_BG, hLineColor: () => VERDE_DIM, vLineColor: () => VERDE_DIM,
                    hLineWidth: () => 0.8, vLineWidth: () => 0.8,
                    paddingLeft: () => 5, paddingRight: () => 5, paddingTop: () => 6, paddingBottom: () => 6 } },
              ], margin: [0, 0, 8, 0] },
              { stack: [
                { text: mudNombre, bold: true, fontSize: 11, color: WHITE },
                { columns: [
                  { text: starStr, fontSize: 9, color: GOLD, width: 'auto' },
                  { text: `  ${estrellas}${nroResenas ? '  ·  ' + nroResenas + ' reseñas' : ''}`, fontSize: 7, color: MUTED, width: '*', margin: [0,1,0,0] },
                ], margin: [0,3,0,4] },
                { columns: [
                  { table: { body: [[{ text: '✓ VERIFICADO', bold: true, fontSize: 6.5, color: VERDE }]] },
                    layout: badgeLayout(VERDE_BG, VERDE_DIM), width: 'auto' },
                  vehiculo ? { width: 4, text: '' } : null,
                  vehiculo ? { table: { body: [[{ text: vehiculo, fontSize: 6.5, color: MUTED }]] },
                    layout: badgeLayout(CARD, BORDER_C), width: 'auto' } : null,
                ].filter(Boolean) },
              ]},
            ], columnGap: 0 },
          ]}]]}, layout: cardLayout(CARD2, BORDER_C) },
        ],
        columnGap: 0,
        margin: [0, 0, 0, 8],
      },

      // ── DETALLE MUDANZA ──────────────────────────
      {
        table: { widths: ['*'], body: [[{ stack: [
          { text: 'DETALLE DE LA MUDANZA', bold: true, fontSize: 7, color: MUTED, characterSpacing: 0.8, margin: [0,0,0,6] },
          { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 467, y2: 0, lineWidth: 0.4, lineColor: BORDER_C }] },
          { text: '', margin: [0, 4, 0, 0] },
          ...filasDet.map(([lbl, val], i) => detalleRow(lbl, val, i === filasDet.length - 1)),
        ]}]]},
        layout: cardLayout(CARD, BORDER_C),
        margin: [0, 0, 0, 8],
      },

      // ── PRECIO ───────────────────────────────────
      {
        table: { widths: ['*', 130], body: [[
          { stack: [
            { text: fmt(precio), bold: true, fontSize: 30, color: VERDE },
            { text: 'PRECIO TOTAL ESTIMADO', bold: true, fontSize: 7, color: MUTED, characterSpacing: 0.5, margin: [0,4,0,2] },
            { text: 'El precio final puede ajustarse al coordinar con el mudancero.', fontSize: 7.5, color: DIM },
          ]},
          { stack: [
            { text: 'FEE MUDATEYA (10%)', bold: true, fontSize: 7, color: MUTED, alignment: 'right', characterSpacing: 0.5 },
            { text: fmt(fee), bold: true, fontSize: 13, color: WHITE, alignment: 'right', margin: [0,2,0,4] },
            { canvas: [{ type: 'line', x1: 17, y1: 0, x2: 113, y2: 0, lineWidth: 0.4, lineColor: BORDER_C }], margin: [0,0,0,4] },
            { text: 'AL MUDANCERO EL DÍA', bold: true, fontSize: 7, color: MUTED, alignment: 'right', characterSpacing: 0.5 },
            { text: fmt(resto), bold: true, fontSize: 13, color: WHITE, alignment: 'right', margin: [0,2,0,0] },
          ], alignment: 'right' },
        ]]},
        layout: {
          fillColor:    () => VERDE_BG,
          hLineColor:   () => VERDE_DIM,
          vLineColor:   () => VERDE_DIM,
          hLineWidth:   () => 0.7,
          vLineWidth:   () => 0.7,
          paddingLeft:  () => 14, paddingRight:  () => 14,
          paddingTop:   () => 14, paddingBottom: () => 14,
        },
        margin: [0, 0, 0, 8],
      },

      // ── PRÓXIMOS PASOS ───────────────────────────
      {
        table: { widths: ['*'], body: [[{ stack: [
          { text: 'PRÓXIMOS PASOS', bold: true, fontSize: 7, color: MUTED, characterSpacing: 0.8, margin: [0,0,0,10] },
          { columns: [
            { width: '25%', stack: [ numBadge('1'), { text: 'Aceptar cotización\nen MudateYa', fontSize: 7, color: MUTED, alignment: 'center' } ] },
            { width: '25%', stack: [ numBadge('2'), { text: 'Pagar fee de reserva\ncon Mercado Pago', fontSize: 7, color: MUTED, alignment: 'center' } ] },
            { width: '25%', stack: [ numBadge('3'), { text: 'Coordinar fecha\ny hora', fontSize: 7, color: MUTED, alignment: 'center' } ] },
            { width: '25%', stack: [ numBadge('4'), { text: '¡Mudanza lista!', fontSize: 7, color: MUTED, alignment: 'center' } ] },
          ], columnGap: 8 },
        ]}]]},
        layout: cardLayout(CARD2, BORDER_C),
        margin: [0, 0, 0, 8],
      },

      // ── GARANTÍAS ────────────────────────────────
      {
        columns: [
          ['🔒', 'Pago seguro',    'Mercado Pago'],
          ['✓',  'Verificado',     'ID confirmada'],
          ['★',  '4.8★ promedio',  'Miles de reseñas'],
          ['↩',  'Sin sorpresas',  'Precio acordado'],
        ].map(([icon, title, sub]) => ({
          width: '25%',
          table: { widths: ['*'], body: [[{ stack: [
            { text: icon,  fontSize: 16, color: VERDE, alignment: 'center', margin: [0,0,0,4] },
            { text: title, bold: true, fontSize: 7.5, color: WHITE, alignment: 'center', margin: [0,0,0,2] },
            { text: sub,   fontSize: 6.5, color: MUTED, alignment: 'center' },
          ]}]]},
          layout: {
            fillColor: () => CARD, hLineColor: () => BORDER_C, vLineColor: () => BORDER_C,
            hLineWidth: () => 0.4, vLineWidth: () => 0.4,
            paddingLeft: () => 6, paddingRight: () => 6, paddingTop: () => 10, paddingBottom: () => 10,
          },
        })),
        columnGap: 4,
        margin: [0, 0, 0, 10],
      },

      // ── FOOTER ───────────────────────────────────
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 523, y2: 0, lineWidth: 0.4, lineColor: BORDER_C }], margin: [0,0,0,6] },
      { columns: [
        { columns: [
          { text: 'MudateYa', bold: true, fontSize: 9, color: VERDE, width: 'auto' },
          { text: ' · El marketplace de mudanzas de Argentina · mudateya.com.ar', fontSize: 8, color: MUTED, width: '*', margin: [0,1,0,0] },
        ]},
        { text: `Válida 24hs · ${nro}`, fontSize: 7, color: DIM, alignment: 'right', margin: [0,1,0,0] },
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {

    if (action === 'publicar' && req.method === 'POST') {
      const { clienteEmail, clienteNombre, desde, hasta, ambientes, fecha, servicios, extras, zonaBase, precio_estimado } = req.body;
      if (!clienteEmail || !desde || !hasta) return res.status(400).json({ error: 'Faltan datos' });
      const id = 'MYA-' + Date.now();
      const mudanza = { id, clienteEmail, clienteNombre, desde, hasta, ambientes, fecha, servicios, extras, zonaBase, precio_estimado, estado: 'buscando', fechaPublicacion: new Date().toISOString(), expira: new Date(Date.now() + 24*60*60*1000).toISOString(), cotizaciones: [] };
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
      const cotizacion = { id: 'COT-' + Date.now(), mudanzaId, mudanceroEmail, mudanceroNombre, mudanceroTel, precio: parseInt(precio), nota: nota||'', tiempoEstimado: tiempoEstimado||'', fecha: new Date().toISOString(), estado: 'pendiente' };
      mudanza.cotizaciones.push(cotizacion);
      await setJSON(`mudanza:${mudanzaId}`, mudanza, 172800);
      const mudIdx = await getJSON(`mudancero:${mudanceroEmail}`) || [];
      if (!mudIdx.includes(mudanzaId)) mudIdx.push(mudanzaId);
      await setJSON(`mudancero:${mudanceroEmail}`, mudIdx, 2592000);
      try { await notificarCliente(mudanza, cotizacion); } catch(e) { console.error(e.message); }
      return res.status(200).json({ ok: true, cotizacion });
    }

    if (action === 'aceptar' && req.method === 'POST') {
      const { mudanzaId, cotizacionId } = req.body;
      const mudanza = await getJSON(`mudanza:${mudanzaId}`);
      if (!mudanza) return res.status(404).json({ error: 'Mudanza no encontrada' });
      const cot = mudanza.cotizaciones.find(c => c.id === cotizacionId);
      if (!cot) return res.status(404).json({ error: 'Cotización no encontrada' });
      mudanza.estado = 'cotizacion_aceptada';
      mudanza.cotizacionAceptada = cot;
      cot.estado = 'aceptada';
      await setJSON(`mudanza:${mudanzaId}`, mudanza, 604800);
      try { await enviarEmailAceptacion(mudanza, cot); } catch(e) { console.error('Error email:', e.message); }
      return res.status(200).json({ ok: true, mudanza, cotizacion: cot });
    }

    if (action === 'mis-mudanzas' && req.method === 'GET') {
      const { email } = req.query;
      if (!email) return res.status(400).json({ error: 'Falta email' });
      try {
        const ids = await getJSON(`cliente:${email}`) || [];
        const mudanzas = [];
        for (const id of ids) {
          try { const m = await getJSON(`mudanza:${id}`); if (m) mudanzas.push(m); } catch(e) {}
        }
        return res.status(200).json({ mudanzas });
      } catch(e) { return res.status(200).json({ mudanzas: [] }); }
    }

    if (action === 'por-zona' && req.method === 'GET') {
      const { email } = req.query;
      const ids = await getJSON('mudanzas:activas') || [];
      const disponibles = [];
      const ahora = new Date();
      for (const id of ids) {
        const m = await getJSON(`mudanza:${id}`);
        if (!m || m.estado !== 'buscando' || new Date(m.expira) < ahora) continue;
        if (email && m.cotizaciones.find(c => c.mudanceroEmail === email)) continue;
        disponibles.push(m);
      }
      return res.status(200).json({ mudanzas: disponibles });
    }

    if (action === 'mis-cotizaciones' && req.method === 'GET') {
      const { email } = req.query;
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

  const emailHtml = `<div style="font-family:Arial,sans-serif;max-width:580px;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden">
    <div style="background:#22C36A;padding:18px 22px"><h2 style="margin:0;color:#041A0E">✅ ¡Cotización aceptada!</h2></div>
    <div style="padding:22px">
      <p style="color:#7AADA0;line-height:1.7">Hola <strong style="color:#E8F5EE">${mudanza.clienteNombre}</strong>,</p>
      <p style="color:#7AADA0;line-height:1.7">Aceptaste la cotización de <strong style="color:#E8F5EE">${cot.mudanceroNombre}</strong> por <strong style="color:#22C36A">$${parseInt(cot.precio).toLocaleString('es-AR')}</strong>.</p>
      <div style="background:#172018;border-radius:10px;padding:14px 18px;margin:14px 0">
        <table style="width:100%">
          <tr><td style="color:#7AADA0;padding:5px 0;width:35%">Mudancero</td><td><strong>${cot.mudanceroNombre}</strong></td></tr>
          <tr><td style="color:#7AADA0;padding:5px 0">Teléfono</td><td>${cot.mudanceroTel || '—'}</td></tr>
          <tr><td style="color:#7AADA0;padding:5px 0">Ruta</td><td>${mudanza.desde} → ${mudanza.hasta}</td></tr>
          <tr><td style="color:#7AADA0;padding:5px 0">Fecha</td><td>${mudanza.fecha}</td></tr>
          <tr><td style="color:#7AADA0;padding:5px 0">Precio</td><td style="color:#22C36A;font-weight:700">$${parseInt(cot.precio).toLocaleString('es-AR')}</td></tr>
          ${cot.nota ? `<tr><td style="color:#7AADA0;padding:5px 0">Nota</td><td style="font-style:italic">${cot.nota}</td></tr>` : ''}
        </table>
      </div>
      <p style="color:#7AADA0">Encontrás el comprobante adjunto en PDF.</p>
      <a href="https://mudateya.vercel.app/mi-mudanza" style="display:inline-block;margin-top:12px;background:#22C36A;color:#041A0E;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Ver mi mudanza →</a>
    </div>
  </div>`;

  if (mudanza.clienteEmail) {
    await resend.emails.send({
      from: 'MudateYa <onboarding@resend.dev>',
      to: mudanza.clienteEmail,
      subject: `✅ Cotización aceptada — ${cot.mudanceroNombre} · $${parseInt(cot.precio).toLocaleString('es-AR')}`,
      html: emailHtml,
      attachments,
    });
  }

  if (cot.mudanceroEmail) {
    await resend.emails.send({
      from: 'MudateYa <onboarding@resend.dev>',
      to: cot.mudanceroEmail,
      subject: `🎉 ¡Aceptaron tu cotización! — ${mudanza.desde} → ${mudanza.hasta}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:580px;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden">
        <div style="background:#22C36A;padding:18px 22px"><h2 style="margin:0;color:#041A0E">🎉 ¡Te eligieron!</h2></div>
        <div style="padding:22px">
          <p style="color:#7AADA0"><strong style="color:#E8F5EE">${mudanza.clienteNombre}</strong> aceptó tu cotización de <strong style="color:#22C36A">$${parseInt(cot.precio).toLocaleString('es-AR')}</strong>.</p>
          <div style="background:#172018;border-radius:10px;padding:14px 18px;margin:14px 0">
            <table style="width:100%">
              <tr><td style="color:#7AADA0;padding:5px 0;width:35%">Ruta</td><td>${mudanza.desde} → ${mudanza.hasta}</td></tr>
              <tr><td style="color:#7AADA0;padding:5px 0">Fecha</td><td>${mudanza.fecha}</td></tr>
              <tr><td style="color:#7AADA0;padding:5px 0">Tamaño</td><td>${mudanza.ambientes}</td></tr>
              <tr><td style="color:#7AADA0;padding:5px 0">Precio acordado</td><td style="color:#22C36A;font-weight:700">$${parseInt(cot.precio).toLocaleString('es-AR')}</td></tr>
            </table>
          </div>
          <a href="https://mudateya.vercel.app/mi-cuenta" style="display:inline-block;margin-top:12px;background:#22C36A;color:#041A0E;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Ver en mi panel →</a>
        </div>
      </div>`,
      attachments,
    });
  }
}
