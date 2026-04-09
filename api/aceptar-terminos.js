// api/aceptar-terminos.js
// Procesa la aceptación de Términos y Condiciones del mudancero
// Se llama cuando el mudancero hace click en el link del email de aprobación

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

module.exports = async function handler(req, res) {
  const { token } = req.query;

  if (!token) {
    return res.status(400).send(paginaError('Link inválido', 'Este link no es válido. Contactá a hola@mudateya.ar'));
  }

  try {
    // Verificar token
    const datos = await getJSON(`terminos:token:${token}`);
    if (!datos) {
      return res.status(400).send(paginaError('Link expirado', 'Este link ya fue usado o expiró. Contactá a hola@mudateya.ar para recibir uno nuevo.'));
    }

    const { email } = datos;

    // Obtener perfil
    const perfil = await getJSON(`mudancero:perfil:${email}`);
    if (!perfil) {
      return res.status(404).send(paginaError('Perfil no encontrado', 'No encontramos tu cuenta. Contactá a hola@mudateya.ar'));
    }

    // Ya aceptó antes
    if (perfil.terminosAceptados) {
      return res.status(200).send(paginaExito(perfil.nombre, true));
    }

    // Registrar aceptación
    perfil.terminosAceptados     = true;
    perfil.fechaAceptoTerminos   = new Date().toISOString();
    perfil.versionTerminos       = '1.0';
    await setJSON(`mudancero:perfil:${email}`, perfil);

    // Invalidar token (borrar)
    await redisCall('DEL', `terminos:token:${token}`);

    return res.status(200).send(paginaExito(perfil.nombre, false));

  } catch(e) {
    console.error('Error aceptar-terminos:', e.message);
    return res.status(500).send(paginaError('Error', 'Ocurrió un error. Intentá nuevamente o contactá a hola@mudateya.ar'));
  }
};

// ── Páginas HTML de respuesta ─────────────────────────────────────
function paginaExito(nombre, yaAceptado) {
  const titulo = yaAceptado ? '¡Ya habías aceptado los términos!' : '¡Términos aceptados!';
  const msg    = yaAceptado
    ? 'Ya tenías los Términos y Condiciones aceptados. Tu cuenta está activa.'
    : `Gracias ${nombre || ''}. Tu cuenta está activa y ya aparecés en el catálogo de MudateYa.`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>MudateYa — Cuenta activada</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',sans-serif;background:#F5F7FA;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.card{background:#fff;border-radius:16px;padding:2.5rem 2rem;max-width:440px;width:100%;text-align:center;box-shadow:0 4px 32px rgba(0,0,0,.1);border-top:4px solid #22C36A}
.icon{font-size:3.5rem;margin-bottom:1rem}
h1{font-size:22px;font-weight:800;color:#003580;margin-bottom:.5rem}
p{font-size:14px;color:#475569;line-height:1.7;margin-bottom:1.5rem}
.badge{display:inline-flex;align-items:center;gap:6px;background:#F0FFF4;color:#166534;border:1px solid #BBF7D0;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;margin-bottom:1.5rem}
.btn{display:block;background:#003580;color:#fff;padding:14px 24px;border-radius:10px;text-decoration:none;font-size:15px;font-weight:700}
.btn:hover{background:#1A6FFF}
.logo{font-family:'Inter',sans-serif;font-size:18px;font-weight:900;color:#003580;margin-bottom:1.5rem}
.logo span{color:#22C36A}
</style>
</head>
<body>
<div class="card">
  <div class="logo">Mudate<span>Ya</span></div>
  <div class="icon">🎉</div>
  <h1>${titulo}</h1>
  <p>${msg}</p>
  <div class="badge">✓ Términos y Condiciones aceptados</div>
  <br/>
  <a href="https://mudateya.ar/mi-cuenta" class="btn">Ir a mi cuenta →</a>
</div>
</body>
</html>`;
}

function paginaError(titulo, mensaje) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>MudateYa — Error</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',sans-serif;background:#F5F7FA;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.card{background:#fff;border-radius:16px;padding:2.5rem 2rem;max-width:440px;width:100%;text-align:center;box-shadow:0 4px 32px rgba(0,0,0,.1);border-top:4px solid #EF4444}
.icon{font-size:3.5rem;margin-bottom:1rem}
h1{font-size:22px;font-weight:800;color:#0F1923;margin-bottom:.5rem}
p{font-size:14px;color:#475569;line-height:1.7;margin-bottom:1.5rem}
.btn{display:block;background:#003580;color:#fff;padding:14px 24px;border-radius:10px;text-decoration:none;font-size:15px;font-weight:700}
.logo{font-family:'Inter',sans-serif;font-size:18px;font-weight:900;color:#003580;margin-bottom:1.5rem}
.logo span{color:#22C36A}
</style>
</head>
<body>
<div class="card">
  <div class="logo">Mudate<span>Ya</span></div>
  <div class="icon">😕</div>
  <h1>${titulo}</h1>
  <p>${mensaje}</p>
  <a href="mailto:hola@mudateya.ar" class="btn">Contactar soporte →</a>
</div>
</body>
</html>`;
}
