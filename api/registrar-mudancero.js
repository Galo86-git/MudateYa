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
      extra,
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
    if (!dniFrente || !dniDorso) {
      return res.status(400).json({ error: 'Faltan fotos del DNI' });
    }
    if (!fotoCamion || !fotoPatente) {
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
  const adminMail = process.env.ADMIN_EMAIL;
  if (!process.env.RESEND_API_KEY || !adminMail) return;

  const dni  = perfil.dniAnalisis || {};
  const afip = perfil.cuilAfip    || {};

  const badgeCuil = perfil.cuilVerificado
    ? `<span style="background:#0D2018;color:#22C36A;padding:3px 10px;border-radius:4px;font-size:11px">✓ CUIL verificado en AFIP</span>`
    : perfil.cuilAdvertencia
    ? `<span style="background:#2D1F0E;color:#F59E0B;padding:3px 10px;border-radius:4px;font-size:11px">⚠ AFIP no disponible al registrar</span>`
    : `<span style="background:#1E1E1E;color:#7AADA0;padding:3px 10px;border-radius:4px;font-size:11px">— CUIL no ingresado</span>`;

  await resend.emails.send({
    from:    'MudateYa <onboarding@resend.dev>',
    to:      adminMail,
    subject: `🚛 Nuevo mudancero — ${perfil.nombre} · ${perfil.zonaBase} · ${perfil.id}`,
    html: `
<div style="font-family:Arial,sans-serif;max-width:600px;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden">
  <div style="background:#22C36A;padding:18px 22px">
    <h2 style="margin:0;color:#041A0E">🚛 Nuevo mudancero registrado</h2>
  </div>
  <div style="padding:22px">
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="color:#7AADA0;padding:6px 0;width:35%">Nombre</td>
          <td><strong>${perfil.nombre}</strong>${perfil.empresa ? ` · ${perfil.empresa}` : ''}</td></tr>
      <tr><td style="color:#7AADA0;padding:6px 0">Email</td><td>${perfil.email}</td></tr>
      <tr><td style="color:#7AADA0;padding:6px 0">Teléfono</td><td>${perfil.telefono}</td></tr>
      <tr><td style="color:#7AADA0;padding:6px 0">CUIL</td>
          <td>${perfil.cuil || '—'} ${badgeCuil}
          ${afip.nombre ? `<br><small style="color:#5A8A78">AFIP: ${afip.nombre} ${afip.apellido} · ${afip.estadoClave}</small>` : ''}</td></tr>
      <tr><td style="color:#7AADA0;padding:6px 0">Zona</td>
          <td>${perfil.zonaBase}${perfil.zonasExtra ? ` · ${perfil.zonasExtra}` : ''}</td></tr>
      <tr><td style="color:#7AADA0;padding:6px 0">Vehículo</td>
          <td>${perfil.vehiculo} · ${perfil.cantVehiculos} unid. · ${perfil.equipo}</td></tr>
      <tr><td style="color:#7AADA0;padding:6px 0">Servicios</td>
          <td style="font-size:12px">${perfil.servicios}</td></tr>
    </table>

    <div style="background:#172018;border-radius:10px;padding:12px 16px;margin:14px 0">
      <div style="font-size:11px;color:#5A8A78;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">DNI análisis IA</div>
      <div style="font-size:13px">
        ${dni.numero_dni ? `DNI: <strong>${dni.numero_dni}</strong> · ` : ''}
        ${dni.apellido || ''} ${dni.nombres || ''}<br>
        ${dni.fecha_vencimiento ? `Vence: ${dni.fecha_vencimiento} · ` : ''}
        Legible: <strong style="color:${dni.legible ? '#22C36A' : '#F59E0B'}">${dni.legible ? '✓ SI' : '✗ NO'}</strong>
      </div>
    </div>

    <div style="background:#172018;border-radius:10px;padding:12px 16px;margin:14px 0">
      <div style="font-size:11px;color:#5A8A78;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Cobro</div>
      <div style="font-size:13px">
        ${perfil.metodoCobro === 'cbu' ? `CBU/Alias: ${perfil.cbu}` : `MP: ${perfil.emailMP}`}
        ${perfil.titularCuenta ? ` · ${perfil.titularCuenta}` : ''}
      </div>
    </div>

    <a href="${process.env.SITE_URL || 'https://mudateya.vercel.app'}/admin"
       style="display:inline-block;margin-top:8px;background:#22C36A;color:#041A0E;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">
      Revisar y aprobar →
    </a>
    <p style="color:#3D6458;font-size:11px;margin-top:16px">ID: ${perfil.id} · ${perfil.fechaRegistro}</p>
  </div>
</div>`,
  });
}

// ── LOG EN GOOGLE SHEETS ─────────────────────────────────────────
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
