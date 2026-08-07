// api/anuncio-emi-asesores.js — Mail a los asesores YA REGISTRADOS (canales de
// derivación: independientes/mudafy/remax/c21 — api/canales.js) contándoles
// que ahora Emi (la asistente de WhatsApp) los reconoce y les puede resolver
// cosas ahí mismo: pasarles su link y contarles cómo van los clientes que les
// llegaron. Acción manual, admin-gated, NO es un cron: se dispara a mano una
// sola vez desde la consola de admin.
//
// OJO: estos son los asesores de LINK FIJO (sin login, sin dashboard). El otro
// sistema de asesores (api/asesores.js, con login/dashboard) NO se usa — no
// tiene destinatarios reales, por eso no se toca acá.
//
// GET  -> arma la lista de destinatarios + el HTML real que les llegaría,
//         SIN mandar nada (para revisar antes de disparar el POST).
// POST -> manda de verdad (reusa la MISMA lógica de cálculo que el GET).
//         Body opcional { soloEmails: [...] } para reintentar solo los que
//         fallaron, sin volver a mandarle a quien ya le llegó bien.

const { esAdmin } = require('./_auth');
const { linkBaja } = require('./_baja');

// Headers List-Unsubscribe (RFC 2369) + List-Unsubscribe-Post (RFC 8058,
// one-click de Gmail/Yahoo) — es un anuncio broadcast, no transaccional.
function headersListUnsub(email) {
  const url = linkBaja(email, 'anuncio-emi-asesores');
  return {
    'List-Unsubscribe': `<mailto:hola@mudateya.ar?subject=BAJA>, <${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

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

// Mismos 4 canales que CANALES en api/canales.js — se duplica acá (config
// mínima, sin efectos secundarios) para no depender de otro archivo.
const CANALES = {
  independientes: { prefijo: 'indep', nombre: 'Asesores independientes' },
  mudafy: { prefijo: 'mudafy', nombre: 'Mudafy' },
  remax: { prefijo: 'remax', nombre: 'RE/MAX' },
  c21: { prefijo: 'c21', nombre: 'Century 21' },
};

const WA_NUMERO = '12399462954'; // mismo número/bot que el resto del sitio

// wa.me con mensaje precargado: abre la ventana de 24hs y de yapa Emi ya
// entiende de entrada que le está escribiendo un asesor (por su WhatsApp).
function linkWhatsApp() {
  return `https://wa.me/${WA_NUMERO}?text=${encodeURIComponent('Hola Emi!')}`;
}

function emailAnuncio(nombre) {
  const primerNombre = String(nombre || '').trim().split(' ')[0] || 'che';
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">
    <div style="background:#003580;padding:26px 32px"><div style="font-family:'Arial Black',Arial,sans-serif;font-size:26px;color:#fff;letter-spacing:1px">Mudate<span style="color:#22C36A">Ya</span></div></div>
    <div style="background:#22C36A;padding:4px"></div>
    <div style="padding:30px 32px">
      <div style="font-size:38px;text-align:center;margin-bottom:12px">👋</div>
      <h2 style="font-size:21px;color:#003580;margin:0 0 8px;text-align:center">¡Hola ${primerNombre}! Te presentamos a Emi</h2>
      <p style="font-size:14px;color:#475569;text-align:center;margin:0 0 22px;line-height:1.6">
        Emi es la asistente de MudateYa por WhatsApp, y ahora también te reconoce a vos como asesor. Escribile cuando quieras y te resuelve al toque:
      </p>
      <ul style="font-size:14px;color:#475569;line-height:1.9;margin:0 0 24px;padding-left:20px">
        <li>¿Perdiste tu link? Pedíselo y te lo pasa ahí mismo (o por mail, como prefieras).</li>
        <li>¿Cómo van tus clientes? Preguntale y te cuenta el estado de cada pedido que te llegó por tu link — si ya tienen cotizaciones, si eligieron, si pagaron la seña, si está en curso o ya se completó.</li>
      </ul>
      <a href="${linkWhatsApp()}" style="display:block;background:#22C36A;color:#fff;text-align:center;padding:14px 24px;border-radius:10px;text-decoration:none;font-size:15px;font-weight:700">Hablar con Emi por WhatsApp →</a>
      <p style="font-size:12px;color:#94A3B8;text-align:center;margin:14px 0 0">Tu link para compartir con tus clientes sigue siendo el mismo de siempre.</p>
    </div>
    <div style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:16px 32px;text-align:center"><p style="font-size:11px;color:#94A3B8;font-family:monospace;margin:0">MudateYa · <a href="https://mudateya.ar" style="color:#94A3B8">mudateya.ar</a></p></div>
  </div>`;
}

// Arma la lista de asesores registrados (en los 4 canales) + el HTML exacto
// que le llegaría a cada uno. Sin efectos secundarios (no manda nada).
async function calcularDestinatarios() {
  const destinatarios = [];
  const vistos = new Set(); // dedup por email: un asesor podría estar en más de un canal
  // Suprimidos globales (mismo SET que usa enviar-propuesta-remax.js etc, ver
  // api/_baja.js) — esto es un anuncio broadcast, no transaccional.
  const suprimidos = new Set((await redisCall('SMEMBERS', 'baja:emails')) || []);
  for (const canalSlug of Object.keys(CANALES)) {
    const { prefijo, nombre: canalNombre } = CANALES[canalSlug];
    const codigos = (await getJSON(`${prefijo}:asesores`)) || [];
    for (const codigo of codigos) {
      const a = await getJSON(`${prefijo}:asesor:${codigo}`);
      if (!a || !a.email || a.activo === false) continue;
      if (suprimidos.has(a.email.toLowerCase())) continue;
      const key = a.email.toLowerCase();
      if (vistos.has(key)) continue;
      vistos.add(key);
      destinatarios.push({
        email: a.email,
        nombre: a.nombre || '',
        canal: canalSlug,
        canalNombre,
        emailHtml: emailAnuncio(a.nombre),
      });
    }
  }
  return destinatarios;
}

module.exports = async function handler(req, res) {
  if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });

  try {
    const destinatarios = await calcularDestinatarios();

    if (req.method === 'GET') {
      return res.status(200).json({
        ok: true,
        totalDestinatarios: destinatarios.length,
        destinatarios: destinatarios.map((d) => ({ email: d.email, nombre: d.nombre, canal: d.canal, canalNombre: d.canalNombre, emailHtml: d.emailHtml })),
      });
    }

    if (req.method === 'POST') {
      if (!process.env.RESEND_API_KEY) return res.status(200).json({ ok: false, error: 'sin RESEND_API_KEY' });
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);

      // Filtro opcional { soloEmails: [...] } -- para reintentar SOLO los que
      // fallaron sin volver a mandarle a quien ya le llegó bien.
      const soloEmails = req.body && Array.isArray(req.body.soloEmails) ? req.body.soloEmails : null;
      const aEnviar = soloEmails ? destinatarios.filter((d) => soloEmails.includes(d.email)) : destinatarios;

      const resultados = [];
      for (const d of aEnviar) {
        try {
          await resend.emails.send({
            from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
            to: d.email,
            subject: '👋 Te presentamos a Emi, tu asistente de MudateYa por WhatsApp',
            html: d.emailHtml,
            headers: headersListUnsub(d.email),
          });
          resultados.push({ email: d.email, canal: d.canal, enviado: true });
        } catch (e) {
          resultados.push({ email: d.email, canal: d.canal, enviado: false, motivo: e.message });
        }
      }
      const enviados = resultados.filter((r) => r.enviado).length;
      return res.status(200).json({ ok: true, totalDestinatarios: aEnviar.length, enviados, fallidos: aEnviar.length - enviados, resultados });
    }

    return res.status(405).json({ error: 'Método no permitido' });
  } catch (e) {
    console.error('anuncio-emi-asesores:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
