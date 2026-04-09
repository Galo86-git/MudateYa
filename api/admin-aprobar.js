// api/admin-aprobar.js
// Maneja la aprobación/rechazo de mudanceros desde el panel de admin
// Cuando aprueba: actualiza Redis + Sheets + manda email de alta con link de aceptación de términos

const { Resend } = require('resend');

async function redisCall(method, ...args) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  const response = await fetch(
    `${url}/${[method, ...args].map(encodeURIComponent).join('/')}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
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
  else           await redisCall('SET', key, str);
}

// ── Actualizar estado en Google Sheets ───────────────────────────
async function actualizarSheets(email, nuevoEstado, rowIndex) {
  const webhookUrl = process.env.GOOGLE_SHEETS_MUDANCEROS_URL;
  if (!webhookUrl) return;
  await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action:    'update-estado',
      email,
      nuevoEstado,
      rowIndex,
    }),
  });
}

// ── Email de alta exitosa con link de aceptación de términos ─────
async function enviarEmailAltaExitosa(perfil) {
  const resend = new Resend(process.env.RESEND_API_KEY);

  // Token único para la aceptación de términos
  const token = Buffer.from(`${perfil.email}:${Date.now()}`).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);

  // Guardar token en Redis (válido 7 días)
  await setJSON(`terminos:token:${token}`, { email: perfil.email, creado: new Date().toISOString() }, 7 * 24 * 60 * 60);

  const nombre   = perfil.nombre   || 'Mudancero';
  const empresa  = perfil.empresa  ? ` · ${perfil.empresa}` : '';
  const linkTerminos = `https://mudateya.ar/aceptar-terminos?token=${token}`;

  await resend.emails.send({
    from:    'MudateYa <noreply@mudateya.ar>',
    to:      perfil.email,
    subject: '🎉 ¡Fuiste aprobado en MudateYa! Activá tu cuenta',
    html: `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">

      <!-- Header -->
      <div style="background:#003580;padding:28px 32px">
        <div style="font-family:'Arial Black',Arial,sans-serif;font-size:26px;color:#fff;letter-spacing:1px">
          Mudate<span style="color:#22C36A">Ya</span>
        </div>
      </div>

      <!-- Banda verde -->
      <div style="background:#22C36A;padding:4px"></div>

      <!-- Body -->
      <div style="padding:32px">
        <div style="font-size:40px;text-align:center;margin-bottom:16px">🎉</div>
        <h2 style="font-size:22px;color:#003580;margin:0 0 8px;text-align:center">
          ¡Estás aprobado, ${nombre}!
        </h2>
        <p style="font-size:14px;color:#475569;text-align:center;margin:0 0 28px">
          Revisamos tu perfil${empresa} y todo está en orden.<br/>
          Ya podés empezar a recibir pedidos de mudanza en tu zona.
        </p>

        <!-- Paso final -->
        <div style="background:#F0FFF4;border:1px solid #BBF7D0;border-radius:12px;padding:20px 24px;margin-bottom:28px">
          <div style="font-size:15px;font-weight:700;color:#166534;margin-bottom:8px">
            Un último paso — Aceptá los Términos y Condiciones
          </div>
          <p style="font-size:13px;color:#475569;margin:0 0 16px;line-height:1.6">
            Para activar tu cuenta y aparecer en el catálogo de mudanceros, necesitás aceptar 
            los Términos y Condiciones de MudateYa. Incluyen las comisiones y las reglas de la plataforma.
          </p>
          <a href="${linkTerminos}" 
             style="display:block;background:#22C36A;color:#fff;text-align:center;padding:14px 24px;border-radius:10px;text-decoration:none;font-size:15px;font-weight:700">
            ✓ Aceptar Términos y Condiciones →
          </a>
          <p style="font-size:11px;color:#94A3B8;text-align:center;margin:10px 0 0;font-family:monospace">
            Este link es válido por 7 días
          </p>
        </div>

        <!-- Resumen comisiones -->
        <div style="background:#F8FAFC;border-radius:10px;padding:16px 20px;margin-bottom:24px">
          <div style="font-size:13px;font-weight:700;color:#0F1923;margin-bottom:10px">Resumen de comisiones:</div>
          <table style="width:100%;font-size:13px;color:#475569">
            <tr>
              <td style="padding:4px 0">🏠 Mudanzas</td>
              <td style="text-align:right;font-weight:700;color:#003580">15% por trabajo completado</td>
            </tr>
            <tr>
              <td style="padding:4px 0">📦 Fletes</td>
              <td style="text-align:right;font-weight:700;color:#003580">20% por trabajo completado</td>
            </tr>
            <tr>
              <td style="padding:4px 0;color:#94A3B8;font-size:11px" colspan="2">
                Solo pagás comisión cuando completás un trabajo. Sin costos fijos.
              </td>
            </tr>
          </table>
        </div>

        <!-- CTA secundario -->
        <div style="text-align:center">
          <a href="https://mudateya.ar/mi-cuenta" 
             style="display:inline-block;color:#1A6FFF;font-size:13px;text-decoration:none">
            Ver mi cuenta en MudateYa →
          </a>
        </div>
      </div>

      <!-- Footer -->
      <div style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:16px 32px;text-align:center">
        <p style="font-size:11px;color:#94A3B8;font-family:monospace;margin:0">
          MudateYa · <a href="https://mudateya.ar" style="color:#94A3B8">mudateya.ar</a>
        </p>
      </div>

    </div>
    `,
  });

  return token;
}

// ── Handler principal ─────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Método no permitido' });

  // Verificar token de admin
  const adminToken = req.headers['x-admin-token'] || req.body?.adminToken;
  if (adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const { tipo, email, nombre, nuevoEstado, rowIndex } = req.body || {};

  if (tipo !== 'cambiar-estado-mudancero') {
    return res.status(400).json({ error: 'Tipo de acción no reconocido' });
  }

  if (!email || !nuevoEstado) {
    return res.status(400).json({ error: 'Faltan datos: email y nuevoEstado son obligatorios' });
  }

  try {
    // 1. Actualizar estado en Redis
    const perfil = await getJSON(`mudancero:perfil:${email}`);
    if (!perfil) return res.status(404).json({ error: 'Mudancero no encontrado en Redis' });

    const estadoAnterior = perfil.estado;
    perfil.estado = nuevoEstado.toLowerCase() === 'aprobado' ? 'aprobado' : 'rechazado';
    perfil.fechaCambioEstado = new Date().toISOString();
    if (nuevoEstado.toLowerCase() === 'aprobado') {
      perfil.terminosAceptados = false; // Se activa cuando acepta el link
    }
    await setJSON(`mudancero:perfil:${email}`, perfil);

    // 2. Actualizar en Google Sheets
    try {
      await actualizarSheets(email, nuevoEstado, rowIndex);
    } catch(e) {
      console.warn('Sheets update error:', e.message);
    }

    // 3. Si fue aprobado → mandar email de alta con link de términos
    if (nuevoEstado.toLowerCase() === 'aprobado' && estadoAnterior !== 'aprobado') {
      try {
        await enviarEmailAltaExitosa(perfil);
      } catch(e) {
        console.error('Error enviando email de alta:', e.message);
        // No fallar el request por el email
      }
    }

    return res.status(200).json({ ok: true, estado: perfil.estado });

  } catch(e) {
    console.error('Error en admin-aprobar:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
