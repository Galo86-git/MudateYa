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
function esAdmin(req) {
  var token = (req.query && req.query.token) || '';
  return token === process.env.ADMIN_TOKEN || token === 'mya-admin-2026';
}

// ── Validación de slug: solo a-z 0-9 y guión ──
function slugValido(slug) {
  if (typeof slug !== 'string') return false;
  if (slug.length < 2 || slug.length > 50) return false;
  return /^[a-z0-9-]+$/.test(slug);
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
  var activa = body.activa !== false; // default true salvo que se pase false explícito
  return { nombre, slug, logo, colorPrimario: color, comisionInmobiliaria: comision, contactoEmail, contactoNombre, activa };
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
      var zona     = (body.zona || '').toString().trim().slice(0, 120);
      var opsMes   = (body.operacionesPorMes || '').toString().trim().slice(0, 20);
      var sitio    = (body.sitio || '').toString().trim().slice(0, 120);
      var logoUrl  = (body.logoUrl || '').toString().trim().slice(0, 500);

      // Validaciones mínimas — devolvemos cada faltante en castellano legible
      var faltan = [];
      if (!nombre)   faltan.push('nombre de la inmobiliaria');
      if (!contacto) faltan.push('tu nombre');
      if (!email)    faltan.push('email');
      if (!wapp)     faltan.push('WhatsApp');
      if (!zona)     faltan.push('zona principal');
      if (!opsMes)   faltan.push('operaciones por mes');
      if (!sitio)    faltan.push('sitio web o Instagram');
      if (faltan.length > 0) {
        console.warn('[solicitar-alta] faltan campos:', faltan.join(', '));
        return res.status(400).json({ error: 'Faltan datos: ' + faltan.join(', ') });
      }
      // Validación básica de email
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Email inválido' });
      }

      // Persistir solicitud en Redis con clave timestamped para que se ordene
      // naturalmente y sea fácil listar en el admin.
      var ts = Date.now();
      var idSolicitud = 'sol-inmo-' + ts;
      var solicitud = {
        id: idSolicitud,
        nombre: nombre,
        contacto: contacto,
        email: email,
        whatsapp: wapp,
        zona: zona,
        operacionesPorMes: opsMes,
        sitio: sitio,
        logoUrl: logoUrl,
        fechaSolicitud: new Date(ts).toISOString(),
        estado: 'pendiente'  // 'pendiente' | 'aprobada' | 'rechazada'
      };
      await setJSON('solicitud-inmo:' + idSolicitud, solicitud);

      // Agregar al índice de solicitudes pendientes (lista de IDs)
      var idxPendientes = (await getJSON('solicitudes-inmo:pendientes')) || [];
      idxPendientes.unshift(idSolicitud);
      // Cap a 200 solicitudes pendientes para que la lista no crezca infinito
      if (idxPendientes.length > 200) idxPendientes = idxPendientes.slice(0, 200);
      await setJSON('solicitudes-inmo:pendientes', idxPendientes);

      // ── Mails (no rompemos el flow si fallan) ──
      try {
        const { Resend } = require('resend');
        const resend = new Resend(process.env.RESEND_API_KEY);

        // (1) Confirmación a la inmobiliaria
        await resend.emails.send({
          from: 'MudateYa <noreply@mudateya.ar>',
          to: email,
          subject: '✅ Recibimos tu solicitud para sumarte a MudateYa',
          html: `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#FAFAFA">
            <div style="font-family:Arial,sans-serif;max-width:560px;margin:24px auto;background:#fff;border:1px solid #E5E7EB;border-radius:16px;overflow:hidden">
              <div style="background:#003580;padding:22px 28px">
                <span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#22C36A">Ya</span>
              </div>
              <div style="padding:28px">
                <h2 style="margin:0 0 12px;color:#0F1419;font-size:20px">¡Gracias por tu interés, ${nombre}!</h2>
                <p style="color:#4B5563;line-height:1.6;font-size:14.5px;margin-bottom:16px">Recibimos tu solicitud para sumarte a MudateYa como inmobiliaria aliada. En las próximas <strong>24 horas hábiles</strong> nos vamos a contactar con vos para coordinar la activación de tu cuenta.</p>
                <div style="background:#F5F8FC;border:1px solid #E5ECF6;border-radius:10px;padding:14px 18px;margin:16px 0">
                  <div style="font-size:11px;color:#003580;font-weight:800;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:6px">Datos que recibimos</div>
                  <table style="width:100%;font-size:13px;color:#4B5563">
                    <tr><td style="padding:3px 0;width:35%;color:#9CA3AF">Inmobiliaria</td><td style="font-weight:600;color:#0F1419">${nombre}</td></tr>
                    <tr><td style="padding:3px 0;color:#9CA3AF">Contacto</td><td style="color:#0F1419">${contacto}</td></tr>
                    <tr><td style="padding:3px 0;color:#9CA3AF">Email</td><td style="color:#0F1419">${email}</td></tr>
                    <tr><td style="padding:3px 0;color:#9CA3AF">WhatsApp</td><td style="color:#0F1419">${wapp}</td></tr>
                    <tr><td style="padding:3px 0;color:#9CA3AF">Zona</td><td style="color:#0F1419">${zona}</td></tr>
                  </table>
                </div>
                <p style="color:#4B5563;line-height:1.6;font-size:14px;margin-top:18px">Mientras tanto podés conocer cómo trabajamos en <a href="https://mudateya.ar" style="color:#1A6FFF;font-weight:700">mudateya.ar</a>.</p>
                <p style="color:#9CA3AF;font-size:13px;margin-top:18px">Cualquier consulta, respondé a este mail o escribinos a <a href="mailto:hola@mudateya.ar" style="color:#1A6FFF">hola@mudateya.ar</a>.</p>
              </div>
              <div style="background:#F5F8FC;padding:14px 28px;font-size:11px;color:#9CA3AF;text-align:center">
                MudateYa · marketplace de mudanzas verificadas · mudateya.ar
              </div>
            </div></body></html>`
        });

        // (2) Notificación a Galo con todos los datos
        await resend.emails.send({
          from: 'MudateYa <noreply@mudateya.ar>',
          to: 'jgalozaldivar@gmail.com',
          subject: '🏢 Nueva solicitud de inmobiliaria: ' + nombre,
          html: `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#FAFAFA">
            <div style="font-family:Arial,sans-serif;max-width:560px;margin:24px auto;background:#fff;border:1px solid #E5E7EB;border-radius:16px;overflow:hidden">
              <div style="background:#003580;padding:20px 28px">
                <span style="color:#fff;font-size:14px;font-weight:700">🏢 Nueva solicitud · Inmobiliaria</span>
              </div>
              <div style="padding:24px 28px">
                <h2 style="margin:0 0 14px;color:#0F1419;font-size:18px">${nombre}</h2>
                <table style="width:100%;font-size:14px;color:#4B5563;border-collapse:collapse">
                  <tr><td style="padding:6px 0;width:36%;color:#9CA3AF;border-bottom:1px solid #F3F4F6">Contacto</td><td style="font-weight:600;color:#0F1419;border-bottom:1px solid #F3F4F6">${contacto}</td></tr>
                  <tr><td style="padding:6px 0;color:#9CA3AF;border-bottom:1px solid #F3F4F6">Email</td><td style="color:#0F1419;border-bottom:1px solid #F3F4F6"><a href="mailto:${email}" style="color:#1A6FFF">${email}</a></td></tr>
                  <tr><td style="padding:6px 0;color:#9CA3AF;border-bottom:1px solid #F3F4F6">WhatsApp</td><td style="color:#0F1419;border-bottom:1px solid #F3F4F6">${wapp}</td></tr>
                  <tr><td style="padding:6px 0;color:#9CA3AF;border-bottom:1px solid #F3F4F6">Zona</td><td style="color:#0F1419;border-bottom:1px solid #F3F4F6">${zona}</td></tr>
                  <tr><td style="padding:6px 0;color:#9CA3AF;border-bottom:1px solid #F3F4F6">Ops/mes</td><td style="color:#0F1419;border-bottom:1px solid #F3F4F6">${opsMes}</td></tr>
                  <tr><td style="padding:6px 0;color:#9CA3AF;border-bottom:1px solid #F3F4F6">Sitio/IG</td><td style="color:#0F1419;border-bottom:1px solid #F3F4F6">${sitio}</td></tr>
                  ${logoUrl ? `<tr><td style="padding:6px 0;color:#9CA3AF">Logo</td><td><a href="${logoUrl}" style="color:#1A6FFF">Ver logo subido</a></td></tr>` : ''}
                </table>
                <div style="margin-top:18px;padding:12px 14px;background:#FEF3C7;border-radius:8px;font-size:13px;color:#92400E">
                  📋 <strong>Próximo paso:</strong> Revisá la solicitud desde <a href="https://mudateya.ar/admin#solicitudes-inmo" style="color:#003580;font-weight:700">/admin → Solicitudes de inmo</a> y aprobá / activá si te interesa.
                </div>
              </div>
            </div></body></html>`
        });
      } catch(emailErr) {
        console.error('[solicitar-alta] Error mandando emails:', emailErr && emailErr.message);
        // No bloqueamos el flow: la solicitud ya quedó guardada en Redis.
      }

      return res.status(200).json({ ok: true, id: idSolicitud });
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
          var saludo = data.contactoNombre ? data.contactoNombre.split(' ')[0] : data.nombre;

          await resend.emails.send({
            from: 'MudateYa <noreply@mudateya.ar>',
            to: data.contactoEmail,
            subject: '🎉 ¡Bienvenida a MudateYa, ' + data.nombre + '!',
            html: `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#FAFAFA">
              <div style="font-family:Arial,sans-serif;max-width:580px;margin:24px auto;background:#fff;border:1px solid #E5E7EB;border-radius:16px;overflow:hidden">
                <!-- Header -->
                <div style="background:#003580;padding:24px 28px;text-align:center">
                  <div style="margin-bottom:6px"><span style="font-family:Georgia,serif;font-size:24px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:24px;font-weight:900;color:#22C36A">Ya</span></div>
                  <div style="color:#B8D4FF;font-size:12px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase">Bienvenida · Inmobiliaria aliada</div>
                </div>
                <!-- Body -->
                <div style="padding:28px">
                  <h1 style="margin:0 0 10px;color:#0F1419;font-size:24px;font-weight:800;line-height:1.2">¡Ya estás activa, ${saludo}!</h1>
                  <p style="color:#4B5563;line-height:1.6;font-size:15px;margin-bottom:22px">${data.nombre} ya es parte de MudateYa. Tu cuenta está lista para que tus clientes consigan mudanceros verificados con tu marca.</p>

                  <!-- URL destacada -->
                  <div style="background:linear-gradient(135deg,#003580 0%,#0055B8 100%);border-radius:14px;padding:22px;margin:20px 0;text-align:center">
                    <div style="color:#B8D4FF;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px">Tu URL única</div>
                    <div style="color:#fff;font-size:18px;font-weight:800;font-family:'Courier New',monospace;word-break:break-all;margin-bottom:14px">${urlInmo}</div>
                    <a href="${urlInmo}" style="display:inline-block;background:#22C36A;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">Abrir mi página →</a>
                  </div>

                  <!-- Cómo usarla -->
                  <h2 style="color:#0F1419;font-size:17px;font-weight:800;margin:28px 0 12px">¿Cómo la uso con mis clientes?</h2>
                  <div style="background:#F5F8FC;border:1px solid #E5ECF6;border-radius:10px;padding:18px;font-size:14px;color:#4B5563;line-height:1.7">
                    <div style="margin-bottom:10px"><strong style="color:#003580">1.</strong> Cuando un cliente cierra una operación con vos, compartile el link de arriba (por WhatsApp, mail, lo que prefieras).</div>
                    <div style="margin-bottom:10px"><strong style="color:#003580">2.</strong> El cliente entra, completa los datos de su mudanza y recibe 3-5 cotizaciones de mudanceros verificados.</div>
                    <div style="margin-bottom:10px"><strong style="color:#003580">3.</strong> Elige el que quiera, paga el 50% de seña por Mercado Pago y coordina con el mudancero.</div>
                    <div><strong style="color:#003580">4.</strong> Cuando la mudanza se completa, vos cobrás una comisión automática sobre el viaje.</div>
                  </div>

                  <!-- Datos cuenta -->
                  <div style="margin-top:24px;padding:16px;background:#FAFBFC;border:1px solid #E5E7EB;border-radius:10px;font-size:13px;color:#4B5563">
                    <div style="font-size:11px;color:#9CA3AF;font-weight:800;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:8px">Datos de tu cuenta</div>
                    <div style="margin-bottom:4px"><strong style="color:#0F1419">Nombre:</strong> ${data.nombre}</div>
                    <div style="margin-bottom:4px"><strong style="color:#0F1419">Slug:</strong> ${data.slug}</div>
                    ${data.comisionInmobiliaria ? `<div style="margin-bottom:4px"><strong style="color:#0F1419">Comisión:</strong> ${data.comisionInmobiliaria}% sobre cada mudanza concretada</div>` : ''}
                  </div>

                  <!-- Soporte -->
                  <p style="color:#4B5563;font-size:14px;margin-top:24px;line-height:1.6">¿Dudas o querés que te ayudemos a armar tu primer envío a clientes? Escribinos a <a href="mailto:hola@mudateya.ar" style="color:#1A6FFF;font-weight:700">hola@mudateya.ar</a> y te respondemos rápido.</p>
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
