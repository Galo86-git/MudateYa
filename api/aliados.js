// ═══════════════════════════════════════════════════════════════════
// MUDATEYA — API ALIADOS
// Programa de referidos. Página oculta /aliados, link /r/SLUG.
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

// Helpers para strings planos (sin JSON.stringify/parse)
async function setString(key, value, exSeconds) {
  if (exSeconds) await redisCall('setex', key, exSeconds, String(value));
  else await redisCall('set', key, String(value));
}
async function getString(key) {
  return await redisCall('get', key);
}

// ── Constantes ──────────────────────────────────────────────────────
var ADMIN_FALLBACK = 'mya-admin-2026';
var MAGIC_LINK_TTL = 900; // 15 minutos
var SESSION_TTL = 60 * 60 * 24 * 30; // 30 días

// Config default — editable desde admin
var CONFIG_DEFAULT = {
  fijoMudanza: 25000,
  fijoFlete: 10000,
  fijoAlta: 5500,
  trimPct: 0.20,
  trimUmbral: 3,
  anualPct: 0.10,
  anualUmbral: 10,
  cookieDias: 90,
  programaAbierto: true
};

async function getConfig() {
  var c = await getJSON('aliados:config');
  return Object.assign({}, CONFIG_DEFAULT, c || {});
}

// ── Slug generator (4 chars, sin ambigüedad) ────────────────────────
function generarSlug() {
  var chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin O/0/I/1/L
  var s = '';
  for (var i=0; i<4; i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}
async function slugUnico() {
  for (var i=0; i<10; i++) {
    var s = generarSlug();
    var existe = await redisCall('get', 'aliado:slug:' + s);
    if (!existe) return s;
  }
  // fallback: 5 chars
  var s5 = generarSlug() + generarSlug()[0];
  return s5;
}

// ── Utilidades de fecha ─────────────────────────────────────────────
function trimestreActual(fecha) {
  var f = fecha ? new Date(fecha) : new Date();
  var m = f.getMonth(); // 0-11
  var q = Math.floor(m/3) + 1; // 1-4
  return f.getFullYear() + '-Q' + q;
}
function anioActual(fecha) {
  var f = fecha ? new Date(fecha) : new Date();
  return String(f.getFullYear());
}

// ── Sanitización ────────────────────────────────────────────────────
function esc(s) {
  if (!s) return '';
  return String(s).replace(/[<>&"']/g, function(c){
    return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c];
  });
}
function validEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e||'').trim());
}

// ── Email: magic link ───────────────────────────────────────────────
async function enviarMagicLink(email, token, nombre) {
  try {
    var resend = new Resend(process.env.RESEND_API_KEY);
    var link = 'https://mudateya.ar/aliados?token=' + token;
    var html = '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#0F1923">' +
      '<div style="text-align:center;margin-bottom:28px">' +
        '<span style="font-family:Bebas Neue,sans-serif;font-size:36px;letter-spacing:2px;color:#003580">MUDATE</span>' +
        '<span style="font-family:Bebas Neue,sans-serif;font-size:36px;letter-spacing:2px;color:#22C36A">YA</span>' +
      '</div>' +
      '<h2 style="color:#003580;font-size:22px;margin-bottom:14px">Hola' + (nombre ? ' ' + esc(nombre) : '') + '</h2>' +
      '<p style="color:#475569;font-size:15px;line-height:1.6;margin-bottom:24px">Para entrar a tu panel de Aliado MudateYa, hacé clic en el botón:</p>' +
      '<div style="text-align:center;margin:32px 0">' +
        '<a href="' + link + '" style="display:inline-block;padding:14px 32px;background:#22C36A;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px">Abrir mi panel</a>' +
      '</div>' +
      '<p style="color:#94A3B8;font-size:12px;text-align:center;margin-top:24px">Este link expira en 15 minutos. Si no fuiste vos, ignorá este email.</p>' +
      '<hr style="border:none;border-top:1px solid #E2E8F0;margin:28px 0">' +
      '<p style="color:#94A3B8;font-size:11px;text-align:center">MudateYa · mudateya.ar</p>' +
      '</div>';
    await resend.emails.send({
      from: 'MudateYa Aliados <noreply@mudateya.ar>',
      to: email,
      subject: 'Accedé a tu panel de Aliado MudateYa',
      html: html
    });
    return true;
  } catch(e) {
    console.error('Error magic link:', e.message);
    return false;
  }
}

async function enviarEmailBienvenida(aliado) {
  try {
    var resend = new Resend(process.env.RESEND_API_KEY);
    var link = 'https://mudateya.ar/aliados?token=' + aliado.sessionToken;
    var html = '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#0F1923">' +
      '<div style="text-align:center;margin-bottom:28px">' +
        '<span style="font-family:Bebas Neue,sans-serif;font-size:36px;letter-spacing:2px;color:#003580">MUDATE</span>' +
        '<span style="font-family:Bebas Neue,sans-serif;font-size:36px;letter-spacing:2px;color:#22C36A">YA</span>' +
      '</div>' +
      '<h2 style="color:#003580;font-size:22px;margin-bottom:14px">🎉 Bienvenido, ' + esc(aliado.nombre) + '</h2>' +
      '<p style="color:#475569;font-size:15px;line-height:1.6">Ya sos Aliado MudateYa. Tu código es <strong style="color:#22C36A">' + aliado.slug + '</strong> y tu link personal para compartir con vecinos es:</p>' +
      '<div style="background:#F5F7FA;padding:14px;border-radius:8px;text-align:center;margin:16px 0"><code style="font-size:14px;color:#003580;word-break:break-all">https://mudateya.ar/r/' + aliado.slug + '</code></div>' +
      '<p style="color:#475569;font-size:15px;line-height:1.6">Desde tu panel vas a poder descargar tu QR personal, ver tus comisiones y compartir tu link por WhatsApp.</p>' +
      '<div style="text-align:center;margin:32px 0">' +
        '<a href="' + link + '" style="display:inline-block;padding:14px 32px;background:#22C36A;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px">Entrar a mi panel</a>' +
      '</div>' +
      '<hr style="border:none;border-top:1px solid #E2E8F0;margin:28px 0">' +
      '<p style="color:#94A3B8;font-size:11px;text-align:center">MudateYa · mudateya.ar</p>' +
      '</div>';
    await resend.emails.send({
      from: 'MudateYa Aliados <noreply@mudateya.ar>',
      to: aliado.email,
      subject: '🎉 Bienvenido a Aliados MudateYa',
      html: html
    });
  } catch(e) { console.error('Email bienvenida:', e.message); }
}

// ── Notificación al admin cuando se registra un aliado nuevo ─────────
async function enviarEmailAdminNuevoAliado(aliado) {
  try {
    var resend = new Resend(process.env.RESEND_API_KEY);
    var fecha = new Date().toLocaleString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
    var html = '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#0F1923">' +
      '<div style="text-align:center;margin-bottom:28px">' +
        '<span style="font-family:Bebas Neue,sans-serif;font-size:36px;letter-spacing:2px;color:#003580">MUDATE</span>' +
        '<span style="font-family:Bebas Neue,sans-serif;font-size:36px;letter-spacing:2px;color:#22C36A">YA</span>' +
      '</div>' +
      '<h2 style="color:#003580;font-size:20px;margin-bottom:6px">🤝 Nuevo Aliado registrado</h2>' +
      '<p style="color:#94A3B8;font-size:12px;margin-bottom:20px">' + fecha + '</p>' +
      '<div style="background:#F5F7FA;border-radius:10px;padding:18px;margin-bottom:20px">' +
        '<table style="width:100%;font-size:14px;color:#475569;border-collapse:collapse">' +
          '<tr><td style="padding:6px 0;font-weight:600;color:#003580;width:110px">Nombre:</td><td style="padding:6px 0">' + esc(aliado.nombre) + '</td></tr>' +
          '<tr><td style="padding:6px 0;font-weight:600;color:#003580">Email:</td><td style="padding:6px 0"><a href="mailto:' + esc(aliado.email) + '" style="color:#1A6FFF;text-decoration:none">' + esc(aliado.email) + '</a></td></tr>' +
          '<tr><td style="padding:6px 0;font-weight:600;color:#003580">Teléfono:</td><td style="padding:6px 0"><a href="https://wa.me/' + esc(String(aliado.telefono||'').replace(/\D/g,'')) + '" style="color:#22C36A;text-decoration:none">' + esc(aliado.telefono || '—') + '</a></td></tr>' +
          '<tr><td style="padding:6px 0;font-weight:600;color:#003580;vertical-align:top">Edificio:</td><td style="padding:6px 0">' + esc(aliado.edificio || '—') + '</td></tr>' +
          '<tr><td style="padding:6px 0;font-weight:600;color:#003580">Alias MP:</td><td style="padding:6px 0;font-family:DM Mono,monospace">' + esc(aliado.aliasMP || '—') + '</td></tr>' +
          '<tr><td style="padding:6px 0;font-weight:600;color:#003580">Código:</td><td style="padding:6px 0"><strong style="color:#22C36A;font-family:DM Mono,monospace;font-size:15px">' + aliado.slug + '</strong></td></tr>' +
          '<tr><td style="padding:6px 0;font-weight:600;color:#003580">Link personal:</td><td style="padding:6px 0;font-family:DM Mono,monospace;font-size:12px"><a href="https://mudateya.ar/r/' + aliado.slug + '" style="color:#1A6FFF;text-decoration:none">mudateya.ar/r/' + aliado.slug + '</a></td></tr>' +
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
      subject: '🤝 Nuevo Aliado: ' + aliado.nombre + ' (' + aliado.slug + ')',
      html: html
    });
  } catch(e) { console.error('Email admin nuevo aliado:', e.message); }
}

// ── Cálculo de balance de un aliado ─────────────────────────────────
async function calcularBalance(email) {
  var aliado = await getJSON('aliado:' + email);
  if (!aliado) return null;
  var cfg = await getConfig();
  var atribIds = aliado.atribuciones || [];
  var balance = {
    enCurso: { count:0, monto:0, ops:[] },
    acreditadas: { count:0, monto:0, ops:[] },
    pagadas: { count:0, monto:0 },
    canceladas: { count:0 },
    trimestre: { periodo: trimestreActual(), count:0, monto:0, umbral: cfg.trimUmbral, bonoPct: cfg.trimPct, bono: 0, elegible: false },
    anio: { periodo: anioActual(), count:0, monto:0, umbral: cfg.anualUmbral, bonoPct: cfg.anualPct, bono: 0, elegible: false },
    historial: []
  };
  var tActual = trimestreActual();
  var aActual = anioActual();
  for (var i=0; i<atribIds.length; i++) {
    var at = await getJSON('atribucion:' + atribIds[i]);
    if (!at) continue;
    balance.historial.push(at);
    if (at.estado === 'en_curso') {
      balance.enCurso.count++;
      balance.enCurso.monto += at.monto;
      balance.enCurso.ops.push(at);
    } else if (at.estado === 'acreditada') {
      balance.acreditadas.count++;
      balance.acreditadas.monto += at.monto;
      balance.acreditadas.ops.push(at);
      // Suma a trimestre y año solo si cae en periodo actual
      var tOp = trimestreActual(at.completadaEn);
      var aOp = anioActual(at.completadaEn);
      if (tOp === tActual) {
        balance.trimestre.count++;
        balance.trimestre.monto += at.monto;
      }
      if (aOp === aActual) {
        balance.anio.count++;
        balance.anio.monto += at.monto;
      }
    } else if (at.estado === 'pagada') {
      balance.pagadas.count++;
      balance.pagadas.monto += at.monto;
    } else if (at.estado === 'cancelada') {
      balance.canceladas.count++;
    }
  }
  // Bonos proyectados (si cumple umbral)
  if (balance.trimestre.count >= cfg.trimUmbral) {
    balance.trimestre.elegible = true;
    balance.trimestre.bono = Math.round(balance.trimestre.monto * cfg.trimPct);
  }
  if (balance.anio.count >= cfg.anualUmbral) {
    balance.anio.elegible = true;
    balance.anio.bono = Math.round(balance.anio.monto * cfg.anualPct);
  }
  // Total pendiente de cobro = acreditadas (fijo) del mes anterior cerrado
  // Simplificación: lo pendiente es la suma de acreditadas todavía no pagadas
  balance.pendientePago = balance.acreditadas.monto;
  balance.historial.sort(function(a,b){
    return new Date(b.creadaEn) - new Date(a.creadaEn);
  });
  return balance;
}

// ── Función interna para acreditar (se exporta para cotizaciones.js) ─
// Se llama desde cotizaciones.js al completarse una mudanza
async function acreditarAliado(mudanzaId) {
  try {
    var atrib = await getJSON('atribucion:' + mudanzaId);
    if (!atrib) return { ok:false, motivo:'sin_atribucion' };
    if (atrib.estado !== 'en_curso') return { ok:false, motivo:'ya_procesada', estado: atrib.estado };
    atrib.estado = 'acreditada';
    atrib.completadaEn = new Date().toISOString();
    await setJSON('atribucion:' + mudanzaId, atrib);
    return { ok:true, monto: atrib.monto, slug: atrib.aliadoSlug };
  } catch(e) {
    console.error('acreditarAliado:', e.message);
    return { ok:false, motivo:'error' };
  }
}

async function cancelarAtribucion(mudanzaId) {
  try {
    var atrib = await getJSON('atribucion:' + mudanzaId);
    if (!atrib) return { ok:false };
    if (atrib.estado === 'pagada') return { ok:false, motivo:'ya_pagada' };
    atrib.estado = 'cancelada';
    atrib.canceladaEn = new Date().toISOString();
    await setJSON('atribucion:' + mudanzaId, atrib);
    return { ok:true };
  } catch(e) { return { ok:false }; }
}

// Crear atribución cuando una mudanza se publica con ref
async function crearAtribucion(mudanzaId, slug, tipo) {
  try {
    var aliadoEmail = await redisCall('get', 'aliado:slug:' + slug);
    if (!aliadoEmail) return { ok:false, motivo:'slug_invalido' };
    // Sanitizar: si viene con comillas de JSON.stringify previo
    aliadoEmail = String(aliadoEmail).replace(/^"(.*)"$/, '$1');
    var aliado = await getJSON('aliado:' + aliadoEmail);
    if (!aliado || aliado.estado !== 'activo') return { ok:false, motivo:'aliado_inactivo' };
    var cfg = await getConfig();
    var monto = tipo === 'flete' ? cfg.fijoFlete : cfg.fijoMudanza;
    var atrib = {
      mudanzaId: mudanzaId,
      aliadoEmail: aliadoEmail,
      aliadoSlug: slug,
      aliadoNombre: aliado.nombre,
      tipo: tipo || 'mudanza',
      monto: monto,
      estado: 'en_curso',
      creadaEn: new Date().toISOString(),
      completadaEn: null,
      canceladaEn: null,
      pagadaEn: null
    };
    await setJSON('atribucion:' + mudanzaId, atrib);
    // Agregar al índice del aliado
    aliado.atribuciones = aliado.atribuciones || [];
    if (!aliado.atribuciones.includes(mudanzaId)) {
      aliado.atribuciones.push(mudanzaId);
      await setJSON('aliado:' + aliadoEmail, aliado);
    }
    return { ok:true };
  } catch(e) {
    console.error('crearAtribucion:', e.message);
    return { ok:false, motivo:'error' };
  }
}

// ── Altas de mudanceros/fleteros ──
// Se dispara cuando un mudancero se registra con cookie mya_ref activa.
// Arranca en 'en_curso' y pasa a 'acreditada' cuando el admin lo aprueba.
async function crearAtribucionAlta(mudanceroEmail, slug, tipoAlta) {
  try {
    if (!mudanceroEmail || !slug) return { ok:false, motivo:'datos_invalidos' };
    var aliadoEmail = await redisCall('get', 'aliado:slug:' + slug);
    if (!aliadoEmail) return { ok:false, motivo:'slug_invalido' };
    aliadoEmail = String(aliadoEmail).replace(/^"(.*)"$/, '$1');
    var aliado = await getJSON('aliado:' + aliadoEmail);
    if (!aliado || aliado.estado !== 'activo') return { ok:false, motivo:'aliado_inactivo' };

    // Tie-break: si ya existe atribución de alta para este mudancero, la nueva pisa a la vieja
    // (última cookie activa gana). Pero si la anterior ya está acreditada/pagada, no se pisa.
    var prev = await getJSON('atribucion:alta:' + mudanceroEmail);
    if (prev && (prev.estado === 'acreditada' || prev.estado === 'pagada')) {
      return { ok:false, motivo:'ya_acreditada_a_otro' };
    }
    // Si había una previa 'en_curso' de otro aliado, desvincularla del índice del aliado viejo
    if (prev && prev.aliadoEmail && prev.aliadoEmail !== aliadoEmail) {
      try {
        var viejo = await getJSON('aliado:' + prev.aliadoEmail);
        if (viejo && Array.isArray(viejo.atribuciones)) {
          viejo.atribuciones = viejo.atribuciones.filter(function(id){ return id !== 'alta:' + mudanceroEmail; });
          await setJSON('aliado:' + prev.aliadoEmail, viejo);
        }
      } catch(ex) {}
    }

    var cfg = await getConfig();
    var atribId = 'alta:' + mudanceroEmail;
    var atrib = {
      mudanzaId: atribId,
      mudanceroEmail: mudanceroEmail,
      aliadoEmail: aliadoEmail,
      aliadoSlug: slug,
      aliadoNombre: aliado.nombre,
      tipo: tipoAlta === 'fletero' ? 'alta_fletero' : 'alta_mudancero',
      monto: cfg.fijoAlta || 5500,
      estado: 'en_curso',
      creadaEn: new Date().toISOString(),
      completadaEn: null,
      canceladaEn: null,
      pagadaEn: null
    };
    await setJSON('atribucion:' + atribId, atrib);
    aliado.atribuciones = aliado.atribuciones || [];
    if (!aliado.atribuciones.includes(atribId)) {
      aliado.atribuciones.push(atribId);
      await setJSON('aliado:' + aliadoEmail, aliado);
    }
    return { ok:true };
  } catch(e) {
    console.error('crearAtribucionAlta:', e.message);
    return { ok:false, motivo:'error' };
  }
}

async function acreditarAlta(mudanceroEmail) {
  try {
    if (!mudanceroEmail) return { ok:false };
    var atribId = 'alta:' + mudanceroEmail;
    var atrib = await getJSON('atribucion:' + atribId);
    if (!atrib) return { ok:false, motivo:'sin_atribucion' };
    if (atrib.estado !== 'en_curso') return { ok:false, motivo:'estado_' + atrib.estado };
    atrib.estado = 'acreditada';
    atrib.completadaEn = new Date().toISOString();
    await setJSON('atribucion:' + atribId, atrib);
    return { ok:true };
  } catch(e) {
    console.error('acreditarAlta:', e.message);
    return { ok:false };
  }
}

async function cancelarAlta(mudanceroEmail) {
  try {
    if (!mudanceroEmail) return { ok:false };
    var atribId = 'alta:' + mudanceroEmail;
    var atrib = await getJSON('atribucion:' + atribId);
    if (!atrib) return { ok:false, motivo:'sin_atribucion' };
    if (atrib.estado === 'pagada') return { ok:false, motivo:'ya_pagada' };
    atrib.estado = 'cancelada';
    atrib.canceladaEn = new Date().toISOString();
    await setJSON('atribucion:' + atribId, atrib);
    return { ok:true };
  } catch(e) {
    console.error('cancelarAlta:', e.message);
    return { ok:false };
  }
}

// ══════════════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ══════════════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  // CORS restricted
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
    // ══════ PÚBLICO ══════

    // Config pública (para que aliados.html sepa umbrales y montos)
    if (action === 'config' && req.method === 'GET') {
      var cfg = await getConfig();
      return res.status(200).json({
        fijoMudanza: cfg.fijoMudanza,
        fijoFlete: cfg.fijoFlete,
        trimPct: cfg.trimPct,
        trimUmbral: cfg.trimUmbral,
        anualPct: cfg.anualPct,
        anualUmbral: cfg.anualUmbral,
        programaAbierto: cfg.programaAbierto
      });
    }

    // Resolver slug → info mínima (usado por r.html para saber si el slug es válido)
    if (action === 'lookup' && req.method === 'GET') {
      var slug = String(req.query.slug || '').toUpperCase().trim();
      if (!slug) return res.status(400).json({ error: 'Falta slug' });
      var email = await redisCall('get', 'aliado:slug:' + slug);
      if (!email) return res.status(404).json({ ok:false });
      email = String(email).replace(/^"(.*)"$/, '$1');
      var aliado = await getJSON('aliado:' + email);
      if (!aliado || aliado.estado !== 'activo') return res.status(404).json({ ok:false });
      return res.status(200).json({ ok:true, slug: slug, nombre: aliado.nombre, edificio: aliado.edificio });
    }

    // Registro de aliado nuevo
    if (action === 'register' && req.method === 'POST') {
      var cfg1 = await getConfig();
      if (!cfg1.programaAbierto) {
        return res.status(403).json({ error: 'El programa de Aliados está cerrado a nuevas inscripciones.' });
      }
      var body = req.body || {};
      var nombre = String(body.nombre || '').trim();
      var email = String(body.email || '').trim().toLowerCase();
      var telefono = String(body.telefono || '').trim();
      var edificio = String(body.edificio || '').trim();
      var aliasMP = String(body.aliasMP || '').trim();
      var aceptaTerminos = !!body.aceptaTerminos;

      if (!nombre || nombre.length < 2) return res.status(400).json({ error: 'Ingresá tu nombre completo' });
      if (!validEmail(email)) return res.status(400).json({ error: 'Email inválido' });
      if (!telefono || telefono.length < 8) return res.status(400).json({ error: 'Teléfono inválido' });
      if (!edificio || edificio.length < 5) return res.status(400).json({ error: 'Ingresá la dirección del edificio' });
      if (!aliasMP || aliasMP.length < 3) return res.status(400).json({ error: 'Ingresá tu alias de Mercado Pago' });
      if (!aceptaTerminos) return res.status(400).json({ error: 'Tenés que aceptar los términos' });

      // Chequear si ya existe
      var existe = await getJSON('aliado:' + email);
      if (existe) {
        // Si existe, enviar magic link en vez de crear duplicado
        var existingToken = Math.random().toString(36).substring(2) + Date.now().toString(36);
        await setJSON('magiclink:' + existingToken, { email: email }, MAGIC_LINK_TTL);
        await enviarMagicLink(email, existingToken, existe.nombre);
        return res.status(200).json({ ok:true, existente:true, mensaje:'Ya estabas registrado. Te mandamos un link a tu email.' });
      }

      var slug = await slugUnico();
      var sessionToken = Math.random().toString(36).substring(2) + Date.now().toString(36) + Math.random().toString(36).substring(2);
      var aliado = {
        email: email,
        nombre: nombre,
        telefono: telefono,
        edificio: edificio,
        aliasMP: aliasMP,
        slug: slug,
        estado: 'activo',
        atribuciones: [],
        sessionToken: sessionToken,
        creadoEn: new Date().toISOString()
      };
      await setJSON('aliado:' + email, aliado);
      await setString('aliado:slug:' + slug, email); // lookup rápido (string plano)
      await setString('aliado:session:' + sessionToken, email, SESSION_TTL);

      // Índice global para el admin
      var todosIdx = await getJSON('aliados:todos') || [];
      if (!todosIdx.includes(email)) {
        todosIdx.push(email);
        await setJSON('aliados:todos', todosIdx);
      }

      await enviarEmailBienvenida(aliado);
      await enviarEmailAdminNuevoAliado(aliado);

      return res.status(200).json({
        ok: true,
        slug: slug,
        sessionToken: sessionToken,
        nombre: nombre,
        edificio: edificio,
        mensaje: 'Listo. Ya sos Aliado MudateYa.'
      });
    }

    // Pedir magic link por email (si ya existe)
    if (action === 'request-magiclink' && req.method === 'POST') {
      var reqEmail = String((req.body||{}).email || '').trim().toLowerCase();
      if (!validEmail(reqEmail)) return res.status(400).json({ error: 'Email inválido' });
      var a = await getJSON('aliado:' + reqEmail);
      if (!a) {
        // No revelar si existe o no (privacidad)
        return res.status(200).json({ ok:true, mensaje:'Si el email está registrado, recibirás un link de acceso.' });
      }
      var token = Math.random().toString(36).substring(2) + Date.now().toString(36);
      await setJSON('magiclink:' + token, { email: reqEmail }, MAGIC_LINK_TTL);
      await enviarMagicLink(reqEmail, token, a.nombre);
      return res.status(200).json({ ok:true, mensaje:'Si el email está registrado, recibirás un link de acceso.' });
    }

    // Verificar magic link y canjear por sesión
    if (action === 'verify-magiclink' && req.method === 'GET') {
      var mlToken = String(req.query.token || '');
      if (!mlToken) return res.status(400).json({ error: 'Falta token' });
      var ml = await getJSON('magiclink:' + mlToken);
      if (!ml) return res.status(401).json({ error: 'Link inválido o expirado' });
      var aliadoEmail = ml.email;
      var aliadoObj = await getJSON('aliado:' + aliadoEmail);
      if (!aliadoObj) return res.status(404).json({ error: 'Aliado no encontrado' });
      // Generar nuevo session token
      var newSession = Math.random().toString(36).substring(2) + Date.now().toString(36) + Math.random().toString(36).substring(2);
      await setString('aliado:session:' + newSession, aliadoEmail, SESSION_TTL);
      aliadoObj.sessionToken = newSession;
      aliadoObj.ultimoLogin = new Date().toISOString();
      await setJSON('aliado:' + aliadoEmail, aliadoObj);
      // Borrar el magic link usado
      await delKey('magiclink:' + mlToken);
      return res.status(200).json({ ok:true, sessionToken: newSession });
    }

    // Panel del aliado (requiere session token)
    if (action === 'panel' && req.method === 'GET') {
      var panelToken = String(req.query.token || '');
      if (!panelToken) return res.status(401).json({ error: 'Sin token' });
      var panelEmail = await redisCall('get', 'aliado:session:' + panelToken);
      if (!panelEmail) return res.status(401).json({ error: 'Sesión expirada' });
      // Sanitizar: si viene con comillas de un JSON.stringify previo, quitarlas
      panelEmail = String(panelEmail).replace(/^"(.*)"$/, '$1');
      var panelAliado = await getJSON('aliado:' + panelEmail);
      if (!panelAliado) return res.status(404).json({ error: 'Aliado no encontrado' });
      var balance = await calcularBalance(panelEmail);
      var cfg2 = await getConfig();
      return res.status(200).json({
        ok: true,
        aliado: {
          nombre: panelAliado.nombre,
          email: panelAliado.email,
          telefono: panelAliado.telefono,
          edificio: panelAliado.edificio,
          aliasMP: panelAliado.aliasMP,
          slug: panelAliado.slug,
          estado: panelAliado.estado,
          creadoEn: panelAliado.creadoEn
        },
        balance: balance,
        config: cfg2
      });
    }

    // Actualizar datos del aliado (alias MP, teléfono)
    if (action === 'update-profile' && req.method === 'POST') {
      var upToken = String((req.body||{}).token || '');
      var upEmail = await redisCall('get', 'aliado:session:' + upToken);
      if (!upEmail) return res.status(401).json({ error: 'Sesión expirada' });
      upEmail = String(upEmail).replace(/^"(.*)"$/, '$1');
      var upAliado = await getJSON('aliado:' + upEmail);
      if (!upAliado) return res.status(404).json({ error: 'No encontrado' });
      var upBody = req.body || {};
      if (upBody.telefono) upAliado.telefono = String(upBody.telefono).trim();
      if (upBody.aliasMP) upAliado.aliasMP = String(upBody.aliasMP).trim();
      await setJSON('aliado:' + upEmail, upAliado);
      return res.status(200).json({ ok:true });
    }

    // ══════ INTERNO (llamado desde cotizaciones.js vía fetch) ══════

    if (action === 'internal-crear-atribucion' && req.method === 'POST') {
      var internalSecret = req.headers['x-internal-secret'];
      var validSecret = process.env.INTERNAL_API_SECRET;
      if (!validSecret || internalSecret !== validSecret) {
        return res.status(403).json({ error: 'Sin autorización' });
      }
      var iBody = req.body || {};
      var r = await crearAtribucion(iBody.mudanzaId, iBody.slug, iBody.tipo);
      return res.status(200).json(r);
    }

    if (action === 'internal-acreditar' && req.method === 'POST') {
      var internalSecret2 = req.headers['x-internal-secret'];
      if (internalSecret2 !== process.env.INTERNAL_API_SECRET) {
        return res.status(403).json({ error: 'Sin autorización' });
      }
      var r2 = await acreditarAliado((req.body||{}).mudanzaId);
      return res.status(200).json(r2);
    }

    if (action === 'internal-cancelar' && req.method === 'POST') {
      var internalSecret3 = req.headers['x-internal-secret'];
      if (internalSecret3 !== process.env.INTERNAL_API_SECRET) {
        return res.status(403).json({ error: 'Sin autorización' });
      }
      var r3 = await cancelarAtribucion((req.body||{}).mudanzaId);
      return res.status(200).json(r3);
    }

    // ── Altas (internal) ──
    if (action === 'internal-alta-crear' && req.method === 'POST') {
      var secA = req.headers['x-internal-secret'];
      if (secA !== process.env.INTERNAL_API_SECRET) {
        return res.status(403).json({ error: 'Sin autorización' });
      }
      var bA = req.body || {};
      var rA = await crearAtribucionAlta(bA.mudanceroEmail, bA.slug, bA.tipo);
      return res.status(200).json(rA);
    }

    if (action === 'internal-alta-acreditar' && req.method === 'POST') {
      var secB = req.headers['x-internal-secret'];
      if (secB !== process.env.INTERNAL_API_SECRET) {
        return res.status(403).json({ error: 'Sin autorización' });
      }
      var rB = await acreditarAlta((req.body||{}).mudanceroEmail);
      return res.status(200).json(rB);
    }

    if (action === 'internal-alta-cancelar' && req.method === 'POST') {
      var secC = req.headers['x-internal-secret'];
      if (secC !== process.env.INTERNAL_API_SECRET) {
        return res.status(403).json({ error: 'Sin autorización' });
      }
      var rC = await cancelarAlta((req.body||{}).mudanceroEmail);
      return res.status(200).json(rC);
    }

    // ══════ ADMIN ══════

    if (action === 'admin-list' && req.method === 'GET') {
      var admToken = req.query.token || req.headers['x-admin-token'];
      if (admToken !== process.env.ADMIN_TOKEN && admToken !== ADMIN_FALLBACK) {
        return res.status(403).json({ error: 'No autorizado' });
      }
      var idx = await getJSON('aliados:todos') || [];
      var lista = [];
      for (var k=0; k<idx.length; k++) {
        var a = await getJSON('aliado:' + idx[k]);
        if (!a) continue;
        var bal = await calcularBalance(idx[k]);
        lista.push({
          email: a.email,
          nombre: a.nombre,
          telefono: a.telefono,
          edificio: a.edificio,
          aliasMP: a.aliasMP,
          slug: a.slug,
          estado: a.estado,
          creadoEn: a.creadoEn,
          ultimoLogin: a.ultimoLogin || null,
          balance: {
            enCursoCount: bal.enCurso.count,
            enCursoMonto: bal.enCurso.monto,
            acreditadasCount: bal.acreditadas.count,
            acreditadasMonto: bal.acreditadas.monto,
            pagadasCount: bal.pagadas.count,
            pagadasMonto: bal.pagadas.monto,
            pendientePago: bal.pendientePago,
            trimestre: bal.trimestre,
            anio: bal.anio
          }
        });
      }
      return res.status(200).json({ ok:true, aliados: lista, total: lista.length });
    }

    if (action === 'admin-detalle' && req.method === 'GET') {
      var admToken2 = req.query.token || req.headers['x-admin-token'];
      if (admToken2 !== process.env.ADMIN_TOKEN && admToken2 !== ADMIN_FALLBACK) {
        return res.status(403).json({ error: 'No autorizado' });
      }
      var dEmail = String(req.query.email || '').toLowerCase();
      var dAliado = await getJSON('aliado:' + dEmail);
      if (!dAliado) return res.status(404).json({ error: 'No encontrado' });
      var dBal = await calcularBalance(dEmail);
      return res.status(200).json({ ok:true, aliado: dAliado, balance: dBal });
    }

    if (action === 'admin-marcar-pagado' && req.method === 'POST') {
      var admToken3 = req.headers['x-admin-token'];
      if (admToken3 !== process.env.ADMIN_TOKEN && admToken3 !== ADMIN_FALLBACK) {
        return res.status(403).json({ error: 'No autorizado' });
      }
      var mpBody = req.body || {};
      var mpEmail = String(mpBody.email || '').toLowerCase();
      var mpIds = Array.isArray(mpBody.mudanzaIds) ? mpBody.mudanzaIds : [];
      var mpConceptoBono = mpBody.conceptoBono || null; // 'trimestral' | 'anual' | null
      var mpMontoBono = mpBody.montoBono || 0;
      if (!mpEmail) return res.status(400).json({ error: 'Falta email' });
      var nowIso = new Date().toISOString();
      var totalPagado = 0;
      // Marcar atribuciones como pagadas
      for (var j=0; j<mpIds.length; j++) {
        var at2 = await getJSON('atribucion:' + mpIds[j]);
        if (at2 && at2.estado === 'acreditada' && at2.aliadoEmail === mpEmail) {
          at2.estado = 'pagada';
          at2.pagadaEn = nowIso;
          await setJSON('atribucion:' + mpIds[j], at2);
          totalPagado += at2.monto;
        }
      }
      // Si hay bono, registrar como pago especial
      if (mpConceptoBono && mpMontoBono > 0) {
        var bonoId = 'bono-' + mpConceptoBono + '-' + Date.now();
        var bonoRec = {
          mudanzaId: bonoId,
          aliadoEmail: mpEmail,
          tipo: 'bono_' + mpConceptoBono,
          monto: mpMontoBono,
          estado: 'pagada',
          creadaEn: nowIso,
          pagadaEn: nowIso,
          concepto: mpConceptoBono === 'trimestral' ? ('Bono trimestral ' + trimestreActual()) : ('Bono anual ' + anioActual())
        };
        await setJSON('atribucion:' + bonoId, bonoRec);
        var mpAliado = await getJSON('aliado:' + mpEmail);
        if (mpAliado) {
          mpAliado.atribuciones = mpAliado.atribuciones || [];
          mpAliado.atribuciones.push(bonoId);
          await setJSON('aliado:' + mpEmail, mpAliado);
        }
        totalPagado += mpMontoBono;
      }
      // Registrar en historial de pagos global
      var histPagos = await getJSON('aliados:pagos') || [];
      histPagos.push({
        aliadoEmail: mpEmail,
        fecha: nowIso,
        mudanzaIds: mpIds,
        cantidadOps: mpIds.length,
        montoOps: totalPagado - (mpMontoBono || 0),
        conceptoBono: mpConceptoBono,
        montoBono: mpMontoBono || 0,
        montoTotal: totalPagado
      });
      await setJSON('aliados:pagos', histPagos);
      return res.status(200).json({ ok:true, totalPagado: totalPagado });
    }

    // ── Admin: acreditar/cancelar altas manualmente ──
    if (action === 'admin-acreditar-alta' && req.method === 'POST') {
      var admTokA = req.headers['x-admin-token'];
      if (admTokA !== process.env.ADMIN_TOKEN && admTokA !== ADMIN_FALLBACK) {
        return res.status(403).json({ error: 'No autorizado' });
      }
      var rAA = await acreditarAlta((req.body||{}).mudanceroEmail);
      return res.status(200).json(rAA);
    }

    if (action === 'admin-cancelar-alta' && req.method === 'POST') {
      var admTokC = req.headers['x-admin-token'];
      if (admTokC !== process.env.ADMIN_TOKEN && admTokC !== ADMIN_FALLBACK) {
        return res.status(403).json({ error: 'No autorizado' });
      }
      var rCA = await cancelarAlta((req.body||{}).mudanceroEmail);
      return res.status(200).json(rCA);
    }

    // Admin: listar altas pendientes de acreditación
    if (action === 'admin-altas-pendientes' && req.method === 'GET') {
      var admTokLA = req.query.token || req.headers['x-admin-token'];
      if (admTokLA !== process.env.ADMIN_TOKEN && admTokLA !== ADMIN_FALLBACK) {
        return res.status(403).json({ error: 'No autorizado' });
      }
      var idxLA = await getJSON('aliados:todos') || [];
      var pendientes = [];
      for (var ia=0; ia<idxLA.length; ia++) {
        var aLA = await getJSON('aliado:' + idxLA[ia]);
        if (!aLA || !aLA.atribuciones) continue;
        for (var ja=0; ja<aLA.atribuciones.length; ja++) {
          var id = aLA.atribuciones[ja];
          if (typeof id !== 'string' || id.indexOf('alta:') !== 0) continue;
          var atLA = await getJSON('atribucion:' + id);
          if (!atLA || atLA.estado !== 'en_curso') continue;
          pendientes.push(atLA);
        }
      }
      pendientes.sort(function(a,b){ return new Date(b.creadaEn) - new Date(a.creadaEn); });
      return res.status(200).json({ ok:true, pendientes: pendientes, total: pendientes.length });
    }

    if (action === 'admin-cambiar-estado' && req.method === 'POST') {
      var admToken4 = req.headers['x-admin-token'];
      if (admToken4 !== process.env.ADMIN_TOKEN && admToken4 !== ADMIN_FALLBACK) {
        return res.status(403).json({ error: 'No autorizado' });
      }
      var ceBody = req.body || {};
      var ceEmail = String(ceBody.email || '').toLowerCase();
      var ceEstado = ceBody.estado; // 'activo' | 'bloqueado'
      if (!['activo','bloqueado'].includes(ceEstado)) return res.status(400).json({ error: 'Estado inválido' });
      var ceAliado = await getJSON('aliado:' + ceEmail);
      if (!ceAliado) return res.status(404).json({ error: 'No encontrado' });
      ceAliado.estado = ceEstado;
      await setJSON('aliado:' + ceEmail, ceAliado);
      return res.status(200).json({ ok:true });
    }

    if (action === 'admin-config' && req.method === 'GET') {
      var admToken5 = req.query.token || req.headers['x-admin-token'];
      if (admToken5 !== process.env.ADMIN_TOKEN && admToken5 !== ADMIN_FALLBACK) {
        return res.status(403).json({ error: 'No autorizado' });
      }
      return res.status(200).json({ ok:true, config: await getConfig() });
    }

    if (action === 'admin-config-update' && req.method === 'POST') {
      var admToken6 = req.headers['x-admin-token'];
      if (admToken6 !== process.env.ADMIN_TOKEN && admToken6 !== ADMIN_FALLBACK) {
        return res.status(403).json({ error: 'No autorizado' });
      }
      var cuBody = req.body || {};
      var currentCfg = await getConfig();
      var newCfg = Object.assign({}, currentCfg);
      if (typeof cuBody.fijoMudanza === 'number') newCfg.fijoMudanza = cuBody.fijoMudanza;
      if (typeof cuBody.fijoFlete === 'number') newCfg.fijoFlete = cuBody.fijoFlete;
      if (typeof cuBody.fijoAlta === 'number') newCfg.fijoAlta = cuBody.fijoAlta;
      if (typeof cuBody.trimPct === 'number') newCfg.trimPct = cuBody.trimPct;
      if (typeof cuBody.trimUmbral === 'number') newCfg.trimUmbral = cuBody.trimUmbral;
      if (typeof cuBody.anualPct === 'number') newCfg.anualPct = cuBody.anualPct;
      if (typeof cuBody.anualUmbral === 'number') newCfg.anualUmbral = cuBody.anualUmbral;
      if (typeof cuBody.cookieDias === 'number') newCfg.cookieDias = cuBody.cookieDias;
      if (typeof cuBody.programaAbierto === 'boolean') newCfg.programaAbierto = cuBody.programaAbierto;
      await setJSON('aliados:config', newCfg);
      return res.status(200).json({ ok:true, config: newCfg });
    }

    if (action === 'admin-ranking' && req.method === 'GET') {
      var admToken7 = req.query.token || req.headers['x-admin-token'];
      if (admToken7 !== process.env.ADMIN_TOKEN && admToken7 !== ADMIN_FALLBACK) {
        return res.status(403).json({ error: 'No autorizado' });
      }
      var periodo = String(req.query.periodo || 'mes'); // mes | trimestre | anio
      var todosEmails = await getJSON('aliados:todos') || [];
      var ranking = [];
      var ahora = new Date();
      var desde;
      if (periodo === 'mes') {
        desde = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
      } else if (periodo === 'trimestre') {
        var m2 = ahora.getMonth();
        var qStart = Math.floor(m2/3)*3;
        desde = new Date(ahora.getFullYear(), qStart, 1);
      } else {
        desde = new Date(ahora.getFullYear(), 0, 1);
      }
      for (var r4=0; r4<todosEmails.length; r4++) {
        var ra = await getJSON('aliado:' + todosEmails[r4]);
        if (!ra) continue;
        var ops = 0, monto = 0;
        for (var x=0; x<(ra.atribuciones||[]).length; x++) {
          var rat = await getJSON('atribucion:' + ra.atribuciones[x]);
          if (!rat || rat.estado === 'cancelada') continue;
          if (rat.tipo === 'bono_trimestral' || rat.tipo === 'bono_anual') continue;
          var rd = new Date(rat.completadaEn || rat.creadaEn);
          if (rd >= desde) { ops++; monto += rat.monto; }
        }
        if (ops > 0) {
          ranking.push({ email: ra.email, nombre: ra.nombre, edificio: ra.edificio, slug: ra.slug, ops: ops, monto: monto });
        }
      }
      ranking.sort(function(a,b){ return b.ops - a.ops || b.monto - a.monto; });
      return res.status(200).json({ ok:true, periodo: periodo, desde: desde.toISOString(), ranking: ranking.slice(0, 10) });
    }

    if (action === 'admin-historial-pagos' && req.method === 'GET') {
      var admToken8 = req.query.token || req.headers['x-admin-token'];
      if (admToken8 !== process.env.ADMIN_TOKEN && admToken8 !== ADMIN_FALLBACK) {
        return res.status(403).json({ error: 'No autorizado' });
      }
      var histP = await getJSON('aliados:pagos') || [];
      histP.sort(function(a,b){ return new Date(b.fecha) - new Date(a.fecha); });
      return res.status(200).json({ ok:true, historial: histP });
    }

    if (action === 'admin-metricas' && req.method === 'GET') {
      var admToken9 = req.query.token || req.headers['x-admin-token'];
      if (admToken9 !== process.env.ADMIN_TOKEN && admToken9 !== ADMIN_FALLBACK) {
        return res.status(403).json({ error: 'No autorizado' });
      }
      var emailsM = await getJSON('aliados:todos') || [];
      var totalAliados = emailsM.length;
      var activos30 = 0, opsMes = 0, pendientePago = 0, totalGenerado = 0;
      var hace30 = new Date(Date.now() - 30*24*60*60*1000);
      var inicioMes = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      for (var mI=0; mI<emailsM.length; mI++) {
        var mA = await getJSON('aliado:' + emailsM[mI]);
        if (!mA) continue;
        var mB = await calcularBalance(emailsM[mI]);
        pendientePago += mB.pendientePago;
        totalGenerado += mB.pagadas.monto + mB.acreditadas.monto;
        // Activo = con operación acreditada en últimos 30 días
        for (var y=0; y<mB.acreditadas.ops.length; y++) {
          var op = mB.acreditadas.ops[y];
          var od = new Date(op.completadaEn || op.creadaEn);
          if (od >= hace30) { activos30++; break; }
        }
        // Ops del mes en curso
        for (var z=0; z<(mA.atribuciones||[]).length; z++) {
          var opAt = await getJSON('atribucion:' + mA.atribuciones[z]);
          if (!opAt || opAt.estado === 'cancelada') continue;
          if (opAt.tipo === 'bono_trimestral' || opAt.tipo === 'bono_anual') continue;
          var oDate = new Date(opAt.completadaEn || opAt.creadaEn);
          if (oDate >= inicioMes) opsMes++;
        }
      }
      return res.status(200).json({
        ok: true,
        metricas: {
          totalAliados: totalAliados,
          activos30: activos30,
          opsMes: opsMes,
          pendientePago: pendientePago,
          totalGenerado: totalGenerado
        }
      });
    }

    return res.status(404).json({ error: 'Acción no encontrada' });
  } catch(e) {
    console.error('aliados handler error:', e);
    return res.status(500).json({ error: 'Error del servidor' });
  }
};
