// api/responder-derivacion.js
//
// Envío puntual (admin) de una respuesta por WhatsApp para un caso derivado a
// humano (mail "🙋 pide atención humana" / "⚠️ Reclamo" que manda derivar_a_humano
// en whatsapp.js). El texto lo redacta y aprueba el admin antes de mandarlo —
// este endpoint NO decide qué decir, solo lo entrega por el número de Emi.
//
// Usa enviarWhatsAppTexto (texto libre, ventana 24h desde el último mensaje del
// usuario) — sirve porque estos casos son charlas recién escaladas, todavía
// dentro de ventana. Si la ventana ya cerró, Twilio devuelve error y hay que
// usar una plantilla aprobada en su lugar (no cubierto acá).
//
//   POST /api/responder-derivacion?token=ADMIN_TOKEN
//     body: { "telefono": "+5491135577674", "mensaje": "texto a mandar" }
//     -> { ok, sid, status }

var { esAdmin } = require('./_auth');
var { enviarWhatsAppTexto } = require('./_whatsapp');

module.exports = async function handler(req, res) {
  if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    var telefono = (req.body && req.body.telefono || '').trim();
    var mensaje = (req.body && req.body.mensaje || '').trim();
    if (!telefono) return res.status(400).json({ error: 'Falta telefono' });
    if (!mensaje) return res.status(400).json({ error: 'Falta mensaje' });

    var resultado = await enviarWhatsAppTexto(telefono, mensaje);
    return res.status(200).json(resultado);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
