// api/recordar-cotizar.js — Recordatorio por WhatsApp a mudanceros que tienen
// pedidos ABIERTOS esperando su cotización (todavía no cotizaron ninguno).
// Acción manual, admin-gated. NO es un cron automático: se dispara a mano
// desde la consola de admin cuando el equipo decide mandar la tanda.
//
// GET  -> arma la lista de destinatarios + el texto real que les llegaría,
//         SIN mandar nada (para revisar antes de disparar el POST).
// POST -> manda de verdad (reusa la MISMA lógica de cálculo que el GET).
//
// Mismo filtro que ya usa el propio mudancero al ver sus pedidos disponibles
// (action=por-zona en api/cotizaciones.js / tool ver_pedidos del bot): pedido
// en estado 'buscando', no vencido, respeta modo dirigido, y que ese
// mudancero todavía no haya cotizado ni rechazado. No inventa un filtro de
// zona nuevo: usa exactamente lo mismo que ya ve el mudancero hoy.

const { enviarPlantilla } = require('./_plantillas');

const WA_NUMERO = '12399462954'; // mismo número/bot que el resto del sitio (mya-mobility.html, etc.)

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

function textoRecordatorio(nombre, cantidad) {
  const primerNombre = String(nombre || '').trim().split(' ')[0] || 'che';
  const plural = cantidad === 1 ? 'pedido' : 'pedidos';
  return (
    `¡Hola ${primerNombre}! Tenés ${cantidad} ${plural} esperando tu cotización en MudateYa 🚚\n\n` +
    `Entrá a mudateya.ar/mi-cuenta y cotizalos antes de que se los lleve otro mudancero. Cualquier duda, respondé este mensaje.`
  );
}

// wa.me con mensaje precargado: al clickear, el mudancero le manda ese texto
// a Emi. Eso ABRE la ventana de 24hs (así el WhatsApp de texto libre le puede
// llegar sin esperar a que Meta apruebe la plantilla) y de yapa Emi ya
// entiende "ver pedidos pendientes" con su tool ver_pedidos.
function linkWhatsApp() {
  return `https://wa.me/${WA_NUMERO}?text=${encodeURIComponent('Hola, quiero ver mis pedidos pendientes')}`;
}

function emailShell(inner) {
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">
    <div style="background:#003580;padding:26px 32px"><div style="font-family:'Arial Black',Arial,sans-serif;font-size:26px;color:#fff;letter-spacing:1px">Mudate<span style="color:#22C36A">Ya</span></div></div>
    <div style="background:#22C36A;padding:4px"></div>
    <div style="padding:30px 32px">${inner}</div>
    <div style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:16px 32px;text-align:center"><p style="font-size:11px;color:#94A3B8;font-family:monospace;margin:0">MudateYa · <a href="https://mudateya.ar" style="color:#94A3B8">mudateya.ar</a></p></div>
  </div>`;
}
function emailRecordatorio(nombre, cantidad) {
  const primerNombre = String(nombre || '').trim().split(' ')[0] || 'che';
  const plural = cantidad === 1 ? 'pedido' : 'pedidos';
  return emailShell(
    `<div style="font-size:38px;text-align:center;margin-bottom:12px">🚚</div>
     <h2 style="font-size:21px;color:#003580;margin:0 0 8px;text-align:center">¡Hola ${primerNombre}! Tenés ${cantidad} ${plural} esperando tu cotización</h2>
     <p style="font-size:14px;color:#475569;text-align:center;margin:0 0 22px;line-height:1.6">La forma más rápida de verlos y cotizar es por WhatsApp — hablás directo con Emi, nuestra asistente, y te muestra tus pedidos al toque.</p>
     <a href="${linkWhatsApp()}" style="display:block;background:#22C36A;color:#fff;text-align:center;padding:14px 24px;border-radius:10px;text-decoration:none;font-size:15px;font-weight:700">Hablar con Emi por WhatsApp →</a>
     <p style="font-size:12px;color:#94A3B8;text-align:center;margin:14px 0 0">También podés entrar a mudateya.ar/mi-cuenta cuando quieras.</p>`
  );
}

// Arma la lista de mudanceros con pedidos pendientes de cotizar + el texto
// exacto que le llegaría a cada uno. Sin efectos secundarios (no manda nada).
async function calcularDestinatarios() {
  const idsActivas = (await getJSON('mudanzas:activas')) || [];
  const ahora = new Date();
  const pedidosAbiertos = [];
  for (const id of idsActivas) {
    const m = await getJSON(`mudanza:${id}`);
    if (!m || m.estado !== 'buscando' || new Date(m.expira) < ahora) continue;
    pedidosAbiertos.push(m);
  }
  if (!pedidosAbiertos.length) return [];

  const todosEmails = (await getJSON('mudanceros:todos')) || [];
  const destinatarios = [];
  for (const email of todosEmails) {
    const p = await getJSON(`mudancero:perfil:${email}`);
    if (!p || p.estado !== 'aprobado' || !p.telefono) continue;
    const rechazados = (await getJSON(`rechazados:${email}`)) || [];
    const pendientes = pedidosAbiertos.filter((m) => {
      if (m.modoCotizacion === 'dirigido' && !(m.mudancerosInvitados || []).includes(email)) return false;
      if ((m.cotizaciones || []).find((c) => c.mudanceroEmail === email)) return false;
      if (rechazados.includes(m.id)) return false;
      return true;
    });
    if (!pendientes.length) continue;
    destinatarios.push({
      email,
      nombre: p.nombre || '',
      telefono: p.telefono,
      cantidad: pendientes.length,
      pedidos: pendientes.map((m) => ({ id: m.id, tipo: m.tipo, ruta: `${m.desde || ''} → ${m.hasta || ''}` })),
      texto: textoRecordatorio(p.nombre, pendientes.length),
      emailHtml: emailRecordatorio(p.nombre, pendientes.length),
    });
  }
  return destinatarios;
}

module.exports = async function handler(req, res) {
  if (!require('./_auth').esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });

  try {
    const destinatarios = await calcularDestinatarios();

    if (req.method === 'GET') {
      return res.status(200).json({
        ok: true,
        totalDestinatarios: destinatarios.length,
        destinatarios: destinatarios.map((d) => ({ email: d.email, nombre: d.nombre, telefono: d.telefono, cantidad: d.cantidad, pedidos: d.pedidos, texto: d.texto, emailHtml: d.emailHtml })),
      });
    }

    if (req.method === 'POST') {
      // canal: 'whatsapp' (default) o 'email' — el mail invita a escribirle a
      // Emi por WhatsApp con un link precargado, así el mudancero ABRE la
      // ventana de 24hs él mismo (no depende de que Meta apruebe la plantilla).
      const canal = (req.body && req.body.canal === 'email') ? 'email' : 'whatsapp';
      // Filtro opcional { soloEmails: [...] } -- para reintentar SOLO los que
      // fallaron sin volver a mandarle a quien ya le llegó bien.
      const soloEmails = req.body && Array.isArray(req.body.soloEmails) ? req.body.soloEmails : null;
      const aEnviar = soloEmails ? destinatarios.filter((d) => soloEmails.includes(d.email)) : destinatarios;

      const resultados = [];
      if (canal === 'email') {
        if (!process.env.RESEND_API_KEY) return res.status(200).json({ ok: false, error: 'sin RESEND_API_KEY' });
        const { Resend } = require('resend');
        const resend = new Resend(process.env.RESEND_API_KEY);
        for (const d of aEnviar) {
          try {
            await resend.emails.send({
              from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
              to: d.email,
              subject: `Tenés ${d.cantidad} pedido${d.cantidad > 1 ? 's' : ''} esperando tu cotización en MudateYa`,
              html: d.emailHtml,
            });
            resultados.push({ email: d.email, cantidad: d.cantidad, enviado: true, via: 'email' });
          } catch (e) {
            resultados.push({ email: d.email, cantidad: d.cantidad, enviado: false, motivo: e.message });
          }
        }
      } else {
        for (const d of aEnviar) {
          const r = await enviarPlantilla(d.telefono, 'recordatorio_pedido_sin_cotizar', { 1: (d.nombre || '').split(' ')[0] || 'che', 2: String(d.cantidad) }, d.texto);
          resultados.push({ email: d.email, telefono: d.telefono, cantidad: d.cantidad, ...r });
        }
      }
      const enviados = resultados.filter((r) => r.enviado).length;
      return res.status(200).json({ ok: true, canal, totalDestinatarios: aEnviar.length, enviados, fallidos: aEnviar.length - enviados, resultados });
    }

    return res.status(405).json({ error: 'Método no permitido' });
  } catch (e) {
    console.error('recordar-cotizar:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
