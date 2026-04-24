// ═══════════════════════════════════════════════════════════════════
// MUDATEYA — API ASESORES (Plan Referidos Inmobiliarios)
// Servicio GRATIS de valor agregado. Los asesores NO cobran comisión.
// Flujo: asesor se registra → carga datos cliente + mudanza →
//        ve mudanceras pre-asignadas por zona con sus 3 precios
//        (esencial/integral/llave) → arma los 3 packs (1 de c/nivel) →
//        envía link al cliente por email + WhatsApp.
// ═══════════════════════════════════════════════════════════════════
const { Resend } = require('resend');

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

// ── Zonas válidas (mismas que usa el resto de MudateYa) ─────────────
var ZONAS_VALIDAS = [
  'CABA', 'Zona Norte GBA', 'Zona Oeste GBA', 'Zona Sur GBA',
  'La Plata', 'Mar del Plata', 'Rosario', 'Córdoba', 'Mendoza', 'Otra'
];
function normZona(z) {
  return String(z||'').trim();
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

// ── Email al cliente con los 3 packs armados por el asesor ─────────
async function enviarEmailClientePacks(pedido, asesor) {
  try {
    var resend = new Resend(process.env.RESEND_API_KEY);
    var link = 'https://mudateya.ar/cliente-packs?id=' + pedido.id;
    var clienteNombre = pedido.cliente && pedido.cliente.nombre ? pedido.cliente.nombre : 'Hola';

    // Resumen visual de los 3 packs
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
      '<p style="color:#475569;font-size:15px;line-height:1.6;margin-bottom:18px"><strong>' + esc(asesor.nombre) + '</strong>' + (asesor.inmobiliaria ? ' de <strong>' + esc(asesor.inmobiliaria) + '</strong>' : '') + ' te preparó 3 opciones de mudanza para <strong>' + esc(pedido.mudanza.destino || 'tu nuevo hogar') + '</strong>.</p>' +
      '<p style="color:#475569;font-size:14px;line-height:1.6;margin-bottom:18px">Todas con mudanceras verificadas por MudateYa. Elegí la que más te convenga:</p>' +
      packsHtml +
      '<div style="text-align:center;margin:28px 0">' +
        '<a href="' + link + '" style="display:inline-block;padding:14px 32px;background:#22C36A;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px">Ver mis 3 opciones</a>' +
      '</div>' +
      '<p style="color:#94A3B8;font-size:12px;text-align:center;margin-top:16px">Servicio gratis cortesía de tu asesor inmobiliario.</p>' +
      '<hr style="border:none;border-top:1px solid #E2E8F0;margin:28px 0">' +
      '<p style="color:#94A3B8;font-size:11px;text-align:center">MudateYa · mudateya.ar</p>' +
      '</div>';
    await resend.emails.send({
      from: 'MudateYa <noreply@mudateya.ar>',
      to: pedido.cliente.email,
      subject: 'Tus 3 opciones de mudanza — cortesía de ' + asesor.nombre,
      html: html
    });
    return true;
  } catch(e) {
    console.error('Email cliente packs:', e.message);
    return false;
  }
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
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
    // Devuelve cada mudancera con sus 3 precios (esencial/integral/llave)
    if (action === 'mudanceros-zona' && req.method === 'GET') {
      var mzToken = String(req.query.token || '');
      var mzSess = await getAsesorDesdeToken(mzToken);
      if (!mzSess) return res.status(401).json({ error: 'Sesión expirada' });

      var mzZona = normZona(req.query.zona || mzSess.asesor.zona);
      var mzEmails = await getJSON('asesor:mudanceros-zona:' + mzZona) || [];

      var mudanceras = [];
      for (var j = 0; j < mzEmails.length; j++) {
        var m = await getJSON('mudancero:perfil:' + mzEmails[j]);
        if (!m) continue;
        if (m.estado && m.estado !== 'aprobado') continue;
        var preciosPack = m.preciosPack || {};
        mudanceras.push({
          email:        m.email,
          nombre:       m.nombre,
          empresa:      m.empresa || m.nombre,
          foto:         m.foto || '',
          estrellas:    m.promedioEstrellas || 0,
          cantResenas:  (m.resenas || []).length,
          zonaBase:     m.zonaBase || '',
          preciosPack: {
            esencial: Number(preciosPack.esencial) || 0,
            integral: Number(preciosPack.integral) || 0,
            llave:    Number(preciosPack.llave)    || 0
          }
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
      if (!Array.isArray(packs) || packs.length !== 3) {
        return res.status(400).json({ error: 'Tenés que elegir exactamente 3 packs (1 de cada nivel)' });
      }

      // Validar: 1 de cada nivel, distintas mudanceras permitido repetir si admin lo permite
      var nivelesPresentes = packs.map(function(p){ return p.nivel; }).sort();
      var nivelesEsperados = NIVELES.slice().sort();
      if (nivelesPresentes.join(',') !== nivelesEsperados.join(',')) {
        return res.status(400).json({ error: 'Tenés que elegir 1 Esencial + 1 Integral + 1 Llave en Mano' });
      }

      // Rehidratar cada pack desde Redis (nunca confiar en el precio que viene del cliente)
      var packsValidos = [];
      for (var k = 0; k < packs.length; k++) {
        var pk = packs[k];
        if (!pk.mudanceroEmail || NIVELES.indexOf(pk.nivel) === -1) {
          return res.status(400).json({ error: 'Pack inválido' });
        }
        var mp = await getJSON('mudancero:perfil:' + pk.mudanceroEmail);
        if (!mp) return res.status(400).json({ error: 'Mudancera no encontrada: ' + pk.mudanceroEmail });
        var precioReal = mp.preciosPack && Number(mp.preciosPack[pk.nivel]);
        if (!precioReal || precioReal <= 0) {
          return res.status(400).json({ error: 'La mudancera ' + mp.nombre + ' no tiene precio cargado para ' + NIVELES_LABEL[pk.nivel] });
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
      var waText =
        'Hola ' + ecPedido.cliente.nombre + '! 👋\n\n' +
        'Te preparé 3 opciones de mudanza con empresas verificadas de MudateYa para tu mudanza a ' + ecPedido.mudanza.destino + '.\n\n' +
        'Elegí la que más te convenga acá:\n' + link + '\n\n' +
        'Cualquier duda me avisás.\n' +
        ecSess.asesor.nombre + (ecSess.asesor.inmobiliaria ? ' · ' + ecSess.asesor.inmobiliaria : '');
      var waLink = 'https://wa.me/' + normFono(ecPedido.cliente.telefono) + '?text=' + encodeURIComponent(waText);

      return res.status(200).json({
        ok: true,
        email: okEmail,
        waLink: waLink,
        waText: waText,
        clienteUrl: link
      });
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
