// api/admin-enviar-whatsapp.js
//
// Mandar un WhatsApp de TEXTO LIBRE a un número puntual, a mano, desde el
// admin — para casos como "me quedé pensando, te lo aclaro mejor" que no
// encajan en ningún flujo automático. Reusa enviarWhatsAppTexto (_whatsapp.js),
// la misma función que ya usan los avisos automáticos del bot.
//
// OJO: WhatsApp solo entrega texto libre dentro de la ventana de 24hs desde
// el último mensaje de esa persona al bot. Si ya pasó, esto devuelve el error
// de Twilio (mensaje "outside the allowed window" o similar) — para eso hace
// falta una plantilla aprobada, no texto libre.
//
// POST ?action=enviar  { telefono, mensaje }  (admin-gated)

const { esAdmin } = require('./_auth');
const { enviarWhatsAppTexto } = require('./_whatsapp');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });

  const action = (req.query && req.query.action) || '';
  if (action !== 'enviar' || req.method !== 'POST') {
    return res.status(400).json({ error: 'Acción no válida' });
  }

  try {
    const body = req.body || {};
    const telefono = String(body.telefono || '').trim();
    const mensaje = String(body.mensaje || '').trim();
    if (!telefono) return res.status(400).json({ error: 'Falta el teléfono' });
    if (!mensaje) return res.status(400).json({ error: 'Falta el mensaje' });

    const r = await enviarWhatsAppTexto(telefono, mensaje);
    return res.status(200).json({ ok: true, sid: r.sid, status: r.status });
  } catch (e) {
    console.error('admin-enviar-whatsapp:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
