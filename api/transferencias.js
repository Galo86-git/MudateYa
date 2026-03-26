// api/transferencias.js — Registrar, listar y confirmar transferencias
const { Resend } = require('resend');

async function redisCall(method, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  const r = await fetch(`${url}/${[method,...args].map(encodeURIComponent).join('/')}`, { headers: { Authorization: `Bearer ${token}` } });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}
async function getJSON(k) { const v = await redisCall('GET', k); return v ? JSON.parse(v) : null; }
async function setJSON(k, v, ex) { const s = JSON.stringify(v); if(ex) await redisCall('SET',k,s,'EX',String(ex)); else await redisCall('SET',k,s); }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();

  if(req.method==='GET'){
    try {
      const ids = await getJSON('transferencias:pendientes') || [];
      const todas = [];
      for(const id of ids){ const t = await getJSON(`transferencia:${id}`); if(t) todas.push(t); }
      return res.status(200).json({ transferencias: todas });
    } catch(e){ return res.status(200).json({ transferencias:[], error:e.message }); }
  }

  if(req.method==='POST'){
    const body = req.body;

    // REGISTRAR (desde modal de pago)
    if(!body.accion && body.clienteEmail){
      const { clienteEmail, clienteNombre, mudancero, desde, hasta, monto, fecha } = body;
      try {
        const transId = 'TRANS-'+Date.now();
        const mudanzaId = 'MYA-TRANS-'+Date.now();
        await setJSON(`transferencia:${transId}`, { id:transId, clienteEmail, clienteNombre, mudancero, desde, hasta, monto, fecha, estado:'pendiente' }, 2592000);
        const idx = await getJSON('transferencias:pendientes') || [];
        idx.push(transId);
        await setJSON('transferencias:pendientes', idx, 2592000);
        const mudanza = { id:mudanzaId, clienteEmail, clienteNombre, desde, hasta, ambientes:'—', fecha, estado:'pago_transferencia_pendiente', fechaPublicacion:new Date().toISOString(), expira:new Date(Date.now()+30*24*60*60*1000).toISOString(), cotizaciones:[], cotizacionAceptada:{ mudanceroNombre:mudancero, precio:parseInt((monto||'0').replace(/\D/g,'')), mudanceroTel:'' }, tipoPago:'transferencia', montoTransferencia:monto };
        await setJSON(`mudanza:${mudanzaId}`, mudanza, 2592000);
        const ci = await getJSON(`cliente:${clienteEmail}`) || [];
        ci.push(mudanzaId);
        await setJSON(`cliente:${clienteEmail}`, ci, 2592000);
      } catch(e){ console.error('Redis:',e.message); }
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        const admin = process.env.ADMIN_EMAIL;
        if(admin) await resend.emails.send({ from:'MudateYa <onboarding@resend.dev>', to:admin, subject:`💸 Transferencia pendiente — ${clienteNombre} · ${monto}`, html:`<div style="font-family:Arial;background:#0D1410;color:#E8F5EE;padding:24px;border-radius:12px"><h2 style="color:#FFB300">💸 Transferencia pendiente</h2><p>Cliente: <strong>${clienteNombre}</strong> (${clienteEmail})</p><p>Mudancero: ${mudancero}</p><p>Ruta: ${desde} → ${hasta}</p><p>Monto: <strong style="color:#FFB300">${monto}</strong></p><p>Fecha: ${fecha}</p><a href="https://mudateya.vercel.app/admin" style="background:#FFB300;color:#041A0E;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700">Ver en Admin →</a></div>` });
        if(clienteEmail) await resend.emails.send({ from:'MudateYa <onboarding@resend.dev>', to:clienteEmail, subject:'Recibimos tu comprobante — MudateYa', html:`<div style="font-family:Arial;background:#0D1410;color:#E8F5EE;padding:24px;border-radius:12px"><h2 style="color:#22C36A">✅ Comprobante recibido</h2><p>Hola <strong>${clienteNombre}</strong>, recibimos tu comprobante de <strong>${monto}</strong>. Lo validamos en las próximas 2hs hábiles.</p></div>` });
      } catch(e){ console.error('Email:',e.message); }
      return res.status(200).json({ ok:true });
    }

    // CONFIRMAR / RECHAZAR (desde admin)
    if(body.id && body.accion){
      const { id, accion } = body;
      try {
        const t = await getJSON(`transferencia:${id}`);
        if(!t) return res.status(404).json({ error:'No encontrada' });
        t.estado = accion==='confirmar' ? 'confirmada' : 'rechazada';
        await setJSON(`transferencia:${id}`, t, 2592000);
        const ci = await getJSON(`cliente:${t.clienteEmail}`) || [];
        for(const mid of ci){
          const m = await getJSON(`mudanza:${mid}`);
          if(m && m.tipoPago==='transferencia' && m.estado==='pago_transferencia_pendiente'){
            m.estado = accion==='confirmar' ? 'cotizacion_aceptada' : 'transferencia_rechazada';
            await setJSON(`mudanza:${mid}`, m, 2592000);
            break;
          }
        }
        if(process.env.RESEND_API_KEY && t.clienteEmail){
          const resend = new Resend(process.env.RESEND_API_KEY);
          if(accion==='confirmar') await resend.emails.send({ from:'MudateYa <onboarding@resend.dev>', to:t.clienteEmail, subject:'✅ ¡Tu reserva está confirmada! — MudateYa', html:`<div style="font-family:Arial;background:#0D1410;color:#E8F5EE;padding:24px;border-radius:12px"><h2 style="color:#22C36A">✅ Reserva confirmada</h2><p>Hola <strong>${t.clienteNombre}</strong>, validamos tu transferencia de <strong>${t.monto}</strong>. Tu mudanza con <strong>${t.mudancero}</strong> está confirmada.</p><a href="https://mudateya.vercel.app/mi-mudanza" style="background:#22C36A;color:#041A0E;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700">Ver mi mudanza →</a></div>` });
          else await resend.emails.send({ from:'MudateYa <onboarding@resend.dev>', to:t.clienteEmail, subject:'Información sobre tu transferencia — MudateYa', html:`<div style="font-family:Arial;background:#0D1410;color:#E8F5EE;padding:24px;border-radius:12px"><h2>Transferencia no validada</h2><p>Hola <strong>${t.clienteNombre}</strong>, no pudimos validar tu transferencia. Respondé este email para resolverlo.</p></div>` });
        }
        return res.status(200).json({ ok:true });
      } catch(e){ return res.status(500).json({ error:e.message }); }
    }
  }
  return res.status(405).json({ error:'Método no permitido' });
};
