// api/inmobiliarias.js
//
// Endpoint para gestionar inmobiliarias asociadas a MudateYa.
//
// MODELO DE NEGOCIO:
// - Cada inmobiliaria tiene una URL única: mudateya.ar/inmobiliaria/{slug}
// - El cliente entra a esa URL, ve el branding de la inmobiliaria,
//   y pide su cotización igual que cualquier cliente de MudateYa
//   (mismo precio, mismo flujo).
// - MudateYa le paga una comisión por viaje cerrado a la inmobiliaria.
// - El % de comisión se define por inmobiliaria desde el admin.
//
// REDIS:
//   inmobiliaria:{slug}       → config (nombre, logo, color, comision, contacto, activa)
//   inmobiliarias:lista       → array con todos los slugs (índice para listar)
//
// ACTIONS:
//   GET ?action=listar&token=ADMIN_TOKEN          → lista todas (admin)
//   GET ?action=obtener&slug=X                    → trae una (público, sin token)
//   GET ?action=verificar-matricula&colegio=X&matricula=X → nombre del matriculado (público, solo CUCICBA)
//   GET ?action=auto-branding&sitio=X&token=..    → sugiere logo+color a partir del sitio (admin)
//   POST ?action=crear&token=ADMIN_TOKEN          → alta nueva
//   POST ?action=actualizar&token=ADMIN_TOKEN     → editar existente
//   POST ?action=desactivar&token=ADMIN_TOKEN     → soft delete
//   GET ?action=comisiones&slug=X&token=ADMIN_TOKEN → mudanzas con comisión pendiente para esa inmo

// ── Wrappers Redis (mismo patrón que cotizaciones.js) ──
async function redisCall(method, args) {
  var url   = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  var r = await fetch(url + '/' + method + '/' + args.map(encodeURIComponent).join('/'), {
    headers: { Authorization: 'Bearer ' + token }
  });
  var data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function getJSON(key) {
  var v = await redisCall('get', [key]);
  if (!v) return null;
  try { return JSON.parse(v); } catch(e) { return null; }
}

async function setJSON(key, value) {
  return redisCall('set', [key, JSON.stringify(value)]);
}

// ── Validación de admin ──
// Validación de admin: delegada en api/_auth.js (master token o sesión
// firmada emitida por /api/admin-sesion). Sin fallback hardcodeado.
var { esAdmin } = require('./_auth');

// ── Validación de slug: solo a-z 0-9 y guión ──
function slugValido(slug) {
  if (typeof slug !== 'string') return false;
  if (slug.length < 2 || slug.length > 50) return false;
  return /^[a-z0-9-]+$/.test(slug);
}

// ────────────────────────────────────────────────────────────────────────────
// AUTO-BRANDING: dado el "sitio" que la inmobiliaria puso al pedir el alta,
// buscar su logo en la web y sugerir un color acorde. Es 100% best-effort: si
// algo falla (dominio raro, servicio caído, imagen no reconocida) devuelve
// null y el admin sigue pudiendo cargarlo a mano como hoy — nunca rompe el alta.
// ────────────────────────────────────────────────────────────────────────────

// Extrae un dominio limpio de lo que haya puesto el solicitante en "sitio"
// (puede venir como URL completa, con o sin protocolo/www, o un @usuario de
// Instagram). Devuelve null si no parece un dominio propio usable.
function extraerDominio(sitio) {
  if (typeof sitio !== 'string' || !sitio.trim()) return null;
  var s = sitio.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  s = s.split('/')[0].split('?')[0].split('#')[0].split(':')[0];
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return null;
  // Redes sociales: su favicon es el ícono de la red, no el logo de la
  // inmobiliaria — no vale la pena (ni corresponde) usarlo como su branding.
  var REDES = ['instagram.com', 'facebook.com', 'linkedin.com', 'twitter.com', 'x.com', 'tiktok.com', 'wa.me', 'whatsapp.com'];
  if (REDES.indexOf(s) !== -1) return null;
  return s;
}

// Descarga bytes con timeout corto; devuelve null si falla o no es imagen.
async function descargarImagen(url, ms) {
  try {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, ms || 5000);
    var r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    var ct = r.headers.get('content-type') || '';
    if (ct.indexOf('image') === -1) return null;
    var buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return null;
    return { buffer: buf, contentType: ct.split(';')[0] };
  } catch (e) { return null; }
}

// Cadena de proveedores gratuitos de logo-por-dominio, del de mejor calidad
// al más confiable. El primero que devuelva una imagen real, gana.
async function buscarLogoPorDominio(dominio) {
  var candidatos = [
    'https://logo.clearbit.com/' + dominio + '?size=256',
    'https://www.google.com/s2/favicons?domain=' + dominio + '&sz=256',
  ];
  for (var i = 0; i < candidatos.length; i++) {
    var img = await descargarImagen(candidatos[i]);
    if (img) return { img: img, fuente: i === 0 ? 'clearbit' : 'google-favicon' };
  }
  return null;
}

// Sube el logo re-descargado a Vercel Blob (mismo store/token que usa el resto
// del admin para logos, ver api/upload-foto.js) para no depender de que el
// servicio de terceros siga arriba/accesible a futuro.
async function rehostearLogo(img, slugOrDominio) {
  var blobLib = require('@vercel/blob');
  var ext = (img.contentType.split('/')[1] || 'png').replace('jpeg', 'jpg').split('+')[0];
  var nombre = 'inmobiliarias/auto-' + String(slugOrDominio).replace(/[^a-z0-9-]/g, '-').slice(0, 40) + '-' + Date.now() + '.' + ext;
  var token = process.env.BLOB_FOTO_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;
  var blob = await blobLib.put(nombre, img.buffer, { access: 'public', contentType: img.contentType, token: token });
  return blob.url;
}

// Color dominante "de marca": promedia los píxeles más saturados (no blanco,
// no negro, no transparente, no gris) del logo, ponderando por saturación —
// así un logo con fondo blanco y un isotipo de color no queda promediado a
// gris. Si no encuentra píxeles vívidos (logo en blanco y negro), promedia lo
// no-blanco como segundo intento. Cualquier error → null (no rompe el alta).
async function extraerColorDominante(buffer) {
  try {
    var mod = require('jimp');
    var JimpClase = mod.Jimp || mod.default || mod;
    var img = await JimpClase.read(buffer);
    try { img.resize({ width: 40, height: 40 }); } catch (eResize) { /* seguimos con el tamaño original */ }

    var data = img.bitmap.data, w = img.bitmap.width, h = img.bitmap.height;
    var sumR = 0, sumG = 0, sumB = 0, sumPeso = 0;
    var sumR2 = 0, sumG2 = 0, sumB2 = 0, n2 = 0; // segundo intento: solo descarta blanco/negro/transparente

    for (var i = 0; i < w * h * 4; i += 4) {
      var r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 200) continue;
      var max = Math.max(r, g, b), min = Math.min(r, g, b);
      if (max > 245 && min > 245) continue; // casi blanco
      if (max < 25) continue;               // casi negro
      sumR2 += r; sumG2 += g; sumB2 += b; n2++;
      var sat = max > 0 ? (max - min) / max : 0;
      if (sat < 0.15) continue;             // gris/neutro: no aporta "color de marca"
      sumR += r * sat; sumG += g * sat; sumB += b * sat; sumPeso += sat;
    }

    var rr, gg, bb;
    if (sumPeso > 0) { rr = sumR / sumPeso; gg = sumG / sumPeso; bb = sumB / sumPeso; }
    else if (n2 > 0) { rr = sumR2 / n2; gg = sumG2 / n2; bb = sumB2 / n2; }
    else return null; // logo transparente/blanco puro: no hay nada para extraer

    // Legibilidad: si quedó muy claro para usarse como color de link/acento
    // sobre fondo blanco, lo oscurecemos un poco.
    var luminancia = 0.299 * rr + 0.587 * gg + 0.114 * bb;
    if (luminancia > 200) { rr *= 0.6; gg *= 0.6; bb *= 0.6; }

    var hex = function (n) { return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'); };
    return '#' + hex(rr) + hex(gg) + hex(bb);
  } catch (e) {
    console.warn('[auto-branding] extraerColorDominante:', e.message);
    return null;
  }
}

// ── Sanitizar payload de inmobiliaria ──
function sanitizarInmo(body, slugForzado) {
  var nombre = (typeof body.nombre === 'string') ? body.nombre.trim().slice(0, 100) : '';
  var slug   = slugForzado || ((typeof body.slug === 'string') ? body.slug.trim().toLowerCase().slice(0, 50) : '');
  var logo   = (typeof body.logo === 'string') ? body.logo.trim().slice(0, 500) : '';
  var color  = (typeof body.colorPrimario === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.colorPrimario.trim()))
    ? body.colorPrimario.trim() : '#003580';
  var comision = parseFloat(body.comisionInmobiliaria);
  if (!isFinite(comision) || comision < 0 || comision > 50) comision = 0;
  var contactoEmail  = (typeof body.contactoEmail === 'string') ? body.contactoEmail.trim().slice(0, 120) : '';
  var contactoNombre = (typeof body.contactoNombre === 'string') ? body.contactoNombre.trim().slice(0, 100) : '';
  // WhatsApp del contacto — con esto Emi reconoce a la inmobiliaria cuando
  // escribe (mismo criterio de últimos 8 dígitos que asesores/mudanceros).
  var contactoWhatsapp = (typeof body.contactoWhatsapp === 'string') ? body.contactoWhatsapp.trim().slice(0, 40) : '';
  var activa = body.activa !== false; // default true salvo que se pase false explícito
  return { nombre, slug, logo, colorPrimario: color, comisionInmobiliaria: comision, contactoEmail, contactoNombre, contactoWhatsapp, activa };
}

// ── Agregar slug al índice (idempotente) ──
async function agregarAlIndice(slug) {
  var lista = (await getJSON('inmobiliarias:lista')) || [];
  if (lista.indexOf(slug) === -1) {
    lista.push(slug);
    await setJSON('inmobiliarias:lista', lista);
  }
}

// ── Listar mudanzas con comisión pendiente para una inmobiliaria ──
// Recorre el índice de mudanzas, filtra por partner === slug y completada.
async function comisionesPendientes(slug) {
  var ids = (await getJSON('mudanzas:todos')) || [];
  var resultados = [];
  var totalAdeudado = 0;
  var totalPagado   = 0;
  for (var i = 0; i < ids.length; i++) {
    var m = await getJSON('mudanza:' + ids[i]);
    if (!m) continue;
    if (m.partner !== slug) continue;
    // Solo nos interesan mudanzas que generaron ingreso (completadas o con saldo pagado).
    var generaComision = m.estado === 'completada' || m.saldoPagado === true;
    if (!generaComision) continue;
    var comisionPagar = parseFloat(m.comisionInmobiliariaPagar) || 0;
    var liquidada = m.comisionInmobiliariaLiquidada === true;
    if (liquidada) totalPagado += comisionPagar;
    else           totalAdeudado += comisionPagar;
    resultados.push({
      id: m.id,
      fecha: m.fecha || '',
      fechaCompletada: m.fechaCompletada || m.fechaPublicacion || '',
      cliente: m.clienteNombre || m.clienteEmail || '',
      mudancero: (m.cotizacionAceptada && m.cotizacionAceptada.mudanceroNombre) || '',
      desde: m.desde || '',
      hasta: m.hasta || '',
      precioFinal: parseFloat(m.precioFinal) || parseFloat(m.precio_estimado) || 0,
      comisionPct: parseFloat(m.comisionInmobiliariaPct) || 0,
      comisionPagar: comisionPagar,
      tipoOperacion: m.tipoOperacion || '',
      partnerAsesor: m.partnerAsesor || '',
      liquidada: liquidada,
      fechaLiquidacion: m.fechaLiquidacionInmobiliaria || null
    });
  }
  // Más recientes primero
  resultados.sort(function(a, b) {
    return (new Date(b.fechaCompletada).getTime() || 0) - (new Date(a.fechaCompletada).getTime() || 0);
  });
  return { resultados, totalAdeudado, totalPagado };
}

// ── HANDLER ──
module.exports = async function handler(req, res) {
  // CORS para llamadas desde browser
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  var action = (req.query && req.query.action) || '';

  try {
    // ── PÚBLICO: obtener config de una inmobiliaria ──
    // Lo usa /inmobiliaria/{slug} para renderizar la página.
    if (action === 'obtener' && req.method === 'GET') {
      var slug = (req.query.slug || '').toLowerCase().trim();
      if (!slugValido(slug)) return res.status(400).json({ error: 'Slug inválido' });
      var inmo = await getJSON('inmobiliaria:' + slug);
      if (!inmo) return res.status(404).json({ error: 'Inmobiliaria no encontrada' });
      // Si está desactivada, también devolvemos 404 para que el cliente vea
      // la página de "no encontrado" en lugar de un branding desactivado.
      if (inmo.activa === false) return res.status(404).json({ error: 'Inmobiliaria no disponible' });
      // No exponemos el email de contacto al cliente final
      var publica = {
        nombre: inmo.nombre,
        slug: inmo.slug,
        logo: inmo.logo,
        colorPrimario: inmo.colorPrimario,
        activa: inmo.activa
      };
      return res.status(200).json(publica);
    }

    // ── PÚBLICO: listar nombres+slugs de inmobiliarias ACTIVAS ──
    // Para el autocomplete del campo "inmobiliaria" en asesor-registro.html:
    // si el asesor tipea el nombre de una inmobiliaria real que ya existe,
    // que la elija de una lista en vez de escribir texto libre que no
    // matchea con nada — así queda bien asociada desde el alta, sin
    // depender de que entre por el link específico de su agencia.
    // Solo nombre/slug (nada sensible: ni contacto, ni comisión).
    if (action === 'listar-publico' && req.method === 'GET') {
      var listaPub = (await getJSON('inmobiliarias:lista')) || [];
      var nombresPub = [];
      for (var iPub = 0; iPub < listaPub.length; iPub++) {
        var inmoPub = await getJSON('inmobiliaria:' + listaPub[iPub]);
        if (inmoPub && inmoPub.activa !== false) nombresPub.push({ nombre: inmoPub.nombre, slug: inmoPub.slug });
      }
      return res.status(200).json({ inmobiliarias: nombresPub });
    }

    // ── ADMIN: listar todas ──
    if (action === 'listar' && req.method === 'GET') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      var lista = (await getJSON('inmobiliarias:lista')) || [];
      var todas = [];
      for (var i = 0; i < lista.length; i++) {
        var inmo = await getJSON('inmobiliaria:' + lista[i]);
        if (inmo) todas.push(inmo);
      }
      // Ordenar: activas primero, después por fecha de alta desc
      todas.sort(function(a, b) {
        if (a.activa !== b.activa) return a.activa ? -1 : 1;
        return (new Date(b.fechaAlta).getTime() || 0) - (new Date(a.fechaAlta).getTime() || 0);
      });
      return res.status(200).json({ inmobiliarias: todas });
    }

    // ── PÚBLICO: solicitar alta como inmobiliaria ──
    // Form en /inmobiliarias-registro.html. NO crea la inmobiliaria activa,
    // solo guarda una solicitud pendiente que después Galo revisa desde admin.
    // Manda 2 emails: al solicitante (confirmación) y a Galo (notificación).
    if (action === 'solicitar-alta' && req.method === 'POST') {
      // El body puede llegar como objeto (Vercel parsea JSON automaticamente si
      // Content-Type es application/json) o como string. Manejamos ambos casos.
      var body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch(e) { body = {}; }
      }
      body = body || {};
      console.log('[solicitar-alta] body recibido:', JSON.stringify(body).slice(0, 500));

      var nombre   = (body.nombre || '').toString().trim().slice(0, 80);
      var contacto = (body.contacto || '').toString().trim().slice(0, 80);
      var email    = (body.email || '').toString().trim().toLowerCase().slice(0, 100);
      var wapp     = (body.whatsapp || '').toString().trim().slice(0, 50);
      var colegio  = (body.colegio || '').toString().trim().slice(0, 80);
      var matricula= (body.matricula || '').toString().trim().slice(0, 20);
      // Opcionales: el form rápido ya no los pide, pero si algún caller viejo
      // los manda, los seguimos guardando (no se pierden, no bloquean el alta).
      var zona     = (body.zona || '').toString().trim().slice(0, 120);
      var opsMes   = (body.operacionesPorMes || '').toString().trim().slice(0, 20);
      var sitio    = (body.sitio || '').toString().trim().slice(0, 120);
      var logoUrl  = (body.logoUrl || '').toString().trim().slice(0, 500);
      // De dónde vino el registro (ej. "expo-realestate-2026") — puramente
      // informativo, no bloquea ni valida nada si no viene.
      var origen   = (body.origen || '').toString().trim().slice(0, 60);

      // Validaciones mínimas — devolvemos cada faltante en castellano legible
      var faltan = [];
      if (!nombre)   faltan.push('nombre de la inmobiliaria');
      if (!contacto) faltan.push('tu nombre');
      if (!email)    faltan.push('email');
      if (!wapp)     faltan.push('WhatsApp');
      if (!colegio)  faltan.push('colegio profesional');
      if (!matricula) faltan.push('número de matrícula');
      if (faltan.length > 0) {
        console.warn('[solicitar-alta] faltan campos:', faltan.join(', '));
        return res.status(400).json({ error: 'Faltan datos: ' + faltan.join(', ') });
      }
      // Validación básica de email
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Email inválido' });
      }

      // ── VERIFICAR DUPLICADO: si ese email ya se registró antes (auto-alta
      // previa, o reenvío del mismo form), no crear una inmobiliaria nueva —
      // devolvemos la que ya existe. ──
      var yaExisteId = await getJSON('solicitud-inmo:email:' + email);
      if (yaExisteId) {
        var solicitudPrevia = await getJSON('solicitud-inmo:' + yaExisteId);
        if (solicitudPrevia && solicitudPrevia.slugAsignado) {
          return res.status(200).json({
            ok: true, existente: true,
            mensaje: 'Ese email ya está registrado. Revisá tu casilla — ya te mandamos el link para tus asesores.',
            slug: solicitudPrevia.slugAsignado
          });
        }
      }
      var listaActivas = (await getJSON('inmobiliarias:lista')) || [];
      for (var iAct = 0; iAct < listaActivas.length; iAct++) {
        var inmoAct = await getJSON('inmobiliaria:' + listaActivas[iAct]);
        if (inmoAct && inmoAct.activa !== false && String(inmoAct.contactoEmail || '').toLowerCase() === email) {
          return res.status(200).json({
            ok: true, existente: true, yaActiva: true,
            mensaje: 'Ese email ya es una inmobiliaria activa en MudateYa. Si necesitás algo, escribinos a contacto@mudateya.ar.',
            slug: inmoAct.slug
          });
        }
      }

      // ── Generar un slug único a partir del nombre (el form público no pide
      // slug — antes lo elegía un admin a mano en /admin → Nueva). ──
      var slugBase = String(nombre).toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '') // sacar acentos
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'inmobiliaria';
      var slugFinal = slugBase;
      var intentoSlug = 1;
      while (await getJSON('inmobiliaria:' + slugFinal)) {
        intentoSlug++;
        slugFinal = slugBase + '-' + intentoSlug;
      }

      // Persistir la solicitud igual que antes (auditoría + índice de
      // duplicados por email), pero ya no queda "pendiente": se aprueba sola.
      var ts = Date.now();
      var idSolicitud = 'sol-inmo-' + ts;
      var solicitud = {
        id: idSolicitud,
        nombre: nombre,
        contacto: contacto,
        email: email,
        whatsapp: wapp,
        colegio: colegio,
        matricula: matricula,
        zona: zona,
        operacionesPorMes: opsMes,
        sitio: sitio,
        logoUrl: logoUrl,
        origen: origen,
        fechaSolicitud: new Date(ts).toISOString(),
        estado: 'auto-aprobada',  // 'auto-aprobada' | 'rechazada' (ya no hay 'pendiente': se activa sola)
        slugAsignado: slugFinal
      };
      await setJSON('solicitud-inmo:' + idSolicitud, solicitud);
      await setJSON('solicitud-inmo:email:' + email, idSolicitud);
      // NOTA: ya no se agrega a solicitudes-inmo:pendientes — no hay nada que
      // un admin tenga que revisar/aprobar a mano, así que no debe aparecer
      // en la cola de /admin → Solicitudes.

      // ── Crear la inmobiliaria YA, activa ──
      // Mismos campos/defaults que la alta manual (action=crear): sin logo ni
      // color propio (branding default de MudateYa), comisión en 0 (usa el
      // default global de la plataforma al liquidar, ver COMISION_ASESOR_DEFAULT
      // en cotizaciones.js). colegio/matricula quedan igual en el registro por
      // si hace falta verificar algo después — no bloquean el alta.
      var dataInmo = {
        nombre: nombre, slug: slugFinal, logo: '', colorPrimario: '#003580',
        comisionInmobiliaria: 0, contactoEmail: email, contactoNombre: contacto,
        contactoWhatsapp: wapp, activa: true, fechaAlta: new Date(ts).toISOString(),
        colegio: colegio, matricula: matricula, origen: origen
      };
      await setJSON('inmobiliaria:' + slugFinal, dataInmo);
      await agregarAlIndice(slugFinal);

      // Índice teléfono→inmobiliaria (últimos 8 dígitos) para que Emi (WhatsApp)
      // reconozca al contacto al instante, sin esperar el backfill de 24hs
      // (asegurarIndiceInmobiliarias en whatsapp.js). Mismo patrón que
      // mudanceros:tel8-idx en registrar-mudancero.js. En try/catch: si
      // falla, no afecta el alta.
      try {
        var _tel8Inmo = wapp.replace(/\D/g, '').slice(-8);
        if (_tel8Inmo.length === 8) await redisCall('hset', ['inmocontacto:tel8-idx', _tel8Inmo, slugFinal]);
      } catch (e) { console.warn('idx tel8 inmo:', e.message); }

      var urlRegistroAsesores = 'https://mudateya.ar/inmobiliaria/' + slugFinal + '/registro';

      // ── Mails (no rompemos el flow si fallan: la inmobiliaria ya quedó activa) ──
      try {
        const { Resend } = require('resend');
        const resend = new Resend(process.env.RESEND_API_KEY);

        // (1) Bienvenida instantánea, con el link para repartir entre sus asesores
        await resend.emails.send({
          from: 'MudateYa <noreply@mudateya.ar>', reply_to:'contacto@mudateya.ar',
          to: email,
          subject: '🎉 ¡Bienvenida a MudateYa, ' + nombre + '!',
          html: `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#FAFAFA">
            <div style="font-family:Arial,sans-serif;max-width:580px;margin:24px auto;background:#fff;border:1px solid #E5E7EB;border-radius:16px;overflow:hidden">
              <div style="background:#003580;padding:24px 28px;text-align:center">
                <div><span style="font-family:Georgia,serif;font-size:24px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:24px;font-weight:900;color:#22C36A">Ya</span></div>
              </div>
              <div style="padding:28px">
                <h1 style="margin:0 0 10px;color:#0F1419;font-size:24px;font-weight:800;line-height:1.2">Cuenta activada</h1>
                <p style="color:#4B5563;line-height:1.6;font-size:15px;margin-bottom:22px">${nombre} ya es parte de MudateYa. Cada asesor de tu equipo va a tener su propio link, con tu marca, para que sus clientes consigan mudanceros verificados.</p>

                <div style="background:linear-gradient(135deg,#003580 0%,#0055B8 100%);border-radius:14px;padding:22px;margin:20px 0;text-align:center">
                  <div style="color:#B8D4FF;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px">Link de registro para tus asesores</div>
                  <div style="color:#fff;font-size:16px;font-weight:800;font-family:'Courier New',monospace;word-break:break-all;margin-bottom:14px">${urlRegistroAsesores}</div>
                  <a href="${urlRegistroAsesores}" style="display:inline-block;background:#22C36A;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">Abrir el registro →</a>
                </div>

                <div style="margin-top:24px;padding:16px;background:#FAFBFC;border:1px solid #E5E7EB;border-radius:10px;font-size:13px;color:#4B5563">
                  <div style="font-size:11px;color:#9CA3AF;font-weight:800;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:8px">Datos de tu cuenta</div>
                  <div style="margin-bottom:4px"><strong style="color:#0F1419">Nombre:</strong> ${nombre}</div>
                  <div style="margin-bottom:4px"><strong style="color:#0F1419">Slug:</strong> ${slugFinal}</div>
                </div>

                <div style="background:#F0FFF4;border:1px solid #BBF7D0;border-radius:10px;padding:16px 18px;margin-top:24px;text-align:center">
                  <div style="margin:0 0 10px;font-size:13px;color:#166534;font-weight:600">📱 Cualquier duda, hablá con Emi por WhatsApp</div>
                  <a href="https://wa.me/12399462954?text=${encodeURIComponent('Hola Emi!')}" style="display:inline-block;background:#22C36A;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;font-size:13px;font-weight:700">Escribirle a Emi →</a>
                </div>

                <div style="text-align:center;margin:28px 0 0">
                  <a href="https://www.instagram.com/mudateya.ar" style="display:inline-block;padding:9px 20px;border:1px solid #E2E8F0;border-radius:20px;color:#0F1923;text-decoration:none;font-size:13px;font-weight:600">📷 @mudateya.ar en Instagram</a>
                </div>

                <p style="color:#4B5563;font-size:14px;margin-top:24px;line-height:1.6">¿Dudas o querés que te ayudemos a armar tu primer envío a tus asesores? Escribinos a <a href="mailto:contacto@mudateya.ar" style="color:#1A6FFF;font-weight:700">contacto@mudateya.ar</a> y te respondemos rápido.</p>
                <p style="color:#9CA3AF;font-size:13px;margin-top:18px">¡Bienvenida al equipo!<br><strong>El equipo de MudateYa</strong></p>
              </div>
              <div style="background:#F5F8FC;padding:14px 28px;font-size:11px;color:#9CA3AF;text-align:center">
                MudateYa · marketplace de mudanzas verificadas en Argentina · <a href="https://mudateya.ar" style="color:#9CA3AF">mudateya.ar</a>
              </div>
            </div></body></html>`
        });

        // (2) Aviso a Galo, informativo — ya no hace falta aprobar nada
        await resend.emails.send({
          from: 'MudateYa <noreply@mudateya.ar>', reply_to:'contacto@mudateya.ar',
          to: 'jgalozaldivar@gmail.com',
          subject: '🏢 Nueva inmobiliaria auto-activada: ' + nombre,
          html: `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#FAFAFA">
            <div style="font-family:Arial,sans-serif;max-width:560px;margin:24px auto;background:#fff;border:1px solid #E5E7EB;border-radius:16px;overflow:hidden">
              <div style="background:#003580;padding:20px 28px">
                <span style="color:#fff;font-size:14px;font-weight:700">🏢 Nueva inmobiliaria · auto-activada</span>
              </div>
              <div style="padding:24px 28px">
                <h2 style="margin:0 0 14px;color:#0F1419;font-size:18px">${nombre}</h2>
                <table style="width:100%;font-size:14px;color:#4B5563;border-collapse:collapse">
                  <tr><td style="padding:6px 0;width:36%;color:#9CA3AF;border-bottom:1px solid #F3F4F6">Slug</td><td style="font-weight:600;color:#0F1419;border-bottom:1px solid #F3F4F6">${slugFinal}</td></tr>
                  <tr><td style="padding:6px 0;color:#9CA3AF;border-bottom:1px solid #F3F4F6">Contacto</td><td style="font-weight:600;color:#0F1419;border-bottom:1px solid #F3F4F6">${contacto}</td></tr>
                  <tr><td style="padding:6px 0;color:#9CA3AF;border-bottom:1px solid #F3F4F6">Email</td><td style="color:#0F1419;border-bottom:1px solid #F3F4F6"><a href="mailto:${email}" style="color:#1A6FFF">${email}</a></td></tr>
                  <tr><td style="padding:6px 0;color:#9CA3AF;border-bottom:1px solid #F3F4F6">WhatsApp</td><td style="color:#0F1419;border-bottom:1px solid #F3F4F6">${wapp}</td></tr>
                  <tr><td style="padding:6px 0;color:#9CA3AF;border-bottom:1px solid #F3F4F6">Colegio / Matrícula</td><td style="color:#0F1419;border-bottom:1px solid #F3F4F6">${colegio} / ${matricula}</td></tr>
                  <tr><td style="padding:6px 0;color:#9CA3AF;border-bottom:1px solid #F3F4F6">Zona</td><td style="color:#0F1419;border-bottom:1px solid #F3F4F6">${zona}</td></tr>
                  <tr><td style="padding:6px 0;color:#9CA3AF">Ops/mes</td><td style="color:#0F1419">${opsMes}</td></tr>
                </table>
                <div style="margin-top:18px;padding:12px 14px;background:#F0FFF4;border-radius:8px;font-size:13px;color:#166534">
                  ✅ Se activó sola y ya le mandamos el link de registro de asesores. Si algo no corresponde, desactivala desde <a href="https://mudateya.ar/admin" style="color:#003580;font-weight:700">/admin → Inmobiliarias</a>.
                </div>
              </div>
            </div></body></html>`
        });
      } catch(emailErr) {
        console.error('[solicitar-alta] Error mandando emails:', emailErr && emailErr.message);
        // No bloqueamos el flow: la inmobiliaria ya quedó activa en Redis.
      }

      return res.status(200).json({ ok: true, id: idSolicitud, slug: slugFinal, urlAsesores: urlRegistroAsesores });
    }

    // ── PÚBLICO: verificar una matrícula contra el padrón oficial ──
    // Lo usa el form de alta (inmobiliarias-registro.html) para autocompletar
    // el nombre del matriculado apenas escribe su número, así no lo tipea a mano.
    //
    // Por ahora SOLO cubre CUCICBA (CABA): es el único colegio de los ~21 del
    // dropdown con una consulta pública que devuelve el nombre a partir del
    // número (confirmado a mano). El padrón único de la Provincia de Bs. As.
    // (los otros ~20 colegios) tiene búsqueda pública pero NO expone la
    // matrícula en los resultados, así que no se puede resolver número→nombre
    // ahí — para esos, sigue siendo carga manual.
    //
    // Best-effort SIEMPRE: cualquier falla (timeout, cambio de formato del
    // 3ro, sin conexión) devuelve encontrado:false, nunca rompe el alta.
    // GET ?action=verificar-matricula&colegio=X&matricula=1234
    if (action === 'verificar-matricula' && req.method === 'GET') {
      var colegioVer   = String(req.query.colegio || '');
      var matriculaVer = String(req.query.matricula || '').trim();

      if (!/^\d{1,10}$/.test(matriculaVer) || colegioVer.indexOf('CUCICBA') === -1) {
        return res.status(200).json({ ok: true, encontrado: false });
      }

      try {
        var ctrlVer = new AbortController();
        var tVer = setTimeout(function () { ctrlVer.abort(); }, 5000);
        var rVer = await fetch(
          'https://colegioinmobiliario.org.ar/servicios/guia-de-matriculados/buscar?q=' +
          encodeURIComponent(matriculaVer) + '&limit=5&offset=0',
          { signal: ctrlVer.signal }
        );
        clearTimeout(tVer);
        if (!rVer.ok) return res.status(200).json({ ok: true, encontrado: false });
        var dVer = await rVer.json();
        var matchVer = ((dVer && dVer.data) || []).find(function (p) {
          return String(p.matricula) === matriculaVer;
        });
        if (!matchVer) return res.status(200).json({ ok: true, encontrado: false });
        return res.status(200).json({
          ok: true, encontrado: true,
          nombre: matchVer.nombre || '', apellido: matchVer.apellido || ''
        });
      } catch (eVer) {
        console.warn('[verificar-matricula] no disponible:', eVer.message);
        return res.status(200).json({ ok: true, encontrado: false });
      }
    }

    // ── ADMIN: listar solicitudes pendientes de inmobiliarias ──
    if (action === 'listar-solicitudes' && req.method === 'GET') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      var idxSol = (await getJSON('solicitudes-inmo:pendientes')) || [];
      var solicitudes = [];
      for (var s = 0; s < idxSol.length; s++) {
        var sol = await getJSON('solicitud-inmo:' + idxSol[s]);
        if (sol) solicitudes.push(sol);
      }
      return res.status(200).json({ solicitudes: solicitudes });
    }

    // ── ADMIN: marcar solicitud como procesada (aprobada o rechazada) ──
    // No borra la solicitud del storage (queda como historial), solo la saca
    // del índice de pendientes y le cambia el estado.
    if (action === 'procesar-solicitud' && req.method === 'POST') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      var bodyP = req.body || {};
      var idP = (bodyP.id || '').toString().trim();
      var nuevoEstado = (bodyP.estado || 'aprobada').toString().trim();
      if (!idP) return res.status(400).json({ error: 'ID requerido' });
      var solP = await getJSON('solicitud-inmo:' + idP);
      if (!solP) return res.status(404).json({ error: 'Solicitud no encontrada' });
      solP.estado = nuevoEstado;
      solP.fechaProcesada = new Date().toISOString();
      await setJSON('solicitud-inmo:' + idP, solP);
      // Sacar del índice de pendientes
      var idxRem = (await getJSON('solicitudes-inmo:pendientes')) || [];
      idxRem = idxRem.filter(function(x){ return x !== idP; });
      await setJSON('solicitudes-inmo:pendientes', idxRem);
      return res.status(200).json({ ok: true });
    }

    // ── ADMIN: auto-branding — buscar logo + color, o solo color si ya hay logo ──
    // Best-effort: SIEMPRE devuelve 200. logo/colorPrimario pueden venir null
    // si no se pudo detectar nada; el admin sigue pudiendo cargarlo a mano.
    // No persiste nada — el admin ve la sugerencia y confirma/edita antes de
    // guardar (mismo flujo de "crear"/"actualizar" de siempre).
    //
    // Dos modos:
    //   ?logoUrl=X          → la inmobiliaria ya subió su propio logo al pedir
    //                         el alta: no buscamos otro, solo le sacamos el
    //                         color a ESE logo.
    //   ?sitio=dominio.com  → no hay logo propio: lo buscamos por dominio
    //                         (Clearbit / favicon de Google), lo re-hosteamos
    //                         en nuestro Blob, y le sacamos el color.
    if (action === 'auto-branding' && req.method === 'GET') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });

      var logoUrlDado = (req.query.logoUrl || '').trim();
      if (logoUrlDado) {
        var imgDado = await descargarImagen(logoUrlDado, 6000);
        if (!imgDado) return res.status(200).json({ ok: true, logo: null, colorPrimario: null, motivo: 'no se pudo leer el logo provisto' });
        var colorDeDado = await extraerColorDominante(imgDado.buffer);
        return res.status(200).json({ ok: true, logo: null, colorPrimario: colorDeDado, fuente: 'logo-provisto' });
      }

      var dominio = extraerDominio(req.query.sitio || '');
      if (!dominio) return res.status(200).json({ ok: true, logo: null, colorPrimario: null, motivo: 'sin dominio propio detectable' });

      var encontrado = await buscarLogoPorDominio(dominio);
      if (!encontrado) return res.status(200).json({ ok: true, logo: null, colorPrimario: null, motivo: 'no se encontró logo para ' + dominio });

      var logoUrl = null, colorPrimario = null;
      try { logoUrl = await rehostearLogo(encontrado.img, req.query.slug || dominio); }
      catch (e) { console.warn('[auto-branding] rehostear:', e.message); }
      colorPrimario = await extraerColorDominante(encontrado.img.buffer);

      return res.status(200).json({ ok: true, logo: logoUrl, colorPrimario: colorPrimario, fuente: encontrado.fuente, dominio: dominio });
    }

    // ── ADMIN: crear nueva ──
    if (action === 'crear' && req.method === 'POST') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      var body = req.body || {};
      if (!body.nombre) return res.status(400).json({ error: 'Nombre requerido' });
      if (!body.slug)   return res.status(400).json({ error: 'Slug requerido' });
      if (!slugValido(body.slug.toLowerCase())) {
        return res.status(400).json({ error: 'Slug inválido: solo letras minúsculas, números y guiones' });
      }
      var existente = await getJSON('inmobiliaria:' + body.slug.toLowerCase());
      if (existente) return res.status(409).json({ error: 'Ya existe una inmobiliaria con ese slug' });

      var data = sanitizarInmo(body);
      // Decisión: las inmobiliarias que se dan de alta de acá en más van SIN
      // logo, solo nombre + los colores default de MudateYa — se ignora
      // cualquier logo/color que venga en el body (auto-branding incluido),
      // para no depender de un logo de terceros que se pueda romper o quedar
      // desactualizado. Si en el futuro se quiere volver a permitir logo
      // propio, sacar estas dos líneas alcanza.
      data.logo = '';
      data.colorPrimario = '#003580';
      data.fechaAlta = new Date().toISOString();
      data.activa = true;
      await setJSON('inmobiliaria:' + data.slug, data);
      await agregarAlIndice(data.slug);

      // ── Mail de bienvenida a la inmobiliaria (opcional, controlado por flag) ──
      // El admin puede marcar/desmarcar el checkbox "Enviar mail de bienvenida"
      // antes de guardar. Si está activado y hay email, mandamos el mail con la
      // URL única y las instrucciones para compartirla con sus clientes.
      var enviarBienvenida = body.enviarBienvenida !== false; // default true
      if (enviarBienvenida && data.contactoEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.contactoEmail)) {
        try {
          const { Resend } = require('resend');
          const resend = new Resend(process.env.RESEND_API_KEY);
          var urlInmo = 'https://mudateya.ar/inmobiliaria/' + data.slug;
          var urlRegistroAsesores = urlInmo + '/registro';
          var saludo = data.contactoNombre ? data.contactoNombre.split(' ')[0] : data.nombre;

          await resend.emails.send({
            from: 'MudateYa <noreply@mudateya.ar>', reply_to:'contacto@mudateya.ar',
            to: data.contactoEmail,
            subject: '🎉 ¡Bienvenida a MudateYa, ' + data.nombre + '!',
            html: `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#FAFAFA">
              <div style="font-family:Arial,sans-serif;max-width:580px;margin:24px auto;background:#fff;border:1px solid #E5E7EB;border-radius:16px;overflow:hidden">
                <!-- Header -->
                <div style="background:#003580;padding:24px 28px;text-align:center">
                  <div><span style="font-family:Georgia,serif;font-size:24px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:24px;font-weight:900;color:#22C36A">Ya</span></div>
                </div>
                <!-- Body -->
                <div style="padding:28px">
                  <h1 style="margin:0 0 10px;color:#0F1419;font-size:24px;font-weight:800;line-height:1.2">Cuenta activada</h1>
                  <p style="color:#4B5563;line-height:1.6;font-size:15px;margin-bottom:22px">${data.nombre} ya es parte de MudateYa. Cada asesor de tu equipo va a tener su propio link, con tu marca, para que sus clientes consigan mudanceros verificados.</p>

                  <!-- Link de registro para asesores -->
                  <div style="background:linear-gradient(135deg,#003580 0%,#0055B8 100%);border-radius:14px;padding:22px;margin:20px 0;text-align:center">
                    <div style="color:#B8D4FF;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px">Link de registro para tus asesores</div>
                    <div style="color:#fff;font-size:16px;font-weight:800;font-family:'Courier New',monospace;word-break:break-all;margin-bottom:14px">${urlRegistroAsesores}</div>
                    <a href="${urlRegistroAsesores}" style="display:inline-block;background:#22C36A;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">Abrir el registro →</a>
                  </div>

                  <!-- Datos cuenta -->
                  <div style="margin-top:24px;padding:16px;background:#FAFBFC;border:1px solid #E5E7EB;border-radius:10px;font-size:13px;color:#4B5563">
                    <div style="font-size:11px;color:#9CA3AF;font-weight:800;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:8px">Datos de tu cuenta</div>
                    <div style="margin-bottom:4px"><strong style="color:#0F1419">Nombre:</strong> ${data.nombre}</div>
                    <div style="margin-bottom:4px"><strong style="color:#0F1419">Slug:</strong> ${data.slug}</div>
                    ${data.comisionInmobiliaria ? `<div style="margin-bottom:4px"><strong style="color:#0F1419">Comisión:</strong> ${data.comisionInmobiliaria}% sobre cada mudanza concretada</div>` : ''}
                  </div>

                  <!-- CTA Emi (WhatsApp) -->
                  <div style="background:#F0FFF4;border:1px solid #BBF7D0;border-radius:10px;padding:16px 18px;margin-top:24px;text-align:center">
                    <div style="margin:0 0 10px;font-size:13px;color:#166534;font-weight:600">📱 Cualquier duda, hablá con Emi por WhatsApp</div>
                    <a href="https://wa.me/12399462954?text=${encodeURIComponent('Hola Emi!')}" style="display:inline-block;background:#22C36A;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;font-size:13px;font-weight:700">Escribirle a Emi →</a>
                  </div>

                  <!-- CTA Instagram -->
                  <div style="text-align:center;margin:28px 0 0">
                    <a href="https://www.instagram.com/mudateya.ar" style="display:inline-block;padding:9px 20px;border:1px solid #E2E8F0;border-radius:20px;color:#0F1923;text-decoration:none;font-size:13px;font-weight:600">📷 @mudateya.ar en Instagram</a>
                  </div>

                  <!-- Soporte -->
                  <p style="color:#4B5563;font-size:14px;margin-top:24px;line-height:1.6">¿Dudas o querés que te ayudemos a armar tu primer envío a clientes? Escribinos a <a href="mailto:contacto@mudateya.ar" style="color:#1A6FFF;font-weight:700">contacto@mudateya.ar</a> y te respondemos rápido.</p>
                  <p style="color:#9CA3AF;font-size:13px;margin-top:18px">¡Bienvenida al equipo!<br><strong>El equipo de MudateYa</strong></p>
                </div>
                <!-- Footer -->
                <div style="background:#F5F8FC;padding:14px 28px;font-size:11px;color:#9CA3AF;text-align:center">
                  MudateYa · marketplace de mudanzas verificadas en Argentina · <a href="https://mudateya.ar" style="color:#9CA3AF">mudateya.ar</a>
                </div>
              </div></body></html>`
          });
          console.log('[crear-inmo] mail de bienvenida enviado a', data.contactoEmail);
        } catch(emailErr) {
          // No bloqueamos: la inmobiliaria ya quedó creada. El mail es nice-to-have.
          console.error('[crear-inmo] Error mandando mail de bienvenida:', emailErr && emailErr.message);
        }
      }

      return res.status(200).json({ ok: true, inmobiliaria: data });
    }

    // ── ADMIN: actualizar existente ──
    if (action === 'actualizar' && req.method === 'POST') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      var body = req.body || {};
      var slug = (body.slug || '').toLowerCase().trim();
      if (!slugValido(slug)) return res.status(400).json({ error: 'Slug inválido' });
      var actual = await getJSON('inmobiliaria:' + slug);
      if (!actual) return res.status(404).json({ error: 'Inmobiliaria no encontrada' });

      // Mantener slug y fechaAlta originales, actualizar el resto
      var data = sanitizarInmo(body, slug);
      data.fechaAlta = actual.fechaAlta;
      data.fechaActualizacion = new Date().toISOString();
      // Si vienen explícitamente como inactiva, respetar; sino mantener
      if (typeof body.activa === 'boolean') data.activa = body.activa;
      await setJSON('inmobiliaria:' + slug, data);
      return res.status(200).json({ ok: true, inmobiliaria: data });
    }

    // ── ADMIN: desactivar (soft delete) ──
    // No borramos para no perder histórico de pedidos. Solo marcamos activa=false.
    if (action === 'desactivar' && req.method === 'POST') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      var body = req.body || {};
      var slug = (body.slug || '').toLowerCase().trim();
      if (!slugValido(slug)) return res.status(400).json({ error: 'Slug inválido' });
      var actual = await getJSON('inmobiliaria:' + slug);
      if (!actual) return res.status(404).json({ error: 'Inmobiliaria no encontrada' });
      actual.activa = false;
      actual.fechaDesactivacion = new Date().toISOString();
      await setJSON('inmobiliaria:' + slug, actual);
      return res.status(200).json({ ok: true });
    }

    // ── ADMIN: reactivar ──
    if (action === 'reactivar' && req.method === 'POST') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      var body = req.body || {};
      var slug = (body.slug || '').toLowerCase().trim();
      if (!slugValido(slug)) return res.status(400).json({ error: 'Slug inválido' });
      var actual = await getJSON('inmobiliaria:' + slug);
      if (!actual) return res.status(404).json({ error: 'Inmobiliaria no encontrada' });
      actual.activa = true;
      actual.fechaDesactivacion = null;
      await setJSON('inmobiliaria:' + slug, actual);
      return res.status(200).json({ ok: true });
    }

    // ── ADMIN: contar mudanzas asociadas (preview antes de eliminar) ──
    // Devuelve cantidad de mudanzas que tienen partner === slug. Sirve para
    // que el admin sepa qué impacto va a tener un eliminado permanente.
    if (action === 'contar-mudanzas' && req.method === 'GET') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      var slugC = (req.query.slug || '').toLowerCase().trim();
      if (!slugValido(slugC)) return res.status(400).json({ error: 'Slug inválido' });
      var idsC = (await getJSON('mudanzas:todos')) || [];
      var totalC = 0;
      for (var iC = 0; iC < idsC.length; iC++) {
        var mC = await getJSON('mudanza:' + idsC[iC]);
        if (mC && mC.partner === slugC) totalC++;
      }
      return res.status(200).json({ slug: slugC, mudanzasAsociadas: totalC });
    }

    // ── ADMIN: eliminar permanentemente (hard delete) ──
    // Borra la inmobiliaria de Redis (key inmobiliaria:{slug}) y la saca del
    // índice inmobiliarias:lista. ESTO ES IRREVERSIBLE.
    //
    // Guardrails:
    //   1. Solo permitido si la inmobiliaria está YA desactivada (activa=false).
    //   2. El body debe incluir confirmar=true para evitar borrados por accidente.
    //   3. No tocamos las mudanzas históricas que tenían partner=slug. Quedan
    //      con partner referenciando un slug que ya no existe, pero los datos
    //      financieros y de viaje siguen siendo válidos para reportes.
    if (action === 'eliminar' && req.method === 'POST') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      var bodyE = req.body || {};
      var slugE = (bodyE.slug || '').toLowerCase().trim();
      if (!slugValido(slugE)) return res.status(400).json({ error: 'Slug inválido' });
      if (bodyE.confirmar !== true) {
        return res.status(400).json({ error: 'Falta confirmación explícita (confirmar:true)' });
      }
      var actualE = await getJSON('inmobiliaria:' + slugE);
      if (!actualE) return res.status(404).json({ error: 'Inmobiliaria no encontrada' });
      // Guardrail 1: solo permitir eliminar si ya está desactivada
      if (actualE.activa !== false) {
        return res.status(400).json({ error: 'Primero desactivá la inmobiliaria. Después podés eliminarla permanentemente.' });
      }
      // Borrar la key de Redis
      await redisCall('del', ['inmobiliaria:' + slugE]);
      // Sacar del índice de slugs
      var listaE = (await getJSON('inmobiliarias:lista')) || [];
      listaE = listaE.filter(function(s){ return s !== slugE; });
      await setJSON('inmobiliarias:lista', listaE);
      console.log('[eliminar-inmo] borrada permanentemente:', slugE);
      return res.status(200).json({ ok: true, slug: slugE });
    }

    // ── ADMIN: listar comisiones (pendientes y liquidadas) por inmobiliaria ──
    // Si no se pasa slug, devuelve todas.
    if (action === 'comisiones' && req.method === 'GET') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      var slug = (req.query.slug || '').toLowerCase().trim();
      if (slug) {
        if (!slugValido(slug)) return res.status(400).json({ error: 'Slug inválido' });
        var data = await comisionesPendientes(slug);
        return res.status(200).json(data);
      }
      // Todas las inmobiliarias
      var lista = (await getJSON('inmobiliarias:lista')) || [];
      var todas = [];
      for (var j = 0; j < lista.length; j++) {
        var d = await comisionesPendientes(lista[j]);
        var inmo = await getJSON('inmobiliaria:' + lista[j]);
        todas.push({
          slug: lista[j],
          nombre: (inmo && inmo.nombre) || lista[j],
          totalAdeudado: d.totalAdeudado,
          totalPagado: d.totalPagado,
          cantidad: d.resultados.length,
          resultados: d.resultados
        });
      }
      return res.status(200).json({ inmobiliarias: todas });
    }

    // ── ADMIN: marcar una mudanza como liquidada ──
    if (action === 'marcar-liquidada' && req.method === 'POST') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      var body = req.body || {};
      var id = (body.mudanzaId || '').trim();
      if (!id) return res.status(400).json({ error: 'mudanzaId requerido' });
      var mudanza = await getJSON('mudanza:' + id);
      if (!mudanza) return res.status(404).json({ error: 'Mudanza no encontrada' });
      mudanza.comisionInmobiliariaLiquidada = true;
      mudanza.fechaLiquidacionInmobiliaria = new Date().toISOString();
      await setJSON('mudanza:' + id, mudanza);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Acción no reconocida', action: action });
  } catch (e) {
    console.error('inmobiliarias.js error:', e.message, e.stack);
    return res.status(500).json({ error: e.message });
  }
};
