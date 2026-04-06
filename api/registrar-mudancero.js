// api/registrar-mudancero.js
// Recibe el formulario completo de onboarding de mudanceros
// Guarda en Redis + valida CUIL contra AFIP + notifica al admin
// Las fotos se suben a Vercel Blob (no se guardan en Redis)

const { Resend } = require('resend');
const { put }    = require('@vercel/blob');

// ── REDIS ────────────────────────────────────────────────────────
async function redisCall(method, ...args) {
  var url   = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  var response = await fetch(
    url + '/' + [method, ...args].map(encodeURIComponent).join('/'),
    { headers: { Authorization: 'Bearer ' + token } }
  );
  var data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}
async function getJSON(key) {
  var val = await redisCall('GET', key);
  if (!val) return null;
  return JSON.parse(val);
}
async function setJSON(key, value, exSeconds) {
  var str = JSON.stringify(value);
  if (exSeconds) await redisCall('SET', key, str, 'EX', String(exSeconds));
  else           await redisCall('SET', key, str);
}

// ── SUBIR IMAGEN A VERCEL BLOB ───────────────────────────────────
// Recibe un data URL ("data:image/jpeg;base64,XXXX"), lo sube a Blob
// y devuelve la URL pública. Si no hay imagen devuelve ''.
async function subirImagen(dataUrl, carpeta, nombre) {
  if (!dataUrl) return '';
  var match = dataUrl.match(/^data:([a-zA-Z0-9+\/]+\/[a-zA-Z0-9+\/]+);base64,(.+)$/);
  if (!match) return '';
  var mediaType = match[1];
  var ext = mediaType.split('/')[1].replace('jpeg', 'jpg');
  var buffer = Buffer.from(match[2], 'base64');
  var pathname = carpeta + '/' + nombre + '-' + Date.now() + '.' + ext;
  var result = await put(pathname, buffer, {
    access: 'public',
    contentType: mediaType,
  });
  return result.url;
}

// ── VALIDAR CUIL CONTRA AFIP ─────────────────────────────────────
async function validarCUIL(cuil) {
  var cuilLimpio = cuil.replace(/[-\s]/g, '');
  if (!/^\d{11}$/.test(cuilLimpio)) {
    return { valido: false, error: 'El CUIL debe tener 11 dígitos' };
  }
  try {
    var response = await fetch(
      'https://afip.tangofactura.com/Rest/GetContribuyenteFull?cuit=' + cuilLimpio,
      { headers: { 'Accept': 'application/json' } }
    );
    if (!response.ok) {
      return { valido: false, error: 'No se pudo consultar AFIP' };
    }
    var data = await response.json();
    if (data.errorGetData || !data.Contribuyente) {
      return { valido: false, error: 'CUIL no encontrado en AFIP' };
    }
    var contribuyente = data.Contribuyente;
    return {
      valido:      true,
      cuil:        cuilLimpio,
      nombre:      contribuyente.nombre      || '',
      apellido:    contribuyente.apellido    || '',
      razonSocial: contribuyente.razonSocial || '',
      estadoClave: contribuyente.estadoClave || '',
      tipoClave:   contribuyente.tipoClave   || '',
    };
  } catch(e) {
    console.warn('Error consultando AFIP:', e.message);
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
    var body = req.body;
    var nombre          = body.nombre;
    var telefono        = body.telefono;
    var email           = body.email;
    var empresa         = body.empresa;
    var cuil            = body.cuil;
    var zonaBase        = body.zonaBase;
    var zonasExtra      = body.zonasExtra;
    var distancia       = body.distancia;
    var vehiculo        = body.vehiculo;
    var cantVehiculos   = body.cantVehiculos;
    var equipo          = body.equipo;
    var servicios       = body.servicios;
    var dias            = body.dias;
    var horarios        = body.horarios;
    var anticipacion    = body.anticipacion;
    var precio1amb      = body.precio1amb;
    var precio2amb      = body.precio2amb;
    var precio3amb      = body.precio3amb;
    var precio4amb      = body.precio4amb;
    var precioFlete     = body.precioFlete;
    var extra           = body.extra;
    var foto            = body.foto;
    var fotoCamion      = body.fotoCamion;
    var fotoPatente     = body.fotoPatente;
    var dniFrente       = body.dniFrente;
    var dniDorso        = body.dniDorso;
    var dniAnalisis     = body.dniAnalisis;
    var metodoCobro     = body.metodoCobro;
    var cbu             = body.cbu;
    var emailMP         = body.emailMP;
    var titularCuenta   = body.titularCuenta;
    var fecha           = body.fecha;

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
    var cuilResultado = null;
    if (cuil) {
      cuilResultado = await validarCUIL(cuil);

      if (cuilResultado.valido === false) {
        return res.status(400).json({
          error: cuilResultado.error || 'CUIL inválido',
          campo: 'cuil'
        });
      }

      if (cuilResultado.valido === true && dniAnalisis) {
        var norm = function(s) {
          return (s || '').toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z ]/g, '').trim();
        };
        var nombreAfip      = norm(cuilResultado.nombre + ' ' + cuilResultado.apellido + ' ' + cuilResultado.razonSocial);
        var apellidoDNI     = norm(dniAnalisis.apellido || '');
        var nombresDNI      = norm(dniAnalisis.nombres  || '');
        var primerApellidoDNI = apellidoDNI.split(' ')[0];
        var primerNombreDNI   = nombresDNI.split(' ')[0];
        var coincide = (primerApellidoDNI && nombreAfip.includes(primerApellidoDNI)) ||
                       (primerNombreDNI   && nombreAfip.includes(primerNombreDNI));
        if (!coincide && primerApellidoDNI) {
          return res.status(400).json({
            error: 'El CUIL ingresado pertenece a "' + (cuilResultado.nombre + ' ' + cuilResultado.apellido).trim() + '" pero el DNI dice "' + dniAnalisis.nombres + ' ' + dniAnalisis.apellido + '". Verificá que sea tu propio CUIL.',
            campo: 'cuil'
          });
        }
      }
    }

    // ── VERIFICAR DUPLICADO ─────────────────────────────────────
    var existente = await getJSON('mudancero:perfil:' + email);
    if (existente && existente.estado !== 'rechazado') {
      return res.status(400).json({
        error: 'Ya existe un perfil con ese email',
        estado: existente.estado
      });
    }

    // ── GENERAR ID ──────────────────────────────────────────────
    var id = 'MUD-' + Date.now();

    // ── SUBIR FOTOS A VERCEL BLOB ───────────────────────────────
    // Se suben en paralelo para no perder tiempo
    var carpeta = 'mudanceros/' + id;
    var resultadoFotos = await Promise.all([
      subirImagen(foto,        carpeta, 'perfil'),
      subirImagen(fotoCamion,  carpeta, 'camion'),
      subirImagen(fotoPatente, carpeta, 'patente'),
      subirImagen(dniFrente,   carpeta, 'dni-frente'),
      subirImagen(dniDorso,    carpeta, 'dni-dorso'),
    ]);
    var urlFoto        = resultadoFotos[0];
    var urlFotoCamion  = resultadoFotos[1];
    var urlFotoPatente = resultadoFotos[2];
    var urlDniFrente   = resultadoFotos[3];
    var urlDniDorso    = resultadoFotos[4];

    // ── ARMAR PERFIL (sin base64 — solo URLs) ───────────────────
    var perfil = {
      id:        id,
      email:     email,
      nombre:    nombre,
      telefono:  telefono,
      empresa:   empresa      || '',
      cuil:      cuil ? cuil.replace(/[-\s]/g, '') : '',
      cuilAfip:  cuilResultado,

      zonaBase:     zonaBase,
      zonasExtra:   zonasExtra   || '',
      distancia:    distancia    || '',
      vehiculo:     vehiculo,
      cantVehiculos: cantVehiculos || '1',
      equipo:       equipo       || 'Solo yo',
      servicios:    servicios    || '',
      dias:         dias         || '',
      horarios:     horarios     || '',
      anticipacion: anticipacion || '48 horas',

      precios: {
        amb1:  precio1amb  || '',
        amb2:  precio2amb  || '',
        amb3:  precio3amb  || '',
        amb4:  precio4amb  || '',
        flete: precioFlete || '',
      },

      extra:      extra      || '',

      // URLs de Blob (no base64)
      foto:        urlFoto,
      fotoCamion:  urlFotoCamion,
      fotoPatente: urlFotoPatente,
      dniFrente:   urlDniFrente,
      dniDorso:    urlDniDorso,
      dniAnalisis: dniAnalisis || null,

      // Verificaciones
      verificadoIdentidad: false,
      verificadoVehiculo:  false,
      verificadoSeguro:    false,
      cuilVerificado:      cuilResultado ? cuilResultado.valido === true  : false,
      cuilAdvertencia:     cuilResultado ? cuilResultado.advertencia === true : false,

      estadoVerificacion: 'pendiente_revision',
      metodoCobro:    metodoCobro    || 'cbu',
      cbu:            cbu            || '',
      emailMP:        emailMP        || '',
      titularCuenta:  titularCuenta  || '',

      estado:          'pendiente_revision',
      fechaRegistro:   new Date().toISOString(),
      fechaFormulario: fecha || new Date().toLocaleString('es-AR'),
      calificacion: 0, nroResenas: 0, trabajosCompletados: 0,
    };

    // ── GUARDAR EN REDIS ────────────────────────────────────────
    await setJSON('mudancero:perfil:' + email, perfil);

    var pendientes = await getJSON('mudanceros:pendientes') || [];
    if (!pendientes.includes(email)) pendientes.push(email);
    await setJSON('mudanceros:pendientes', pendientes);

    var todos = await getJSON('mudanceros:todos') || [];
    if (!todos.includes(email)) todos.push(email);
    await setJSON('mudanceros:todos', todos);

    // ── NOTIFICAR AL ADMIN ──────────────────────────────────────
    try { await notificarAdmin(perfil); } catch(e) { console.warn('Email admin:', e.message); }

    // ── LOG EN SHEETS ───────────────────────────────────────────
    try { await logMudanceroSheets(perfil); } catch(e) { console.warn('Sheets:', e.message); }

    return res.status(200).json({
      ok:      true,
      id:      id,
      cuilOk:  cuilResultado ? cuilResultado.valido === true : false,
      mensaje: 'Solicitud recibida. Te contactamos en 24hs para activar tu perfil.',
    });

  } catch(e) {
    console.error('Error en registrar-mudancero:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

// ── EMAIL AL ADMIN ───────────────────────────────────────────────
async function notificarAdmin(perfil) {
  var resend    = new Resend(process.env.RESEND_API_KEY);
  var adminMail = process.env.ADMIN_EMAIL;
  if (!process.env.RESEND_API_KEY || !adminMail) return;

  var dni  = perfil.dniAnalisis || {};
  var afip = perfil.cuilAfip    || {};

  var badgeCuil = perfil.cuilVerificado
    ? '<span style="background:#0D2018;color:#22C36A;padding:3px 10px;border-radius:4px;font-size:11px">✓ CUIL verificado en AFIP</span>'
    : perfil.cuilAdvertencia
    ? '<span style="background:#2D1F0E;color:#F59E0B;padding:3px 10px;border-radius:4px;font-size:11px">⚠ AFIP no disponible al registrar</span>'
    : '<span style="background:#1E1E1E;color:#7AADA0;padding:3px 10px;border-radius:4px;font-size:11px">— CUIL no ingresado</span>';

  // Bloques de fotos para el email (links directos a Blob)
  var bloquesFotos = '';
  if (perfil.dniFrente || perfil.dniDorso) {
    bloquesFotos += '<div style="background:#172018;border-radius:10px;padding:12px 16px;margin:14px 0">';
    bloquesFotos += '<div style="font-size:11px;color:#5A8A78;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Fotos DNI</div>';
    bloquesFotos += '<div style="display:flex;gap:10px;flex-wrap:wrap">';
    if (perfil.dniFrente)   bloquesFotos += '<a href="' + perfil.dniFrente   + '" target="_blank"><img src="' + perfil.dniFrente   + '" style="max-width:160px;max-height:100px;border-radius:6px;border:1px solid #2D4A3E" alt="DNI frente"/></a>';
    if (perfil.dniDorso)    bloquesFotos += '<a href="' + perfil.dniDorso    + '" target="_blank"><img src="' + perfil.dniDorso    + '" style="max-width:160px;max-height:100px;border-radius:6px;border:1px solid #2D4A3E" alt="DNI dorso"/></a>';
    bloquesFotos += '</div></div>';
  }
  if (perfil.fotoCamion || perfil.fotoPatente) {
    bloquesFotos += '<div style="background:#172018;border-radius:10px;padding:12px 16px;margin:14px 0">';
    bloquesFotos += '<div style="font-size:11px;color:#5A8A78;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Fotos vehículo</div>';
    bloquesFotos += '<div style="display:flex;gap:10px;flex-wrap:wrap">';
    if (perfil.fotoCamion)  bloquesFotos += '<a href="' + perfil.fotoCamion  + '" target="_blank"><img src="' + perfil.fotoCamion  + '" style="max-width:160px;max-height:100px;border-radius:6px;border:1px solid #2D4A3E" alt="Camión"/></a>';
    if (perfil.fotoPatente) bloquesFotos += '<a href="' + perfil.fotoPatente + '" target="_blank"><img src="' + perfil.fotoPatente + '" style="max-width:160px;max-height:100px;border-radius:6px;border:1px solid #2D4A3E" alt="Patente"/></a>';
    bloquesFotos += '</div></div>';
  }

  await resend.emails.send({
    from:    'MudateYa <noreply@mudateya.ar>',
    to:      adminMail,
    subject: '🚛 Nuevo mudancero — ' + perfil.nombre + ' · ' + perfil.zonaBase + ' · ' + perfil.id,
    html: '<div style="font-family:Arial,sans-serif;max-width:600px;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden">' +
      '<div style="background:#22C36A;padding:18px 22px">' +
        '<h2 style="margin:0;color:#041A0E">🚛 Nuevo mudancero registrado</h2>' +
      '</div>' +
      '<div style="padding:22px">' +
        '<table style="width:100%;border-collapse:collapse">' +
          '<tr><td style="color:#7AADA0;padding:6px 0;width:35%">Nombre</td>' +
              '<td><strong>' + perfil.nombre + '</strong>' + (perfil.empresa ? ' · ' + perfil.empresa : '') + '</td></tr>' +
          '<tr><td style="color:#7AADA0;padding:6px 0">Email</td><td>' + perfil.email + '</td></tr>' +
          '<tr><td style="color:#7AADA0;padding:6px 0">Teléfono</td><td>' + perfil.telefono + '</td></tr>' +
          '<tr><td style="color:#7AADA0;padding:6px 0">CUIL</td>' +
              '<td>' + (perfil.cuil || '—') + ' ' + badgeCuil +
              (afip.nombre ? '<br><small style="color:#5A8A78">AFIP: ' + afip.nombre + ' ' + afip.apellido + ' · ' + afip.estadoClave + '</small>' : '') + '</td></tr>' +
          '<tr><td style="color:#7AADA0;padding:6px 0">Zona</td>' +
              '<td>' + perfil.zonaBase + (perfil.zonasExtra ? ' · ' + perfil.zonasExtra : '') + '</td></tr>' +
          '<tr><td style="color:#7AADA0;padding:6px 0">Vehículo</td>' +
              '<td>' + perfil.vehiculo + ' · ' + perfil.cantVehiculos + ' unid. · ' + perfil.equipo + '</td></tr>' +
          '<tr><td style="color:#7AADA0;padding:6px 0">Servicios</td>' +
              '<td style="font-size:12px">' + perfil.servicios + '</td></tr>' +
        '</table>' +

        '<div style="background:#172018;border-radius:10px;padding:12px 16px;margin:14px 0">' +
          '<div style="font-size:11px;color:#5A8A78;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">DNI análisis IA</div>' +
          '<div style="font-size:13px">' +
            (dni.numero_dni ? 'DNI: <strong>' + dni.numero_dni + '</strong> · ' : '') +
            (dni.apellido || '') + ' ' + (dni.nombres || '') + '<br>' +
            (dni.fecha_vencimiento ? 'Vence: ' + dni.fecha_vencimiento + ' · ' : '') +
            'Legible: <strong style="color:' + (dni.legible ? '#22C36A' : '#F59E0B') + '">' + (dni.legible ? '✓ SI' : '✗ NO') + '</strong>' +
          '</div>' +
        '</div>' +

        bloquesFotos +

        '<div style="background:#172018;border-radius:10px;padding:12px 16px;margin:14px 0">' +
          '<div style="font-size:11px;color:#5A8A78;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Cobro</div>' +
          '<div style="font-size:13px">' +
            (perfil.metodoCobro === 'cbu' ? 'CBU/Alias: ' + perfil.cbu : 'MP: ' + perfil.emailMP) +
            (perfil.titularCuenta ? ' · ' + perfil.titularCuenta : '') +
          '</div>' +
        '</div>' +

        '<a href="' + (process.env.SITE_URL || 'https://mudateya.ar') + '/admin"' +
           ' style="display:inline-block;margin-top:8px;background:#22C36A;color:#041A0E;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">' +
          'Revisar y aprobar →' +
        '</a>' +
        '<p style="color:#3D6458;font-size:11px;margin-top:16px">ID: ' + perfil.id + ' · ' + perfil.fechaRegistro + '</p>' +
      '</div>' +
    '</div>',
  });
}

// ── LOG EN GOOGLE SHEETS ─────────────────────────────────────────
async function logMudanceroSheets(perfil) {
  var webhookUrl = process.env.GOOGLE_SHEETS_MUDANCEROS_URL;
  if (!webhookUrl) return;

  var dni  = perfil.dniAnalisis || {};
  var afip = perfil.cuilAfip    || {};

  await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ID:                perfil.id,
      'Fecha registro':  new Date(perfil.fechaRegistro).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }),
      Nombre:            perfil.nombre,
      Empresa:           perfil.empresa    || '—',
      Email:             perfil.email,
      'Teléfono':        perfil.telefono,
      CUIL:              perfil.cuil       || '—',
      'CUIL verificado': perfil.cuilVerificado ? 'SI' : perfil.cuilAdvertencia ? 'ADVERTENCIA' : 'NO',
      'AFIP nombre':     afip.nombre       ? (afip.nombre + ' ' + afip.apellido).trim() : '—',
      'AFIP estado':     afip.estadoClave  || '—',
      'Zona base':       perfil.zonaBase,
      'Zonas extra':     perfil.zonasExtra || '—',
      'Vehículo':        perfil.vehiculo,
      Servicios:         perfil.servicios,
      'Días':            perfil.dias,
      Horarios:          perfil.horarios,
      'DNI número':      dni.numero_dni       || '—',
      'DNI apellido':    dni.apellido         || '—',
      'DNI nombres':     dni.nombres          || '—',
      'DNI vencimiento': dni.fecha_vencimiento || '—',
      'DNI legible':     dni.legible ? 'SI' : 'NO',
      'Método cobro':    perfil.metodoCobro,
      'CBU/Alias':       perfil.cbu           || '—',
      Titular:           perfil.titularCuenta  || '—',
      'Foto perfil':     perfil.foto          || '—',
      'Foto camión':     perfil.fotoCamion    || '—',
      'Foto patente':    perfil.fotoPatente   || '—',
      'DNI frente URL':  perfil.dniFrente     || '—',
      'DNI dorso URL':   perfil.dniDorso      || '—',
      Estado:            'PENDIENTE_REVISION',
    }),
  });
}
