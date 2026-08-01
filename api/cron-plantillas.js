// api/cron-plantillas.js — Chequeo automático del estado de aprobación (Meta) de
// las plantillas de WhatsApp. Corre por cron (ver vercel.json). Guarda el último
// estado en Redis y AVISA POR MAIL a ADMIN_EMAIL cuando alguna cambia (aprobada
// o rechazada). Idempotente: solo notifica el cambio una vez.
//
// También sirve de chequeo manual: GET /api/cron-plantillas devuelve el estado
// actual y los cambios desde la última corrida.

const { Resend } = require('resend');

async function redisCall(method, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/${[method, ...args].map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d = await r.json();
  return d.result;
}
async function getJSON(k) { const v = await redisCall('GET', k); return v ? JSON.parse(v) : null; }
async function setJSON(k, v) { await redisCall('SET', k, JSON.stringify(v)); }

module.exports = async function handler(req, res) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return res.status(200).json({ error: 'Twilio no configurado' });

  try {
    const auth = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64');
    const r = await fetch('https://content.twilio.com/v1/ContentAndApprovals?PageSize=100', {
      headers: { Authorization: auth },
    });
    const d = await r.json();
    if (!r.ok) return res.status(200).json({ error: 'Twilio ' + r.status });

    const contents = Array.isArray(d.contents) ? d.contents : [];
    const actual = {};
    contents.forEach((c) => {
      if (/^notification/.test(c.friendly_name || '')) return; // ignorar demos de Twilio
      const ar = c.approval_requests || {};
      actual[c.friendly_name] = ar.status || (ar.whatsapp && ar.whatsapp.status) || 'desconocido';
    });

    const previo = (await getJSON('plantillas:estado')) || {};
    const primeraVez = Object.keys(previo).length === 0;

    const cambios = [];
    Object.keys(actual).forEach((name) => {
      if (previo[name] !== actual[name]) cambios.push({ name, de: previo[name] || '(nueva)', a: actual[name] });
    });

    await setJSON('plantillas:estado', actual);

    // Avisar solo cambios relevantes (aprobada/rechazada) y no en la primera corrida.
    const relevantes = cambios.filter((c) => c.a === 'approved' || c.a === 'rejected');
    let avisado = false;
    if (!primeraVez && relevantes.length && process.env.RESEND_API_KEY && process.env.ADMIN_EMAIL) {
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        const aprobadas = relevantes.filter((c) => c.a === 'approved').map((c) => c.name);
        const rechazadas = relevantes.filter((c) => c.a === 'rejected').map((c) => c.name);
        const pendientes = Object.keys(actual).filter((n) => actual[n] === 'pending');
        await resend.emails.send({
          from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
          to: process.env.ADMIN_EMAIL,
          subject: `📋 Plantillas WhatsApp: ${aprobadas.length ? aprobadas.length + ' aprobada(s) ✅' : ''}${aprobadas.length && rechazadas.length ? ' · ' : ''}${rechazadas.length ? rechazadas.length + ' rechazada(s) ❌' : ''}`.trim(),
          html:
            `<p><b>Cambios en las plantillas de WhatsApp (Meta):</b></p>` +
            (aprobadas.length ? `<p>✅ <b>Aprobadas:</b> ${aprobadas.join(', ')}</p>` : '') +
            (rechazadas.length ? `<p>❌ <b>Rechazadas:</b> ${rechazadas.join(', ')} — revisá el motivo en Twilio Console.</p>` : '') +
            `<p style="color:#64748B">Siguen pendientes (${pendientes.length}): ${pendientes.join(', ') || '—'}</p>`,
        });
        avisado = true;
      } catch (e) { console.warn('cron-plantillas email:', e.message); }
    }

    return res.status(200).json({ ok: true, primeraVez, cambios, avisado, actual });
  } catch (e) {
    console.error('cron-plantillas:', e.message);
    return res.status(200).json({ error: e.message });
  }
};
