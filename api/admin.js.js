// api/admin.js — Combina admin-data y admin-accion
const { Resend } = require('resend');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET — leer datos de Sheets ──────────────────────────────────────────
  if (req.method === 'GET') {
    const type = req.query.type;
    if (!type) return res.status(400).json({ error: 'Falta type' });
    const sheetUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
    if (!sheetUrl) return res.status(200).json({ rows: [] });
    try {
      const response = await fetch(sheetUrl + '?sheet=' + type);
      const text = await response.text();
      const data = JSON.parse(text);
      return res.status(200).json({ rows: data.rows || [], total: data.total || 0 });
    } catch (e) {
      return res.status(200).json({ rows: [], error: e.message });
    }
  }

  // ── POST — acciones del admin ──────────────────────────────────────────
  if (req.method === 'POST') {
    const { tipo, nuevoEstado, email, nombre, telefono, rowIndex } = req.body;

    if (tipo === 'cambiar-estado-mudancero') {
      const errors = [];
      try {
        const sheetUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
        if (sheetUrl) {
          await fetch(sheetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'update-status', rowIndex, nuevoEstado }),
          });
        }
      } catch (e) { errors.push('sheet: ' + e.message); }

      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        if (nuevoEstado === 'Aprobado') {
          await resend.emails.send({
            from: 'MudateYa <onboarding@resend.dev>', to: email,
            subject: `¡Tu perfil fue aprobado, ${nombre.split(' ')[0]}! 🎉`,
            html: `<div style="font-family:Arial;max-width:600px;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden"><div style="background:#22C36A;padding:20px 24px"><h1 style="margin:0;color:#041A0E">¡Bienvenido a MudateYa! 🚛</h1></div><div style="padding:28px 24px"><p style="color:#7AADA0;line-height:1.7">Hola <strong>${nombre.split(' ')[0]}</strong>, tu perfil fue <strong style="color:#22C36A">aprobado</strong>. Ya podés recibir pedidos en tu zona.</p><a href="https://mudateya.vercel.app/mi-cuenta" style="display:inline-block;margin-top:16px;background:#22C36A;color:#041A0E;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Ver mi panel →</a></div></div>`,
          });
        } else if (nuevoEstado === 'Rechazado') {
          await resend.emails.send({
            from: 'MudateYa <onboarding@resend.dev>', to: email,
            subject: `Actualización sobre tu solicitud — MudateYa`,
            html: `<div style="font-family:Arial;max-width:600px;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden"><div style="background:#2A3C32;padding:20px 24px"><h1 style="margin:0">MudateYa</h1></div><div style="padding:28px 24px"><p style="color:#7AADA0;line-height:1.7">Hola <strong>${nombre.split(' ')[0]}</strong>, en este momento no pudimos activar tu perfil. Respondé este email para más info.</p></div></div>`,
          });
        }
      } catch (e) { errors.push('email: ' + e.message); }

      return res.status(200).json({ ok: true, warnings: errors });
    }

    return res.status(400).json({ error: 'Acción no reconocida' });
  }

  return res.status(405).json({ error: 'Método no permitido' });
};
