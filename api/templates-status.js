// api/templates-status.js — Estado de aprobación (Meta/WhatsApp) de las plantillas
// de Twilio Content. Diagnóstico temporal. Devuelve nombre + status por plantilla,
// SIN datos sensibles. Se saca después de chequear.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    return res.status(200).json({ error: 'Twilio no configurado (faltan TWILIO_ACCOUNT_SID / AUTH_TOKEN)' });
  }

  try {
    const auth = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64');
    // ContentAndApprovals trae cada plantilla con su estado de aprobación en una sola llamada.
    const r = await fetch('https://content.twilio.com/v1/ContentAndApprovals?PageSize=100', {
      headers: { Authorization: auth },
    });
    const d = await r.json();
    if (!r.ok) {
      return res.status(200).json({ error: 'Twilio ' + r.status, detalle: d && d.message });
    }
    const contents = Array.isArray(d.contents) ? d.contents : [];
    const plantillas = contents.map((c) => {
      const ar = c.approval_requests || {};
      // La estructura puede venir como { status } o { whatsapp: { status } }.
      const status = ar.status || (ar.whatsapp && ar.whatsapp.status) || 'desconocido';
      const category = ar.category || (ar.whatsapp && ar.whatsapp.category) || '';
      const rejection = ar.rejection_reason || (ar.whatsapp && ar.whatsapp.rejection_reason) || '';
      return { nombre: c.friendly_name || '(sin nombre)', status, category, rejection, sid: c.sid };
    });
    // Ordenar por status para leer rápido.
    plantillas.sort((a, b) => String(a.status).localeCompare(String(b.status)));
    const resumen = plantillas.reduce((acc, p) => { acc[p.status] = (acc[p.status] || 0) + 1; return acc; }, {});
    return res.status(200).json({ total: plantillas.length, resumen, plantillas });
  } catch (e) {
    return res.status(200).json({ error: e.message });
  }
};
