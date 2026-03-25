// api/cotizaciones.js — con Upstash Redis
const { Resend } = require('resend');

async function redisCall(method, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  const response = await fetch(`${url}/${[method, ...args].map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function getJSON(key) {
  const val = await redisCall('GET', key);
  if (!val) return null;
  return JSON.parse(val);
}

async function setJSON(key, value, exSeconds) {
  const str = JSON.stringify(value);
  if (exSeconds) await redisCall('SET', key, str, 'EX', String(exSeconds));
  else await redisCall('SET', key, str);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {

  if (action === 'publicar' && req.method === 'POST') {
    const { clienteEmail, clienteNombre, desde, hasta, ambientes, fecha, servicios, extras, zonaBase, precio_estimado } = req.body;
    if (!clienteEmail || !desde || !hasta) return res.status(400).json({ error: 'Faltan datos' });
    const id = 'MYA-' + Date.now();
    const mudanza = { id, clienteEmail, clienteNombre, desde, hasta, ambientes, fecha, servicios, extras, zonaBase, precio_estimado, estado: 'buscando', fechaPublicacion: new Date().toISOString(), expira: new Date(Date.now() + 24*60*60*1000).toISOString(), cotizaciones: [] };
    await setJSON(`mudanza:${id}`, mudanza, 172800);
    const clienteIdx = await getJSON(`cliente:${clienteEmail}`) || [];
    clienteIdx.push(id);
    await setJSON(`cliente:${clienteEmail}`, clienteIdx, 2592000);
    const globalIdx = await getJSON('mudanzas:activas') || [];
    globalIdx.push(id);
    await setJSON('mudanzas:activas', globalIdx, 172800);
    try { await notificarMudanceros(mudanza); } catch(e) { console.error(e.message); }
    return res.status(200).json({ ok: true, id, mudanza });
  }

  if (action === 'cotizar' && req.method === 'POST') {
    const { mudanzaId, mudanceroEmail, mudanceroNombre, mudanceroTel, precio, nota, tiempoEstimado } = req.body;
    if (!mudanzaId || !mudanceroEmail || !precio) return res.status(400).json({ error: 'Faltan datos' });
    const mudanza = await getJSON(`mudanza:${mudanzaId}`);
    if (!mudanza) return res.status(404).json({ error: 'Mudanza no encontrada' });
    if (mudanza.estado !== 'buscando') return res.status(400).json({ error: 'No acepta más cotizaciones' });
    if (mudanza.cotizaciones.find(c => c.mudanceroEmail === mudanceroEmail)) return res.status(400).json({ error: 'Ya cotizaste esta mudanza' });
    const cotizacion = { id: 'COT-' + Date.now(), mudanzaId, mudanceroEmail, mudanceroNombre, mudanceroTel, precio: parseInt(precio), nota: nota||'', tiempoEstimado: tiempoEstimado||'', fecha: new Date().toISOString(), estado: 'pendiente' };
    mudanza.cotizaciones.push(cotizacion);
    await setJSON(`mudanza:${mudanzaId}`, mudanza, 172800);
    const mudIdx = await getJSON(`mudancero:${mudanceroEmail}`) || [];
    if (!mudIdx.includes(mudanzaId)) mudIdx.push(mudanzaId);
    await setJSON(`mudancero:${mudanceroEmail}`, mudIdx, 2592000);
    try { await notificarCliente(mudanza, cotizacion); } catch(e) { console.error(e.message); }
    return res.status(200).json({ ok: true, cotizacion });
  }

  if (action === 'aceptar' && req.method === 'POST') {
    const { mudanzaId, cotizacionId } = req.body;
    const mudanza = await getJSON(`mudanza:${mudanzaId}`);
    if (!mudanza) return res.status(404).json({ error: 'Mudanza no encontrada' });
    const cot = mudanza.cotizaciones.find(c => c.id === cotizacionId);
    if (!cot) return res.status(404).json({ error: 'Cotización no encontrada' });
    mudanza.estado = 'cotizacion_aceptada';
    mudanza.cotizacionAceptada = cot;
    cot.estado = 'aceptada';
    await setJSON(`mudanza:${mudanzaId}`, mudanza, 172800);
    return res.status(200).json({ ok: true, mudanza, cotizacion: cot });
  }

  if (action === 'mis-mudanzas' && req.method === 'GET') {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Falta email' });
    try {
      const ids = await getJSON(`cliente:${email}`) || [];
      const mudanzas = [];
      for (const id of ids) {
        try {
          const m = await getJSON(`mudanza:${id}`);
          if (m) mudanzas.push(m);
        } catch(e) { console.warn('Error leyendo mudanza', id, e.message); }
      }
      return res.status(200).json({ mudanzas });
    } catch (e) {
      console.error('Error en mis-mudanzas:', e.message);
      return res.status(200).json({ mudanzas: [] });
    }
  }

  if (action === 'por-zona' && req.method === 'GET') {
    const { email } = req.query;
    const ids = await getJSON('mudanzas:activas') || [];
    const disponibles = [];
    const ahora = new Date();
    for (const id of ids) {
      const m = await getJSON(`mudanza:${id}`);
      if (!m || m.estado !== 'buscando' || new Date(m.expira) < ahora) continue;
      if (email && m.cotizaciones.find(c => c.mudanceroEmail === email)) continue;
      disponibles.push(m);
    }
    return res.status(200).json({ mudanzas: disponibles });
  }

  if (action === 'mis-cotizaciones' && req.method === 'GET') {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Falta email' });
    const ids = await getJSON(`mudancero:${email}`) || [];
    const mudanzas = [];
    for (const id of ids) { const m = await getJSON(`mudanza:${id}`); if (m) mudanzas.push({ ...m, miCotizacion: m.cotizaciones.find(c => c.mudanceroEmail === email) }); }
    return res.status(200).json({ mudanzas });
  }

  return res.status(400).json({ error: 'Acción no reconocida' });
  } catch(e) {
    console.error('Error en cotizaciones:', e.message);
    return res.status(200).json({ mudanzas: [], error: e.message });
  }
};

async function notificarMudanceros(mudanza) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!process.env.RESEND_API_KEY || !adminEmail) return;
  const expira = new Date(mudanza.expira).toLocaleString('es-AR', { day:'numeric', month:'long', hour:'2-digit', minute:'2-digit' });
  await resend.emails.send({
    from: 'MudateYa <onboarding@resend.dev>',
    to: adminEmail,
    subject: `🚛 Nueva mudanza — ${mudanza.desde} → ${mudanza.hasta} · ${mudanza.id}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:580px;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden"><div style="background:#22C36A;padding:18px 22px"><h2 style="margin:0;color:#041A0E">🚛 Nueva mudanza disponible · ${mudanza.id}</h2></div><div style="padding:22px"><table style="width:100%"><tr><td style="color:#7AADA0;padding:6px 0;width:35%">De</td><td><strong>${mudanza.desde}</strong></td></tr><tr><td style="color:#7AADA0;padding:6px 0">A</td><td><strong>${mudanza.hasta}</strong></td></tr><tr><td style="color:#7AADA0;padding:6px 0">Tamaño</td><td>${mudanza.ambientes}</td></tr><tr><td style="color:#7AADA0;padding:6px 0">Fecha</td><td>${mudanza.fecha}</td></tr><tr><td style="color:#7AADA0;padding:6px 0">Estimado</td><td style="color:#22C36A;font-weight:700">$${parseInt(mudanza.precio_estimado||0).toLocaleString('es-AR')}</td></tr><tr><td style="color:#7AADA0;padding:6px 0">Expira</td><td style="color:#FFB300">${expira}</td></tr></table><a href="https://mudateya.vercel.app/mi-cuenta" style="display:inline-block;margin-top:16px;background:#22C36A;color:#041A0E;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Cotizar →</a></div></div>`,
  });
}

async function notificarCliente(mudanza, cotizacion) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  if (!process.env.RESEND_API_KEY) return;
  await resend.emails.send({
    from: 'MudateYa <onboarding@resend.dev>',
    to: mudanza.clienteEmail,
    subject: `💰 Cotización de ${cotizacion.mudanceroNombre} — $${cotizacion.precio.toLocaleString('es-AR')}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:580px;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden"><div style="background:#22C36A;padding:18px 22px"><h2 style="margin:0;color:#041A0E">💰 Nueva cotización recibida</h2></div><div style="padding:22px"><p style="color:#7AADA0"><strong style="color:#E8F5EE">${cotizacion.mudanceroNombre}</strong> cotizó tu mudanza <strong>${mudanza.desde} → ${mudanza.hasta}</strong></p><div style="background:#172018;border-radius:10px;padding:14px 18px;margin:14px 0"><div style="font-size:1.8rem;color:#22C36A;font-weight:700">$${cotizacion.precio.toLocaleString('es-AR')}</div>${cotizacion.tiempoEstimado?`<div style="color:#7AADA0;font-size:12px;margin-top:4px">⏱ ${cotizacion.tiempoEstimado}</div>`:''} ${cotizacion.nota?`<div style="color:#7AADA0;font-size:12px;margin-top:8px;font-style:italic">"${cotizacion.nota}"</div>`:''}</div><a href="https://mudateya.vercel.app/mi-mudanza" style="display:inline-block;background:#22C36A;color:#041A0E;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Ver cotizaciones →</a></div></div>`,
  });
}
