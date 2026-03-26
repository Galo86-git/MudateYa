// api/generar-pdf.js
// Genera PDF de cotización usando pdfmake y lo devuelve como base64

const PdfPrinter = require('pdfmake');

const fonts = {
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
};

function formatPeso(n) {
  return '$ ' + parseInt(n).toLocaleString('es-AR');
}

function generarDocDefinition(data) {
  const {
    id, fechaEmision,
    clienteNombre, clienteEmail,
    mudanceroNombre, mudanceroTel,
    desde, hasta, fecha, ambientes,
    objetos, extras, precio, nota,
  } = data;

  const fee = Math.round(precio * 0.10);
  const resto = precio - fee;

  const C_EMERALD = '#22C36A';
  const C_BG      = '#080E0C';
  const C_SURFACE = '#172018';
  const C_TEXT    = '#E8F5EE';
  const C_TEXT2   = '#7AADA0';
  const C_TEXT3   = '#3D6458';
  const C_AMBER   = '#FFB300';
  const C_BORDER  = '#213029';

  const row = (label, value) => ({
    columns: [
      { text: label, width: 90, style: 'rowLabel' },
      { text: value || '—', style: 'rowValue' },
    ],
    margin: [0, 3, 0, 3],
  });

  return {
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 60],
    defaultStyle: { font: 'Helvetica', fontSize: 10, color: C_TEXT },
    background: (currentPage, pageSize) => ({
      canvas: [
        // Fondo oscuro
        { type: 'rect', x: 0, y: 0, w: pageSize.width, h: pageSize.height, color: C_BG },
        // Línea verde izquierda
        { type: 'rect', x: 0, y: 0, w: 4, h: pageSize.height, color: C_EMERALD },
      ],
    }),
    content: [
      // ── HEADER ──────────────────────────────────────────────────────────
      {
        canvas: [{ type: 'rect', x: -40, y: -40, w: 595, h: 90, color: '#0D1410' }],
        margin: [0, 0, 0, 0],
      },
      {
        columns: [
          {
            stack: [
              { text: [{ text: 'MUDATE', style: 'logoWhite' }, { text: 'YA', style: 'logoGreen' }] },
              { text: 'mudateya.ar · El marketplace de mudanzas de Argentina', style: 'tagline', margin: [0, 2, 0, 0] },
            ],
          },
          {
            stack: [
              { text: 'COTIZACIÓN', style: 'titleRight' },
              { text: 'N° ' + id, style: 'metaRight' },
              { text: fechaEmision, style: 'metaRight' },
            ],
            alignment: 'right',
          },
        ],
        margin: [0, -70, 0, 0],
        columnGap: 10,
      },
      // Badge aceptada
      {
        table: {
          widths: ['auto'],
          body: [[{ text: '✓  COTIZACIÓN ACEPTADA', style: 'badge', fillColor: C_EMERALD }]],
        },
        layout: 'noBorders',
        margin: [0, 18, 0, 20],
      },

      // ── DATOS ────────────────────────────────────────────────────────────
      {
        columns: [
          {
            stack: [
              { text: 'CLIENTE', style: 'sectionTitle', color: C_EMERALD },
              { canvas: [{ type: 'rect', x: 0, y: 0, w: 235, h: 52, r: 4, color: C_SURFACE }] },
              {
                stack: [
                  row('Nombre', clienteNombre),
                  row('Email', clienteEmail),
                ],
                margin: [8, -44, 8, 8],
              },
            ],
          },
          {
            stack: [
              { text: 'MUDANCERO', style: 'sectionTitle', color: C_EMERALD },
              { canvas: [{ type: 'rect', x: 0, y: 0, w: 235, h: 52, r: 4, color: C_SURFACE }] },
              {
                stack: [
                  row('Empresa', mudanceroNombre),
                  row('Teléfono', mudanceroTel),
                ],
                margin: [8, -44, 8, 8],
              },
            ],
          },
        ],
        columnGap: 15,
        margin: [0, 0, 0, 20],
      },

      // ── DETALLE MUDANZA ──────────────────────────────────────────────────
      { text: 'DETALLE DE LA MUDANZA', style: 'sectionTitle', color: C_EMERALD },
      {
        canvas: [{ type: 'line', x1: 0, y1: 0, x2: 60, y2: 0, lineWidth: 2, lineColor: C_EMERALD }],
        margin: [0, 2, 0, 10],
      },
      ...([
        ['Origen',   desde],
        ['Destino',  hasta],
        ['Fecha',    fecha],
        ['Tamaño',   ambientes],
        ['Objetos',  objetos],
        ...(extras ? [['Extras', extras]] : []),
      ].map(([label, value], i) => ({
        fillColor: i % 2 === 0 ? '#0D1410' : C_SURFACE,
        columns: [
          { text: label, width: 80, style: 'rowLabel' },
          { text: value || '—', style: 'rowValue', color: C_TEXT },
        ],
        margin: [8, 5, 8, 5],
      }))),

      // Nota del mudancero
      ...(nota ? [{
        stack: [
          { text: '📝  Nota del mudancero', style: 'rowLabel', color: C_EMERALD, margin: [0, 0, 0, 4] },
          { text: nota, style: 'nota' },
        ],
        margin: [0, 12, 0, 0],
        fillColor: C_SURFACE,
        border: [false, false, false, false],
      }] : []),

      { text: '', margin: [0, 16, 0, 0] },

      // ── PRECIO ───────────────────────────────────────────────────────────
      {
        table: {
          widths: ['*', 'auto'],
          body: [
            [
              {
                stack: [
                  { text: 'PRECIO COTIZADO', style: 'priceLabel' },
                  { text: formatPeso(precio), style: 'priceMain', color: C_EMERALD },
                  { text: 'Acordado con el mudancero', style: 'priceSub' },
                ],
              },
              {
                stack: [
                  { text: 'FEE MUDATEYA (10%)', style: 'priceLabel', alignment: 'right' },
                  { text: formatPeso(fee), style: 'priceSec', color: C_AMBER, alignment: 'right' },
                  { text: 'Resto al mudancero: ' + formatPeso(resto), style: 'priceSub', alignment: 'right' },
                ],
              },
            ],
          ],
        },
        layout: {
          fillColor: () => C_SURFACE,
          hLineColor: () => C_EMERALD,
          vLineColor: () => C_BORDER,
          hLineWidth: (i) => i === 0 || i === 1 ? 1 : 0,
          vLineWidth: () => 0,
          paddingLeft: () => 14,
          paddingRight: () => 14,
          paddingTop: () => 14,
          paddingBottom: () => 14,
        },
        margin: [0, 0, 0, 24],
      },
    ],
    footer: (currentPage, pageCount) => ({
      columns: [
        { text: '© 2025 MudateYa · mudateya.ar · soporte@mudateya.ar · Hecho en Argentina 🇦🇷', style: 'footer' },
        { text: 'ID: ' + id, style: 'footer', alignment: 'right' },
      ],
      margin: [40, 10, 40, 0],
    }),
    styles: {
      logoWhite:    { font: 'Helvetica', bold: true, fontSize: 28, color: C_TEXT },
      logoGreen:    { font: 'Helvetica', bold: true, fontSize: 28, color: C_EMERALD },
      tagline:      { fontSize: 8, color: C_TEXT2 },
      titleRight:   { font: 'Helvetica', bold: true, fontSize: 20, color: C_EMERALD },
      metaRight:    { fontSize: 8, color: C_TEXT2, margin: [0, 2, 0, 0] },
      badge:        { font: 'Helvetica', bold: true, fontSize: 9, color: '#041A0E', padding: [8, 5, 8, 5] },
      sectionTitle: { font: 'Helvetica', bold: true, fontSize: 9, letterSpacing: 1, margin: [0, 0, 0, 6] },
      rowLabel:     { font: 'Helvetica', bold: true, fontSize: 9, color: C_TEXT2 },
      rowValue:     { fontSize: 9, color: C_TEXT },
      nota:         { fontSize: 9, color: C_TEXT2, italics: true, lineHeight: 1.5 },
      priceLabel:   { font: 'Helvetica', bold: true, fontSize: 8, color: C_TEXT2, margin: [0, 0, 0, 4] },
      priceMain:    { font: 'Helvetica', bold: true, fontSize: 26, lineHeight: 1 },
      priceSec:     { font: 'Helvetica', bold: true, fontSize: 16, lineHeight: 1 },
      priceSub:     { fontSize: 8, color: C_TEXT2, margin: [0, 4, 0, 0] },
      footer:       { fontSize: 7, color: C_TEXT3 },
    },
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    const data = req.body;
    const printer = new PdfPrinter(fonts);
    const docDef = generarDocDefinition(data);
    const pdfDoc = printer.createPdfKitDocument(docDef);

    const chunks = [];
    pdfDoc.on('data', chunk => chunks.push(chunk));
    pdfDoc.on('end', () => {
      const pdfBuffer = Buffer.concat(chunks);
      const base64 = pdfBuffer.toString('base64');
      res.status(200).json({ pdf: base64, filename: `cotizacion-mudateya-${data.id}.pdf` });
    });
    pdfDoc.end();
  } catch (e) {
    console.error('Error generando PDF:', e);
    res.status(500).json({ error: e.message });
  }
};
