// api/registrar-mudancero.js
// Recibe el formulario completo de onboarding de mudanceros
// Guarda en Redis + valida CUIL contra AFIP + notifica al admin

const { Resend } = require('resend');

// ── REDIS ────────────────────────────────────────────────────────
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

// ── VALIDAR CUIL CONTRA AFIP ─────────────────────────────────────
// Usa la API pública de TangoFactura que consulta AFIP sin credenciales
async function validarCUIL(cuil) {
  // Limpiar guiones y espacios: "20-12345678-9" → "20123456789"
  const cuilLimpio = cuil.replace(/[-\s]/g, '');

  if (!/^\d{11}$/.test(cuilLimpio)) {
    return { valido: false, error: 'El CUIL debe tener 11 dígitos' };
  }

  try {
    const response = await fetch(
      `https://afip.tangofactura.com/Rest/GetContribuyenteFull?cuit=${cuilLimpio}`,
      { headers: { 'Accept': 'application/json' } }
    );

    if (!response.ok) {
      return { valido: false, error: 'No se pudo consultar AFIP' };
    }

    const data = await response.json();

    // TangoFactura devuelve error si el CUIL no existe
    if (data.errorGetData || !data.Contribuyente) {
      return { valido: false, error: 'CUIL no encontrado en AFIP' };
    }

    const contribuyente = data.Contribuyente;

    return {
      valido:     true,
      cuil:       cuilLimpio,
      nombre:     contribuyente.nombre      || '',
      apellido:   contribuyente.apellido    || '',
      razonSocial: contribuyente.razonSocial || '',
      estadoClave: contribuyente.estadoClave || '', // ACTIVO / INACTIVO
      tipoClave:   contribuyente.tipoClave   || '', // CUIL / CUIT
    };
  } catch(e) {
    console.warn('Error consultando AFIP:', e.message);
    // No bloqueamos el registro si AFIP falla — seguimos con advertencia
    return { valido: null, error: 'AFIP no disponible temporalmente', advertencia: true };
  }
}

// ── HANDLER ──────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Método no permitido' });

  try {
    const {
      nombre, telefono, email, empresa,
      cuil,
      zonaBase, zonasExtra, distancia,
      vehiculo, cantVehiculos, equipo,
      servicios, dias, horarios, anticipacion,
      precio1amb, precio2amb, precio3amb, precio4amb, precioFlete,
      extra, sinEstres,
      foto, fotoCamion, fotoPatente,
      dniFrente, dniDorso, dniAnalisis,
      metodoCobro, cbu, emailMP, titularCuenta,
      fecha,
    } = req.body;

    // ── VALIDACIONES BÁSICAS ────────────────────────────────────
    if (!nombre || !telefono || !email || !zonaBase || !vehiculo) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Email inválido' });
    }
    if (!dniFrente) {
      return res.status(400).json({ error: 'Falta la foto del frente del DNI' });
    }
    if (!fotoCamion && !req.body.fotosVehiculo?.length) {
      return res.status(400).json({ error: 'Faltan fotos del vehículo' });
    }

    // ── VALIDAR CUIL CONTRA AFIP ────────────────────────────────
    let cuilResultado = null;
    if (cuil) {
      cuilResultado = await validarCUIL(cuil);

      // Si AFIP responde y el CUIL no existe → bloqueamos
      if (cuilResultado.valido === false) {
        return res.status(400).json({
          error: cuilResultado.error || 'CUIL inválido',
          campo: 'cuil'
        });
      }

      // Si AFIP responde y el CUIL existe → cruzamos con el nombre del DNI
      if (cuilResultado.valido === true && dniAnalisis) {
        const norm = s => (s || '').toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z ]/g, '').trim();

        const nombreAfip = norm(cuilResultado.nombre + ' ' + cuilResultado.apellido + ' ' + cuilResultado.razonSocial);
        const apellidoDNI = norm(dniAnalisis.apellido || '');
        const nombresDNI  = norm(dniAnalisis.nombres  || '');

        const primerApellidoDNI = apellidoDNI.split(' ')[0];
        const primerNombreDNI   = nombresDNI.split(' ')[0];

        const coincide = (primerApellidoDNI && nombreAfip.includes(primerApellidoDNI)) ||
                         (primerNombreDNI   && nombreAfip.includes(primerNombreDNI));

        if (!coincide && primerApellidoDNI) {
          return res.status(400).json({
            error: `El CUIL ingresado pertenece a "${(cuilResultado.nombre + ' ' + cuilResultado.apellido).trim()}" pero el DNI dice "${dniAnalisis.nombres} ${dniAnalisis.apellido}". Verificá que sea tu propio CUIL.`,
            campo: 'cuil'
          });
        }
      }
    }

    // ── VERIFICAR DUPLICADO ─────────────────────────────────────
    const existente = await getJSON(`mudancero:perfil:${email}`);
    if (existente && existente.estado !== 'rechazado') {
      return res.status(400).json({
        error: 'Ya existe un perfil con ese email',
        estado: existente.estado
      });
    }

    // ── ARMAR PERFIL ────────────────────────────────────────────
    const id = 'MUD-' + Date.now();

    const perfil = {
      id, email, nombre, telefono,
      empresa:      empresa      || '',
      cuil:         cuil         ? cuil.replace(/[-\s]/g, '') : '',
      cuilAfip:     cuilResultado,   // resultado completo de AFIP

      zonaBase, zonasExtra: zonasExtra || '', distancia: distancia || '',
      vehiculo, cantVehiculos: cantVehiculos || '1', equipo: equipo || 'Solo yo',
      servicios: servicios || '', dias: dias || '', horarios: horarios || '',
      anticipacion: anticipacion || '48 horas',

      precios: {
        amb1: precio1amb || '', amb2: precio2amb || '',
        amb3: precio3amb || '', amb4: precio4amb || '',
        flete: precioFlete || '',
      },

      extra: extra || '',
      sinEstres: sinEstres === true || sinEstres === 'true' || false,
      sitioWeb: req.body.sitioWeb || '',
      foto: foto || '', fotoCamion: fotoCamion || '', fotoPatente: fotoPatente || '',
      dniFrente: dniFrente || '', dniDorso: dniDorso || '',
      dniAnalisis: dniAnalisis || null,

      // Verificaciones
      verificadoIdentidad:  false,
      verificadoVehiculo:   false,
      verificadoSeguro:     false,
      cuilVerificado:       cuilResultado?.valido === true,
      cuilAdvertencia:      cuilResultado?.advertencia === true,

      estadoVerificacion: 'pendiente_revision',
      metodoCobro: metodoCobro || 'cbu',
      cbu: cbu || '', emailMP: emailMP || '', titularCuenta: titularCuenta || '',

      estado:          'pendiente_revision',
      fechaRegistro:   new Date().toISOString(),
      fechaFormulario: fecha || new Date().toLocaleString('es-AR'),
      calificacion: 0, nroResenas: 0, trabajosCompletados: 0,
    };

    // ── GUARDAR EN REDIS ────────────────────────────────────────
    await setJSON(`mudancero:perfil:${email}`, perfil);

    const pendientes = await getJSON('mudanceros:pendientes') || [];
    if (!pendientes.includes(email)) pendientes.push(email);
    await setJSON('mudanceros:pendientes', pendientes);

    const todos = await getJSON('mudanceros:todos') || [];
    if (!todos.includes(email)) todos.push(email);
    await setJSON('mudanceros:todos', todos);

    // ── NOTIFICAR AL ADMIN ──────────────────────────────────────
    try { await notificarAdmin(perfil); } catch(e) { console.warn('Email admin:', e.message); }

    // ── BIENVENIDA AL MUDANCERO ─────────────────────────────────
    try { await bienvenidaMudancero(perfil); } catch(e) { console.warn('Email mudancero:', e.message); }

    // ── LOG EN SHEETS ───────────────────────────────────────────
    try { await logMudanceroSheets(perfil); } catch(e) { console.warn('Sheets:', e.message); }

    return res.status(200).json({
      ok:      true,
      id,
      cuilOk:  cuilResultado?.valido === true,
      mensaje: 'Solicitud recibida. Te contactamos en 24hs para activar tu perfil.',
    });

  } catch(e) {
    console.error('Error en registrar-mudancero:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

// ── EMAIL AL ADMIN ───────────────────────────────────────────────
async function notificarAdmin(perfil) {
  const resend    = new Resend(process.env.RESEND_API_KEY);
  const adminMail = process.env.ADMIN_EMAIL || 'jgalozaldivar@gmail.com';
  if (!process.env.RESEND_API_KEY) return;

  const dni  = perfil.dniAnalisis || {};
  const afip = perfil.cuilAfip    || {};
  const siteUrl = process.env.SITE_URL || 'https://mudateya.ar';

  const badgeCuil = perfil.cuilVerificado
    ? `<span style="background:#F0FFF4;color:#16A34A;border:1px solid #BBF7D0;padding:3px 10px;border-radius:4px;font-size:11px;font-weight:600">✓ CUIL verificado en AFIP</span>`
    : perfil.cuilAdvertencia
    ? `<span style="background:#FFFBEB;color:#92400E;border:1px solid #FCD34D;padding:3px 10px;border-radius:4px;font-size:11px;font-weight:600">⚠ AFIP no disponible</span>`
    : `<span style="background:#F4F6F9;color:#94A3B8;border:1px solid #E2E8F0;padding:3px 10px;border-radius:4px;font-size:11px">— Sin CUIL</span>`;

  await resend.emails.send({
    from:    'MudateYa <noreply@mudateya.ar>',
    to:      adminMail,
    subject: `🚛 Nuevo mudancero — ${perfil.nombre} · ${perfil.zonaBase}`,
    html: `
<div style="font-family:Inter,Arial,sans-serif;max-width:580px;margin:0 auto;background:#ffffff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
  <div style="background:#003580;padding:20px 28px">
    <span style="font-size:20px;font-weight:900;color:#ffffff;letter-spacing:1px">Mudate</span><span style="font-size:20px;font-weight:900;color:#22C36A;letter-spacing:1px">Ya</span>
    <span style="margin-left:10px;background:#22C36A;color:#003580;font-size:11px;font-weight:700;padding:3px 8px;border-radius:4px">NUEVO MUDANCERO</span>
  </div>
  <div style="padding:28px">
    <h2 style="margin:0 0 6px;font-size:18px;color:#0F1923">🚛 ${perfil.nombre}${perfil.empresa ? ' · ' + perfil.empresa : ''}</h2>
    <p style="font-size:13px;color:#475569;margin:0 0 20px">${perfil.zonaBase} · ${perfil.vehiculo}</p>

    <div style="background:#F4F6F9;border:1px solid #E2E8F0;border-radius:12px;padding:18px;margin-bottom:16px">
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="font-size:11px;color:#94A3B8;font-family:monospace;text-transform:uppercase;letter-spacing:.5px;padding:6px 0;width:35%;border-bottom:1px solid #E2E8F0">Email</td><td style="font-size:13px;color:#0F1923;padding:6px 0;border-bottom:1px solid #E2E8F0">${perfil.email}</td></tr>
        <tr><td style="font-size:11px;color:#94A3B8;font-family:monospace;text-transform:uppercase;letter-spacing:.5px;padding:6px 0;border-bottom:1px solid #E2E8F0">Teléfono</td><td style="font-size:13px;color:#0F1923;padding:6px 0;border-bottom:1px solid #E2E8F0">${perfil.telefono}</td></tr>
        <tr><td style="font-size:11px;color:#94A3B8;font-family:monospace;text-transform:uppercase;letter-spacing:.5px;padding:6px 0;border-bottom:1px solid #E2E8F0">CUIL</td><td style="font-size:13px;padding:6px 0;border-bottom:1px solid #E2E8F0">${perfil.cuil || '—'} ${badgeCuil}</td></tr>
        <tr><td style="font-size:11px;color:#94A3B8;font-family:monospace;text-transform:uppercase;letter-spacing:.5px;padding:6px 0;border-bottom:1px solid #E2E8F0">Zona</td><td style="font-size:13px;color:#0F1923;padding:6px 0;border-bottom:1px solid #E2E8F0">${perfil.zonaBase}${perfil.zonasExtra ? ' · ' + perfil.zonasExtra : ''}</td></tr>
        <tr><td style="font-size:11px;color:#94A3B8;font-family:monospace;text-transform:uppercase;letter-spacing:.5px;padding:6px 0;border-bottom:1px solid #E2E8F0">Vehículo</td><td style="font-size:13px;color:#0F1923;padding:6px 0;border-bottom:1px solid #E2E8F0">${perfil.vehiculo} · ${perfil.cantVehiculos} unid.</td></tr>
        <tr><td style="font-size:11px;color:#94A3B8;font-family:monospace;text-transform:uppercase;letter-spacing:.5px;padding:6px 0;border-bottom:1px solid #E2E8F0">Servicios</td><td style="font-size:12px;color:#0F1923;padding:6px 0;border-bottom:1px solid #E2E8F0">${perfil.servicios}</td></tr>
        <tr><td style="font-size:11px;color:#94A3B8;font-family:monospace;text-transform:uppercase;letter-spacing:.5px;padding:6px 0">DNI</td><td style="font-size:13px;padding:6px 0">${dni.numero_dni ? 'DNI: <strong>' + dni.numero_dni + '</strong> · ' + (dni.apellido||'') + ' ' + (dni.nombres||'') : '—'} ${dni.legible !== undefined ? '<span style="color:' + (dni.legible?'#16A34A':'#F59E0B') + '">' + (dni.legible?'✓ Legible':'⚠ Ilegible') + '</span>' : ''}</td></tr>
      </table>
    </div>

    <div style="background:#EEF4FF;border:1px solid #C7D9FF;border-radius:10px;padding:12px 16px;margin-bottom:20px">
      <div style="font-size:11px;color:#94A3B8;font-family:monospace;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Cobro</div>
      <div style="font-size:13px;color:#0F1923">${perfil.metodoCobro === 'cbu' ? 'CBU/Alias: ' + perfil.cbu : 'Mercado Pago: ' + perfil.emailMP}${perfil.titularCuenta ? ' · ' + perfil.titularCuenta : ''}</div>
    </div>

    <a href="${siteUrl}/admin" style="display:block;text-align:center;background:#1A6FFF;color:#ffffff;padding:13px 24px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:700">Revisar y aprobar →</a>
    <p style="font-size:11px;color:#94A3B8;text-align:center;margin-top:10px;font-family:monospace">${perfil.id}</p>
  </div>
  <div style="background:#F4F6F9;border-top:1px solid #E2E8F0;padding:14px 28px;text-align:center">
    <p style="font-size:11px;color:#94A3B8;margin:0;font-family:monospace">MudateYa · mudateya.ar</p>
  </div>
</div>`,
  });
}

// ── EMAIL DE BIENVENIDA AL MUDANCERO ────────────────────────────
async function bienvenidaMudancero(perfil) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  if (!process.env.RESEND_API_KEY || !perfil.email) return;
  const siteUrl = process.env.SITE_URL || 'https://mudateya.ar';
  const nombre = perfil.nombre.split(' ')[0]; // Solo el primer nombre

  await resend.emails.send({
    from:    'MudateYa <noreply@mudateya.ar>',
    to:      perfil.email,
    subject: `¡Bienvenido a MudateYa, ${nombre}! 🚛`,
    html: `
<div style="font-family:Inter,Arial,sans-serif;max-width:580px;margin:0 auto;background:#ffffff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
  <div style="background:#003580;padding:20px 28px">
    <span style="font-size:20px;font-weight:900;color:#ffffff;letter-spacing:1px">Mudate</span><span style="font-size:20px;font-weight:900;color:#22C36A;letter-spacing:1px">Ya</span>
  </div>
  <div style="padding:28px">
    <h2 style="margin:0 0 8px;font-size:20px;color:#0F1923">¡Hola ${nombre}, bienvenido! 👋</h2>
    <p style="font-size:14px;color:#475569;margin:0 0 20px;line-height:1.6">Recibimos tu solicitud de registro en MudateYa. Estamos revisando tu perfil y en menos de <strong>24 horas</strong> te confirmamos la activación.</p>

    <div style="background:#F4F6F9;border:1px solid #E2E8F0;border-radius:12px;padding:18px;margin-bottom:20px">
      <div style="font-size:11px;color:#94A3B8;font-family:monospace;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Tu perfil</div>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="font-size:11px;color:#94A3B8;font-family:monospace;text-transform:uppercase;letter-spacing:.5px;padding:5px 0;width:35%;border-bottom:1px solid #E2E8F0">Nombre</td><td style="font-size:13px;font-weight:600;color:#0F1923;padding:5px 0;border-bottom:1px solid #E2E8F0">${perfil.nombre}${perfil.empresa ? ' · ' + perfil.empresa : ''}</td></tr>
        <tr><td style="font-size:11px;color:#94A3B8;font-family:monospace;text-transform:uppercase;letter-spacing:.5px;padding:5px 0;border-bottom:1px solid #E2E8F0">Zona</td><td style="font-size:13px;color:#0F1923;padding:5px 0;border-bottom:1px solid #E2E8F0">${perfil.zonaBase}</td></tr>
        <tr><td style="font-size:11px;color:#94A3B8;font-family:monospace;text-transform:uppercase;letter-spacing:.5px;padding:5px 0">Vehículo</td><td style="font-size:13px;color:#0F1923;padding:5px 0">${perfil.vehiculo}</td></tr>
      </table>
    </div>

    <div style="background:#EEF4FF;border:1px solid #C7D9FF;border-radius:10px;padding:14px 16px;margin-bottom:20px">
      <p style="font-size:13px;color:#003580;margin:0;line-height:1.6">⏱ <strong>¿Qué pasa ahora?</strong><br>Revisamos tu DNI y datos. Una vez aprobado empezás a recibir pedidos de mudanzas directo en tu panel.</p>
    </div>

    <a href="${siteUrl}/mi-cuenta" style="display:block;text-align:center;background:#1A6FFF;color:#ffffff;padding:13px 24px;border-radius:10px;text-decoration:none;font-size:15px;font-weight:700">Ver mi cuenta →</a>
  </div>
  <div style="background:#F4F6F9;border-top:1px solid #E2E8F0;padding:14px 28px;text-align:center">
    <p style="font-size:11px;color:#94A3B8;margin:0;font-family:monospace">MudateYa · mudateya.ar · Cualquier consulta escribinos a hola@mudateya.ar</p>
  </div>
</div>`,
  });
}
async function logMudanceroSheets(perfil) {
  const webhookUrl = process.env.GOOGLE_SHEETS_MUDANCEROS_URL;
  if (!webhookUrl) return;

  const dni  = perfil.dniAnalisis || {};
  const afip = perfil.cuilAfip    || {};

  await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ID:                perfil.id,
      'Fecha registro':  new Date(perfil.fechaRegistro).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }),
      Nombre:            perfil.nombre,
      Empresa:           perfil.empresa    || '—',
      Email:             perfil.email,
      Teléfono:          perfil.telefono,
      CUIL:              perfil.cuil       || '—',
      'CUIL verificado': perfil.cuilVerificado ? 'SI' : perfil.cuilAdvertencia ? 'ADVERTENCIA' : 'NO',
      'AFIP nombre':     afip.nombre       ? `${afip.nombre} ${afip.apellido}`.trim() : '—',
      'AFIP estado':     afip.estadoClave  || '—',
      'Zona base':       perfil.zonaBase,
      'Zonas extra':     perfil.zonasExtra || '—',
      Vehículo:          perfil.vehiculo,
      Servicios:         perfil.servicios,
      Días:              perfil.dias,
      Horarios:          perfil.horarios,
      'DNI número':      dni.numero_dni       || '—',
      'DNI apellido':    dni.apellido         || '—',
      'DNI nombres':     dni.nombres          || '—',
      'DNI vencimiento': dni.fecha_vencimiento || '—',
      'DNI legible':     dni.legible ? 'SI' : 'NO',
      'Método cobro':    perfil.metodoCobro,
      'CBU/Alias':       perfil.cbu           || '—',
      Titular:           perfil.titularCuenta  || '—',
      Estado:            'PENDIENTE_REVISION',
    }),
  });
}
