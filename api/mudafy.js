// api/mudafy.js
//
// Endpoint del canal MUDAFY. Da de alta asesores de Mudafy en el evento
// (Planetario · 4 de agosto) y les genera un link único de derivación.
//
// MODELO:
// - Todos los asesores quedan orquestados bajo el partner "mudafy" (para tener
//   el canal consolidado), pero cada uno tiene su propio {codigo} para atribuir
//   su comisión individual.
// - El link del asesor manda al cliente al form de publicar ya existente,
//   atribuido con partner=mudafy + partnerAsesor={codigo}.
// - RÉGIMEN (igual que inmobiliarias): ALQUILER paga comisión al asesor;
//   COMPRAVENTA no paga comisión pero se ofrece limpieza de destino.
//
// REDIS:
//   mudafy:asesor:{codigo}  → { codigo, nombre, email, whatsapp, zona, origen, activo, createdAt }
//   mudafy:asesores         → array con todos los códigos (índice para listar)
//
// ACTIONS:
//   POST ?action=registrar                 → alta pública desde la landing → { codigo, link }
//   GET  ?action=obtener&codigo=X          → trae un asesor (público, para mostrar su nombre)
//   GET  ?action=listar&token=ADMIN_TOKEN  → lista todos (admin, para reporting)

// ── Base del link de derivación. El cliente entra acá y publica su mudanza
//    atribuida a Mudafy + este asesor. Reusa el form de partner ya existente.
var LINK_BASE = 'https://mudateya.ar/inmobiliaria/mudafy';

// ── Wrappers Redis (mismo patrón que cotizaciones.js / inmobiliarias.js) ──
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

// ── Slug legible a partir del nombre (a-z 0-9 y guión) ──
function slugificar(txt) {
  return (txt || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // saca acentos
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

// ── Sufijo random corto (4 chars base36) para unicidad del código ──
function sufijoRandom() {
  var s = '';
  var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (var i = 0; i < 4; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

// ── Genera un código único chequeando contra Redis ──
async function generarCodigo(nombre) {
  var base = slugificar(nombre) || 'asesor';
  for (var intento = 0; intento < 6; intento++) {
    var codigo = base + '-' + sufijoRandom();
    var existe = await getJSON('mudafy:asesor:' + codigo);
    if (!existe) return codigo;
  }
  // Fallback improbable: base + timestamp
  return base + '-' + Date.now().toString(36).slice(-5);
}

// ── Agregar código al índice (idempotente) ──
async function agregarAlIndice(codigo) {
  var lista = (await getJSON('mudafy:asesores')) || [];
  if (lista.indexOf(codigo) === -1) {
    lista.push(codigo);
    await setJSON('mudafy:asesores', lista);
  }
}

// ── Validación básica de email ──
function emailValido(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ── HANDLER ──
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  var action = (req.query && req.query.action) || '';

  try {
    // ── PÚBLICO: alta de asesor Mudafy desde la landing del evento ──
    if (action === 'registrar' && req.method === 'POST') {
      var body = req.body || {};
      var nombre   = (typeof body.nombre === 'string')   ? body.nombre.trim().slice(0, 80)   : '';
      var email    = (typeof body.email === 'string')    ? body.email.trim().slice(0, 120)   : '';
      var whatsapp = (typeof body.whatsapp === 'string') ? body.whatsapp.trim().slice(0, 40) : '';
      var zona     = (typeof body.zona === 'string')     ? body.zona.trim().slice(0, 80)     : '';
      var origen   = (typeof body.origen === 'string')   ? body.origen.trim().slice(0, 40)   : 'mudafy';

      if (!nombre)   return res.status(400).json({ error: 'Falta el nombre.' });
      if (!email || !emailValido(email)) return res.status(400).json({ error: 'Email inválido.' });
      if (!whatsapp || whatsapp.replace(/\D/g, '').length < 8) return res.status(400).json({ error: 'WhatsApp inválido.' });

      var codigo = await generarCodigo(nombre);
      var asesor = {
        codigo: codigo,
        nombre: nombre,
        email: email,
        whatsapp: whatsapp,
        zona: zona,
        origen: origen,
        activo: true,
        createdAt: new Date().toISOString()
      };
      await setJSON('mudafy:asesor:' + codigo, asesor);
      await agregarAlIndice(codigo);

      var link = LINK_BASE + '?asesor=' + encodeURIComponent(codigo);
      return res.status(200).json({ ok: true, codigo: codigo, link: link });
    }

    // ── PÚBLICO: obtener un asesor por código (para mostrar su nombre en el form) ──
    if (action === 'obtener' && req.method === 'GET') {
      var cod = (req.query.codigo || '').trim();
      if (!cod) return res.status(400).json({ error: 'Falta el código.' });
      var a = await getJSON('mudafy:asesor:' + cod);
      if (!a || a.activo === false) return res.status(404).json({ error: 'Asesor no encontrado.' });
      // Solo datos públicos (no exponemos email/whatsapp acá)
      return res.status(200).json({ codigo: a.codigo, nombre: a.nombre, zona: a.zona });
    }

    // ── ADMIN: listar todos los asesores Mudafy (reporting) ──
    if (action === 'listar' && req.method === 'GET') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      var ids = (await getJSON('mudafy:asesores')) || [];
      var asesores = [];
      for (var i = 0; i < ids.length; i++) {
        var m = await getJSON('mudafy:asesor:' + ids[i]);
        if (m) asesores.push(m);
      }
      // Más recientes primero
      asesores.sort(function(x, y) {
        return (new Date(y.createdAt).getTime() || 0) - (new Date(x.createdAt).getTime() || 0);
      });
      return res.status(200).json({ total: asesores.length, asesores: asesores });
    }

    return res.status(400).json({ error: 'Acción no válida' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Error interno' });
  }
};
