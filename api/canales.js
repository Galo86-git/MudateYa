// api/canales.js
//
// Endpoint GENÉRICO de canales de derivación (inmobiliarias partner).
// Unifica la lógica que hoy está duplicada en api/remax.js, api/mudafy.js y
// api/independientes.js. Sumar un canal nuevo = agregar una entrada en CANALES.
//
// MODELO (idéntico al de los endpoints por canal):
// - Todos los asesores de un canal quedan orquestados bajo partner={slug} (para
//   tener el canal consolidado), pero cada uno tiene su propio {codigo} para
//   atribuir su comisión individual.
// - El asesor comparte su link único; la mudanza que salga de ahí queda
//   atribuida con partner={slug} + partnerAsesor={codigo}.
//
// COMPATIBILIDAD DE DATOS:
//   Los prefijos de Redis se declaran por canal, NO se derivan del slug.
//   Esto es a propósito: el canal "independientes" guarda con prefijo "indep:".
//   Si se derivara del slug, los asesores ya cargados quedarían huérfanos.
//
// REQUISITO DE ALTA DE UN CANAL NUEVO (una sola vez):
//   Crear en /admin → Inmobiliarias el slug del canal con su comisión y logo.
//   Sin ese registro en `inmobiliaria:{slug}`, cotizaciones.js no reconoce el
//   partner y la atribución se pierde en silencio.
//
// REDIS (por canal, con su prefijo):
//   {pfx}:asesor:{codigo}  → { codigo, nombre, email, whatsapp, inmobiliaria?, zona, origen, activo, createdAt }
//   {pfx}:asesores         → array con todos los códigos (índice para listar)
//   {pfx}:email:{email}    → codigo (alta idempotente por email)
//
// ACTIONS (todas requieren ?canal={slug}):
//   POST ?action=registrar&canal=X          → alta pública del asesor
//   GET  ?action=obtener&canal=X&codigo=Y   → datos públicos del asesor
//   GET  ?action=qr&canal=X&codigo=Y        → PNG del QR del link del asesor
//   GET  ?action=listar&canal=X             → todos los asesores (admin)
//   POST ?action=eliminar&canal=X           → baja de un asesor (admin)
//   POST ?action=eliminar-todos&canal=X     → limpieza de datos de prueba (admin)
//   GET  ?action=canales                    → slugs disponibles (admin, para el panel)

// ── Registro de canales ────────────────────────────────────────────
// nombre           : cómo se nombra el canal en el mail al asesor
// prefijo          : prefijo de las keys en Redis (NO tocar en canales vivos)
// color            : color de marca, usado en el CTA del mail
// beneficios       : página de beneficios a la que apunta el CTA
// pideInmobiliaria : true si el asesor tiene que declarar su inmobiliaria a mano
//                    (solo el canal paraguas de independientes)
var CANALES = {
  remax: {
    nombre: 'RE/MAX',
    prefijo: 'remax',
    color: '#DC1C2E',
    fondoAviso: '#FFF5F5',
    beneficios: '/beneficios-remax.html',
    pideInmobiliaria: false
  },
  mudafy: {
    nombre: 'Mudafy',
    prefijo: 'mudafy',
    color: '#FF5A5F',
    fondoAviso: '#FFF5F5',
    beneficios: '/beneficios-mudafy.html',
    pideInmobiliaria: false
  },
  independientes: {
    nombre: 'Asesores independientes',
    prefijo: 'indep',
    color: '#003580',
    fondoAviso: '#F5F8FC',
    beneficios: '/beneficios-asesores.html',
    pideInmobiliaria: true
  },
  c21: {
    nombre: 'Century 21',
    prefijo: 'c21',
    color: '#BEAF87',
    fondoAviso: '#FBF8F1',
    beneficios: '/beneficios-c21.html',
    pideInmobiliaria: false
  }
};

// ── Base del sitio, para construir URLs absolutas (QR en el mail, etc.) ──
var SITE_BASE = 'https://mudateya.ar';

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

// ── Resolución del canal a partir del query ──
// Devuelve el objeto de config con el slug ya adentro, o null si no existe.
function resolverCanal(req) {
  var slug = ((req.query && req.query.canal) || '').toString().trim().toLowerCase();
  if (!slug) return null;
  var cfg = CANALES[slug];
  if (!cfg) return null;
  return {
    slug: slug,
    nombre: cfg.nombre,
    prefijo: cfg.prefijo,
    color: cfg.color,
    fondoAviso: cfg.fondoAviso,
    beneficios: cfg.beneficios,
    pideInmobiliaria: cfg.pideInmobiliaria === true,
    linkBase: SITE_BASE + '/inmobiliaria/' + slug
  };
}

// ── Helpers de keys por canal ──
function kAsesor(c, codigo) { return c.prefijo + ':asesor:' + codigo; }
function kIndice(c)         { return c.prefijo + ':asesores'; }
function kEmail(c, email)   { return c.prefijo + ':email:' + email.toLowerCase(); }

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
async function generarCodigo(canal, nombre) {
  var base = slugificar(nombre) || 'asesor';
  for (var intento = 0; intento < 6; intento++) {
    var codigo = base + '-' + sufijoRandom();
    var existe = await getJSON(kAsesor(canal, codigo));
    if (!existe) return codigo;
  }
  // Fallback improbable: base + timestamp
  return base + '-' + Date.now().toString(36).slice(-5);
}

// ── Agregar código al índice (idempotente) ──
async function agregarAlIndice(canal, codigo) {
  var lista = (await getJSON(kIndice(canal))) || [];
  if (lista.indexOf(codigo) === -1) {
    lista.push(codigo);
    await setJSON(kIndice(canal), lista);
  }
}

// ── Validación básica de email ──
function emailValido(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ── Escape para interpolar datos del usuario dentro del HTML del mail ──
// El nombre y la inmobiliaria los escribe el asesor: sin esto, un apellido con
// comillas o un "&" rompen el markup del mail.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// ── HANDLER ──
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  var action = (req.query && req.query.action) || '';

  try {
    // ── ADMIN: listar los canales disponibles (para poblar selects en el panel) ──
    if (action === 'canales' && req.method === 'GET') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      var slugs = Object.keys(CANALES).map(function(s) {
        return {
          slug: s,
          nombre: CANALES[s].nombre,
          color: CANALES[s].color,
          pideInmobiliaria: CANALES[s].pideInmobiliaria === true
        };
      });
      return res.status(200).json({ canales: slugs });
    }

    // Todo lo demás necesita un canal válido.
    var canal = resolverCanal(req);
    if (!canal) {
      return res.status(400).json({
        error: 'Canal no reconocido. Pasá ?canal= con uno de: ' + Object.keys(CANALES).join(', ')
      });
    }

    // ── PÚBLICO: alta de asesor desde la landing del canal ──
    if (action === 'registrar' && req.method === 'POST') {
      var body = req.body || {};
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch(e) { body = {}; }
      }
      var nombre   = (typeof body.nombre === 'string')   ? body.nombre.trim().slice(0, 80)   : '';
      var email    = (typeof body.email === 'string')    ? body.email.trim().slice(0, 120)   : '';
      var whatsapp = (typeof body.whatsapp === 'string') ? body.whatsapp.trim().slice(0, 40) : '';
      var zona     = (typeof body.zona === 'string')     ? body.zona.trim().slice(0, 80)     : '';
      var origen   = (typeof body.origen === 'string')   ? body.origen.trim().slice(0, 40)   : canal.slug;
      var inmobiliaria = (typeof body.inmobiliaria === 'string') ? body.inmobiliaria.trim().slice(0, 80) : '';

      if (!nombre)   return res.status(400).json({ error: 'Falta el nombre.' });
      if (!email || !emailValido(email)) return res.status(400).json({ error: 'Email inválido.' });
      if (!whatsapp || whatsapp.replace(/\D/g, '').length < 8) return res.status(400).json({ error: 'WhatsApp inválido.' });
      if (canal.pideInmobiliaria && !inmobiliaria) return res.status(400).json({ error: 'Falta la inmobiliaria.' });

      // ── No duplicar por email: si ya hay un asesor activo con ese mail,
      //    devolvemos su link existente (alta idempotente) en vez de crear otro. ──
      var emailKey = kEmail(canal, email);
      var existenteCod = await getJSON(emailKey);
      if (existenteCod) {
        var existente = await getJSON(kAsesor(canal, existenteCod));
        if (existente && existente.activo !== false) {
          var linkExist = canal.linkBase + '?asesor=' + encodeURIComponent(existente.codigo);
          return res.status(200).json({
            ok: true,
            yaExistia: true,
            codigo: existente.codigo,
            link: linkExist,
            inmobiliaria: existente.inmobiliaria || ''
          });
        }
      }

      var codigo = await generarCodigo(canal, nombre);
      var asesor = {
        codigo: codigo,
        nombre: nombre,
        email: email,
        whatsapp: whatsapp,
        zona: zona,
        origen: origen,
        canal: canal.slug,
        activo: true,
        createdAt: new Date().toISOString()
      };
      // Solo guardamos inmobiliaria en los canales que la piden, para no ensuciar
      // el registro de los canales donde el nombre del canal ya es la inmobiliaria.
      if (canal.pideInmobiliaria) asesor.inmobiliaria = inmobiliaria;

      await setJSON(kAsesor(canal, codigo), asesor);
      await agregarAlIndice(canal, codigo);
      await setJSON(emailKey, codigo);

      var link  = canal.linkBase + '?asesor=' + encodeURIComponent(codigo);
      var qrUrl = SITE_BASE + '/api/canales?action=qr&canal=' + encodeURIComponent(canal.slug) + '&codigo=' + encodeURIComponent(codigo);

      // ── Mail de bienvenida al asesor (no rompemos el alta si falla) ──
      try {
        const { Resend } = require('resend');
        const resend = new Resend(process.env.RESEND_API_KEY);
        var primerNombre = nombre.split(' ')[0];

        // QR embebido en el propio mail (attachment inline por CID). Más robusto
        // que un <img> a un endpoint externo, que Gmail puede no cargar. Si la
        // generación falla, el mail igual sale con el link y sin QR inline.
        var qrAttachments = [];
        var qrBloqueHtml =
          '<div style="text-align:center;margin:0 0 22px">'
          + '<div style="font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#94A3B8;margin-bottom:10px">Tu QR</div>'
          + '<a href="' + qrUrl + '" style="display:inline-block;font-size:13px;color:#003580;font-weight:700;text-decoration:none">⬇ Descargar mi QR</a>'
          + '</div>';
        try {
          const QRCode = require('qrcode');
          var qrBuf = await QRCode.toBuffer(link, { type: 'png', width: 600, margin: 1, color: { dark: '#003580', light: '#FFFFFF' } });
          qrAttachments = [{ filename: 'mudateya-qr-' + codigo + '.png', content: qrBuf.toString('base64'), content_type: 'image/png', content_id: 'qrcanal' }];
          qrBloqueHtml =
            '<div style="text-align:center;margin:0 0 22px">'
            + '<div style="font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#94A3B8;margin-bottom:10px">Tu QR</div>'
            + '<img src="cid:qrcanal" alt="QR de tu link" width="180" height="180" style="display:block;margin:0 auto;border:1px solid #E5E7EB;border-radius:12px;padding:8px;background:#fff"/>'
            + '<a href="' + qrUrl + '" style="display:inline-block;margin-top:10px;font-size:13px;color:#003580;font-weight:700;text-decoration:none">⬇ Descargar mi QR</a>'
            + '</div>';
        } catch (qrErr) {
          console.warn('No se pudo generar el QR para el mail:', qrErr.message);
        }

        // Fila extra de inmobiliaria solo en los canales que la piden
        var filaInmo = canal.pideInmobiliaria
          ? '<tr><td style="color:#64748B;padding-right:12px">Inmobiliaria</td><td style="font-weight:600">' + esc(inmobiliaria) + '</td></tr>'
          : '';

        await resend.emails.send({
          from: 'MudateYa <noreply@mudateya.ar>',
          to: email,
          subject: '✅ Ya sos aliado de MudateYa · tu link y QR',
          attachments: qrAttachments,
          html: `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#FAFAFA">
            <div style="font-family:Arial,sans-serif;max-width:560px;margin:24px auto;background:#fff;border:1px solid #E5E7EB;border-radius:16px;overflow:hidden">
              <div style="background:#003580;padding:22px 28px">
                <span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#22C36A">Ya</span>
                <span style="color:#B8D4FF;font-size:13px;font-weight:600;margin-left:8px">× ${esc(canal.nombre)}</span>
              </div>
              <div style="padding:28px">
                <h2 style="margin:0 0 10px;color:#0F1419;font-size:21px">¡Listo, ${esc(primerNombre)}! Ya estás dado de alta 🎉</h2>
                <p style="color:#4B5563;line-height:1.6;font-size:14.5px;margin:0 0 20px">Ya sos aliado de MudateYa a través de ${esc(canal.nombre)}. Este es tu <strong>link único</strong>: compartilo con tus clientes cuando cierren una operación y ellos consiguen mudanceros verificados.</p>

                <div style="background:#F5F8FC;border:1px solid #E5ECF6;border-radius:10px;padding:14px 18px;margin:0 0 20px">
                  <div style="font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#94A3B8;margin-bottom:8px">Tus datos</div>
                  <table style="font-size:14px;color:#0F1419;line-height:1.8">
                    <tr><td style="color:#64748B;padding-right:12px">Nombre</td><td style="font-weight:600">${esc(nombre)}</td></tr>
                    ${filaInmo}
                    <tr><td style="color:#64748B;padding-right:12px">Email</td><td style="font-weight:600">${esc(email)}</td></tr>
                    <tr><td style="color:#64748B;padding-right:12px">WhatsApp</td><td style="font-weight:600">${esc(whatsapp)}</td></tr>
                  </table>
                </div>

                <div style="border:1px dashed #CBD5E1;border-radius:10px;padding:14px 16px;margin:0 0 18px">
                  <div style="font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#94A3B8;margin-bottom:6px">Tu link único</div>
                  <a href="${link}" style="color:#003580;font-weight:700;font-size:14px;word-break:break-all;text-decoration:none">${link.replace(/^https?:\/\//, '')}</a>
                </div>

                ${qrBloqueHtml}

                <div style="background:${canal.fondoAviso};border-left:3px solid ${canal.color};border-radius:8px;padding:12px 16px;margin:0 0 8px">
                  <div style="font-size:13px;color:#0F1419;line-height:1.7">
                    <strong>🔑 Alquiler:</strong> ganás una comisión por cada mudanza que tu cliente concrete.<br>
                    <strong>🏡 Compraventa:</strong> le regalás a tu cliente la limpieza de la casa nueva.
                  </div>
                </div>
                <div style="text-align:center;margin-top:16px">
                  <a href="${SITE_BASE}${canal.beneficios}" style="display:inline-block;background:${canal.color};color:#fff;text-decoration:none;font-weight:800;font-size:14px;padding:12px 22px;border-radius:10px">Ver tus beneficios completos →</a>
                </div>
              </div>
              <div style="background:#FAFAFA;border-top:1px solid #E5E7EB;padding:16px 28px;text-align:center">
                <span style="font-size:12px;color:#94A3B8">MudateYa · la seguridad de mudarse · mudateya.ar</span>
              </div>
            </div>
          </body></html>`
        });
      } catch (mailErr) {
        console.warn('No se pudo enviar el mail de alta de ' + canal.slug + ':', mailErr.message);
      }

      var respuesta = { ok: true, codigo: codigo, link: link };
      if (canal.pideInmobiliaria) respuesta.inmobiliaria = inmobiliaria;
      return res.status(200).json(respuesta);
    }

    // ── PÚBLICO: QR (PNG) del link del asesor. Lo usa el <img> del mail y se
    //    puede abrir/descargar directo. Se genera server-side con 'qrcode'. ──
    if (action === 'qr' && req.method === 'GET') {
      var codQr = (req.query.codigo || '').trim();
      if (!codQr) return res.status(400).json({ error: 'Falta el código.' });
      var aQr = await getJSON(kAsesor(canal, codQr));
      if (!aQr || aQr.activo === false) return res.status(404).json({ error: 'Asesor no encontrado.' });
      var linkQr = canal.linkBase + '?asesor=' + encodeURIComponent(codQr);
      const QRCode = require('qrcode');
      var png = await QRCode.toBuffer(linkQr, { type: 'png', width: 600, margin: 1, color: { dark: '#003580', light: '#FFFFFF' } });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.status(200).end(png);
    }

    // ── PÚBLICO: obtener un asesor por código (para mostrar su nombre en el form) ──
    if (action === 'obtener' && req.method === 'GET') {
      var cod = (req.query.codigo || '').trim();
      if (!cod) return res.status(400).json({ error: 'Falta el código.' });
      var a = await getJSON(kAsesor(canal, cod));
      if (!a || a.activo === false) return res.status(404).json({ error: 'Asesor no encontrado.' });
      // Solo datos públicos (no exponemos email/whatsapp acá)
      return res.status(200).json({
        codigo: a.codigo,
        nombre: a.nombre,
        inmobiliaria: a.inmobiliaria || '',
        zona: a.zona || ''
      });
    }

    // ── ADMIN: listar todos los asesores del canal (reporting) ──
    if (action === 'listar' && req.method === 'GET') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      var ids = (await getJSON(kIndice(canal))) || [];
      var asesores = [];
      for (var i = 0; i < ids.length; i++) {
        var m = await getJSON(kAsesor(canal, ids[i]));
        if (m) asesores.push(m);
      }
      // Más recientes primero
      asesores.sort(function(x, y) {
        return (new Date(y.createdAt).getTime() || 0) - (new Date(x.createdAt).getTime() || 0);
      });
      return res.status(200).json({ canal: canal.slug, total: asesores.length, asesores: asesores });
    }

    // ── ADMIN: eliminar un asesor por código ──
    if (action === 'eliminar' && req.method === 'POST') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      var codDel = ((req.body && req.body.codigo) || '').trim();
      if (!codDel) return res.status(400).json({ error: 'Falta el código.' });
      var aDel = await getJSON(kAsesor(canal, codDel));
      await redisCall('del', [kAsesor(canal, codDel)]);
      var idxDel = (await getJSON(kIndice(canal))) || [];
      await setJSON(kIndice(canal), idxDel.filter(function(c){ return c !== codDel; }));
      if (aDel && aDel.email) await redisCall('del', [kEmail(canal, aDel.email)]);
      return res.status(200).json({ ok: true });
    }

    // ── ADMIN: eliminar TODOS los asesores del canal (limpieza de datos de prueba) ──
    if (action === 'eliminar-todos' && req.method === 'POST') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      var idsAll = (await getJSON(kIndice(canal))) || [];
      for (var k = 0; k < idsAll.length; k++) {
        var aAll = await getJSON(kAsesor(canal, idsAll[k]));
        await redisCall('del', [kAsesor(canal, idsAll[k])]);
        if (aAll && aAll.email) await redisCall('del', [kEmail(canal, aAll.email)]);
      }
      await setJSON(kIndice(canal), []);
      return res.status(200).json({ ok: true, borrados: idsAll.length });
    }

    return res.status(400).json({ error: 'Acción no válida' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Error interno' });
  }
};
