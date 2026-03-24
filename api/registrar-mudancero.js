// api/registrar-mudancero.js
// Guarda el registro en Google Sheets y envía emails con Resend

const { Resend } = require('resend');

module.exports = async function handler(req, res) {

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const data = req.body;

  if (!data.nombre || !data.email || !data.telefono) {
    return res.status(400).json({ error: 'Faltan datos obligatorios' });
  }

  const errors = [];

  // ── 1. GUARDAR EN GOOGLE SHEETS ──────────────────────────────────────────
  try {
    await guardarEnSheets(data);
  } catch (e) {
    console.error('Error Google Sheets:', e.message);
    errors.push('sheets: ' + e.message);
  }

  // ── 2. EMAIL AL ADMIN ────────────────────────────────────────────────────
  try {
    await enviarEmailAdmin(data);
  } catch (e) {
    console.error('Error email admin:', e.message);
    errors.push('email_admin: ' + e.message);
  }

  // ── 3. EMAIL DE CONFIRMACIÓN AL MUDANCERO ────────────────────────────────
  try {
    await enviarEmailMudancero(data);
  } catch (e) {
    console.error('Error email mudancero:', e.message);
    errors.push('email_mudancero: ' + e.message);
  }

  // Si al menos algo funcionó, devolver éxito
  if (errors.length < 3) {
    return res.status(200).json({ ok: true, warnings: errors });
  }

  return res.status(500).json({ error: 'Error al procesar la solicitud. Intentá de nuevo.' });
};


// ── GOOGLE SHEETS ──────────────────────────────────────────────────────────
async function guardarEnSheets(data) {
  const sheetsUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!sheetsUrl) throw new Error('GOOGLE_SHEETS_WEBHOOK_URL no configurada');

  const fila = [
    data.fecha || new Date().toLocaleString('es-AR'),
    data.nombre,
    data.empresa || '',
    data.telefono,
    data.email,
    data.zonaBase,
    data.zonasExtra || '',
    data.distancia || '',
    data.vehiculo,
    data.cantVehiculos || '',
    data.equipo || '',
    data.servicios || '',
    data.dias || '',
    data.horarios || '',
    data.anticipacion || '',
    data.precio1amb || '',
    data.precio2amb || '',
    data.precio3amb || '',
    data.precio4amb || '',
    data.precioFlete || '',
    data.extra || '',
    'Pendiente', // Estado
  ];

  const response = await fetch(sheetsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: fila }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Sheets respondió ${response.status}: ${text}`);
  }
}


// ── EMAIL ADMIN ────────────────────────────────────────────────────────────
async function enviarEmailAdmin(data) {
  const apiKey = process.env.RESEND_API_KEY;
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!apiKey || !adminEmail) throw new Error('Resend o admin email no configurados');

  const resend = new Resend(apiKey);

  await resend.emails.send({
    from:    'MudateYa <noreply@mudateya.vercel.app>',
    to:      adminEmail,
    subject: `🚛 Nuevo mudancero: ${data.nombre} — ${data.zonaBase}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden">
        <div style="background:#22C36A;padding:20px 24px">
          <h1 style="margin:0;font-size:20px;color:#041A0E">🚛 Nueva solicitud de mudancero</h1>
        </div>
        <div style="padding:24px">
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:8px 0;color:#7AADA0;font-size:13px;width:40%">Nombre</td><td style="padding:8px 0;font-size:13px"><strong>${data.nombre}</strong></td></tr>
            <tr><td style="padding:8px 0;color:#7AADA0;font-size:13px">Empresa</td><td style="padding:8px 0;font-size:13px">${data.empresa||'—'}</td></tr>
            <tr><td style="padding:8px 0;color:#7AADA0;font-size:13px">WhatsApp</td><td style="padding:8px 0;font-size:13px"><a href="https://wa.me/${data.telefono.replace(/\D/g,'')}" style="color:#22C36A">${data.telefono}</a></td></tr>
            <tr><td style="padding:8px 0;color:#7AADA0;font-size:13px">Email</td><td style="padding:8px 0;font-size:13px">${data.email}</td></tr>
            <tr><td style="padding:8px 0;color:#7AADA0;font-size:13px">Zona base</td><td style="padding:8px 0;font-size:13px">${data.zonaBase}</td></tr>
            <tr><td style="padding:8px 0;color:#7AADA0;font-size:13px">Zonas extra</td><td style="padding:8px 0;font-size:13px">${data.zonasExtra||'—'}</td></tr>
            <tr><td style="padding:8px 0;color:#7AADA0;font-size:13px">Vehículo</td><td style="padding:8px 0;font-size:13px">${data.vehiculo}</td></tr>
            <tr><td style="padding:8px 0;color:#7AADA0;font-size:13px">Equipo</td><td style="padding:8px 0;font-size:13px">${data.equipo}</td></tr>
            <tr><td style="padding:8px 0;color:#7AADA0;font-size:13px">Servicios</td><td style="padding:8px 0;font-size:13px">${data.servicios}</td></tr>
            <tr><td style="padding:8px 0;color:#7AADA0;font-size:13px">Días</td><td style="padding:8px 0;font-size:13px">${data.dias}</td></tr>
            <tr><td style="padding:8px 0;color:#7AADA0;font-size:13px">Horarios</td><td style="padding:8px 0;font-size:13px">${data.horarios}</td></tr>
            <tr><td style="padding:8px 0;color:#7AADA0;font-size:13px">Precios</td><td style="padding:8px 0;font-size:13px">1amb: $${data.precio1amb||'—'} · 2amb: $${data.precio2amb||'—'} · 3amb: $${data.precio3amb||'—'} · 4+: $${data.precio4amb||'—'}</td></tr>
            <tr><td style="padding:8px 0;color:#7AADA0;font-size:13px">Notas</td><td style="padding:8px 0;font-size:13px">${data.extra||'—'}</td></tr>
            <tr><td style="padding:8px 0;color:#7AADA0;font-size:13px">Fecha</td><td style="padding:8px 0;font-size:13px">${data.fecha}</td></tr>
          </table>
          <div style="margin-top:20px">
            <a href="https://wa.me/${data.telefono.replace(/\D/g,'')}" style="display:inline-block;background:#22C36A;color:#041A0E;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">
              📱 Contactar por WhatsApp
            </a>
          </div>
        </div>
      </div>
    `,
  });
}


// ── EMAIL MUDANCERO ────────────────────────────────────────────────────────
async function enviarEmailMudancero(data) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY no configurada');

  const resend = new Resend(apiKey);

  await resend.emails.send({
    from:    'MudateYa <noreply@mudateya.vercel.app>',
    to:      data.email,
    subject: `¡Recibimos tu solicitud, ${data.nombre.split(' ')[0]}! 🚛`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden">
        <div style="background:#22C36A;padding:20px 24px">
          <h1 style="margin:0;font-size:22px;color:#041A0E">MudateYa 🚛</h1>
        </div>
        <div style="padding:28px 24px">
          <h2 style="margin:0 0 12px;font-size:20px">¡Hola, ${data.nombre.split(' ')[0]}!</h2>
          <p style="color:#7AADA0;line-height:1.7;margin:0 0 20px">Recibimos tu solicitud para sumarte como mudancero en MudateYa. 
          Estamos revisando tu información y te vamos a contactar por WhatsApp en las próximas <strong style="color:#E8F5EE">24 horas</strong>.</p>
          
          <div style="background:#172018;border-radius:12px;padding:16px 20px;margin-bottom:20px">
            <h3 style="margin:0 0 12px;font-size:15px;color:#22C36A">¿Qué pasa ahora?</h3>
            <div style="display:flex;flex-direction:column;gap:10px">
              <div style="display:flex;gap:10px;align-items:flex-start">
                <span style="background:#22C36A;color:#041A0E;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;text-align:center;line-height:20px">1</span>
                <span style="color:#7AADA0;font-size:14px">Revisamos tu solicitud y verificamos tus datos</span>
              </div>
              <div style="display:flex;gap:10px;align-items:flex-start">
                <span style="background:#22C36A;color:#041A0E;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;text-align:center;line-height:20px">2</span>
                <span style="color:#7AADA0;font-size:14px">Te contactamos por WhatsApp al ${data.telefono}</span>
              </div>
              <div style="display:flex;gap:10px;align-items:flex-start">
                <span style="background:#22C36A;color:#041A0E;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;text-align:center;line-height:20px">3</span>
                <span style="color:#7AADA0;font-size:14px">Activamos tu perfil y empezás a recibir pedidos</span>
              </div>
            </div>
          </div>

          <p style="color:#3D6458;font-size:12px;margin:0">¿Tenés alguna duda? Respondé este email o escribinos directamente.</p>
        </div>
      </div>
    `,
  });
}
