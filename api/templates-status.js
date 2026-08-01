// api/templates-status.js — Estado de aprobación (Meta) de las plantillas Twilio.
// Diagnóstico temporal. Devuelve nombre + status por plantilla (sin datos sensibles).

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return res.status(200).json({ error: 'Twilio no configurado' });

  try {
    const auth = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64');
    const r = await fetch('https://content.twilio.com/v1/ContentAndApprovals?PageSize=100', {
      headers: { Authorization: auth },
    });
    const d = await r.json();
    if (!r.ok) return res.status(200).json({ error: 'Twilio ' + r.status, detalle: d && d.message });
    const contents = Array.isArray(d.contents) ? d.contents : [];
    const plantillas = contents.map((c) => {
      const ar = c.approval_requests || {};
      const status = ar.status || (ar.whatsapp && ar.whatsapp.status) || 'desconocido';
      const category = ar.category || (ar.whatsapp && ar.whatsapp.category) || '';
      return { nombre: c.friendly_name || '(sin nombre)', status, category };
    }).filter((p) => !/^notification/.test(p.nombre)); // ocultar las demo de Twilio
    plantillas.sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
    const resumen = plantillas.reduce((a, p) => { a[p.status] = (a[p.status] || 0) + 1; return a; }, {});
    return res.status(200).json({ total: plantillas.length, resumen, plantillas });
  } catch (e) {
    return res.status(200).json({ error: e.message });
  }
};
