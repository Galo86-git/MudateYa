// api/recordar-dni.js
// Encuentra mudanceros que subieron UNA sola foto del DNI (les falta el frente
// o el dorso) y les manda un mail para que completen la que falta.
//
//   GET  /api/recordar-dni   → VISTA PREVIA: lista quiénes están así. NO manda nada.
//   POST /api/recordar-dni   → ENVÍA el mail a esos mudanceros.
//        body: { forzar?: true, limite?: number }
//          forzar → reenvía incluso a quienes ya recibieron el recordatorio.
//          limite → tope de mails por corrida (default 200).
//
// Protegido con token de admin (mismo patrón que admin-aprobar.js / admin-fotos.js).

var { esAdmin } = require('./_auth');
const { Resend } = require('resend');

async function redisCall(method, ...args) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  const r = await fetch(
    url + '/' + [method, ...args].map(encodeURIComponent).join('/'),
    { headers: { Authorization: 'Bearer ' + token } }
  );
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}
async function getJSON(key) {
  const v = await redisCall('GET', key);
  return v ? JSON.parse(v) : null;
}
async function setJSON(key, val) {
  await redisCall('SET', key, JSON.stringify(val));
}

// ¿Tiene exactamente UNA de las dos fotos del DNI? (le falta la otra)
function tieneUnaSolaFoto(p) {
  var f = !!(p.dniFrente && String(p.dniFrente).trim());
  var d = !!(p.dniDorso  && String(p.dniDorso).trim());
  return (f ? 1 : 0) + (d ? 1 : 0) === 1;
}

// ── Email de recordatorio ─────────────────────────────────────────
async function enviarEmailRecordatorio(perfil, falta) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const nombre    = perfil.nombre || 'Mudancero';
  const faltaTxt  = falta === 'frente' ? 'el FRENTE' : 'el DORSO';
  const tieneTxt  = falta === 'frente' ? 'el dorso'  : 'el frente';
  const linkCuenta = 'https://mudateya.ar/mi-cuenta';

  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
    to: perfil.email,
    subject: 'Te falta una foto del DNI para verificar tu perfil en MudateYa',
    html: `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">
      <div style="background:#003580;padding:28px 32px">
        <div style="font-family:'Arial Black',Arial,sans-serif;font-size:26px;color:#fff;letter-spacing:1px">
          Mudate<span style="color:#22C36A">Ya</span>
        </div>
      </div>
      <div style="background:#22C36A;padding:4px"></div>
      <div style="padding:32px">
        <div style="font-size:40px;text-align:center;margin-bottom:16px">🪪</div>
        <h2 style="font-size:22px;color:#003580;margin:0 0 8px;text-align:center">
          ¡Hola ${nombre}! Te falta una foto
        </h2>
        <p style="font-size:14px;color:#475569;text-align:center;margin:0 0 24px;line-height:1.6">
          Para verificar tu identidad necesitamos las <b>dos caras del DNI</b>.
          Ya tenemos ${tieneTxt}, pero nos falta <b>${faltaTxt}</b>.
        </p>
        <div style="background:#F0FFF4;border:1px solid #BBF7D0;border-radius:12px;padding:20px 24px;margin-bottom:24px">
          <p style="font-size:13px;color:#475569;margin:0 0 16px;line-height:1.6">
            Subí la foto que falta desde tu cuenta — te lleva menos de un minuto y
            nos permite aprobar tu perfil más rápido.
          </p>
          <a href="${linkCuenta}"
             style="display:block;background:#22C36A;color:#fff;text-align:center;padding:14px 24px;border-radius:10px;text-decoration:none;font-size:15px;font-weight:700">
            Subir ${faltaTxt} del DNI →
          </a>
        </div>
        <p style="font-size:12px;color:#94A3B8;text-align:center;margin:0">
          Si ya la subiste, ignorá este mensaje.
        </p>
      </div>
      <div style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:16px 32px;text-align:center">
        <p style="font-size:11px;color:#94A3B8;font-family:monospace;margin:0">
          MudateYa · <a href="https://mudateya.ar" style="color:#94A3B8">mudateya.ar</a>
        </p>
      </div>
    </div>
    `,
  });
}

// ── Handler ───────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://mudateya.ar');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });

  try {
    var todos = await getJSON('mudanceros:todos') || [];
    var candidatos = [];
    for (var i = 0; i < todos.length; i++) {
      var p = await getJSON('mudancero:perfil:' + todos[i]);
      if (!p || !p.email) continue;
      if (p.estado === 'rechazado') continue;
      if (!tieneUnaSolaFoto(p)) continue;
      var tieneFrente = !!(p.dniFrente && String(p.dniFrente).trim());
      candidatos.push({
        email:       p.email,
        nombre:      p.nombre || '',
        tiene:       tieneFrente ? 'frente' : 'dorso',
        falta:       tieneFrente ? 'dorso'  : 'frente',
        yaRecordado: !!(p.recordatorioDni && p.recordatorioDni.enviadoEn),
      });
    }

    // ── GET → vista previa (no manda nada) ──────────────────────────
    if (req.method === 'GET') {
      return res.status(200).json({
        modo:             'preview',
        total:            candidatos.length,
        pendientesDeMail: candidatos.filter(function(c) { return !c.yaRecordado; }).length,
        mudanceros:       candidatos,
      });
    }

    // ── POST → enviar los mails ─────────────────────────────────────
    if (req.method === 'POST') {
      var body   = req.body || {};
      var forzar = body.forzar === true;
      var limite = parseInt(body.limite, 10) || 200;

      var aEnviar = candidatos
        .filter(function(c) { return forzar || !c.yaRecordado; })
        .slice(0, limite);

      var enviados = 0, fallidos = 0, detalle = [];
      for (var j = 0; j < aEnviar.length; j++) {
        var c = aEnviar[j];
        try {
          var perfil = await getJSON('mudancero:perfil:' + c.email);
          if (!perfil) { fallidos++; detalle.push({ email: c.email, ok: false, error: 'perfil no encontrado' }); continue; }
          await enviarEmailRecordatorio(perfil, c.falta);
          perfil.recordatorioDni = { enviadoEn: new Date().toISOString(), falta: c.falta };
          await setJSON('mudancero:perfil:' + c.email, perfil);
          enviados++;
          detalle.push({ email: c.email, ok: true });
        } catch (e) {
          fallidos++;
          detalle.push({ email: c.email, ok: false, error: e.message });
        }
      }

      return res.status(200).json({
        modo:            'enviar',
        enviados:        enviados,
        fallidos:        fallidos,
        totalCandidatos: candidatos.length,
        detalle:         detalle,
      });
    }

    return res.status(405).json({ error: 'Método no permitido' });
  } catch (e) {
    console.error('Error en recordar-dni:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
