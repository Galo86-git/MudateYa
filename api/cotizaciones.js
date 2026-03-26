// api/cotizaciones.js — con Upstash Redis + PDF inline (sin archivos extra)
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
// GENERADOR DE PDF (inline, sin archivo separado)
// Genera un PDF en base64 usando solo código nativo
// ════════════════════════════════════════════════════
function generarPDFBase64(datos) {
  // Usamos jsPDF via CDN-style inline — en Node usamos una versión simplificada
  // Genera un PDF válido con estructura mínima usando Buffer
  
  const lines = [];
  const add = (s) => lines.push(s);

  // Datos del PDF
  const nro = datos.id || 'MYA-0001';
  const fechaEmision = datos.fechaEmision || new Date().toLocaleDateString('es-AR');
  const mudanceroNombre = (datos.mudanceroNombre || 'Mudancero').replace(/[()\\]/g, '');
  const clienteNombre = (datos.clienteNombre || 'Cliente').replace(/[()\\]/g, '');
  const desde = (datos.desde || '—').replace(/[()\\]/g, '').slice(0, 60);
  const hasta = (datos.hasta || '—').replace(/[()\\]/g, '').slice(0, 60);
  const fecha = (datos.fecha || '—').replace(/[()\\]/g, '');
  const ambientes = (datos.ambientes || '—').replace(/[()\\]/g, '');
  const objetos = (datos.objetos || '—').replace(/[()\\]/g, '').slice(0, 80);
  const extras = (datos.extras || '').replace(/[()\\]/g, '').slice(0, 60);
  const precio = parseInt(datos.precio || 0);
  const fee = Math.round(precio * 0.10 / 500) * 500;
  const resto = precio - fee;
  const precioFmt = '$' + precio.toLocaleString('es-AR');
  const feeFmt = '$' + fee.toLocaleString('es-AR');
  const restoFmt = '$' + resto.toLocaleString('es-AR');
  const nota = (datos.nota || '').replace(/[()\\]/g, '').slice(0, 100);

  // ── Construir PDF manualmente ──────────────────────
  const objects = [];
  let objNum = 1;

  function pdfStr(s) { return `(${s})`; }
  function addObj(content) {
    const num = objNum++;
    objects.push({ num, content });
    return num;
  }

  // Página content stream
  const pageContent = `
BT
/F1 20 Tf
0.133 0.765 0.416 rg
56 780 Td
(MudateYa) Tj
0.91 0.96 0.93 rg
/F1 8 Tf
0 -16 Td
(El marketplace de mudanzas de Argentina) Tj

% Numero cotizacion
0.133 0.765 0.416 rg
/F1 14 Tf
350 796 Td
(${nro}) Tj
0.35 0.54 0.47 rg
/F1 7 Tf
0 -14 Td
(COTIZACION OFICIAL) Tj
0.56 0.69 0.63 rg
/F1 8 Tf
0 -12 Td
(${fechaEmision}) Tj

% Linea separadora
ET
0.118 0.176 0.149 rg
56 748 612 2 re f
BT

% MUDANCERO
0.56 0.69 0.63 rg
/F1 7 Tf
56 730 Td
(MUDANCERO ASIGNADO) Tj
0.91 0.96 0.93 rg
/F1 13 Tf
0 -18 Td
(${mudanceroNombre}) Tj
0.133 0.765 0.416 rg
/F1 8 Tf
0 -14 Td
(Verificado  |  MudateYa) Tj

% LINEA
ET
0.118 0.176 0.149 rg
56 690 500 1 re f
BT

% DETALLE
0.56 0.69 0.63 rg
/F1 7 Tf
56 678 Td
(DETALLE DE LA MUDANZA) Tj

0.91 0.96 0.93 rg
/F1 8 Tf
56 660 Td
(DESDE) Tj
/F1 9 Tf
150 660 Td
(${desde}) Tj

0.91 0.96 0.93 rg
/F1 8 Tf
56 642 Td
(HASTA) Tj
/F1 9 Tf
150 642 Td
(${hasta}) Tj

0.91 0.96 0.93 rg
/F1 8 Tf
56 624 Td
(FECHA) Tj
/F1 9 Tf
150 624 Td
(${fecha}) Tj

0.91 0.96 0.93 rg
/F1 8 Tf
56 606 Td
(AMBIENTES) Tj
/F1 9 Tf
150 606 Td
(${ambientes}) Tj

0.91 0.96 0.93 rg
/F1 8 Tf
56 588 Td
(OBJETOS) Tj
/F1 9 Tf
150 588 Td
(${objetos}) Tj

${extras ? `
0.91 0.96 0.93 rg
/F1 8 Tf
56 570 Td
(SERVICIOS) Tj
/F1 9 Tf
150 570 Td
(${extras}) Tj
` : ''}

${nota ? `
0.56 0.69 0.63 rg
/F1 8 Tf
56 552 Td
(NOTA DEL MUDANCERO) Tj
0.91 0.96 0.93 rg
/F1 9 Tf
150 552 Td
(${nota}) Tj
` : ''}

% PRECIO BOX
ET
0.051 0.125 0.094 rg
56 480 500 80 re f
0.082 0.306 0.196 rg
56 480 500 80 re S
BT

0.133 0.765 0.416 rg
/F1 30 Tf
66 525 Td
(${precioFmt}) Tj

0.56 0.69 0.63 rg
/F1 7 Tf
0 -18 Td
(PRECIO TOTAL ESTIMADO) Tj
0.35 0.54 0.47 rg
/F1 7 Tf
0 -12 Td
(El precio final puede ajustarse al coordinar.) Tj

% Desglose
0.56 0.69 0.63 rg
/F1 7 Tf
380 548 Td
(FEE MUDATEYA (10%)) Tj
0.91 0.96 0.93 rg
/F1 11 Tf
0 -14 Td
(${feeFmt}) Tj

ET
0.118 0.176 0.149 rg
378 528 144 1 re f
BT

0.56 0.69 0.63 rg
/F1 7 Tf
380 522 Td
(AL MUDANCERO EL DIA) Tj
0.91 0.96 0.93 rg
/F1 11 Tf
0 -14 Td
(${restoFmt}) Tj

% PROXIMOS PASOS
ET
0.078 0.157 0.118 rg
56 420 500 52 re f
0.118 0.176 0.149 rg
56 420 500 52 re S
BT

0.56 0.69 0.63 rg
/F1 7 Tf
66 462 Td
(PROXIMOS PASOS) Tj

0.91 0.96 0.93 rg
/F1 8 Tf
66 446 Td
(1. Aceptar cotizacion en MudateYa) Tj
0 -14 Td
(2. Pagar fee de reserva con Mercado Pago) Tj
0 -14 Td
(3. Coordinar fecha y hora con el mudancero) Tj

% FOOTER
ET
0.118 0.176 0.149 rg
56 60 500 1 re f
BT
0.133 0.765 0.416 rg
/F1 9 Tf
56 48 Td
(MudateYa) Tj
0.35 0.54 0.47 rg
/F1 8 Tf
110 48 Td
( - El marketplace de mudanzas de Argentina) Tj
0.118 0.176 0.149 rg
/F1 7 Tf
56 36 Td
(Cotizacion valida por 24 horas  |  ${nro}  |  mudateya.com.ar) Tj

ET
`.trim();

  // Construir PDF binario como string
  const catalog_id = 1;
  const pages_id = 2;
  const page_id = 3;
  const content_id = 4;
  const font_id = 5;

  let pdf = '%PDF-1.4\n';
  const offsets = {};

  function writeObj(id, content) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${content}\nendobj\n`;
  }

  // Font
  writeObj(font_id, `<<
  /Type /Font
  /Subtype /Type1
  /BaseFont /Helvetica
  /Encoding /WinAnsiEncoding
>>`);

  // Content stream — fondo negro primero
  const bgAndContent = `0.039 0.078 0.063 rg\n0 0 612 792 re\nf\n` + pageContent;
  const streamBytes = Buffer.from(bgAndContent, 'latin1');
  
  writeObj(content_id, `<<\n  /Length ${streamBytes.length}\n>>\nstream\n${bgAndContent}\nendstream`);

  // Page
  writeObj(page_id, `<<
  /Type /Page
  /Parent ${pages_id} 0 R
  /MediaBox [0 0 612 792]
  /Contents ${content_id} 0 R
  /Resources <<
    /Font << /F1 ${font_id} 0 R >>
  >>
>>`);

  // Pages
  writeObj(pages_id, `<<
  /Type /Pages
  /Kids [${page_id} 0 R]
  /Count 1
>>`);

  // Catalog
  writeObj(catalog_id, `<<
  /Type /Catalog
  /Pages ${pages_id} 0 R
>>`);

  // xref
  const xrefOffset = pdf.length;
  const allIds = [catalog_id, pages_id, page_id, content_id, font_id];
  const maxId = Math.max(...allIds);

  pdf += 'xref\n';
  pdf += `0 ${maxId + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= maxId; i++) {
    const off = offsets[i];
    if (off !== undefined) {
      pdf += String(off).padStart(10, '0') + ' 00000 n \n';
    } else {
      pdf += '0000000000 65535 f \n';
    }
  }

  pdf += `trailer\n<<\n  /Size ${maxId + 1}\n  /Root ${catalog_id} 0 R\n>>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, 'latin1').toString('base64');
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
      try { await enviarEmailAceptacion(mudanza, cot); } catch(e) { console.error('Error email aceptacion:', e.message); }
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
      } catch(e) {
        return res.status(200).json({ mudanzas: [] });
      }
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
        <a href="https://mudateya.vercel.app/mi-mudanza" style="display:inline-block;background:#22C36A;color:#041A0E;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Ver cotizaciones →</a>
      </div>
    </div>`,
  });
}

async function enviarEmailAceptacion(mudanza, cot) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  if (!process.env.RESEND_API_KEY) return;

  // Generar PDF inline — sin llamada externa
  let attachments = [];
  try {
    const pdfBase64 = generarPDFBase64({
      id: mudanza.id,
      fechaEmision: new Date().toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' }),
      clienteNombre: mudanza.clienteNombre,
      clienteEmail: mudanza.clienteEmail,
      mudanceroNombre: cot.mudanceroNombre,
      mudanceroTel: cot.mudanceroTel,
      desde: mudanza.desde,
      hasta: mudanza.hasta,
      fecha: mudanza.fecha,
      ambientes: mudanza.ambientes,
      objetos: mudanza.servicios,
      extras: mudanza.extras,
      precio: cot.precio,
      nota: cot.nota,
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

  // Email al cliente
  if (mudanza.clienteEmail) {
    await resend.emails.send({
      from: 'MudateYa <onboarding@resend.dev>',
      to: mudanza.clienteEmail,
      subject: `✅ Cotización aceptada — ${cot.mudanceroNombre} · $${parseInt(cot.precio).toLocaleString('es-AR')}`,
      html: emailHtml,
      attachments,
    });
  }

  // Email al mudancero
  if (cot.mudanceroEmail) {
    await resend.emails.send({
      from: 'MudateYa <onboarding@resend.dev>',
      to: cot.mudanceroEmail,
      subject: `🎉 ¡Aceptaron tu cotización! — ${mudanza.desde} → ${mudanza.hasta}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:580px;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden">
        <div style="background:#22C36A;padding:18px 22px"><h2 style="margin:0;color:#041A0E">🎉 ¡Te eligieron!</h2></div>
        <div style="padding:22px">
          <p style="color:#7AADA0;line-height:1.7"><strong style="color:#E8F5EE">${mudanza.clienteNombre}</strong> aceptó tu cotización de <strong style="color:#22C36A">$${parseInt(cot.precio).toLocaleString('es-AR')}</strong>.</p>
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
