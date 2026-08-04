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
  // Seguridad: solo lo puede disparar el Cron de Vercel o un admin con token.
  // Sin esto, cualquiera podía llamarlo en loop y quemar cuota de Twilio/Vercel,
  // gatillar creación de plantillas en Meta y leer la lista de todas las plantillas.
  let esVercelCron = false;
  try { esVercelCron = require('./_auth').esCronVercel(req); } catch (e) {}
  let esAdmin = false;
  try { esAdmin = require('./_auth').esAdmin(req); } catch (e) {}
  if (!esVercelCron && !esAdmin) return res.status(401).json({ error: 'No autorizado' });

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return res.status(200).json({ error: 'Twilio no configurado' });

  try {
    // 0) Auto-crear las plantillas nuevas que todavía no existan (idempotente).
    //    Así, cuando agregamos una plantilla al código, se crea sola y se manda a
    //    Meta sin tener que tocar ningún botón del admin.
    let creadas = [];
    try {
      const r = await require('./plantillas-emi').crearFaltantes();
      creadas = (r && r.creadas) || [];
      if (creadas.length) console.log('[cron-plantillas] creadas:', creadas.map((c) => c.name).join(', '));
    } catch (e) { console.warn('[cron-plantillas] crearFaltantes:', e.message); }

    // 0b) Auto-aplicar cambios de TEXTO en plantillas que ya existen (array
    //     ACTUALIZAR de plantillas-emi.js), cuando el body en código difiere del
    //     que está vivo en Twilio. Idempotente (no hace nada si ya está al día).
    let actualizadas = [];
    try {
      const r2 = await require('./plantillas-emi').actualizarCambiadas();
      actualizadas = (r2 && r2.actualizadas) || [];
      if (actualizadas.length) console.log('[cron-plantillas] actualizadas:', actualizadas.map((c) => c.name).join(', '));
    } catch (e) { console.warn('[cron-plantillas] actualizarCambiadas:', e.message); }

    const auth = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64');
    const r = await fetch('https://content.twilio.com/v1/ContentAndApprovals?PageSize=100', {
      headers: { Authorization: auth },
    });
    const d = await r.json();
    if (!r.ok) return res.status(200).json({ error: 'Twilio ' + r.status });

    const contents = Array.isArray(d.contents) ? d.contents : [];
    const actual = {};
    const registro = {}; // nombre -> { sid, status } — lo usa _plantillas.enviarPlantilla
    contents.forEach((c) => {
      if (/^notification/.test(c.friendly_name || '')) return; // ignorar demos de Twilio
      const ar = c.approval_requests || {};
      const status = ar.status || (ar.whatsapp && ar.whatsapp.status) || 'desconocido';
      actual[c.friendly_name] = status;
      registro[c.friendly_name] = { sid: c.sid, status };
    });
    await setJSON('plantillas:registro', registro);

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

    return res.status(200).json({ ok: true, primeraVez, creadas: creadas.map((c) => c.name), actualizadas: actualizadas.map((c) => c.name), cambios, avisado, actual });
  } catch (e) {
    console.error('cron-plantillas:', e.message);
    return res.status(200).json({ error: e.message });
  }
};
