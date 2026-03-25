// api/registrar-transferencia.js
// Registra una transferencia pendiente y notifica al admin

const { Resend } = require('resend');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { clienteEmail, clienteNombre, mudancero, desde, hasta, monto, fecha } = req.body;

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const adminEmail = process.env.ADMIN_EMAIL;

    if (adminEmail) {
      await resend.emails.send({
        from: 'MudateYa <onboarding@resend.dev>',
        to: adminEmail,
        subject: `💸 Transferencia pendiente — ${clienteNombre} · ${monto}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:580px;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden">
            <div style="background:#FFB300;padding:18px 22px">
              <h2 style="margin:0;color:#041A0E">💸 Nueva transferencia pendiente de validación</h2>
            </div>
            <div style="padding:22px">
              <table style="width:100%;border-collapse:collapse">
                <tr><td style="color:#7AADA0;padding:7px 0;width:35%">Cliente</td><td><strong>${clienteNombre}</strong></td></tr>
                <tr><td style="color:#7AADA0;padding:7px 0">Email</td><td>${clienteEmail}</td></tr>
                <tr><td style="color:#7AADA0;padding:7px 0">Mudancero</td><td>${mudancero}</td></tr>
                <tr><td style="color:#7AADA0;padding:7px 0">Desde</td><td>${desde}</td></tr>
                <tr><td style="color:#7AADA0;padding:7px 0">Hasta</td><td>${hasta}</td></tr>
                <tr><td style="color:#7AADA0;padding:7px 0">Monto</td><td style="color:#FFB300;font-weight:700;font-size:1.1em">${monto}</td></tr>
                <tr><td style="color:#7AADA0;padding:7px 0">Fecha</td><td>${fecha}</td></tr>
              </table>
              <div style="margin-top:16px;padding:12px;background:#172018;border-radius:8px;font-size:12px;color:#7AADA0">
                El cliente subió el comprobante. Verificá la transferencia y confirmá la reserva manualmente.
              </div>
            </div>
          </div>`,
      });
    }

    // Email de confirmación al cliente
    if (clienteEmail) {
      await resend.emails.send({
        from: 'MudateYa <onboarding@resend.dev>',
        to: clienteEmail,
        subject: `Recibimos tu comprobante — MudateYa`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:580px;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden">
            <div style="background:#22C36A;padding:18px 22px">
              <h2 style="margin:0;color:#041A0E">✅ Comprobante recibido</h2>
            </div>
            <div style="padding:22px">
              <p style="color:#7AADA0;line-height:1.7">Hola <strong style="color:#E8F5EE">${clienteNombre}</strong>,<br>
              recibimos tu comprobante de transferencia de <strong style="color:#22C36A">${monto}</strong>.<br>
              Vamos a verificarlo en las próximas <strong style="color:#E8F5EE">2 horas hábiles</strong> y te confirmaremos la reserva por email.</p>
              <div style="background:#172018;border-radius:10px;padding:14px;margin-top:16px;font-size:12px;color:#7AADA0">
                <strong style="color:#E8F5EE">Detalle:</strong><br>
                Mudancero: ${mudancero}<br>
                ${desde} → ${hasta}
              </div>
            </div>
          </div>`,
      });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error registrando transferencia:', error);
    return res.status(500).json({ error: error.message });
  }
};
