// ═══════════════════════════════════════════════════════════════════
// MUDATEYA — API ASESORES (Plan Referidos Inmobiliarios)
// Servicio GRATIS de valor agregado. Los asesores NO cobran comisión.
// Flujo: asesor se registra → carga datos cliente + mudanza →
//        ve mudanceras pre-asignadas por zona con sus 3 precios
//        (esencial/integral/llave) → arma los 3 packs (1 de c/nivel) →
//        envía link al cliente por email + WhatsApp.
// ═══════════════════════════════════════════════════════════════════
const { Resend } = require('resend');

// Helper de push notifications (definido en api/push.js)
// Si push.js no carga, las notificaciones por email siguen funcionando normal.
let enviarPush = async function() { return { ok: false, error: 'push no cargado' }; };
try {
  enviarPush = require('./push').enviarPush || enviarPush;
} catch (e) {
  console.warn('[push] no se pudo cargar push.js:', e.message);
}

// ── Helpers Redis (Upstash) ─────────────────────────────────────────
async function redisCall(method, ...args) {
  var url = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  var r = await fetch(url + '/' + method + '/' + args.map(encodeURIComponent).join('/'), {
    headers: { Authorization: 'Bearer ' + token }
  });
  var j = await r.json();
  return j.result;
}
async function getJSON(key) {
  var v = await redisCall('get', key);
  try { return v ? JSON.parse(v) : null; } catch(e) { return null; }
}
async function setJSON(key, value, exSeconds) {
  var v = JSON.stringify(value);
  if (exSeconds) await redisCall('setex', key, exSeconds, v);
  else await redisCall('set', key, v);
}
async function delKey(key) { await redisCall('del', key); }

async function setString(key, value, exSeconds) {
  if (exSeconds) await redisCall('setex', key, exSeconds, String(value));
  else await redisCall('set', key, String(value));
}
async function getString(key) {
  var v = await redisCall('get', key);
  if (v == null) return null;
  // Sanitizar: si viene con comillas de un JSON.stringify previo, quitarlas
  return String(v).replace(/^"(.*)"$/, '$1');
}

// ── Constantes ──────────────────────────────────────────────────────
var ADMIN_FALLBACK = 'mya-admin-2026';
var MAGIC_LINK_TTL = 900;              // 15 min
var SESSION_TTL    = 60 * 60 * 24 * 30; // 30 días
var PEDIDO_TTL     = 60 * 60 * 24 * 30; // pedido público vive 30 días

// ── Sanitización / validación ───────────────────────────────────────
function esc(s) {
  if (!s) return '';
  return String(s).replace(/[<>&"']/g, function(c){
    return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c];
  });
}
function validEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e||'').trim());
}
function normFono(t) {
  return String(t||'').replace(/\D/g,'');
}

// ── Zonas válidas ──────────────────────────────────────────────────
// AMBA engloba CABA + todas las GBA (Norte, Oeste, Sur)
var ZONAS_VALIDAS = [
  'AMBA', 'La Plata', 'Mar del Plata', 'Rosario', 'Córdoba', 'Mendoza', 'Otra'
];
// Subzonas legacy que ahora caen bajo AMBA (auto-migración en runtime)
var ZONAS_LEGACY_AMBA = {
  'CABA': 'AMBA',
  'Zona Norte GBA': 'AMBA',
  'Zona Oeste GBA': 'AMBA',
  'Zona Sur GBA':   'AMBA'
};
function normZona(z) {
  var v = String(z||'').trim();
  if (ZONAS_LEGACY_AMBA[v]) return ZONAS_LEGACY_AMBA[v];
  return v;
}

// ── Niveles de pack ─────────────────────────────────────────────────
var NIVELES = ['esencial', 'integral', 'llave'];
var NIVELES_LABEL = {
  esencial: 'Esencial',
  integral: 'Integral',
  llave:    'Llave en Mano'
};

// ── EMAILS ──────────────────────────────────────────────────────────
async function enviarMagicLink(email, token, nombre) {
  try {
    var resend = new Resend(process.env.RESEND_API_KEY);
    var link = 'https://mudateya.ar/asesor-login?token=' + token;
    var html = '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#0F1923">' +
      '<div style="text-align:center;margin-bottom:28px">' +
        '<span style="font-family:Bebas Neue,sans-serif;font-size:36px;letter-spacing:2px;color:#003580">MUDATE</span>' +
        '<span style="font-family:Bebas Neue,sans-serif;font-size:36px;letter-spacing:2px;color:#22C36A">YA</span>' +
      '</div>' +
      '<h2 style="color:#003580;font-size:22px;margin-bottom:14px">Hola' + (nombre ? ' ' + esc(nombre) : '') + '</h2>' +
      '<p style="color:#475569;font-size:15px;line-height:1.6;margin-bottom:24px">Para entrar a tu panel de Asesor Referido, hacé clic en el botón:</p>' +
      '<div style="text-align:center;margin:32px 0">' +
        '<a href="' + link + '" style="display:inline-block;padding:14px 32px;background:#22C36A;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px">Abrir mi panel</a>' +
      '</div>' +
      '<p style="color:#94A3B8;font-size:12px;text-align:center;margin-top:24px">Este link expira en 15 minutos. Si no fuiste vos, ignorá este email.</p>' +
      '<hr style="border:none;border-top:1px solid #E2E8F0;margin:28px 0">' +
      '<p style="color:#94A3B8;font-size:11px;text-align:center">MudateYa · mudateya.ar</p>' +
      '</div>';
    await resend.emails.send({
      from: 'MudateYa Asesores <noreply@mudateya.ar>',
      to: email,
      subject: 'Accedé a tu panel de Asesor MudateYa',
      html: html
    });
    return true;
  } catch(e) {
    console.error('Error magic link asesor:', e.message);
    return false;
  }
}

async function enviarEmailBienvenida(asesor) {
  try {
    var resend = new Resend(process.env.RESEND_API_KEY);
    var link = 'https://mudateya.ar/asesor-login?token=' + asesor.sessionToken;
    var html = '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#0F1923">' +
      '<div style="text-align:center;margin-bottom:28px">' +
        '<span style="font-family:Bebas Neue,sans-serif;font-size:36px;letter-spacing:2px;color:#003580">MUDATE</span>' +
        '<span style="font-family:Bebas Neue,sans-serif;font-size:36px;letter-spacing:2px;color:#22C36A">YA</span>' +
      '</div>' +
      '<h2 style="color:#003580;font-size:22px;margin-bottom:14px">🎉 Bienvenido, ' + esc(asesor.nombre) + '</h2>' +
      '<p style="color:#475569;font-size:15px;line-height:1.6">Ya sos Asesor Referido de MudateYa. Desde tu panel vas a poder armar presupuestos de mudanzas premium para tus clientes — un servicio gratis que suma valor a tu propuesta inmobiliaria.</p>' +
      '<div style="background:#F5F7FA;padding:14px;border-radius:8px;margin:18px 0">' +
        '<p style="margin:0;color:#475569;font-size:13px"><strong style="color:#003580">Inmobiliaria:</strong> ' + esc(asesor.inmobiliaria || '—') + '</p>' +
        '<p style="margin:8px 0 0 0;color:#475569;font-size:13px"><strong style="color:#003580">Zona:</strong> ' + esc(asesor.zona || '—') + '</p>' +
      '</div>' +
      '<div style="text-align:center;margin:32px 0">' +
        '<a href="' + link + '" style="display:inline-block;padding:14px 32px;background:#22C36A;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px">Entrar a mi panel</a>' +
      '</div>' +
      '<hr style="border:none;border-top:1px solid #E2E8F0;margin:28px 0">' +
      '<p style="color:#94A3B8;font-size:11px;text-align:center">MudateYa · mudateya.ar</p>' +
      '</div>';
    await resend.emails.send({
      from: 'MudateYa Asesores <noreply@mudateya.ar>',
      to: asesor.email,
      subject: '🎉 Bienvenido a MudateYa Asesores',
      html: html
    });
  } catch(e) { console.error('Email bienvenida asesor:', e.message); }
}

async function enviarEmailAdminNuevoAsesor(asesor) {
  try {
    var resend = new Resend(process.env.RESEND_API_KEY);
    var fecha = new Date().toLocaleString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
    var html = '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#0F1923">' +
      '<div style="text-align:center;margin-bottom:28px">' +
        '<span style="font-family:Bebas Neue,sans-serif;font-size:36px;letter-spacing:2px;color:#003580">MUDATE</span>' +
        '<span style="font-family:Bebas Neue,sans-serif;font-size:36px;letter-spacing:2px;color:#22C36A">YA</span>' +
      '</div>' +
      '<h2 style="color:#003580;font-size:20px;margin-bottom:6px">🤝 Nuevo Asesor registrado</h2>' +
      '<p style="color:#94A3B8;font-size:12px;margin-bottom:20px">' + fecha + '</p>' +
      '<div style="background:#F5F7FA;border-radius:10px;padding:18px;margin-bottom:20px">' +
        '<table style="width:100%;font-size:14px;color:#475569;border-collapse:collapse">' +
          '<tr><td style="padding:6px 0;font-weight:600;color:#003580;width:120px">Nombre:</td><td style="padding:6px 0">' + esc(asesor.nombre) + '</td></tr>' +
          '<tr><td style="padding:6px 0;font-weight:600;color:#003580">Email:</td><td style="padding:6px 0"><a href="mailto:' + esc(asesor.email) + '" style="color:#1A6FFF;text-decoration:none">' + esc(asesor.email) + '</a></td></tr>' +
          '<tr><td style="padding:6px 0;font-weight:600;color:#003580">Teléfono:</td><td style="padding:6px 0"><a href="https://wa.me/' + esc(normFono(asesor.telefono)) + '" style="color:#22C36A;text-decoration:none">' + esc(asesor.telefono || '—') + '</a></td></tr>' +
          '<tr><td style="padding:6px 0;font-weight:600;color:#003580">Inmobiliaria:</td><td style="padding:6px 0">' + esc(asesor.inmobiliaria || '—') + '</td></tr>' +
          '<tr><td style="padding:6px 0;font-weight:600;color:#003580">Zona:</td><td style="padding:6px 0">' + esc(asesor.zona || '—') + '</td></tr>' +
        '</table>' +
      '</div>' +
      '<div style="text-align:center;margin:24px 0">' +
        '<a href="https://mudateya.ar/admin" style="display:inline-block;padding:12px 28px;background:#003580;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px">Ver en panel admin →</a>' +
      '</div>' +
      '<hr style="border:none;border-top:1px solid #E2E8F0;margin:28px 0">' +
      '<p style="color:#94A3B8;font-size:11px;text-align:center">Notificación automática · MudateYa</p>' +
      '</div>';
    await resend.emails.send({
      from: 'MudateYa <noreply@mudateya.ar>',
      to: 'jgalozaldivar@gmail.com',
      subject: '🤝 Nuevo Asesor: ' + asesor.nombre + ' (' + (asesor.inmobiliaria || '—') + ')',
      html: html
    });
  } catch(e) { console.error('Email admin nuevo asesor:', e.message); }
}

// ── Email al admin cuando un asesor crea un nuevo pedido ─────────
async function enviarEmailAdminNuevoPedido(pedido, asesor) {
  try {
    var resend = new Resend(process.env.RESEND_API_KEY);
    var fecha = new Date().toLocaleString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
    var packsRow = '';
    for (var i = 0; i < pedido.packs.length; i++) {
      var p = pedido.packs[i];
      packsRow +=
        '<tr><td style="padding:4px 0;font-weight:600;color:#003580;width:110px">' + esc(NIVELES_LABEL[p.nivel] || p.nivel) + ':</td>' +
          '<td style="padding:4px 0">' + esc(p.empresa || p.mudanceroNombre) + ' — <strong style="color:#22C36A;font-family:DM Mono,monospace">$' + Number(p.precio).toLocaleString('es-AR') + '</strong></td></tr>';
    }
    var html = '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#0F1923">' +
      '<div style="text-align:center;margin-bottom:28px">' +
        '<span style="font-family:Bebas Neue,sans-serif;font-size:36px;letter-spacing:2px;color:#003580">MUDATE</span>' +
        '<span style="font-family:Bebas Neue,sans-serif;font-size:36px;letter-spacing:2px;color:#22C36A">YA</span>' +
      '</div>' +
      '<h2 style="color:#003580;font-size:20px;margin-bottom:6px">📋 Nuevo pedido de Asesor</h2>' +
      '<p style="color:#94A3B8;font-size:12px;margin-bottom:20px">' + fecha + ' · ID: <code style="font-family:DM Mono,monospace">' + esc(pedido.id) + '</code></p>' +
      '<div style="background:#F5F7FA;border-radius:10px;padding:18px;margin-bottom:14px">' +
        '<div style="font-size:11px;font-weight:700;color:#64748B;font-family:DM Mono,monospace;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Asesor</div>' +
        '<div style="font-size:14px;color:#0F1923"><strong>' + esc(asesor.nombre) + '</strong>' + (asesor.inmobiliaria ? ' · ' + esc(asesor.inmobiliaria) : '') + '</div>' +
        '<div style="font-size:12px;color:#64748B;font-family:DM Mono,monospace;margin-top:4px">' + esc(asesor.email) + '</div>' +
      '</div>' +
      '<div style="background:#F5F7FA;border-radius:10px;padding:18px;margin-bottom:14px">' +
        '<div style="font-size:11px;font-weight:700;color:#64748B;font-family:DM Mono,monospace;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Cliente</div>' +
        '<div style="font-size:14px;color:#0F1923"><strong>' + esc(pedido.cliente.nombre) + '</strong></div>' +
        '<div style="font-size:12px;color:#64748B;font-family:DM Mono,monospace;margin-top:4px">' + esc(pedido.cliente.email) + ' · ' + esc(pedido.cliente.telefono) + '</div>' +
      '</div>' +
      '<div style="background:#F5F7FA;border-radius:10px;padding:18px;margin-bottom:14px">' +
        '<div style="font-size:11px;font-weight:700;color:#64748B;font-family:DM Mono,monospace;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Mudanza</div>' +
        '<div style="font-size:13px;color:#475569;line-height:1.6">' +
          '<div><strong style="color:#003580">Origen:</strong> ' + esc(pedido.mudanza.origen) + '</div>' +
          '<div><strong style="color:#003580">Destino:</strong> ' + esc(pedido.mudanza.destino) + '</div>' +
          '<div><strong style="color:#003580">Fecha:</strong> ' + esc(pedido.mudanza.fecha) + ' · <strong style="color:#003580">Ambientes:</strong> ' + esc(pedido.mudanza.ambientes || '—') + '</div>' +
        '</div>' +
      '</div>' +
      '<div style="background:#F5F7FA;border-radius:10px;padding:18px;margin-bottom:20px">' +
        '<div style="font-size:11px;font-weight:700;color:#64748B;font-family:DM Mono,monospace;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">3 Packs armados</div>' +
        '<table style="width:100%;font-size:13px;color:#475569;border-collapse:collapse">' + packsRow + '</table>' +
      '</div>' +
      '<div style="text-align:center;margin:20px 0">' +
        '<a href="https://mudateya.ar/admin" style="display:inline-block;padding:12px 26px;background:#003580;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:13px">Ver en panel admin →</a>' +
      '</div>' +
      '<hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0">' +
      '<p style="color:#94A3B8;font-size:11px;text-align:center">Notificación automática · MudateYa</p>' +
      '</div>';
    await resend.emails.send({
      from: 'MudateYa <noreply@mudateya.ar>',
      to: 'jgalozaldivar@gmail.com',
      subject: '📋 Nuevo pedido asesor: ' + asesor.nombre + ' → ' + pedido.cliente.nombre,
      html: html
    });
  } catch(e) { console.error('Email admin nuevo pedido:', e.message); }
}

// ── Email al cliente con los 3 packs armados por el asesor ─────────
async function enviarEmailClientePacks(pedido, asesor) {
  try {
    var resend = new Resend(process.env.RESEND_API_KEY);
    var link = 'https://mudateya.ar/cliente-packs?id=' + pedido.id;
    var clienteNombre = pedido.cliente && pedido.cliente.nombre ? pedido.cliente.nombre : 'Hola';
    var cantPacks = (pedido.packs || []).length;
    // Singular/plural según cantidad
    var palabraOpc = cantPacks === 1 ? 'opción' : 'opciones';
    var verboTitulo = cantPacks === 1 ? 'preparó una opción' : ('preparó ' + cantPacks + ' opciones');
    var ctaTexto = cantPacks === 1 ? 'Ver mi opción' : ('Ver mis ' + cantPacks + ' opciones');

    // Resumen visual de los packs (1-3)
    var packsHtml = '';
    for (var i = 0; i < pedido.packs.length; i++) {
      var p = pedido.packs[i];
      packsHtml +=
        '<div style="background:#F5F7FA;border-radius:10px;padding:14px;margin-bottom:10px;border-left:4px solid #22C36A">' +
          '<div style="color:#003580;font-weight:700;font-size:14px">' + esc(NIVELES_LABEL[p.nivel] || p.nivel) + '</div>' +
          '<div style="color:#475569;font-size:13px;margin-top:4px">' + esc(p.empresa || p.mudanceroNombre) + '</div>' +
          '<div style="color:#22C36A;font-weight:700;font-size:18px;margin-top:6px;font-family:DM Mono,monospace">$' + Number(p.precio).toLocaleString('es-AR') + '</div>' +
        '</div>';
    }

    var html = '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#0F1923">' +
      '<div style="text-align:center;margin-bottom:28px">' +
        '<span style="font-family:Bebas Neue,sans-serif;font-size:36px;letter-spacing:2px;color:#003580">MUDATE</span>' +
        '<span style="font-family:Bebas Neue,sans-serif;font-size:36px;letter-spacing:2px;color:#22C36A">YA</span>' +
      '</div>' +
      '<h2 style="color:#003580;font-size:22px;margin-bottom:8px">Hola ' + esc(clienteNombre) + ' 👋</h2>' +
      '<p style="color:#475569;font-size:15px;line-height:1.6;margin-bottom:18px"><strong>' + esc(asesor.nombre) + '</strong>' + (asesor.inmobiliaria ? ' de <strong>' + esc(asesor.inmobiliaria) + '</strong>' : '') + ' te ' + verboTitulo + ' de mudanza para <strong>' + esc(pedido.mudanza.destino || 'tu nuevo hogar') + '</strong>.</p>' +
      '<p style="color:#475569;font-size:14px;line-height:1.6;margin-bottom:18px">' + (cantPacks === 1 ? 'Empresa verificada por MudateYa.' : 'Todas con mudanceras verificadas por MudateYa. Elegí la que más te convenga:') + '</p>' +
      packsHtml +
      '<div style="text-align:center;margin:28px 0">' +
        '<a href="' + link + '" style="display:inline-block;padding:14px 32px;background:#22C36A;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px">' + ctaTexto + '</a>' +
      '</div>' +
      '<p style="color:#94A3B8;font-size:12px;text-align:center;margin-top:16px">Servicio gratis cortesía de tu asesor inmobiliario.</p>' +
      '<hr style="border:none;border-top:1px solid #E2E8F0;margin:28px 0">' +
      '<p style="color:#94A3B8;font-size:11px;text-align:center">MudateYa · mudateya.ar</p>' +
      '</div>';

    var subject = cantPacks === 1
      ? 'Tu opción de mudanza — cortesía de ' + asesor.nombre
      : 'Tus ' + cantPacks + ' opciones de mudanza — cortesía de ' + asesor.nombre;

    var result = await resend.emails.send({
      from: 'MudateYa <noreply@mudateya.ar>',
      to: pedido.cliente.email,
      subject: subject,
      html: html
    });
    if (result && result.error) {
      console.error('Resend error (email cliente):', JSON.stringify(result.error));
      return false;
    }
    console.log('Email cliente enviado:', pedido.cliente.email, '· packs:', cantPacks);
    return true;
  } catch(e) {
    console.error('Email cliente packs:', e.message);
    return false;
  }
}

// ── Email al mudancero: te eligieron por un pack del Plan Referidos ──
async function enviarEmailMudanceroPedidoAsesor(mudanza, cot, mudancero) {
  try {
    var resend = new Resend(process.env.RESEND_API_KEY);
    var nivelLbl = NIVELES_LABEL[mudanza.nivelPack] || mudanza.nivelPack;
    var precioBruto = Number(cot.precio) || 0;
    var comision = Math.round(precioBruto * 0.25);
    var neto = precioBruto - comision;
    var anticipo = Math.round(precioBruto * 0.5);
    var precioFmt = '$' + precioBruto.toLocaleString('es-AR');
    var comisionFmt = '$' + comision.toLocaleString('es-AR');
    var netoFmt = '$' + neto.toLocaleString('es-AR');
    var anticipoFmt = '$' + anticipo.toLocaleString('es-AR');
    var html = '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#0F1923">' +
      '<div style="text-align:center;margin-bottom:28px">' +
        '<span style="font-family:Bebas Neue,sans-serif;font-size:36px;letter-spacing:2px;color:#003580">MUDATE</span>' +
        '<span style="font-family:Bebas Neue,sans-serif;font-size:36px;letter-spacing:2px;color:#22C36A">YA</span>' +
      '</div>' +
      '<h2 style="color:#003580;font-size:22px;margin-bottom:10px">🎯 Nueva mudanza aceptada — Plan Referidos</h2>' +
      '<p style="color:#475569;font-size:14px;line-height:1.6;margin-bottom:16px">Hola ' + esc(mudancero.nombre) + ', un asesor inmobiliario eligió tu empresa para el pack <strong>' + esc(nivelLbl) + '</strong> y el cliente ya confirmó. Cuando pague el anticipo vas a poder ver el teléfono en tu panel.</p>' +
      '<div style="background:#F5F7FA;border-radius:10px;padding:16px;margin-bottom:14px">' +
        '<table style="width:100%;font-size:14px;color:#475569;border-collapse:collapse">' +
          '<tr><td style="padding:5px 0;font-weight:600;color:#003580;width:110px">Cliente:</td><td style="padding:5px 0">' + esc(mudanza.clienteNombre) + '</td></tr>' +
          '<tr><td style="padding:5px 0;font-weight:600;color:#003580">Origen:</td><td style="padding:5px 0">' + esc(mudanza.desde) + '</td></tr>' +
          '<tr><td style="padding:5px 0;font-weight:600;color:#003580">Destino:</td><td style="padding:5px 0">' + esc(mudanza.hasta) + '</td></tr>' +
          '<tr><td style="padding:5px 0;font-weight:600;color:#003580">Fecha:</td><td style="padding:5px 0">' + esc(mudanza.fecha) + '</td></tr>' +
          '<tr><td style="padding:5px 0;font-weight:600;color:#003580">Ambientes:</td><td style="padding:5px 0">' + esc(mudanza.ambientes || '—') + '</td></tr>' +
          (mudanza.notasCliente ? '<tr><td style="padding:5px 0;font-weight:600;color:#003580;vertical-align:top">Notas:</td><td style="padding:5px 0;font-style:italic">' + esc(mudanza.notasCliente) + '</td></tr>' : '') +
          '<tr><td style="padding:5px 0;font-weight:600;color:#003580">Pack:</td><td style="padding:5px 0">' + esc(nivelLbl) + '</td></tr>' +
        '</table>' +
      '</div>' +
      '<div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:10px;padding:14px 16px;margin-bottom:18px">' +
        '<div style="font-size:11px;font-weight:700;color:#92400E;font-family:DM Mono,monospace;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">💰 Desglose del pago</div>' +
        '<table style="width:100%;font-size:13.5px;color:#475569;border-collapse:collapse">' +
          '<tr><td style="padding:4px 0">Total pagado por el cliente</td><td style="padding:4px 0;text-align:right;font-family:DM Mono,monospace;font-weight:600;color:#0F1923">' + precioFmt + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#92400E">Comisión MudateYa (25% — Plan Referidos)</td><td style="padding:4px 0;text-align:right;font-family:DM Mono,monospace;color:#92400E">−' + comisionFmt + '</td></tr>' +
          '<tr style="border-top:2px solid #FDE68A"><td style="padding:8px 0 4px;font-weight:700;color:#003580">Neto para vos</td><td style="padding:8px 0 4px;text-align:right;font-family:DM Mono,monospace;font-weight:800;color:#22C36A;font-size:16px">' + netoFmt + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#64748B;font-size:12px">Anticipo (50% del total)</td><td style="padding:4px 0;text-align:right;font-family:DM Mono,monospace;color:#64748B;font-size:12px">' + anticipoFmt + '</td></tr>' +
        '</table>' +
      '</div>' +
      '<div style="text-align:center;margin:24px 0">' +
        '<a href="https://mudateya.ar/mi-cuenta" style="display:inline-block;padding:14px 32px;background:#22C36A;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px">Ver en mi panel</a>' +
      '</div>' +
      '<p style="color:#94A3B8;font-size:12px;text-align:center;margin-top:18px">El cliente recibió el link para pagar el anticipo. Te avisamos apenas lo pague.</p>' +
      '<hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0">' +
      '<p style="color:#94A3B8;font-size:11px;text-align:center">MudateYa · mudateya.ar</p>' +
      '</div>';
    await resend.emails.send({
      from: 'MudateYa <noreply@mudateya.ar>',
      to: mudancero.email,
      subject: '🎯 Nueva mudanza ' + nivelLbl + ' · ' + mudanza.clienteNombre,
      html: html
    });
  } catch(e) { console.error('Email mudancero pedido-asesor:', e.message); }
}

// ── Email al asesor: tu cliente eligió un pack ──
async function enviarEmailAsesorClienteEligio(pedido, nivel, mudancero) {
  try {
    var resend = new Resend(process.env.RESEND_API_KEY);
    if (!pedido.asesorEmail) return;
    var nivelLbl = NIVELES_LABEL[nivel] || nivel;
    var precio = 0;
    for (var i = 0; i < pedido.packs.length; i++) {
      if (pedido.packs[i].nivel === nivel) { precio = pedido.packs[i].precio; break; }
    }
    var html = '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#0F1923">' +
      '<div style="text-align:center;margin-bottom:28px">' +
        '<span style="font-family:Bebas Neue,sans-serif;font-size:36px;letter-spacing:2px;color:#003580">MUDATE</span>' +
        '<span style="font-family:Bebas Neue,sans-serif;font-size:36px;letter-spacing:2px;color:#22C36A">YA</span>' +
      '</div>' +
      '<h2 style="color:#003580;font-size:22px;margin-bottom:10px">✅ Tu cliente eligió un pack</h2>' +
      '<p style="color:#475569;font-size:15px;line-height:1.6;margin-bottom:16px"><strong>' + esc(pedido.cliente.nombre) + '</strong> eligió el pack <strong>' + esc(nivelLbl) + '</strong> con <strong>' + esc(mudancero.nombre) + '</strong> por <strong style="color:#22C36A">$' + Number(precio).toLocaleString('es-AR') + '</strong>.</p>' +
      '<p style="color:#475569;font-size:14px;line-height:1.6;margin-bottom:18px">Le enviamos el link para pagar el anticipo (50%). Te vamos a avisar cuando lo complete.</p>' +
      '<div style="text-align:center;margin:24px 0">' +
        '<a href="https://mudateya.ar/asesor-dashboard" style="display:inline-block;padding:12px 28px;background:#003580;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px">Ver en mi panel</a>' +
      '</div>' +
      '<hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0">' +
      '<p style="color:#94A3B8;font-size:11px;text-align:center">MudateYa · mudateya.ar</p>' +
      '</div>';
    await resend.emails.send({
      from: 'MudateYa Asesores <noreply@mudateya.ar>',
      to: pedido.asesorEmail,
      subject: '✅ ' + pedido.cliente.nombre + ' eligió ' + nivelLbl,
      html: html
    });
  } catch(e) { console.error('Email asesor cliente eligió:', e.message); }
}


// ── Auth helper: extrae email del asesor desde session token ───────
async function getAsesorDesdeToken(token) {
  if (!token) return null;
  var email = await getString('asesor:session:' + token);
  if (!email) return null;
  var asesor = await getJSON('asesor:' + email);
  if (!asesor) return null;
  return { email: email, asesor: asesor };
}

// ══════════════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ══════════════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  // CORS restricted a mudateya.ar
  var origin = req.headers.origin;
  var allowedOrigins = ['https://mudateya.ar', 'https://www.mudateya.ar'];
  if (origin && allowedOrigins.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-internal-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  var action = req.query.action;

  try {
    // ══════════════════════════════════════════════════════════════
    // PÚBLICO — Registro / Login / Pedido-cliente
    // ══════════════════════════════════════════════════════════════

    // ── REGISTER ──────────────────────────────────────────────────
    if (action === 'register' && req.method === 'POST') {
      var body = req.body || {};
      var nombre        = String(body.nombre || '').trim();
      var emailReg      = String(body.email || '').trim().toLowerCase();
      var telefono      = String(body.telefono || '').trim();
      var inmobiliaria  = String(body.inmobiliaria || '').trim();
      var zona          = normZona(body.zona);

      if (!nombre || nombre.length < 2)          return res.status(400).json({ error: 'Ingresá tu nombre completo' });
      if (!validEmail(emailReg))                 return res.status(400).json({ error: 'Email inválido' });
      if (!telefono || normFono(telefono).length < 8) return res.status(400).json({ error: 'Teléfono inválido' });
      if (!inmobiliaria || inmobiliaria.length < 2)   return res.status(400).json({ error: 'Ingresá tu inmobiliaria (o "Independiente")' });
      if (!zona)                                 return res.status(400).json({ error: 'Elegí tu zona de trabajo' });

      // Si ya existe → mandamos magic link (no duplicamos)
      var existe = await getJSON('asesor:' + emailReg);
      if (existe) {
        var existingToken = Math.random().toString(36).substring(2) + Date.now().toString(36);
        await setJSON('asesor:magiclink:' + existingToken, { email: emailReg }, MAGIC_LINK_TTL);
        await enviarMagicLink(emailReg, existingToken, existe.nombre);
        return res.status(200).json({ ok:true, existente:true, mensaje:'Ya estabas registrado. Te mandamos un link a tu email.' });
      }

      var sessionToken = Math.random().toString(36).substring(2) + Date.now().toString(36) + Math.random().toString(36).substring(2);
      var asesor = {
        email:         emailReg,
        nombre:        nombre,
        telefono:      telefono,
        inmobiliaria:  inmobiliaria,
        zona:          zona,
        estado:        'activo',
        sessionToken:  sessionToken,
        creadoEn:      new Date().toISOString()
      };
      await setJSON('asesor:' + emailReg, asesor);
      await setString('asesor:session:' + sessionToken, emailReg, SESSION_TTL);

      // Índice global
      var todosIdx = await getJSON('asesores:todos') || [];
      if (todosIdx.indexOf(emailReg) === -1) {
        todosIdx.push(emailReg);
        await setJSON('asesores:todos', todosIdx);
      }

      await enviarEmailBienvenida(asesor);
      await enviarEmailAdminNuevoAsesor(asesor);

      return res.status(200).json({
        ok: true,
        sessionToken: sessionToken,
        nombre: nombre,
        mensaje: 'Listo. Ya sos Asesor MudateYa.'
      });
    }

    // ── REQUEST MAGIC LINK ────────────────────────────────────────
    if (action === 'request-magiclink' && req.method === 'POST') {
      var reqEmail = String((req.body||{}).email || '').trim().toLowerCase();
      if (!validEmail(reqEmail)) return res.status(400).json({ error: 'Email inválido' });
      var a = await getJSON('asesor:' + reqEmail);
      if (!a) {
        // No revelar si existe o no
        return res.status(200).json({ ok:true, mensaje:'Si el email está registrado, recibirás un link de acceso.' });
      }
      var mlToken = Math.random().toString(36).substring(2) + Date.now().toString(36);
      await setJSON('asesor:magiclink:' + mlToken, { email: reqEmail }, MAGIC_LINK_TTL);
      await enviarMagicLink(reqEmail, mlToken, a.nombre);
      return res.status(200).json({ ok:true, mensaje:'Si el email está registrado, recibirás un link de acceso.' });
    }

    // ── VERIFY MAGIC LINK ─────────────────────────────────────────
    if (action === 'verify-magiclink' && req.method === 'GET') {
      var vToken = String(req.query.token || '');
      if (!vToken) return res.status(400).json({ error: 'Falta token' });
      var ml = await getJSON('asesor:magiclink:' + vToken);
      if (!ml) return res.status(401).json({ error: 'Link inválido o expirado' });
      var asesorEmail = ml.email;
      var asesorObj = await getJSON('asesor:' + asesorEmail);
      if (!asesorObj) return res.status(404).json({ error: 'Asesor no encontrado' });
      var newSession = Math.random().toString(36).substring(2) + Date.now().toString(36) + Math.random().toString(36).substring(2);
      await setString('asesor:session:' + newSession, asesorEmail, SESSION_TTL);
      asesorObj.sessionToken = newSession;
      asesorObj.ultimoLogin = new Date().toISOString();
      await setJSON('asesor:' + asesorEmail, asesorObj);
      await delKey('asesor:magiclink:' + vToken);
      return res.status(200).json({ ok:true, sessionToken: newSession });
    }

    // ── PEDIDO-CLIENTE (vista pública del link que recibe el cliente) ──
    if (action === 'pedido-cliente' && req.method === 'GET') {
      var pcId = String(req.query.id || '').trim();
      if (!pcId) return res.status(400).json({ error: 'Falta id' });
      var pcPedido = await getJSON('pedido-asesor:' + pcId);
      if (!pcPedido) return res.status(404).json({ error: 'Pedido no encontrado o expirado' });
      var pcAsesor = await getJSON('asesor:' + pcPedido.asesorEmail);
      return res.status(200).json({
        ok: true,
        pedido: pcPedido,
        asesor: pcAsesor ? { nombre: pcAsesor.nombre, inmobiliaria: pcAsesor.inmobiliaria } : null
      });
    }

    // ══════════════════════════════════════════════════════════════
    // CON SESIÓN — Acciones del asesor logueado
    // ══════════════════════════════════════════════════════════════

    // ── PANEL (dashboard del asesor) ──────────────────────────────
    if (action === 'panel' && req.method === 'GET') {
      var pToken = String(req.query.token || '');
      var sess = await getAsesorDesdeToken(pToken);
      if (!sess) return res.status(401).json({ error: 'Sesión expirada' });

      // Historial de pedidos del asesor
      var pedidosIds = await getJSON('pedidos-asesor:' + sess.email) || [];
      var pedidos = [];
      for (var i = 0; i < pedidosIds.length; i++) {
        var ped = await getJSON('pedido-asesor:' + pedidosIds[i]);
        if (ped) pedidos.push(ped);
      }
      pedidos.sort(function(a, b) { return (b.creadoEn || '').localeCompare(a.creadoEn || ''); });

      // Stats básicas
      var stats = {
        pedidosCreados:   pedidos.length,
        clientesEnviados: pedidos.filter(function(p){ return p.estado === 'enviado' || p.estado === 'elegido' || p.estado === 'pagado'; }).length,
        clientesPagados:  pedidos.filter(function(p){ return p.estado === 'pagado'; }).length
      };

      return res.status(200).json({
        ok: true,
        asesor: {
          nombre:       sess.asesor.nombre,
          email:        sess.asesor.email,
          telefono:     sess.asesor.telefono,
          inmobiliaria: sess.asesor.inmobiliaria,
          zona:         sess.asesor.zona,
          estado:       sess.asesor.estado,
          creadoEn:     sess.asesor.creadoEn
        },
        stats: stats,
        pedidos: pedidos
      });
    }

    // ── UPDATE PROFILE ────────────────────────────────────────────
    if (action === 'update-profile' && req.method === 'POST') {
      var upToken = String((req.body||{}).token || '');
      var upSess = await getAsesorDesdeToken(upToken);
      if (!upSess) return res.status(401).json({ error: 'Sesión expirada' });
      var upBody = req.body || {};
      if (upBody.telefono)     upSess.asesor.telefono = String(upBody.telefono).trim();
      if (upBody.inmobiliaria) upSess.asesor.inmobiliaria = String(upBody.inmobiliaria).trim();
      if (upBody.zona)         upSess.asesor.zona = normZona(upBody.zona);
      await setJSON('asesor:' + upSess.email, upSess.asesor);
      return res.status(200).json({ ok:true });
    }

    // ── MUDANCEROS-ZONA (los pre-asignados por admin para esta zona) ──
    // Devuelve cada mudancera con sus 3 precios (esencial/integral/llave).
    // Por defecto usa amb2 (2 ambientes) — el dashboard llama a `mudanceros-todos`
    // con el tamaño elegido para el cálculo real.
    if (action === 'mudanceros-zona' && req.method === 'GET') {
      var mzToken = String(req.query.token || '');
      var mzSess = await getAsesorDesdeToken(mzToken);
      if (!mzSess) return res.status(401).json({ error: 'Sesión expirada' });

      var mzZona = normZona(req.query.zona || mzSess.asesor.zona);
      var mzEmails = await getJSON('asesor:mudanceros-zona:' + mzZona) || [];

      // Helper igual al de mudanceros-todos
      var parsePrecioZ = function(v){
        if (v === null || v === undefined || v === '') return 0;
        return parseInt(String(v).replace(/\./g, '').replace(/[^0-9]/g, ''), 10) || 0;
      };

      var mudanceras = [];
      for (var j = 0; j < mzEmails.length; j++) {
        var m = await getJSON('mudancero:perfil:' + mzEmails[j]);
        if (!m) continue;
        if (m.estado && m.estado !== 'aprobado') continue;

        // Modelo nuevo: precios por nivel × ambientes (uso amb2 por default acá)
        // Sin fallbacks: si el mudancero no cargó el precio en el form actual,
        // ese pack queda vacío.
        var pe = parsePrecioZ(m.preciosEsencial && m.preciosEsencial.amb2);
        var pi = parsePrecioZ(m.preciosIntegral && m.preciosIntegral.amb2);
        var pl = parsePrecioZ(m.preciosLlave    && m.preciosLlave.amb2);

        mudanceras.push({
          email:        m.email,
          nombre:       m.nombre,
          empresa:      m.empresa || m.nombre,
          foto:         m.foto || '',
          estrellas:    m.promedioEstrellas || 0,
          cantResenas:  (m.resenas || []).length,
          zonaBase:     m.zonaBase || '',
          preciosPack:  { esencial: pe, integral: pi, llave: pl }
        });
      }

      return res.status(200).json({
        ok: true,
        zona: mzZona,
        mudanceras: mudanceras,
        niveles: NIVELES,
        nivelesLabel: NIVELES_LABEL
      });
    }

    // ── MUDANCEROS-TODOS (TODAS las mudanceras aprobadas con precios pack) ──
    // Sin filtro de zona. Se usa mientras no tengamos suficiente cobertura
    // regional. Cuando haya más zonas, el frontend puede cambiar a mudanceros-zona.
    if (action === 'mudanceros-todos' && req.method === 'GET') {
      var mtToken = String(req.query.token || '');
      var mtSess = await getAsesorDesdeToken(mtToken);
      if (!mtSess) return res.status(401).json({ error: 'Sesión expirada' });

      // Mapear ambientes (número que pasa el frontend) a la clave del precio
      // 1 → amb1 · 2 → amb2 · 3 → amb3 · 4+ → amb4 (el modelo nuevo no tiene amb5plus)
      var ambN = parseInt(String(req.query.ambientes || '').replace(/\D/g, '')) || 0;
      var ambKey = 'amb2'; // fallback razonable: 2 ambientes
      if (ambN === 1)      ambKey = 'amb1';
      else if (ambN === 2) ambKey = 'amb2';
      else if (ambN === 3) ambKey = 'amb3';
      else if (ambN >= 4)  ambKey = 'amb4';

      // Helper: parsea un precio que puede venir como "300.000" (string AR) o número
      var parsePrecio = function(v){
        if (v === null || v === undefined || v === '') return 0;
        var s = String(v).replace(/\./g, '').replace(/[^0-9]/g, '');
        return parseInt(s, 10) || 0;
      };

      // ── Filtro por zona del pedido (permisivo: solo descarta si es claramente otra región) ──
      // Acepta origen y destino del pedido. Si vienen vacíos → no filtra.
      var origen  = String(req.query.origen  || '').toLowerCase();
      var destino = String(req.query.destino || '').toLowerCase();
      var textoZona = (origen + ' ' + destino).trim();
      // Normalizar: quitar acentos, signos, separar palabras
      function _normZ(s) {
        return (s||'').toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
          .replace(/[^a-z0-9\s]/g,' ')
          .replace(/\s+/g,' ').trim();
      }
      // Lista de regiones del país. Si la búsqueda coincide con una región distinta
      // a la del mudancero, lo descartamos. Si no podemos determinarla, dejamos pasar.
      // NOTA: cuidado con palabras ambiguas. Ej: "capital" puede ser CABA o Mendoza Capital.
      // Por eso solo incluimos términos específicos en cada región.
      var REGIONES = {
        amba:    ['caba','autonoma','palermo','belgrano','caballito','flores','almagro','boedo','balvanera','recoleta','retiro','barracas','mataderos','liniers','devoto','urquiza','colegiales','nunez','saavedra','olivos','vicente','lopez','isidro','tigre','pilar','escobar','quilmes','lanus','avellaneda','moron','ituzaingo','merlo','ramos','mejia','floresta','crespo','microcentro','zarate','campana','hurlingham','lomas','zamora','varela','solano','beccar','martinez','acassuso','munro','florida','gba','vte','vlopez','lvp','telmo'],
        rosario: ['rosario','funes','venado','tuerto'],
        cordoba: ['cordoba','cba'],
        mendoza: ['mendoza','godoy','lujan','cuyo','chacras','coria'],
        tucuman: ['tucuman','smt'],
        salta:   ['salta','jujuy','noa']
      };
      function detectarRegion(palabras) {
        var matches = {};
        for (var rg in REGIONES) {
          var keys = REGIONES[rg];
          for (var pi = 0; pi < palabras.length; pi++) {
            if (keys.indexOf(palabras[pi]) !== -1) {
              matches[rg] = (matches[rg] || 0) + 1;
            }
          }
        }
        // Devolver la región con más matches, o null si no hay
        var top = null, maxN = 0;
        for (var k in matches) {
          if (matches[k] > maxN) { maxN = matches[k]; top = k; }
        }
        return top;
      }
      var palabrasPedido = _normZ(textoZona).split(/\s+/).filter(function(p){ return p.length > 2; });
      var regionPedido = detectarRegion(palabrasPedido);

      function cubreZona(perfil) {
        // Sin zona en el pedido → no filtramos
        if (!textoZona || palabrasPedido.length === 0) return true;
        var palabrasPerfil = _normZ((perfil.zonaBase || '') + ' ' + (perfil.zonasExtra || '')).split(/\s+/).filter(function(p){ return p.length > 2; });
        var regionPerfil = detectarRegion(palabrasPerfil);
        // Si no podemos determinar región del perfil (ej. perfil sin zona cargada), dejamos pasar
        if (!regionPerfil) return true;
        // Si no podemos determinar región del pedido, dejamos pasar
        if (!regionPedido) return true;
        // Solo descartamos si las regiones son distintas y ambas conocidas
        return regionPerfil === regionPedido;
      }

      // Usamos el índice global de mudanceros del sistema
      var mtTodosEmails = await getJSON('mudanceros:todos') || [];
      var mtMudanceras = [];
      for (var mi = 0; mi < mtTodosEmails.length; mi++) {
        var mt = await getJSON('mudancero:perfil:' + mtTodosEmails[mi]);
        if (!mt) continue;
        if (mt.estado && mt.estado !== 'aprobado') continue;
        // Filtro por zona del pedido
        if (!cubreZona(mt)) continue;

        // ── Modelo nuevo (único que carga el mudancero hoy en su perfil): ──
        // mt.preciosEsencial = { amb1, amb2, amb3, amb4 } (strings/números)
        // mt.preciosIntegral = { amb1, amb2, amb3, amb4 }
        // mt.preciosLlave    = { amb1, amb2, amb3, amb4 }
        // NO usamos fallbacks (preciosLeads, preciosPack) — si el mudancero no
        // cargó el precio en el modelo nuevo, ese pack queda vacío y no aparece.
        var mtEsc = parsePrecio(mt.preciosEsencial && mt.preciosEsencial[ambKey]);
        var mtInt = parsePrecio(mt.preciosIntegral && mt.preciosIntegral[ambKey]);
        var mtLla = parsePrecio(mt.preciosLlave    && mt.preciosLlave[ambKey]);

        // Filtramos las que no tienen ningún precio cargado para este tamaño
        if (mtEsc === 0 && mtInt === 0 && mtLla === 0) continue;

        mtMudanceras.push({
          email:       mt.email,
          nombre:      mt.nombre,
          empresa:     mt.empresa || mt.nombre,
          foto:        mt.foto || '',
          estrellas:   mt.promedioEstrellas || 0,
          cantResenas: (mt.resenas || []).length,
          zonaBase:    mt.zonaBase || '',
          preciosPack: { esencial: mtEsc, integral: mtInt, llave: mtLla }
        });
      }

      return res.status(200).json({
        ok: true,
        ambientes: ambN || null,
        ambientesUsado: ambKey,
        zonaFiltro: textoZona || null,
        mudanceras: mtMudanceras,
        niveles: NIVELES,
        nivelesLabel: NIVELES_LABEL
      });
    }

    // ── CREAR-PEDIDO (asesor guarda los 3 packs + datos del cliente y mudanza) ──
    if (action === 'crear-pedido' && req.method === 'POST') {
      var cpBody = req.body || {};
      var cpSess = await getAsesorDesdeToken(String(cpBody.token || ''));
      if (!cpSess) return res.status(401).json({ error: 'Sesión expirada' });

      var cliente = cpBody.cliente || {};
      var mudanza = cpBody.mudanza || {};
      var packs   = cpBody.packs   || [];

      if (!cliente.nombre || !validEmail(cliente.email)) {
        return res.status(400).json({ error: 'Datos del cliente incompletos (nombre + email válido)' });
      }
      if (!cliente.telefono || normFono(cliente.telefono).length < 8) {
        return res.status(400).json({ error: 'Teléfono del cliente inválido' });
      }
      if (!mudanza.origen || !mudanza.destino || !mudanza.fecha) {
        return res.status(400).json({ error: 'Datos de la mudanza incompletos (origen, destino, fecha)' });
      }
      if (!Array.isArray(packs) || packs.length < 1 || packs.length > 3) {
        return res.status(400).json({ error: 'Tenés que elegir entre 1 y 3 packs.' });
      }

      // Validar niveles: cada uno debe ser válido y no puede haber duplicados
      var nivelesPresentes = packs.map(function(p){ return p.nivel; });
      var nivelesUnicos = {};
      for (var ni = 0; ni < nivelesPresentes.length; ni++) {
        var nv = nivelesPresentes[ni];
        if (NIVELES.indexOf(nv) === -1) {
          return res.status(400).json({ error: 'Nivel inválido: ' + nv });
        }
        if (nivelesUnicos[nv]) {
          return res.status(400).json({ error: 'No podés elegir el mismo nivel dos veces' });
        }
        nivelesUnicos[nv] = true;
      }

      // Rehidratar cada pack desde Redis (nunca confiar en el precio que viene del cliente)
      // Mapeo de ambientes (del pedido) a la clave del precio del mudancero
      var ambNumPedido = parseInt(String(mudanza.ambientes || '').replace(/\D/g, '')) || 2;
      var ambKey = 'amb2';
      if (ambNumPedido === 1)      ambKey = 'amb1';
      else if (ambNumPedido === 2) ambKey = 'amb2';
      else if (ambNumPedido === 3) ambKey = 'amb3';
      else if (ambNumPedido >= 4)  ambKey = 'amb4';
      // Helper local para parsear precios en formato AR ("300.000")
      var _pp = function(v){
        if (v === null || v === undefined || v === '') return 0;
        return parseInt(String(v).replace(/\./g,'').replace(/[^0-9]/g,''),10) || 0;
      };

      var packsValidos = [];
      for (var k = 0; k < packs.length; k++) {
        var pk = packs[k];
        if (!pk.mudanceroEmail || NIVELES.indexOf(pk.nivel) === -1) {
          return res.status(400).json({ error: 'Pack inválido' });
        }
        var mp = await getJSON('mudancero:perfil:' + pk.mudanceroEmail);
        if (!mp) return res.status(400).json({ error: 'Mudancera no encontrada: ' + pk.mudanceroEmail });

        // Modelo nuevo (lo que carga el mudancero hoy): preciosEsencial/Integral/Llave[ambKey]
        var precioReal = 0;
        if (pk.nivel === 'esencial') precioReal = _pp(mp.preciosEsencial && mp.preciosEsencial[ambKey]);
        else if (pk.nivel === 'integral') precioReal = _pp(mp.preciosIntegral && mp.preciosIntegral[ambKey]);
        else if (pk.nivel === 'llave')    precioReal = _pp(mp.preciosLlave    && mp.preciosLlave[ambKey]);

        if (!precioReal || precioReal <= 0) {
          return res.status(400).json({ error: 'La mudancera ' + mp.nombre + ' no tiene precio cargado para ' + NIVELES_LABEL[pk.nivel] + ' (' + ambNumPedido + ' amb)' });
        }
        packsValidos.push({
          nivel:            pk.nivel,
          mudanceroEmail:   mp.email,
          mudanceroNombre:  mp.nombre,
          empresa:          mp.empresa || mp.nombre,
          foto:             mp.foto || '',
          estrellas:        mp.promedioEstrellas || 0,
          cantResenas:      (mp.resenas || []).length,
          precio:           precioReal
        });
      }

      var pedidoId = 'PED-ASR-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();
      var pedido = {
        id:          pedidoId,
        asesorEmail: cpSess.email,
        cliente: {
          nombre:   String(cliente.nombre).trim(),
          email:    String(cliente.email).trim().toLowerCase(),
          telefono: String(cliente.telefono).trim()
        },
        mudanza: {
          origen:    String(mudanza.origen).trim(),
          destino:   String(mudanza.destino).trim(),
          fecha:     String(mudanza.fecha).trim(),
          ambientes: String(mudanza.ambientes || '').trim(),
          tipo:      mudanza.tipo === 'flete' ? 'flete' : 'mudanza',
          notas:     String(mudanza.notas || '').trim()
        },
        packs:    packsValidos,
        estado:   'borrador', // borrador → enviado → elegido → pagado
        creadoEn: new Date().toISOString()
      };

      await setJSON('pedido-asesor:' + pedidoId, pedido, PEDIDO_TTL);

      // Índice por asesor
      var listaAsesor = await getJSON('pedidos-asesor:' + cpSess.email) || [];
      listaAsesor.unshift(pedidoId);
      await setJSON('pedidos-asesor:' + cpSess.email, listaAsesor);

      // Notificar al admin
      try { await enviarEmailAdminNuevoPedido(pedido, cpSess.asesor); } catch(e) { console.warn('Email admin nuevo pedido:', e.message); }

      return res.status(200).json({ ok:true, pedidoId: pedidoId, pedido: pedido });
    }

    // ── ENVIAR-CLIENTE (dispara email + arma texto WhatsApp) ──────
    if (action === 'enviar-cliente' && req.method === 'POST') {
      var ecBody = req.body || {};
      var ecSess = await getAsesorDesdeToken(String(ecBody.token || ''));
      if (!ecSess) return res.status(401).json({ error: 'Sesión expirada' });

      var ecPedidoId = String(ecBody.pedidoId || '').trim();
      if (!ecPedidoId) return res.status(400).json({ error: 'Falta pedidoId' });

      var ecPedido = await getJSON('pedido-asesor:' + ecPedidoId);
      if (!ecPedido) return res.status(404).json({ error: 'Pedido no encontrado' });
      if (ecPedido.asesorEmail !== ecSess.email) {
        return res.status(403).json({ error: 'Este pedido no es tuyo' });
      }

      // Enviar email al cliente
      var okEmail = await enviarEmailClientePacks(ecPedido, ecSess.asesor);

      // Actualizar estado a "enviado"
      ecPedido.estado   = 'enviado';
      ecPedido.enviadoEn = new Date().toISOString();
      await setJSON('pedido-asesor:' + ecPedidoId, ecPedido, PEDIDO_TTL);

      // Texto WhatsApp pre-armado para que el asesor copie
      var link = 'https://mudateya.ar/cliente-packs?id=' + ecPedidoId;
      var ecCantPacks = (ecPedido.packs || []).length;
      var ecTextoOpciones = ecCantPacks === 1 ? 'una opción' : (ecCantPacks + ' opciones');
      var ecTextoElegi = ecCantPacks === 1 ? 'Mirá los detalles acá:' : 'Elegí la que más te convenga acá:';
      var waText =
        'Hola ' + ecPedido.cliente.nombre + '! 👋\n\n' +
        'Te preparé ' + ecTextoOpciones + ' de mudanza con empresas verificadas de MudateYa para tu mudanza a ' + ecPedido.mudanza.destino + '.\n\n' +
        ecTextoElegi + '\n' + link + '\n\n' +
        'Cualquier duda me avisás.\n' +
        ecSess.asesor.nombre + (ecSess.asesor.inmobiliaria ? ' · ' + ecSess.asesor.inmobiliaria : '');
      var waLink = 'https://wa.me/' + normFono(ecPedido.cliente.telefono) + '?text=' + encodeURIComponent(waText);

      return res.status(200).json({
        ok: true,
        email: okEmail,
        emailError: !okEmail ? 'No se pudo enviar el email al cliente. Compartí el link por WhatsApp.' : null,
        waLink: waLink,
        waText: waText,
        clienteUrl: link
      });
    }

    // ── CLIENTE-ELEGIR-PACK (el cliente elige un pack y arranca el pago) ──
    // Flujo: convierte el pedido-asesor en una mudanza "normal" con cotización
    // ya aceptada, genera link de MP y devuelve URL para redirigir al cliente.
    if (action === 'cliente-elegir-pack' && req.method === 'POST') {
      var cepBody = req.body || {};
      var cepPedidoId = String(cepBody.pedidoId || '').trim();
      var cepNivel    = String(cepBody.nivel || '').trim();
      if (!cepPedidoId)                       return res.status(400).json({ error: 'Falta pedidoId' });
      if (NIVELES.indexOf(cepNivel) === -1)   return res.status(400).json({ error: 'Nivel inválido' });

      var cepPedido = await getJSON('pedido-asesor:' + cepPedidoId);
      if (!cepPedido) return res.status(404).json({ error: 'Pedido no encontrado o expirado' });

      // Si ya eligió antes y ya se creó mudanza, devolvemos la que existe
      if (cepPedido.mudanzaId) {
        var existente = await getJSON('mudanza:' + cepPedido.mudanzaId);
        if (existente && existente.linkPagoAnticipo) {
          return res.status(200).json({
            ok: true,
            yaElegido: true,
            mudanzaId: cepPedido.mudanzaId,
            linkPago:  existente.linkPagoAnticipo,
            nivel:     cepPedido.nivelElegido
          });
        }
      }

      // Buscar el pack elegido
      var packElegido = null;
      for (var pi = 0; pi < cepPedido.packs.length; pi++) {
        if (cepPedido.packs[pi].nivel === cepNivel) { packElegido = cepPedido.packs[pi]; break; }
      }
      if (!packElegido) return res.status(400).json({ error: 'Este pedido no tiene pack ' + cepNivel });

      // Volver a leer la mudancera para asegurarnos que sigue aprobada
      var mp = await getJSON('mudancero:perfil:' + packElegido.mudanceroEmail);
      if (!mp) return res.status(400).json({ error: 'La mudancera ya no está disponible' });

      // ── CREAR MUDANZA "NORMAL" ──
      var mudanzaId = 'MYA-' + Date.now();
      var cotizacionId = 'COT-' + Date.now();
      var cot = {
        id:              cotizacionId,
        mudanzaId:       mudanzaId,
        mudanceroEmail:  mp.email,
        mudanceroNombre: mp.nombre,
        mudanceroTel:    mp.telefono || '',
        precio:          Number(packElegido.precio),
        nota:            'Pack ' + (NIVELES_LABEL[cepNivel] || cepNivel) + ' · armado por asesor ' + (cepPedido.asesorEmail || ''),
        tiempoEstimado: '',
        fecha:           new Date().toISOString(),
        estado:          'aceptada',
        // Marca para trazabilidad
        origenAsesor:    true,
        asesorEmail:     cepPedido.asesorEmail,
        nivelPack:       cepNivel,
        pedidoAsesorId:  cepPedidoId
      };

      var mudanza = {
        id:                mudanzaId,
        clienteEmail:      cepPedido.cliente.email,
        clienteNombre:     cepPedido.cliente.nombre,
        clienteWA:         cepPedido.cliente.telefono || '',
        desde:             cepPedido.mudanza.origen,
        hasta:             cepPedido.mudanza.destino,
        ambientes:         cepPedido.mudanza.ambientes || '',
        fecha:             cepPedido.mudanza.fecha,
        servicios:         [],
        extras:            [],
        zonaBase:          mp.zonaBase || '',
        precio_estimado:   Number(packElegido.precio),
        tipo:              cepPedido.mudanza.tipo || 'mudanza',
        pisoOrigen:        '',
        pisoDestino:       '',
        ascOrigen:         '',
        ascDestino:        '',
        fotos:             [],
        estado:            'cotizacion_aceptada',
        modoCotizacion:    'dirigido',
        maxCotizaciones:   1,
        mudancerosInvitados: [mp.email],
        fechaPublicacion:  new Date().toISOString(),
        expira:            new Date(Date.now() + 30*24*60*60*1000).toISOString(),
        cotizaciones:      [cot],
        cotizacionAceptada: Object.assign({}, cot, {
          clienteNombre: cepPedido.cliente.nombre,
          clienteEmail:  cepPedido.cliente.email
        }),
        mudanceroAceptado: mp.email,
        montoTotal:        Number(packElegido.precio),
        // Marcas de trazabilidad
        origenAsesor:      true,
        asesorEmail:       cepPedido.asesorEmail,
        nivelPack:         cepNivel,
        pedidoAsesorId:    cepPedidoId,
        notasCliente:      cepPedido.mudanza.notas || ''
      };

      // ── GENERAR LINK DE PAGO DEL ANTICIPO (50%) ──
      var siteUrl = process.env.SITE_URL || 'https://mudateya.ar';
      var linkPago = siteUrl + '/mi-mudanza';
      try {
        var mpLib = require('mercadopago');
        var client = new mpLib.MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
        var preference = new mpLib.Preference(client);
        var anticipo = Math.round(Number(packElegido.precio) * 0.5);
        var result = await preference.create({ body: {
          items: [{
            id:          mudanzaId + '-' + cotizacionId + '-anticipo',
            title:       'MudateYa — Anticipo (50%) · ' + mp.nombre,
            description: cepPedido.mudanza.origen + ' → ' + cepPedido.mudanza.destino,
            quantity:    1,
            unit_price:  anticipo,
            currency_id: 'ARS'
          }],
          back_urls: {
            success: siteUrl + '/pago-exitoso?mudanzaId=' + mudanzaId + '&cotizacionId=' + cotizacionId + '&monto=' + anticipo + '&mudancero=' + encodeURIComponent(mp.nombre) + '&tipoPago=anticipo',
            failure: siteUrl + '/cliente-packs?id=' + cepPedidoId + '&pago=error',
            pending: siteUrl + '/cliente-packs?id=' + cepPedidoId + '&pago=pendiente'
          },
          auto_return:          'approved',
          statement_descriptor: 'MUDATEYA',
          external_reference:   mudanzaId + '-' + cotizacionId,
          notification_url:     siteUrl + '/api/webhook-mp',
          metadata:             { mudanzaId: mudanzaId, cotizacionId: cotizacionId, tipoPago: 'anticipo', pedidoAsesorId: cepPedidoId }
        }});
        linkPago = result.init_point || result.initPoint || linkPago;
      } catch(mpErr) {
        console.error('Error generando link MP (asesor):', mpErr.message);
      }
      mudanza.linkPagoAnticipo = linkPago;

      // ── PERSISTIR TODO (imitando lo que hace 'publicar') ──
      await setJSON('mudanza:' + mudanzaId, mudanza, 60 * 60 * 24 * 30); // 30 días

      // Índice del cliente
      var clienteIdx = await getJSON('cliente:' + cepPedido.cliente.email) || [];
      if (clienteIdx.indexOf(mudanzaId) === -1) clienteIdx.push(mudanzaId);
      await setJSON('cliente:' + cepPedido.cliente.email, clienteIdx, 60 * 60 * 24 * 30);

      // Perfil del cliente (lo creamos si no existe)
      var clientePerfil = await getJSON('cliente:perfil:' + cepPedido.cliente.email) || {
        email:         cepPedido.cliente.email,
        nombre:        cepPedido.cliente.nombre,
        wa:            cepPedido.cliente.telefono,
        fechaRegistro: new Date().toISOString(),
        mudanzas:      0,
        estado:        'activo',
        origenAsesor:  true,
        asesorEmail:   cepPedido.asesorEmail
      };
      clientePerfil.nombre   = cepPedido.cliente.nombre || clientePerfil.nombre;
      clientePerfil.wa       = cepPedido.cliente.telefono || clientePerfil.wa;
      clientePerfil.mudanzas = (clientePerfil.mudanzas || 0) + 1;
      clientePerfil.ultimaActividad = new Date().toISOString();
      await setJSON('cliente:perfil:' + cepPedido.cliente.email, clientePerfil);

      var clientesTodos = await getJSON('clientes:todos') || [];
      if (clientesTodos.indexOf(cepPedido.cliente.email) === -1) {
        clientesTodos.push(cepPedido.cliente.email);
        await setJSON('clientes:todos', clientesTodos);
      }

      // Índices globales
      var globalIdx = await getJSON('mudanzas:activas') || [];
      if (globalIdx.indexOf(mudanzaId) === -1) globalIdx.push(mudanzaId);
      await setJSON('mudanzas:activas', globalIdx, 604800);

      var todosIdx = await getJSON('mudanzas:todos') || [];
      if (todosIdx.indexOf(mudanzaId) === -1) todosIdx.push(mudanzaId);
      await setJSON('mudanzas:todos', todosIdx);

      // Índice del mudancero
      var mudIdx = await getJSON('mudancero:' + mp.email) || [];
      if (mudIdx.indexOf(mudanzaId) === -1) mudIdx.push(mudanzaId);
      await setJSON('mudancero:' + mp.email, mudIdx, 2592000);

      // ── ACTUALIZAR PEDIDO-ASESOR ──
      cepPedido.estado         = 'elegido';
      cepPedido.nivelElegido   = cepNivel;
      cepPedido.mudanzaId      = mudanzaId;
      cepPedido.elegidoEn      = new Date().toISOString();
      await setJSON('pedido-asesor:' + cepPedidoId, cepPedido, PEDIDO_TTL);

      // ── AVISAR AL MUDANCERO + ASESOR ──
      try { await enviarEmailMudanceroPedidoAsesor(mudanza, cot, mp); } catch(e) { console.warn('Email mudancero asesor:', e.message); }
      try { await enviarEmailAsesorClienteEligio(cepPedido, cepNivel, mp); } catch(e) { console.warn('Email asesor cliente eligió:', e.message); }

      return res.status(200).json({
        ok: true,
        mudanzaId: mudanzaId,
        linkPago:  linkPago,
        nivel:     cepNivel
      });
    }

    // ── INTERNAL-MARCAR-PAGADO (llamado desde cotizaciones.js vía hook) ──
    if (action === 'internal-marcar-pagado' && req.method === 'POST') {
      var intSecret = req.headers['x-internal-secret'];
      if (intSecret !== process.env.INTERNAL_API_SECRET) {
        return res.status(401).json({ error: 'No autorizado' });
      }
      var impBody = req.body || {};
      var impPedidoId = String(impBody.pedidoAsesorId || '').trim();
      var impTipoPago = String(impBody.tipoPago || 'anticipo').trim();
      if (!impPedidoId) return res.status(400).json({ error: 'Falta pedidoAsesorId' });

      var impPedido = await getJSON('pedido-asesor:' + impPedidoId);
      if (!impPedido) return res.status(200).json({ ok: true, noop: true }); // no existir no es error

      // Solo actualizamos si avanza el estado
      if (impTipoPago === 'anticipo' && impPedido.estado !== 'pagado') {
        impPedido.estado = 'pagado';
        impPedido.anticipoPagadoEn = new Date().toISOString();
      } else if (impTipoPago === 'saldo') {
        impPedido.estado = 'completado';
        impPedido.completadoEn = new Date().toISOString();
      }
      await setJSON('pedido-asesor:' + impPedidoId, impPedido, PEDIDO_TTL);
      return res.status(200).json({ ok: true, estado: impPedido.estado });
    }

    // ── INTERNAL: marcar pedido-asesor como cancelado (cliente eliminó la mudanza) ──
    // Llamado desde cotizaciones.js cuando el cliente borra una mudanza del Plan Referidos.
    // Cambia el estado del pedido a 'cancelado' y notifica al asesor (push + email).
    if (action === 'internal-marcar-cancelado' && req.method === 'POST') {
      var icSecret = req.headers['x-internal-secret'];
      if (icSecret !== process.env.INTERNAL_API_SECRET) {
        return res.status(401).json({ error: 'No autorizado' });
      }
      var icBody = req.body || {};
      var icPedidoId = String(icBody.pedidoAsesorId || '').trim();
      if (!icPedidoId) return res.status(400).json({ error: 'Falta pedidoAsesorId' });

      var icPedido = await getJSON('pedido-asesor:' + icPedidoId);
      if (!icPedido) return res.status(200).json({ ok: true, noop: true });

      // No reescribir si ya está cancelado
      if (icPedido.estado === 'cancelado') {
        return res.status(200).json({ ok: true, noop: true });
      }
      // No marcar como cancelado si ya está pagado o completado (raro pero posible si se elimina mudanza ya pagada)
      if (icPedido.estado === 'pagado' || icPedido.estado === 'completado') {
        return res.status(200).json({ ok: true, noop: true, motivo: 'estado ' + icPedido.estado + ' no se cancela' });
      }

      icPedido.estado = 'cancelado';
      icPedido.canceladoEn = new Date().toISOString();
      await setJSON('pedido-asesor:' + icPedidoId, icPedido, PEDIDO_TTL);

      // ── Notificar al asesor: push + email ───────────────────────────
      try {
        var clienteNombre = (icPedido.cliente && icPedido.cliente.nombre) || 'el cliente';
        var destino = (icPedido.mudanza && icPedido.mudanza.destino) || '';
        var rutaTxt = destino ? destino.split(',')[0] : 'mudanza';

        // Push (silencioso si no tiene suscripción activa)
        enviarPush(icPedido.asesorEmail, {
          titulo: '❌ Cliente canceló mudanza',
          cuerpo: clienteNombre + ' canceló: ' + rutaTxt,
          link: '/asesor-dashboard'
        }).catch(function(e){ console.warn('Push asesor cancelación error:', e && e.message); });

        // Email
        if (process.env.RESEND_API_KEY && icPedido.asesorEmail) {
          var icResend = new Resend(process.env.RESEND_API_KEY);
          var icAsesor = await getJSON('asesor:' + icPedido.asesorEmail);
          var icAsesorNombre = (icAsesor && icAsesor.nombre) ? icAsesor.nombre.split(' ')[0] : 'Asesor';
          icResend.emails.send({
            from: 'MudateYa <noreply@mudateya.ar>',
            to: icPedido.asesorEmail,
            subject: '❌ ' + clienteNombre + ' canceló su mudanza',
            html:
              '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;background:#F5F7FA;padding:20px">' +
                '<div style="background:#003580;padding:18px 24px;border-radius:8px 8px 0 0">' +
                  '<span style="font-family:Georgia,serif;font-size:18px;font-weight:900;color:#fff">Mudate</span>' +
                  '<span style="font-family:Georgia,serif;font-size:18px;font-weight:900;color:#22C36A">Ya</span>' +
                '</div>' +
                '<div style="background:#fff;padding:24px;border-radius:0 0 8px 8px">' +
                  '<h2 style="color:#0F1923;font-size:18px;margin:0 0 12px">Hola ' + esc(icAsesorNombre) + ',</h2>' +
                  '<p style="color:#374151;font-size:14px;line-height:1.6"><b>' + esc(clienteNombre) + '</b> canceló la mudanza que le habías presupuestado.</p>' +
                  (rutaTxt ? '<div style="background:#FEE2E2;border-left:4px solid #DC2626;padding:12px 14px;border-radius:6px;margin:16px 0;font-size:14px;color:#7F1D1D">' +
                    '<b>' + esc(rutaTxt) + '</b>' +
                  '</div>' : '') +
                  '<p style="color:#374151;font-size:13px;line-height:1.6">El pedido pasó al estado <b>Cancelado</b> en tu panel. Si querés, podés contactarlo para entender el motivo y ofrecerle otra alternativa.</p>' +
                  '<div style="text-align:center;margin:24px 0">' +
                    '<a href="https://mudateya.ar/asesor-dashboard" style="display:inline-block;padding:12px 28px;background:#003580;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px">Ir al panel →</a>' +
                  '</div>' +
                  '<p style="color:#64748B;font-size:12px;margin-top:18px">Si tenés dudas, respondé este mail.</p>' +
                '</div>' +
              '</div>'
          }).catch(function(e){ console.warn('Email asesor cancelación error:', e.message); });
        }
      } catch(e) { console.warn('Notificación asesor cancelación:', e.message); }

      return res.status(200).json({ ok: true, estado: 'cancelado' });
    }



    // ── ELIMINAR-PEDIDO (solo borradores, solo el asesor dueño) ──────
    if (action === 'eliminar-pedido' && req.method === 'POST') {
      var epBody = req.body || {};
      var epSess = await getAsesorDesdeToken(String(epBody.token || ''));
      if (!epSess) return res.status(401).json({ error: 'Sesión expirada' });
      var epPedidoId = String(epBody.pedidoId || '').trim();
      if (!epPedidoId) return res.status(400).json({ error: 'Falta pedidoId' });
      var epPedido = await getJSON('pedido-asesor:' + epPedidoId);
      if (!epPedido) return res.status(404).json({ error: 'Pedido no encontrado' });
      if (epPedido.asesorEmail !== epSess.email) {
        return res.status(403).json({ error: 'Este pedido no es tuyo' });
      }
      if (epPedido.estado !== 'borrador') {
        return res.status(400).json({ error: 'Solo se pueden eliminar pedidos en borrador. Este ya fue ' + epPedido.estado + '.' });
      }
      // Borrar el pedido
      await delKey('pedido-asesor:' + epPedidoId);
      // Sacarlo del índice del asesor
      var epLista = await getJSON('pedidos-asesor:' + epSess.email) || [];
      var epNueva = epLista.filter(function(id){ return id !== epPedidoId; });
      await setJSON('pedidos-asesor:' + epSess.email, epNueva);
      return res.status(200).json({ ok: true });
    }

    // ══════════════════════════════════════════════════════════════
    // ADMIN — Requiere x-admin-token
    // ══════════════════════════════════════════════════════════════

    function checkAdmin(tok) {
      return tok === process.env.ADMIN_TOKEN || tok === ADMIN_FALLBACK;
    }

    // ── ADMIN-LIST: todos los asesores ────────────────────────────
    if (action === 'admin-list' && req.method === 'GET') {
      var admToken1 = req.query.token || req.headers['x-admin-token'];
      if (!checkAdmin(admToken1)) return res.status(401).json({ error: 'No autorizado' });
      var emails = await getJSON('asesores:todos') || [];
      var lista = [];
      for (var a = 0; a < emails.length; a++) {
        var asr = await getJSON('asesor:' + emails[a]);
        if (!asr) continue;
        var pedIds = await getJSON('pedidos-asesor:' + emails[a]) || [];
        lista.push({
          email:        asr.email,
          nombre:       asr.nombre,
          telefono:     asr.telefono,
          inmobiliaria: asr.inmobiliaria,
          zona:         asr.zona,
          estado:       asr.estado,
          creadoEn:     asr.creadoEn,
          ultimoLogin:  asr.ultimoLogin || null,
          cantPedidos:  pedIds.length
        });
      }
      lista.sort(function(a, b){ return (b.creadoEn || '').localeCompare(a.creadoEn || ''); });
      return res.status(200).json({ ok:true, asesores: lista });
    }

    // ── ADMIN-CAMBIAR-ESTADO ──────────────────────────────────────
    if (action === 'admin-cambiar-estado' && req.method === 'POST') {
      var admToken2 = req.headers['x-admin-token'];
      if (!checkAdmin(admToken2)) return res.status(401).json({ error: 'No autorizado' });
      var aceBody = req.body || {};
      var aceEmail = String(aceBody.email || '').trim().toLowerCase();
      var aceEstado = String(aceBody.estado || '').trim();
      if (['activo','suspendido','bloqueado'].indexOf(aceEstado) === -1) {
        return res.status(400).json({ error: 'Estado inválido' });
      }
      var aceAsr = await getJSON('asesor:' + aceEmail);
      if (!aceAsr) return res.status(404).json({ error: 'No encontrado' });
      aceAsr.estado = aceEstado;
      await setJSON('asesor:' + aceEmail, aceAsr);
      return res.status(200).json({ ok:true });
    }

    // ── ADMIN-MUDANCEROS-ZONA (GET): ver qué mudanceras asignadas tiene una zona ──
    if (action === 'admin-mudanceros-zona' && req.method === 'GET') {
      var admToken3 = req.query.token || req.headers['x-admin-token'];
      if (!checkAdmin(admToken3)) return res.status(401).json({ error: 'No autorizado' });
      var amzZona = normZona(req.query.zona || '');
      if (!amzZona) return res.status(400).json({ error: 'Falta zona' });
      var amzEmails = await getJSON('asesor:mudanceros-zona:' + amzZona) || [];
      var amzData = [];
      for (var z = 0; z < amzEmails.length; z++) {
        var amzM = await getJSON('mudancero:perfil:' + amzEmails[z]);
        if (!amzM) continue;
        amzData.push({
          email:       amzM.email,
          nombre:      amzM.nombre,
          empresa:     amzM.empresa || amzM.nombre,
          estado:      amzM.estado,
          preciosPack: amzM.preciosPack || { esencial:0, integral:0, llave:0 }
        });
      }
      return res.status(200).json({ ok:true, zona: amzZona, mudanceras: amzData });
    }

    // ── ADMIN-ASIGNAR-ZONA: setear lista de mudanceras por zona ────
    if (action === 'admin-asignar-zona' && req.method === 'POST') {
      var admToken4 = req.headers['x-admin-token'];
      if (!checkAdmin(admToken4)) return res.status(401).json({ error: 'No autorizado' });
      var azBody = req.body || {};
      var azZona = normZona(azBody.zona);
      var azEmails = Array.isArray(azBody.emails) ? azBody.emails : [];
      if (!azZona) return res.status(400).json({ error: 'Falta zona' });
      // Validar que cada email corresponda a una mudancera existente
      var limpios = [];
      for (var y = 0; y < azEmails.length; y++) {
        var em = String(azEmails[y]||'').trim().toLowerCase();
        if (!em) continue;
        var mVal = await getJSON('mudancero:perfil:' + em);
        if (!mVal) continue;
        if (limpios.indexOf(em) === -1) limpios.push(em);
      }
      await setJSON('asesor:mudanceros-zona:' + azZona, limpios);
      // Índice de zonas con asignación (para UI admin)
      var zonasIdx = await getJSON('asesor:zonas-asignadas') || [];
      if (limpios.length > 0 && zonasIdx.indexOf(azZona) === -1) {
        zonasIdx.push(azZona);
        await setJSON('asesor:zonas-asignadas', zonasIdx);
      }
      return res.status(200).json({ ok:true, zona: azZona, cantidad: limpios.length, emails: limpios });
    }

    // ── ADMIN-LISTAR-ZONAS: todas las zonas con asignación ────────
    if (action === 'admin-listar-zonas' && req.method === 'GET') {
      var admToken5 = req.query.token || req.headers['x-admin-token'];
      if (!checkAdmin(admToken5)) return res.status(401).json({ error: 'No autorizado' });
      var zonasAsig = await getJSON('asesor:zonas-asignadas') || [];
      return res.status(200).json({ ok:true, zonas: zonasAsig, zonasValidas: ZONAS_VALIDAS });
    }

    // ── ADMIN-MIGRAR-ZONAS-AMBA (one-shot): unifica CABA + 3 GBA en AMBA ──
    // Mergea asignaciones Redis viejas a la nueva clave AMBA sin duplicar,
    // y actualiza la zona de los asesores existentes que tenían subzona vieja.
    if (action === 'admin-migrar-zonas-amba' && req.method === 'POST') {
      var admTokenMg = req.body.token || req.headers['x-admin-token'];
      if (!checkAdmin(admTokenMg)) return res.status(401).json({ error: 'No autorizado' });

      var ZONAS_VIEJAS = ['CABA', 'Zona Norte GBA', 'Zona Oeste GBA', 'Zona Sur GBA'];
      var ambaEmails = await getJSON('asesor:mudanceros-zona:AMBA') || [];
      var ambaSet = {};
      for (var zi = 0; zi < ambaEmails.length; zi++) ambaSet[ambaEmails[zi]] = true;

      // 1. Mergear mudanceras de cada zona vieja en AMBA
      var mergeados = 0;
      for (var zv = 0; zv < ZONAS_VIEJAS.length; zv++) {
        var zVieja = ZONAS_VIEJAS[zv];
        var emailsVieja = await getJSON('asesor:mudanceros-zona:' + zVieja) || [];
        for (var em = 0; em < emailsVieja.length; em++) {
          var mail = emailsVieja[em];
          if (!ambaSet[mail]) {
            ambaSet[mail] = true;
            ambaEmails.push(mail);
            mergeados++;
          }
        }
        // Borrar la clave vieja
        if (emailsVieja.length > 0) {
          await redisCall('DEL', 'asesor:mudanceros-zona:' + zVieja);
        }
      }
      await setJSON('asesor:mudanceros-zona:AMBA', ambaEmails);

      // 2. Actualizar índice de zonas asignadas
      var zonasAsignadas = await getJSON('asesor:zonas-asignadas') || [];
      var zonasFiltradas = zonasAsignadas.filter(function(z){ return ZONAS_VIEJAS.indexOf(z) === -1; });
      if (zonasFiltradas.indexOf('AMBA') === -1 && ambaEmails.length > 0) zonasFiltradas.push('AMBA');
      await setJSON('asesor:zonas-asignadas', zonasFiltradas);

      // 3. Actualizar la zona de los asesores registrados que tenían subzona vieja
      var allEmails = await getJSON('asesores:todos') || [];
      var asesoresMigrados = 0;
      for (var ae = 0; ae < allEmails.length; ae++) {
        var aesEmail = allEmails[ae];
        var aesPerfil = await getJSON('asesor:' + aesEmail);
        if (!aesPerfil) continue;
        if (ZONAS_VIEJAS.indexOf(aesPerfil.zona) !== -1) {
          aesPerfil.zona = 'AMBA';
          await setJSON('asesor:' + aesEmail, aesPerfil);
          asesoresMigrados++;
        }
      }

      return res.status(200).json({
        ok: true,
        ambaTotal: ambaEmails.length,
        mudancerasMergeadas: mergeados,
        asesoresMigrados: asesoresMigrados,
        zonasViejasEliminadas: ZONAS_VIEJAS
      });
    }

    // ── ADMIN-PEDIDOS: ver todos los pedidos creados por asesores ─
    if (action === 'admin-pedidos' && req.method === 'GET') {
      var admToken6 = req.query.token || req.headers['x-admin-token'];
      if (!checkAdmin(admToken6)) return res.status(401).json({ error: 'No autorizado' });
      var emailsIdx = await getJSON('asesores:todos') || [];
      var todos = [];
      for (var w = 0; w < emailsIdx.length; w++) {
        var idsW = await getJSON('pedidos-asesor:' + emailsIdx[w]) || [];
        for (var x = 0; x < idsW.length; x++) {
          var pd = await getJSON('pedido-asesor:' + idsW[x]);
          if (pd) todos.push(pd);
        }
      }
      todos.sort(function(a, b){ return (b.creadoEn || '').localeCompare(a.creadoEn || ''); });
      return res.status(200).json({ ok:true, pedidos: todos });
    }

    // ── DEFAULT ───────────────────────────────────────────────────
    return res.status(400).json({ error: 'Acción no reconocida: ' + action });

  } catch(err) {
    console.error('Asesores API error:', err);
    return res.status(500).json({ error: 'Error interno: ' + (err.message || err) });
  }
};
