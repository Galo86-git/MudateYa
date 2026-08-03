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
//   COMPRAVENTA no paga comisión: el cliente recibe un regalo especial que
//   escala con el valor de la mudanza (ver páginas de beneficios).
//
// REDIS:
//   mudafy:asesor:{codigo}  → { codigo, nombre, email, whatsapp, zona, origen, activo, createdAt }
//   mudafy:asesores         → array con todos los códigos (índice para listar)
//
// ACTIONS:
//   POST ?action=registrar                 → alta pública desde la landing → { codigo, link }
//   GET  ?action=obtener&codigo=X          → trae un asesor (público, para mostrar su nombre)
//   GET  ?action=listar&token=ADMIN_TOKEN  → lista todos (admin, para reporting)
//   POST ?action=importar                  → alta masiva desde listado (admin)
//   POST ?action=reenviar                  → reenvía el mail de bienvenida (admin)

// ── Base del link de derivación. El cliente entra acá y publica su mudanza
//    atribuida a Mudafy + este asesor. Reusa el form de partner ya existente.
var LINK_BASE = 'https://mudateya.ar/inmobiliaria/mudafy';

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
// Validación de admin: delegada en api/_auth.js (master token o sesión
// firmada emitida por /api/admin-sesion). Sin fallback hardcodeado.
var { esAdmin, emailAdmin } = require('./_auth');

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

// ── El alta pública (action=registrar) exige mail corporativo de Mudafy —
//    evita que alguien se registre con su Gmail personal y quede duplicado
//    con el alta real (pasó de verdad en el canal de C21: 8 de 41 asesores
//    terminaron duplicados así). Dominio exacto confirmado: ext.mudafy.com. ──
function esMailMudafy(email) {
  var m = /@([^@]+)$/.exec(String(email || '').toLowerCase());
  if (!m) return false;
  return m[1] === 'ext.mudafy.com';
}

// ── Últimos 8 dígitos del teléfono (parte estable de un celular argentino,
//    más allá de 54/9/15/código de área) — mismo criterio que usa whatsapp.js
//    para matchear un número sin importar cómo lo haya tipeado la persona. ──
function clave8(tel) {
  return String(tel || '').replace(/\D/g, '').slice(-8);
}


// ── Escape de HTML para todo lo que venga del listado (nombre, zona, etc.)
//    Sin esto, un nombre con < o & rompe el HTML del mail. ──
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── MAIL DE BIENVENIDA ──────────────────────────────────────────────────────
// Compartido por el alta individual (action=registrar) y por la importación
// masiva (action=importar). Dos variantes de copy:
//   importado=false → el asesor se registró solo desde la landing.
//   importado=true  → lo dio de alta Mudafy desde el listado. No pidió nada,
//                     así que el mail explica qué es MudateYa y cómo darse de baja.
// opts: { nombre, email, whatsapp, zona, codigo, link, importado, to, prueba }
//   to     → destinatario alternativo (modo prueba: todo va a un solo mail).
//   prueba → antepone [PRUEBA] al asunto para no confundirlo con uno real.
// Tira error si falla: cada call site decide si eso rompe el alta o no.
async function enviarBienvenida(opts) {
  var nombre    = opts.nombre || '';
  var email     = opts.email || '';
  var whatsapp  = opts.whatsapp || '';
  var zona      = opts.zona || '';
  var codigo    = opts.codigo;
  var link      = opts.link;
  var importado = !!opts.importado;
  var destino   = opts.to || email;

  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);

  var primerNombre = escHtml(String(nombre).split(' ')[0] || '');
  var qrUrl = SITE_BASE + '/api/mudafy?action=qr&codigo=' + encodeURIComponent(codigo);

  // ── QR ────────────────────────────────────────────────────────────────
  // ANTES: se adjuntaba con content_type + content_id para incrustarlo por CID
  // (<img src="cid:qrmudafy">). El SDK de Resend 3.x NO soporta esos campos:
  // su tipo Attachment es solo { filename, content, path }. Los campos de más
  // viajaban igual en el JSON y la API respondía 422 — el mail no salía nunca.
  //
  // AHORA: el <img> apunta al endpoint público /api/mudafy?action=qr (Gmail lo
  // carga por su proxy sin problema, y ya devuelve Cache-Control) y el PNG va
  // además como adjunto común, con los campos que el SDK sí acepta.
  var qrAttachments = [];
  var qrUrlHtml = qrUrl.replace(/&/g, '&amp;');   // & válido dentro de un atributo
  var qrBloqueHtml =
    '<div style="text-align:center;margin:0 0 22px">'
    + '<div style="font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#94A3B8;margin-bottom:10px">Tu QR</div>'
    + '<a href="' + qrUrlHtml + '" style="display:inline-block;font-size:13px;color:#003580;font-weight:700;text-decoration:none">⬇ Descargar mi QR</a>'
    + '</div>';
  try {
    const QRCode = require('qrcode');
    var qrBuf = await QRCode.toBuffer(link, { type: 'png', width: 600, margin: 1, color: { dark: '#003580', light: '#FFFFFF' } });
    qrAttachments = [{ filename: 'mudateya-qr-' + codigo + '.png', content: qrBuf.toString('base64') }];

    if (opts.prueba) {
      // En modo prueba el código es ficticio: el endpoint del QR devolvería 404,
      // así que no ponemos el <img> roto. El PNG va igual como adjunto.
      qrBloqueHtml =
        '<div style="text-align:center;margin:0 0 22px">'
        + '<div style="font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#94A3B8;margin-bottom:10px">Tu QR</div>'
        + '<div style="border:1px dashed #CBD5E1;border-radius:12px;padding:18px;color:#64748B;font-size:12.5px;line-height:1.6">'
        + 'Acá va el QR del asesor.<br>En esta prueba el código es de mentira, así que lo mandamos <strong>adjunto</strong> en vez de incrustado.'
        + '</div></div>';
    } else {
      qrBloqueHtml =
        '<div style="text-align:center;margin:0 0 22px">'
        + '<div style="font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#94A3B8;margin-bottom:10px">Tu QR</div>'
        + '<img src="' + qrUrlHtml + '" alt="QR de tu link" width="180" height="180" style="display:block;margin:0 auto;border:1px solid #E5E7EB;border-radius:12px;padding:8px;background:#fff"/>'
        + '<a href="' + qrUrlHtml + '" style="display:inline-block;margin-top:10px;font-size:13px;color:#003580;font-weight:700;text-decoration:none">⬇ Descargar mi QR</a>'
        + '</div>';
    }
  } catch (qrErr) {
    console.warn('No se pudo generar el QR para el mail:', qrErr.message);
  }

  var asunto = importado
    ? 'Mudafy te dio de alta en MudateYa · tu link y QR'
    : '✅ Ya sos aliado de MudateYa · tu link y QR';
  if (opts.prueba) asunto = '[PRUEBA] ' + asunto;

  var titulo = importado
    ? '¡Hola ' + primerNombre + '! Ya tenés tu link de MudateYa 🎉'
    : '¡Listo, ' + primerNombre + '! Ya estás dado de alta 🎉';

  var intro = importado
    ? '<p style="color:#4B5563;line-height:1.6;font-size:14.5px;margin:0 0 14px"><strong>Mudafy sumó a sus asesores a MudateYa</strong> y ya te dimos de alta. MudateYa es la plataforma donde tus clientes consiguen mudanceros verificados, con presupuestos para comparar y seguimiento de la mudanza.</p>'
      + '<p style="color:#4B5563;line-height:1.6;font-size:14.5px;margin:0 0 20px">No tenés que hacer nada para activarlo: acá abajo está tu <strong>link único</strong>. Compartilo con tus clientes cuando cierren una operación y la mudanza queda atribuida a vos.</p>'
    : '<p style="color:#4B5563;line-height:1.6;font-size:14.5px;margin:0 0 20px">Ya sos aliado de MudateYa a través de Mudafy. Este es tu <strong>link único</strong>: compartilo con tus clientes cuando cierren una operación y ellos consiguen mudanceros verificados.</p>';

  var pieBaja = importado
    ? '<div style="margin-top:18px;text-align:center"><span style="font-size:12px;color:#94A3B8;line-height:1.6">¿No querés participar? Respondé este mail y te damos de baja.</span></div>'
    : '';

  var envio = await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
    to: destino,
    subject: asunto,
    attachments: qrAttachments,
    html: `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#FAFAFA">
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:24px auto;background:#fff;border:1px solid #E5E7EB;border-radius:16px;overflow:hidden">
        <div style="background:#003580;padding:22px 28px">
          <span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#22C36A">Ya</span>
          <span style="color:#B8D4FF;font-size:13px;font-weight:600;margin-left:8px">× Mudafy</span>
        </div>
        <div style="padding:28px">
          <h2 style="margin:0 0 10px;color:#0F1419;font-size:21px">${titulo}</h2>
          ${intro}

          <div style="background:#F5F8FC;border:1px solid #E5ECF6;border-radius:10px;padding:14px 18px;margin:0 0 20px">
            <div style="font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#94A3B8;margin-bottom:8px">Tus datos</div>
            <table style="font-size:14px;color:#0F1419;line-height:1.8">
              <tr><td style="color:#64748B;padding-right:12px">Nombre</td><td style="font-weight:600">${escHtml(nombre)}</td></tr>
              ${zona ? '<tr><td style="color:#64748B;padding-right:12px">Zona</td><td style="font-weight:600">' + escHtml(zona) + '</td></tr>' : ''}
              <tr><td style="color:#64748B;padding-right:12px">Email</td><td style="font-weight:600">${escHtml(email)}</td></tr>
              ${whatsapp ? '<tr><td style="color:#64748B;padding-right:12px">WhatsApp</td><td style="font-weight:600">' + escHtml(whatsapp) + '</td></tr>' : ''}
            </table>
          </div>

          <div style="border:1px dashed #CBD5E1;border-radius:10px;padding:14px 16px;margin:0 0 18px">
            <div style="font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#94A3B8;margin-bottom:6px">Tu link único</div>
            <a href="${link}" style="color:#003580;font-weight:700;font-size:14px;word-break:break-all;text-decoration:none">${escHtml(link.replace(/^https?:\/\//, ''))}</a>
          </div>

          ${qrBloqueHtml}

          <div style="background:#FFF5F5;border-left:3px solid #FF5A5F;border-radius:8px;padding:12px 16px;margin:0 0 8px">
            <div style="font-size:13px;color:#0F1419;line-height:1.7">
              <strong>🔑 Alquiler:</strong> ganás una comisión por cada mudanza que tu cliente concrete.<br>
              <strong>🏡 Compraventa:</strong> le regalás a tu cliente un regalo especial que escala con el valor de la mudanza.
            </div>
          </div>
          <div style="text-align:center;margin-top:16px">
            <a href="${SITE_BASE}/beneficios-mudafy.html" style="display:inline-block;background:#FF5A5F;color:#fff;text-decoration:none;font-weight:800;font-size:14px;padding:12px 22px;border-radius:10px">Ver tus beneficios completos →</a>
          </div>
          <div style="background:#F0FFF4;border:1px solid #BBF7D0;border-radius:10px;padding:16px 18px;margin-top:20px;text-align:center">
            <div style="margin:0 0 10px;font-size:13px;color:#166534;font-weight:600">📱 Cualquier duda, hablá con Emi por WhatsApp</div>
            <div style="margin:0 0 12px;font-size:12px;color:#475569;line-height:1.6">Te reenvía tu link, o te cuenta cómo van los clientes que ya te llegaron — al toque, sin entrar a ningún lado.</div>
            <a href="https://wa.me/12399462954?text=${encodeURIComponent('Hola Emi!')}" style="display:inline-block;background:#22C36A;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;font-size:13px;font-weight:700">Escribirle a Emi →</a>
          </div>
          ${pieBaja}
        </div>
        <div style="background:#FAFAFA;border-top:1px solid #E5E7EB;padding:16px 28px;text-align:center">
          <span style="font-size:12px;color:#94A3B8">MudateYa · la seguridad de mudarse · mudateya.ar</span>
        </div>
      </div>
    </body></html>`
  });

  // ── ESTO ES CLAVE ────────────────────────────────────────────────────────
  // El SDK de Resend NO tira excepción cuando la API rechaza el mail: devuelve
  // { data: null, error: {...} }. Sin este chequeo, un 422 (payload inválido),
  // un 403 (dominio sin verificar) o un 429 (rate limit) pasaban por el try/catch
  // sin hacer ruido y el alta se reportaba como "mail enviado" igual.
  if (envio && envio.error) {
    var er = envio.error;
    throw new Error(
      (er.name ? er.name + ' — ' : '') +
      (er.message || JSON.stringify(er))
    );
  }
  return (envio && envio.data && envio.data.id) || null;
}

// ── Pausa entre envíos: Resend limita a ~2 req/s. Sin esto, un lote grande
//    empieza a devolver 429 a la mitad. ──
function dormir(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

// ── Normalización de una fila del listado importado ──
// Devuelve { ok:true, asesor } o { ok:false, error }.
function normalizarFila(fila) {
  var nombre   = (typeof fila.nombre === 'string')   ? fila.nombre.trim().replace(/\s+/g, ' ').slice(0, 80) : '';
  var email    = (typeof fila.email === 'string')    ? fila.email.trim().toLowerCase().slice(0, 120)        : '';
  var whatsapp = (typeof fila.whatsapp === 'string') ? fila.whatsapp.trim().slice(0, 40)                    : '';
  var zona     = (typeof fila.zona === 'string')     ? fila.zona.trim().slice(0, 80)                        : '';

  if (!nombre) return { ok: false, error: 'Falta el nombre.' };
  if (!email || !emailValido(email)) return { ok: false, error: 'Email inválido.' };
  if (!whatsapp || whatsapp.replace(/\D/g, '').length < 8) return { ok: false, error: 'WhatsApp inválido.' };

  return { ok: true, asesor: { nombre: nombre, email: email, whatsapp: whatsapp, zona: zona } };
}

// ── Tope de filas por request. La UI manda de a 5 para no acercarse al
//    timeout de la función (cada alta = varias llamadas a Redis + un mail). ──
var MAX_POR_LOTE = 20;

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
      if (!esMailMudafy(email)) return res.status(400).json({ error: 'Usá tu mail de Mudafy (@ext.mudafy.com) para darte de alta.' });
      if (!whatsapp || whatsapp.replace(/\D/g, '').length < 8) return res.status(400).json({ error: 'WhatsApp inválido.' });

      var tel8 = clave8(whatsapp);
      var telKey = tel8.length === 8 ? 'mudafy:whatsapp8:' + tel8 : null;

      // ── No duplicar: si ya hay un asesor activo con ese MAIL o con ese
      //    WHATSAPP (aunque haya usado otro mail), devolvemos su link
      //    existente (alta idempotente) en vez de crear otro. El chequeo por
      //    whatsapp evita el caso real que pasó en C21: la misma persona
      //    registrada dos veces con mails distintos (uno personal, uno
      //    corporativo) por no saber que ya estaba de alta. ──
      var emailKey = 'mudafy:email:' + email.toLowerCase();
      var existenteCod = await getJSON(emailKey);
      if (!existenteCod && telKey) existenteCod = await getJSON(telKey);
      if (existenteCod) {
        var existente = await getJSON('mudafy:asesor:' + existenteCod);
        if (existente && existente.activo !== false) {
          var linkExist = LINK_BASE + '?asesor=' + encodeURIComponent(existente.codigo);
          return res.status(200).json({ ok: true, yaExistia: true, codigo: existente.codigo, link: linkExist });
        }
      }

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
      await setJSON(emailKey, codigo);
      if (telKey) await setJSON(telKey, codigo);

      var link = LINK_BASE + '?asesor=' + encodeURIComponent(codigo);

      // ── Mail de bienvenida al asesor (no rompemos el alta si falla) ──
      try {
        await enviarBienvenida({
          nombre: nombre, email: email, whatsapp: whatsapp, zona: zona,
          codigo: codigo, link: link, importado: false
        });
      } catch (mailErr) {
        console.warn('No se pudo enviar el mail de alta Mudafy:', mailErr.message);
      }

      return res.status(200).json({ ok: true, codigo: codigo, link: link });
    }

    // ── ADMIN: ALTA MASIVA desde el listado que manda MUDAFY ───────────────
    //
    // La UI (/mudafy-importar) parsea el CSV o el Excel, deja corregir las filas
    // con error y manda de a lotes chicos (5) para no acercarse al timeout de la
    // función: cada alta son 4 llamadas a Redis + un mail con QR adjunto.
    //
    // BODY:
    //   asesores    → [{ fila, nombre, email, whatsapp, zona }]  (máx 20)
    //   enviarMail  → default true. En false: crea las altas sin mandar nada.
    //   prueba      → true: NO escribe en Redis. Genera un código ficticio y
    //                 manda el mail a `mailA`. Sirve para ver cómo llega.
    //   mailA       → destinatario en modo prueba.
    //   reenviarMail→ true: a los que ya existían les vuelve a mandar el mail.
    //
    // IDEMPOTENTE: si el email ya está dado de alta, no duplica — devuelve el
    // código y link que ya tenía con estado 'ya-existia'. Se puede correr el
    // mismo archivo dos veces sin romper nada.
    if (action === 'importar' && req.method === 'POST') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });

      var bodyImp = req.body || {};
      var filas = Array.isArray(bodyImp.asesores) ? bodyImp.asesores : null;
      if (!filas || !filas.length) return res.status(400).json({ error: 'No llegó ninguna fila para importar.' });
      if (filas.length > MAX_POR_LOTE) {
        return res.status(400).json({ error: 'Máximo ' + MAX_POR_LOTE + ' asesores por lote. Mandá el listado en partes.' });
      }

      var esPrueba    = bodyImp.prueba === true;
      var enviarMail  = bodyImp.enviarMail !== false;
      var reenviar    = bodyImp.reenviarMail === true;
      var mailA       = (typeof bodyImp.mailA === 'string') ? bodyImp.mailA.trim().toLowerCase() : '';
      var origenImp   = (typeof bodyImp.origen === 'string' && bodyImp.origen.trim())
                          ? bodyImp.origen.trim().slice(0, 40)
                          : 'mudafy-importacion';

      if (esPrueba && !emailValido(mailA)) {
        return res.status(400).json({ error: 'En modo prueba hay que indicar a qué mail mandar la prueba.' });
      }

      var quien = emailAdmin(req) || 'master-token';
      var resultados = [];

      for (var fi = 0; fi < filas.length; fi++) {
        var cruda = filas[fi] || {};
        var nroFila = (typeof cruda.fila === 'number') ? cruda.fila : (fi + 1);

        var norm = normalizarFila(cruda);
        if (!norm.ok) {
          resultados.push({
            fila: nroFila, nombre: cruda.nombre || '', email: cruda.email || '',
            estado: 'error', error: norm.error
          });
          continue;
        }
        var aImp = norm.asesor;

        try {
          // ── MODO PRUEBA: no toca Redis. Código ficticio, mail a mailA. ──
          if (esPrueba) {
            var codPrueba  = 'prueba-' + sufijoRandom();
            var linkPrueba = LINK_BASE + '?asesor=' + encodeURIComponent(codPrueba);
            var mailPruebaEstado = 'omitido';
            var errPrueba = '';
            if (enviarMail) {
              try {
                await enviarBienvenida({
                  nombre: aImp.nombre, email: aImp.email, whatsapp: aImp.whatsapp,
                  zona: aImp.zona, codigo: codPrueba, link: linkPrueba,
                  importado: true, to: mailA, prueba: true
                });
                mailPruebaEstado = 'enviado';
              } catch (ePr) {
                mailPruebaEstado = 'falló';
                errPrueba = ePr.message || 'error de envío';
              }
              await dormir(400);
            }
            resultados.push({
              fila: nroFila, nombre: aImp.nombre, email: aImp.email,
              estado: 'prueba', codigo: codPrueba, link: linkPrueba,
              mail: mailPruebaEstado, mailA: mailA, error: errPrueba
            });
            continue;
          }

          // ── ALTA REAL. Idempotente por email. ──
          var emailKeyImp = 'mudafy:email:' + aImp.email;
          var codExistente = await getJSON(emailKeyImp);
          var yaEsta = codExistente ? await getJSON('mudafy:asesor:' + codExistente) : null;

          if (yaEsta && yaEsta.activo !== false) {
            var linkYa = LINK_BASE + '?asesor=' + encodeURIComponent(yaEsta.codigo);
            var mailYaEstado = 'omitido';
            var errYa = '';
            if (enviarMail && reenviar) {
              try {
                await enviarBienvenida({
                  nombre: yaEsta.nombre, email: yaEsta.email, whatsapp: yaEsta.whatsapp,
                  zona: yaEsta.zona, codigo: yaEsta.codigo, link: linkYa,
                  importado: true
                });
                mailYaEstado = 'enviado';
              } catch (eYa) {
                mailYaEstado = 'falló';
                errYa = eYa.message || 'error de envío';
              }
              await dormir(400);
            }
            resultados.push({
              fila: nroFila, nombre: yaEsta.nombre, email: yaEsta.email,
              estado: 'ya-existia', codigo: yaEsta.codigo, link: linkYa,
              mail: mailYaEstado, error: errYa
            });
            continue;
          }

          var codImp = await generarCodigo(aImp.nombre);
          var regImp = {
            codigo: codImp,
            nombre: aImp.nombre,
            email: aImp.email,
            whatsapp: aImp.whatsapp,
            zona: aImp.zona,
            origen: origenImp,
            activo: true,
            createdAt: new Date().toISOString(),
            importadoPor: quien
          };
          await setJSON('mudafy:asesor:' + codImp, regImp);
          await agregarAlIndice(codImp);
          await setJSON(emailKeyImp, codImp);

          var linkImp = LINK_BASE + '?asesor=' + encodeURIComponent(codImp);
          var mailImpEstado = 'omitido';
          var errImp = '';
          if (enviarMail) {
            try {
              await enviarBienvenida({
                nombre: aImp.nombre, email: aImp.email, whatsapp: aImp.whatsapp,
                zona: aImp.zona, codigo: codImp, link: linkImp,
                importado: true
              });
              mailImpEstado = 'enviado';
            } catch (eMail) {
              // El alta ya quedó guardada: el mail se puede reenviar después
              // con action=reenviar. No revertimos.
              mailImpEstado = 'falló';
              errImp = eMail.message || 'error de envío';
            }
            await dormir(400);
          }

          resultados.push({
            fila: nroFila, nombre: aImp.nombre, email: aImp.email,
            estado: 'creado', codigo: codImp, link: linkImp,
            mail: mailImpEstado, error: errImp
          });

        } catch (eFila) {
          resultados.push({
            fila: nroFila, nombre: aImp.nombre, email: aImp.email,
            estado: 'error', error: eFila.message || 'Error inesperado'
          });
        }
      }

      var resumen = { creados: 0, yaExistian: 0, errores: 0, pruebas: 0, mailsEnviados: 0, mailsFallidos: 0 };
      resultados.forEach(function(r) {
        if (r.estado === 'creado')          resumen.creados++;
        else if (r.estado === 'ya-existia') resumen.yaExistian++;
        else if (r.estado === 'prueba')     resumen.pruebas++;
        else                                resumen.errores++;
        if (r.mail === 'enviado') resumen.mailsEnviados++;
        if (r.mail === 'falló')   resumen.mailsFallidos++;
      });

      return res.status(200).json({ ok: true, prueba: esPrueba, resumen: resumen, resultados: resultados });
    }

    // ── ADMIN: reenviar el mail de bienvenida a un asesor ya dado de alta ──
    //    Para los casos en que el envío falló durante la importación.
    if (action === 'reenviar' && req.method === 'POST') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      var codRe = ((req.body && req.body.codigo) || '').trim();
      if (!codRe) return res.status(400).json({ error: 'Falta el código.' });
      var aRe = await getJSON('mudafy:asesor:' + codRe);
      if (!aRe || aRe.activo === false) return res.status(404).json({ error: 'Asesor no encontrado.' });
      var linkRe = LINK_BASE + '?asesor=' + encodeURIComponent(aRe.codigo);
      try {
        await enviarBienvenida({
          nombre: aRe.nombre, email: aRe.email, whatsapp: aRe.whatsapp,
          zona: aRe.zona, codigo: aRe.codigo, link: linkRe,
          importado: true
        });
      } catch (eRe) {
        return res.status(502).json({ error: 'No se pudo enviar: ' + (eRe.message || 'error') });
      }
      return res.status(200).json({ ok: true, email: aRe.email, link: linkRe });
    }

    // ── PÚBLICO: QR (PNG) del link del asesor. Lo usa el <img> del mail y se
    //    puede abrir/descargar directo. Se genera server-side con 'qrcode'. ──
    if (action === 'qr' && req.method === 'GET') {
      var codQr = (req.query.codigo || '').trim();
      if (!codQr) return res.status(400).json({ error: 'Falta el código.' });
      var aQr = await getJSON('mudafy:asesor:' + codQr);
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
      var aDel = await getJSON('mudafy:asesor:' + codDel);
      await redisCall('del', ['mudafy:asesor:' + codDel]);
      var idxDel = (await getJSON('mudafy:asesores')) || [];
      await setJSON('mudafy:asesores', idxDel.filter(function(c){ return c !== codDel; }));
      if (aDel && aDel.email) await redisCall('del', ['mudafy:email:' + aDel.email.toLowerCase()]);
      return res.status(200).json({ ok: true });
    }

    // ── ADMIN: eliminar TODOS los asesores (limpieza de datos de prueba) ──
    if (action === 'eliminar-todos' && req.method === 'POST') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      var idsAll = (await getJSON('mudafy:asesores')) || [];
      for (var k = 0; k < idsAll.length; k++) {
        var aAll = await getJSON('mudafy:asesor:' + idsAll[k]);
        await redisCall('del', ['mudafy:asesor:' + idsAll[k]]);
        if (aAll && aAll.email) await redisCall('del', ['mudafy:email:' + aAll.email.toLowerCase()]);
      }
      await setJSON('mudafy:asesores', []);
      return res.status(200).json({ ok: true, borrados: idsAll.length });
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
