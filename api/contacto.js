// api/contacto.js
// Recibe el formulario de contacto (contacto.html) y lo manda por mail al equipo.
// Antes el form solo abría un mailto: del lado del cliente y mostraba "éxito"
// SIEMPRE, aunque el usuario no tuviera cliente de mail configurado (muy común en
// mobile) — un cliente con un problema real podía creer que ya avisó a MudateYa
// sin haberlo hecho. Ahora se manda de verdad desde el servidor.

const { Resend } = require('resend');

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://mudateya.ar');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    const body = req.body || {};
    const nombre = String(body.nombre || '').trim().slice(0, 200);
    const email = String(body.email || '').trim().slice(0, 200);
    const tipo = String(body.tipo || '').trim().slice(0, 100);
    const asunto = String(body.asunto || '').trim().slice(0, 100);
    const mensaje = String(body.mensaje || '').trim().slice(0, 5000);

    if (!nombre || !email || !mensaje) {
      return res.status(400).json({ error: 'Faltan datos: nombre, email y mensaje son obligatorios' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'El email no es válido' });
    }

    if (!process.env.RESEND_API_KEY || !process.env.ADMIN_EMAIL) {
      console.error('contacto.js: falta RESEND_API_KEY o ADMIN_EMAIL');
      return res.status(500).json({ error: 'No se pudo enviar el mensaje. Escribinos directo a hola@mudateya.ar' });
    }

    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: 'MudateYa <noreply@mudateya.ar>',
      reply_to: email,
      to: process.env.ADMIN_EMAIL,
      subject: `[Contacto] ${asunto || 'Consulta general'} — ${nombre}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
          <h2 style="color:#003580">Nuevo mensaje de contacto</h2>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr><td style="color:#64748B;padding:6px 0;width:100px">Nombre</td><td style="font-weight:600">${esc(nombre)}</td></tr>
            <tr><td style="color:#64748B;padding:6px 0">Email</td><td>${esc(email)}</td></tr>
            <tr><td style="color:#64748B;padding:6px 0">Soy</td><td>${esc(tipo)}</td></tr>
            <tr><td style="color:#64748B;padding:6px 0">Asunto</td><td>${esc(asunto)}</td></tr>
          </table>
          <p style="color:#64748B;font-size:13px;margin:16px 0 4px">Mensaje:</p>
          <p style="white-space:pre-wrap;background:#F5F7FA;border-radius:8px;padding:14px;font-size:14px">${esc(mensaje)}</p>
          <p style="color:#94A3B8;font-size:11px;margin-top:20px">Enviado desde mudateya.ar/contacto · reply-to configurado a ${esc(email)}</p>
        </div>`,
    });

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Error en contacto.js:', e.message);
    return res.status(500).json({ error: 'No se pudo enviar el mensaje. Escribinos directo a hola@mudateya.ar' });
  }
};
