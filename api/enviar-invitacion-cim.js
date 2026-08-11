// api/enviar-invitacion-cim.js
// ── ONE-OFF, borrar después de usar ──
// Mail institucional a la Cámara Inmobiliaria de Mendoza (CIM), proponiendo
// llevar el beneficio de MudateYa a toda su red de inmobiliarias asociadas
// de una sola vez. No es una inmobiliaria individual (por eso no entra en
// api/enviar-invitacion-inmobiliarias.js con el CTA de autoregistro) — acá
// pedimos una charla, sin prometer condiciones concretas.
//
// GET  ?token=ADMIN_TOKEN            → preview, no manda nada
// POST ?token=ADMIN_TOKEN {apply:true} → manda el mail ahora

const { Resend } = require('resend');
const { esAdmin } = require('./_auth');
const { linkBaja } = require('./_baja');

const DESTINATARIO = { nombre: 'CIM (Cámara Inmobiliaria de Mendoza)', email: 'cim.camarainmobmendoza@gmail.com' };
const ASUNTO = 'Un beneficio de mudanza para las inmobiliarias asociadas a CIM';
const FLAG_ENVIADO = 'invitacion-cim:enviado';

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
async function setJSON(k, v) { return redisCall('SET', k, JSON.stringify(v)); }

function cuerpoHtml() {
  return `<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">
    <div style="background:#003580;padding:22px 28px;text-align:center">
      <span style="font-family:Arial Black,Arial,sans-serif;font-size:28px;font-weight:900;letter-spacing:2px;color:#fff">MUDATE</span><span style="font-family:Arial Black,Arial,sans-serif;font-size:28px;font-weight:900;letter-spacing:2px;color:#22C36A">YA</span>
    </div>
    <div style="padding:28px">
      <h2 style="margin:0 0 12px;color:#0F1923;font-size:20px">Hola, equipo de CIM 👋</h2>
      <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">Somos <strong>MudateYa</strong>, un marketplace argentino de mudanzas y fletes verificados. Le damos a quien alquila o compra una propiedad una forma simple de conseguir presupuestos de mudanza — y a la inmobiliaria y sus asesores, un beneficio por recomendarlo, sin costo ni gestión para ellos.</p>
      <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">Ya estamos sumando inmobiliarias independientes de Mendoza una por una, y pensamos que la mejor forma de llegar a todo el sector de una vez es a través de CIM. Nos encantaría contarles el programa y ver si tiene sentido compartirlo con las inmobiliarias asociadas.</p>
      <div style="text-align:center;margin:20px 0">
        <a href="mailto:contacto@mudateya.ar" style="display:inline-block;background:#22C36A;color:#fff;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none">Coordinemos una charla →</a>
      </div>
      <p style="color:#475569;font-size:14px;line-height:1.7;margin:0">Gracias por su tiempo — quedamos atentos.</p>
      <p style="color:#94A3B8;font-size:11px;text-align:center;margin:22px 0 0;border-top:1px solid #E2E8F0;padding-top:16px">MudateYa · contacto@mudateya.ar · mudateya.ar</p>
    </div>
  </div>`;
}

module.exports = async function handler(req, res) {
  if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
  if (!process.env.RESEND_API_KEY) return res.status(200).json({ error: 'sin RESEND_API_KEY' });

  try {
    if (req.method === 'GET') {
      return res.status(200).json({
        ok: true,
        modo: 'preview',
        destinatario: DESTINATARIO,
        asunto: ASUNTO,
        html: cuerpoHtml(),
        nota: 'POST con {"apply":true} para mandarlo ahora.',
      });
    }

    if (req.method === 'POST') {
      const apply = req.body && req.body.apply === true;
      if (!apply) return res.status(400).json({ error: 'Falta {"apply":true} en el body.' });

      const yaEnviado = await getJSON(FLAG_ENVIADO);
      if (yaEnviado) return res.status(200).json({ ok: true, yaEnviado: true, cuando: yaEnviado, nota: 'Ya se mandó antes, no se repite.' });

      const resend = new Resend(process.env.RESEND_API_KEY);
      const linkB = linkBaja(DESTINATARIO.email, 'invitacion-cim');
      const envio = await resend.emails.send({
        from: 'MudateYa <contacto@mudateya.ar>',
        to: DESTINATARIO.email,
        subject: ASUNTO,
        html: cuerpoHtml(),
        headers: {
          'List-Unsubscribe': `<mailto:hola@mudateya.ar?subject=BAJA>, <${linkB}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });
      if (envio && envio.error) return res.status(502).json({ ok: false, error: envio.error });

      await setJSON(FLAG_ENVIADO, new Date().toISOString());
      return res.status(200).json({ ok: true, enviado: true, id: (envio && envio.data && envio.data.id) || null });
    }

    return res.status(405).json({ error: 'Método no permitido' });
  } catch (e) {
    console.error('enviar-invitacion-cim:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
