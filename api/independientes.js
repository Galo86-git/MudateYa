// api/independientes.js
//
// Endpoint del canal INDEPENDIENTES. Da de alta asesores inmobiliarios que no
// pertenecen a Mudafy ni a RE/MAX y les genera un link único de derivación.
//
// MODELO (idéntico a api/mudafy.js):
// - Todos los asesores quedan orquestados bajo el partner "independientes" (para
//   tener el canal consolidado), pero cada uno tiene su propio {codigo} para
//   atribuir su comisión individual.
// - El link del asesor manda al cliente al form de publicar ya existente,
//   atribuido con partner=independientes + partnerAsesor={codigo}.
// - RÉGIMEN (igual que inmobiliarias): ALQUILER paga comisión al asesor;
//   COMPRAVENTA no paga comisión: el cliente recibe un regalo especial que
//   escala con el valor de la mudanza (ver páginas de beneficios).
//
// DIFERENCIA CON MUDAFY/RE/MAX:
// - El asesor escribe el nombre de su inmobiliaria a mano (texto libre). No se
//   valida contra ningún padrón ni tiene que matchear con nada: es un dato de
//   segmentación para el reporting, no una entidad del sistema.
//
// REQUISITO DE ALTA (una sola vez):
//   Crear en el panel de Inmobiliarias el slug "independientes" con su comisión.
//   Sin ese registro en `inmobiliaria:independientes`, cotizaciones.js no
//   reconoce el partner y la atribución se pierde en silencio.
//
// REDIS:
//   indep:asesor:{codigo}  → { codigo, nombre, email, whatsapp, inmobiliaria, zona, origen, activo, createdAt }
//   indep:asesores         → array con todos los códigos (índice para listar)
//   indep:email:{email}    → codigo (alta idempotente por email)
//
// ACTIONS:
//   POST ?action=registrar                 → alta pública desde la landing → { codigo, link }
//   GET  ?action=qr&codigo=X               → PNG del QR del link del asesor
//   GET  ?action=obtener&codigo=X          → trae un asesor (público, para mostrar su nombre)
//   GET  ?action=listar&token=ADMIN_TOKEN  → lista todos (admin, para reporting)
//   POST ?action=eliminar                  → baja de un asesor (admin)
//   POST ?action=eliminar-todos            → limpieza de datos de prueba (admin)

// ── Slug del canal. Tiene que existir en Redis como inmobiliaria:{slug} ──
var CANAL_SLUG = 'independientes';

// ── Base del link de derivación. El cliente entra acá y publica su mudanza
//    atribuida al canal + este asesor. Reusa el form de partner ya existente.
var LINK_BASE = 'https://mudateya.ar/inmobiliaria/' + CANAL_SLUG;

// ── Base del sitio, para construir URLs absolutas (QR en el mail, etc.) ──
var SITE_BASE = 'https://mudateya.ar';

// Los campos de texto libre del alta (nombre, inmobiliaria, etc.) van directo
// al HTML del mail de bienvenida sin pasar por acá antes — un asesor que
// cargue <a href="..."> en su nombre podía romper el mail que se manda a sí
// mismo (impacto bajo, pero mismo patrón de bug que el de inmobiliarias.js).
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Wrappers Redis (mismo patrón que cotizaciones.js / mudafy.js) ──
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
    var existe = await getJSON('indep:asesor:' + codigo);
    if (!existe) return codigo;
  }
  // Fallback improbable: base + timestamp
  return base + '-' + Date.now().toString(36).slice(-5);
}

// ── Agregar código al índice (idempotente) ──
async function agregarAlIndice(codigo) {
  var lista = (await getJSON('indep:asesores')) || [];
  if (lista.indexOf(codigo) === -1) {
    lista.push(codigo);
    await setJSON('indep:asesores', lista);
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
    // ── PÚBLICO: alta de asesor independiente desde la landing ──
    if (action === 'registrar' && req.method === 'POST') {
      var body = req.body || {};
      var nombre       = (typeof body.nombre === 'string')       ? body.nombre.trim().slice(0, 80)       : '';
      var email        = (typeof body.email === 'string')        ? body.email.trim().slice(0, 120)       : '';
      var whatsapp     = (typeof body.whatsapp === 'string')     ? body.whatsapp.trim().slice(0, 40)     : '';
      var inmobiliaria = (typeof body.inmobiliaria === 'string') ? body.inmobiliaria.trim().slice(0, 80) : '';
      var zona         = (typeof body.zona === 'string')         ? body.zona.trim().slice(0, 80)         : '';
      var origen       = (typeof body.origen === 'string')       ? body.origen.trim().slice(0, 40)       : CANAL_SLUG;

      if (!nombre)   return res.status(400).json({ error: 'Falta el nombre.' });
      if (!email || !emailValido(email)) return res.status(400).json({ error: 'Email inválido.' });
      if (!whatsapp || whatsapp.replace(/\D/g, '').length < 8) return res.status(400).json({ error: 'WhatsApp inválido.' });
      if (!inmobiliaria) return res.status(400).json({ error: 'Falta la inmobiliaria.' });

      // ── Asesor que pertenece a una inmobiliaria YA DADA DE ALTA en
      //    api/inmobiliarias.js. Viene del autocomplete de asesor-registro.html
      //    (nunca lo tipea el asesor a mano), así que se valida server-side
      //    contra Redis antes de confiar en él — mismo criterio que canales.js. ──
      var inmobiliariaSlugPedido = (typeof body.inmobiliariaSlug === 'string')
        ? body.inmobiliariaSlug.trim().toLowerCase().slice(0, 50) : '';
      var inmobiliariaVinculada = null;
      if (inmobiliariaSlugPedido) {
        var inmoReg = await getJSON('inmobiliaria:' + inmobiliariaSlugPedido);
        if (inmoReg && inmoReg.activa !== false) {
          inmobiliariaVinculada = { slug: inmobiliariaSlugPedido, nombre: inmoReg.nombre || inmobiliariaSlugPedido };
        }
      }

      // ── No duplicar por email: si ya hay un asesor activo con ese mail,
      //    devolvemos su link existente (alta idempotente) en vez de crear otro. ──
      var emailKey = 'indep:email:' + email.toLowerCase();
      var existenteCod = await getJSON(emailKey);
      if (existenteCod) {
        var existente = await getJSON('indep:asesor:' + existenteCod);
        if (existente && existente.activo !== false) {
          var slugLinkExist = existente.inmobiliariaSlug || CANAL_SLUG;
          var linkExist = 'https://mudateya.ar/inmobiliaria/' + slugLinkExist + '?asesor=' + encodeURIComponent(existente.codigo);
          return res.status(200).json({ ok: true, yaExistia: true, codigo: existente.codigo, link: linkExist, inmobiliaria: existente.inmobiliaria || '' });
        }
      }

      var codigo = await generarCodigo(nombre);
      var asesor = {
        codigo: codigo,
        nombre: nombre,
        email: email,
        whatsapp: whatsapp,
        inmobiliaria: inmobiliaria,
        zona: zona,
        origen: origen,
        activo: true,
        createdAt: new Date().toISOString()
      };
      if (inmobiliariaVinculada) {
        asesor.inmobiliariaSlug   = inmobiliariaVinculada.slug;
        asesor.inmobiliariaNombre = inmobiliariaVinculada.nombre;
      }
      await setJSON('indep:asesor:' + codigo, asesor);
      await agregarAlIndice(codigo);
      await setJSON(emailKey, codigo);

      // El link que comparte con sus clientes usa el slug de SU inmobiliaria
      // real si quedó vinculada (así el cliente ve la marca correcta y la
      // mudanza se atribuye bien) — si no, el genérico "independientes" de siempre.
      var linkSlugBase = inmobiliariaVinculada
        ? 'https://mudateya.ar/inmobiliaria/' + inmobiliariaVinculada.slug
        : LINK_BASE;
      var link = linkSlugBase + '?asesor=' + encodeURIComponent(codigo);

      // ── Mail de bienvenida al asesor (no rompemos el alta si falla) ──
      // Sin QR: lo sacamos del mail (hacía el mensaje pesado) — el código
      // sigue disponible vía /api/independientes?action=qr para quien lo
      // necesite desde el admin, y para "se me perdió el link" ahora está
      // Emi por WhatsApp.
      try {
        const { Resend } = require('resend');
        const resend = new Resend(process.env.RESEND_API_KEY);
        var primerNombre = nombre.split(' ')[0];

        await resend.emails.send({
          from: 'MudateYa <noreply@mudateya.ar>', reply_to:'hola@mudateya.ar',
          to: email,
          subject: '✅ Ya sos asesor aliado de MudateYa · tu link',
          html: `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#FAFAFA">
            <div style="font-family:Arial,sans-serif;max-width:560px;margin:24px auto;background:#fff;border:1px solid #E5E7EB;border-radius:16px;overflow:hidden">
              <div style="background:#003580;padding:22px 28px">
                <span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#22C36A">Ya</span>
                <span style="color:#B8D4FF;font-size:13px;font-weight:600;margin-left:8px">· Programa de Asesores</span>
              </div>
              <div style="padding:28px">
                <h2 style="margin:0 0 10px;color:#0F1419;font-size:21px">¡Listo, ${esc(primerNombre)}! Ya estás dado de alta 🎉</h2>
                <p style="color:#4B5563;line-height:1.6;font-size:14.5px;margin:0 0 20px">Ya sos asesor aliado de MudateYa. Este es tu <strong>link único</strong>: compartilo con tus clientes cuando cierren una operación y ellos consiguen mudanceros verificados.</p>

                <div style="background:#F5F8FC;border:1px solid #E5ECF6;border-radius:10px;padding:14px 18px;margin:0 0 20px">
                  <div style="font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#94A3B8;margin-bottom:8px">Tus datos</div>
                  <table style="font-size:14px;color:#0F1419;line-height:1.8">
                    <tr><td style="color:#64748B;padding-right:12px">Nombre</td><td style="font-weight:600">${esc(nombre)}</td></tr>
                    <tr><td style="color:#64748B;padding-right:12px">Inmobiliaria</td><td style="font-weight:600">${esc(inmobiliaria)}</td></tr>
                    <tr><td style="color:#64748B;padding-right:12px">Email</td><td style="font-weight:600">${esc(email)}</td></tr>
                    <tr><td style="color:#64748B;padding-right:12px">WhatsApp</td><td style="font-weight:600">${esc(whatsapp)}</td></tr>
                  </table>
                </div>

                <div style="border:1px dashed #CBD5E1;border-radius:10px;padding:14px 16px;margin:0 0 18px">
                  <div style="font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#94A3B8;margin-bottom:6px">Tu link único</div>
                  <a href="${link}" style="color:#003580;font-weight:700;font-size:14px;word-break:break-all;text-decoration:none">${link.replace(/^https?:\/\//, '')}</a>
                </div>

                <div style="background:#F5F8FC;border-left:3px solid #003580;border-radius:8px;padding:12px 16px;margin:0 0 8px">
                  <div style="font-size:13px;color:#0F1419;line-height:1.7">
                    <strong>🔑 Alquiler:</strong> ganás una comisión por cada mudanza que tu cliente concrete.<br>
                    <strong>🏡 Compraventa:</strong> le regalás a tu cliente un regalo especial que escala con el valor de la mudanza.
                  </div>
                </div>
                <div style="text-align:center;margin-top:16px">
                  <a href="${SITE_BASE}/beneficios-asesores.html" style="display:inline-block;background:#003580;color:#fff;text-decoration:none;font-weight:800;font-size:14px;padding:12px 22px;border-radius:10px">Ver tus beneficios completos →</a>
                </div>
                <div style="background:#F0FFF4;border:1px solid #BBF7D0;border-radius:10px;padding:16px 18px;margin-top:20px;text-align:center">
                  <div style="margin:0 0 10px;font-size:13px;color:#166534;font-weight:600">📱 Cualquier duda, hablá con Emi por WhatsApp</div>
                  <div style="margin:0 0 12px;font-size:12px;color:#475569;line-height:1.6">Te reenvía tu link, o te cuenta cómo van los clientes que ya te llegaron — al toque, sin entrar a ningún lado.</div>
                  <a href="https://wa.me/12399462954?text=${encodeURIComponent('Hola Emi!')}" style="display:inline-block;background:#22C36A;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;font-size:13px;font-weight:700">Escribirle a Emi →</a>
                </div>
                <div style="text-align:center;margin:28px 0 0">
                  <a href="https://www.instagram.com/mudateya.ar" style="display:inline-block;padding:9px 20px;border:1px solid #E2E8F0;border-radius:20px;color:#0F1923;text-decoration:none;font-size:13px;font-weight:600">📷 @mudateya.ar en Instagram</a>
                </div>
              </div>
              <div style="background:#FAFAFA;border-top:1px solid #E5E7EB;padding:16px 28px;text-align:center">
                <span style="font-size:12px;color:#94A3B8">MudateYa · la seguridad de mudarse · mudateya.ar</span>
              </div>
            </div>
          </body></html>`
        });
      } catch (mailErr) {
        console.warn('No se pudo enviar el mail de alta Independientes:', mailErr.message);
      }

      return res.status(200).json({ ok: true, codigo: codigo, link: link, inmobiliaria: inmobiliaria });
    }

    // ── PÚBLICO: QR (PNG) del link del asesor. Lo usa el <img> del mail y se
    //    puede abrir/descargar directo. Se genera server-side con 'qrcode'. ──
    if (action === 'qr' && req.method === 'GET') {
      var codQr = (req.query.codigo || '').trim();
      if (!codQr) return res.status(400).json({ error: 'Falta el código.' });
      var aQr = await getJSON('indep:asesor:' + codQr);
      if (!aQr || aQr.activo === false) return res.status(404).json({ error: 'Asesor no encontrado.' });
      var linkQr = LINK_BASE + '?asesor=' + encodeURIComponent(codQr);
      const QRCode = require('qrcode');
      var png = await QRCode.toBuffer(linkQr, { type: 'png', width: 600, margin: 1, color: { dark: '#003580', light: '#FFFFFF' } });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.status(200).end(png);
    }

    // ── ADMIN: eliminar un asesor por código ──
    if (action === 'eliminar' && req.method === 'POST') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      var codDel = ((req.body && req.body.codigo) || '').trim();
      if (!codDel) return res.status(400).json({ error: 'Falta el código.' });
      var aDel = await getJSON('indep:asesor:' + codDel);
      await redisCall('del', ['indep:asesor:' + codDel]);
      var idxDel = (await getJSON('indep:asesores')) || [];
      await setJSON('indep:asesores', idxDel.filter(function(c){ return c !== codDel; }));
      if (aDel && aDel.email) await redisCall('del', ['indep:email:' + aDel.email.toLowerCase()]);
      return res.status(200).json({ ok: true });
    }

    // ── ADMIN: eliminar TODOS los asesores (limpieza de datos de prueba) ──
    if (action === 'eliminar-todos' && req.method === 'POST') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      var idsAll = (await getJSON('indep:asesores')) || [];
      for (var k = 0; k < idsAll.length; k++) {
        var aAll = await getJSON('indep:asesor:' + idsAll[k]);
        await redisCall('del', ['indep:asesor:' + idsAll[k]]);
        if (aAll && aAll.email) await redisCall('del', ['indep:email:' + aAll.email.toLowerCase()]);
      }
      await setJSON('indep:asesores', []);
      return res.status(200).json({ ok: true, borrados: idsAll.length });
    }

    // ── PÚBLICO: obtener un asesor por código (para mostrar su nombre en el form) ──
    if (action === 'obtener' && req.method === 'GET') {
      var cod = (req.query.codigo || '').trim();
      if (!cod) return res.status(400).json({ error: 'Falta el código.' });
      var a = await getJSON('indep:asesor:' + cod);
      if (!a || a.activo === false) return res.status(404).json({ error: 'Asesor no encontrado.' });
      // Solo datos públicos (no exponemos email/whatsapp acá)
      return res.status(200).json({ codigo: a.codigo, nombre: a.nombre, inmobiliaria: a.inmobiliaria, zona: a.zona });
    }

    // ── ADMIN: listar todos los asesores independientes (reporting) ──
    if (action === 'listar' && req.method === 'GET') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      var ids = (await getJSON('indep:asesores')) || [];
      var asesores = [];
      for (var i = 0; i < ids.length; i++) {
        var m = await getJSON('indep:asesor:' + ids[i]);
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
