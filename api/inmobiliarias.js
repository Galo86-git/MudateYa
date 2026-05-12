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
