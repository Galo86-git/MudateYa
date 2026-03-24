// api/admin-accion.js
// Ejecuta acciones del admin: aprobar/rechazar mudanceros, etc.

const { Resend } = require('resend');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { tipo, nuevoEstado, email, nombre, telefono, rowIndex } = req.body;

  if (tipo === 'cambiar-estado-mudancero') {
    const errors = [];

    // 1. Actualizar estado en Google Sheets
    try {
      const sheetUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
      if (sheetUrl) {
        await fetch(sheetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'update-status',
            rowIndex,
            nuevoEstado,
          }),
        });
      }
    } catch (e) {
      console.error('Error actualizando Sheet:', e);
      errors.push('sheet: ' + e.message);
    }

    // 2. Enviar email al mudancero
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);

      if (nuevoEstado === 'Aprobado') {
        await resend.emails.send({
          from: 'MudateYa <onboarding@resend.dev>',
          to: email,
          subject: `¡Tu perfil fue aprobado, ${nombre.split(' ')[0]}! 🎉`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden">
              <div style="background:#22C36A;padding:20px 24px">
                <h1 style="margin:0;font-size:22px;color:#041A0E">¡Bienvenido a MudateYa! 🚛</h1>
              </div>
              <div style="padding:28px 24px">
                <h2 style="margin:0 0 12px;font-size:20px">¡Hola, ${nombre.split(' ')[0]}!</h2>
                <p style="color:#7AADA0;line-height:1.7;margin:0 0 20px">
                  Tu perfil fue <strong style="color:#22C36A">aprobado</strong>. Ya podés empezar a recibir pedidos de mudanza en tu zona.
                </p>
                <div style="background:#172018;border-radius:12px;padding:16px 20px;margin-bottom:20px">
                  <h3 style="margin:0 0 10px;font-size:15px;color:#22C36A">¿Qué pasa ahora?</h3>
                  <p style="color:#7AADA0;font-size:14px;margin:0;line-height:1.7">
                    • Los usuarios de tu zona van a ver tu perfil cuando busquen mudanceros<br>
                    • Cuando alguien elija tu servicio, te llegará una notificación<br>
                    • Coordinás directo con el cliente y cobrás el trabajo
                  </p>
                </div>
                <p style="color:#3D6458;font-size:12px;margin:0">
                  ¿Tenés dudas? Respondé este email o escribinos directamente.
                </p>
              </div>
            </div>
          `,
        });
      } else if (nuevoEstado === 'Rechazado') {
        await resend.emails.send({
          from: 'MudateYa <onboarding@resend.dev>',
          to: email,
          subject: `Actualización sobre tu solicitud — MudateYa`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden">
              <div style="background:#2A3C32;padding:20px 24px">
                <h1 style="margin:0;font-size:22px;color:#E8F5EE">MudateYa</h1>
              </div>
              <div style="padding:28px 24px">
                <h2 style="margin:0 0 12px;font-size:18px">Hola, ${nombre.split(' ')[0]}</h2>
                <p style="color:#7AADA0;line-height:1.7;margin:0 0 20px">
                  Revisamos tu solicitud y en este momento no podemos activar tu perfil. 
                  Puede ser por zona de cobertura, documentación incompleta u otros criterios internos.
                </p>
                <p style="color:#7AADA0;line-height:1.7;margin:0">
                  Si creés que es un error o querés más información, respondé este email y te ayudamos.
                </p>
              </div>
            </div>
          `,
        });
      }
    } catch (e) {
      console.error('Error enviando email:', e);
      errors.push('email: ' + e.message);
    }

    return res.status(200).json({ ok: true, warnings: errors });
  }

  return res.status(400).json({ error: 'Acción no reconocida' });
};
