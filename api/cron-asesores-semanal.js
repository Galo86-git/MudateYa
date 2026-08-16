// api/cron-asesores-semanal.js
//
// Recordatorio SEMANAL a los asesores de CANAL (Remax, C21, Mudafy,
// Independientes) Y a las INMOBILIARIAS dadas de alta (api/inmobiliarias.js),
// aunque no tengan ningún asesor cargado. Corre todos los lunes 09:00 hora
// Argentina (12:00 UTC) — schedule "0 12 * * 1" en vercel.json.
//
// A cada asesor le manda su LINK EXCLUSIVO de cotización ya existente:
//   https://mudateya.ar/inmobiliaria/{canal}?asesor={codigo}
// A cada inmobiliaria (el contacto de la agencia) le manda SU PROPIO link
// directo, sin código de asesor: https://mudateya.ar/inmobiliaria/{slug}
// Desde la decisión 2026-08-07 la inmobiliaria cobra ella misma el 5% cuando
// un cliente entra por ese link directo sin pasar por un asesor puntual — por
// eso le interesa este mail igual que a un asesor, tenga o no tenga asesores.
// No se inventa ningún link: se usa el codigo propio de cada asesor, o el
// slug propio de cada inmobiliaria.
//
// QUIÉN NO RECIBE (por decisión de producto):
//   - Asesores del registro genérico (indice asesores:todos): no tienen link
//     de cotización, así que quedan afuera.
//   - Aliados (programa de referidos de edificios): otro circuito.
//
// IDEMPOTENCIA: al arrancar setea una marca en Redis por semana (SET ... NX).
// Si el cron corre dos veces el mismo lunes (reintento de Vercel), la segunda
// vez ve la marca y no manda nada. La marca expira sola a los 15 días.
// Además se deduplica por email (si un asesor está en dos canales, un solo mail).
//
// SEGURIDAD: el endpoint solo se ejecuta si:
//   1. Llega del Vercel Cron (header x-vercel-cron === '1'), o
//   2. Se llama manualmente con ?token=ADMIN_TOKEN (para probar).
//
// MODOS DE PRUEBA (solo con ?token=ADMIN_TOKEN):
//   ?dry=1            → NO envía nada; devuelve a cuántos y a quiénes les llegaría
//                       (con el canal y el link de cada uno).
//   ?test=mail@x.com  → envía UN solo mail de muestra a esa dirección y corta.
//                       Si ese mail es un asesor de canal, usa su link REAL.

const { Resend } = require('resend');
var { linkBaja } = require('./_baja');

// ── Canales con link exclusivo de cotización (?asesor={codigo}) ──
// prefijo = prefijo de las claves en Redis · slug = canal en la URL pública.
// Ojo: independientes guarda con prefijo "indep" pero la URL dice "independientes".
// nombre/color/fondoAviso: MISMO branding que ya usa el mail de alta en
// api/canales.js (asesorRegistro) — se duplica acá a propósito (config mínima,
// sin efectos secundarios) para no acoplar este cron a ese archivo.
var CANALES = [
  { prefijo: 'remax',  slug: 'remax',          nombre: 'RE/MAX',                color: '#DC1C2E', fondoAviso: '#FFF5F5' },
  { prefijo: 'c21',    slug: 'c21',             nombre: 'Century 21',            color: '#BEAF87', fondoAviso: '#FBF8F1' },
  { prefijo: 'mudafy', slug: 'mudafy',          nombre: 'Mudafy',                color: '#FF5A5F', fondoAviso: '#FFF5F5' },
  { prefijo: 'indep',  slug: 'independientes',  nombre: 'Asesores independientes', color: '#003580', fondoAviso: '#F5F8FC' }
];
var SITE = 'https://mudateya.ar';
var WA_EMI = 'https://wa.me/12399462954?text=' + encodeURIComponent('Hola Emi!');

// ── Suscriptos extra al newsletter de los lunes que NO son asesores: no
// entran a ningún índice {prefijo}:asesores, así que no tienen link de
// cotización propio (les llega el CTA genérico a /asesores), no aparecen en
// action=listar de ningún canal, y — a diferencia de cargarlos como asesor —
// NO les llega el resumen de comisiones de los viernes, porque
// cron-asesores-viernes.js reusa recolectarDestinatarios() SIN pasarle este
// array. Se cargan a mano acá, mismo criterio que CONTENIDO_SEMANAS.
var SUSCRIPTOS_EXTRA = [
  {
    email: 'maria.franco@mudafy.com', nombre: 'Mery',
    canalNombre: 'Mudafy', color: '#FF5A5F', fondoAviso: '#FFF5F5',
    tituloOverride: 'Hola {nombre}, esto le llega a los asesores hoy 👀',
    footerNota: 'Te llega este mail para que estés al tanto de lo que reciben los asesores de Mudafy — no hace falta que hagas nada con el link.'
  }
];

// ── Wrappers Redis (mismo patrón que cron-onboarding.js) ──
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

// ── HELPER: fecha YYYY-MM-DD en hora Argentina (para la clave semanal) ──
function fechaAR() {
  // Argentina es UTC-3 fijo (sin horario de verano).
  var ahora = new Date();
  var ar = new Date(ahora.getTime() - 180 * 60 * 1000);
  return ar.getUTCFullYear() + '-' +
    String(ar.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(ar.getUTCDate()).padStart(2, '0');
}

function validEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
}

// ── HELPER: link exclusivo de cotización de un asesor ──
// Es EXACTAMENTE el mismo que arma cada canal (remax.js/c21.js/mudafy.js/
// independientes.js): SITE + /inmobiliaria/{slug}?asesor={codigo}.
function linkCotizacion(slug, codigo) {
  return SITE + '/inmobiliaria/' + slug + '?asesor=' + encodeURIComponent(codigo);
}

// ── Headers List-Unsubscribe (RFC 2369) + List-Unsubscribe-Post (RFC 8058,
// one-click de Gmail/Yahoo) para mails masivos. Si no hay link puntual
// (ej. modo test sin match), cae al mailto solo — sigue siendo válido.
function headersListUnsub(url) {
  var mailto = 'mailto:hola@mudateya.ar?subject=BAJA';
  var h = { 'List-Unsubscribe': url ? ('<' + mailto + '>, <' + url + '>') : ('<' + mailto + '>') };
  if (url) h['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  return h;
}

// ── Recolecta los destinatarios: recorre el índice de cada canal, arma el link
//    real de cada asesor y deduplica por email. Devuelve [{email,nombre,canal,link}].
//    extras (opcional) = SUSCRIPTOS_EXTRA — solo lo pasa cron-asesores-semanal.js
//    para su propio envío; cron-asesores-viernes.js llama a esta función sin
//    argumentos, así que nunca les llega el resumen de comisiones. ──
async function recolectarDestinatarios(extras) {
  var out = [];
  var vistos = {};
  // Suprimidos globales (mismo SET que usan enviar-propuesta-remax.js /
  // enviar-propuestas-colegios.js vía api/_baja.js) — un asesor que se dio de
  // baja de este mail NO se toca en su ficha (`activo` sigue intacto, sus
  // notificaciones reales de comisión/clientes siguen andando).
  var suprimidos = {};
  try {
    var listaSuprimidos = (await redisCall('smembers', ['baja:emails'])) || [];
    for (var s = 0; s < listaSuprimidos.length; s++) suprimidos[listaSuprimidos[s]] = true;
  } catch (e) { console.warn('No se pudo leer baja:emails:', e.message); }
  for (var c = 0; c < CANALES.length; c++) {
    var canal = CANALES[c];
    var ids = await getJSON(canal.prefijo + ':asesores') || [];
    for (var i = 0; i < ids.length; i++) {
      var a = await getJSON(canal.prefijo + ':asesor:' + ids[i]);
      if (!a || !validEmail(a.email)) continue;
      if (a.activo === false) continue; // asesor dado de baja de la cuenta
      var k = String(a.email).toLowerCase().trim();
      if (suprimidos[k]) continue;      // se dio de baja de este mail puntual
      if (vistos[k]) continue;          // ya listado por otro canal
      vistos[k] = true;
      var codigoReal = a.codigo || ids[i];
      // Asesor vinculado a una inmobiliaria real (api/inmobiliarias.js, alta
      // via /inmobiliaria/{slug}/registro): SU marca real, no el genérico
      // del canal — mismo criterio que ya usa Emi (whatsapp.js) y el mail
      // de bienvenida (canales.js).
      var canalSlug = canal.slug, canalNombre = canal.nombre, color = canal.color, fondoAviso = canal.fondoAviso;
      if (a.inmobiliariaSlug) {
        canalSlug = a.inmobiliariaSlug;
        canalNombre = a.inmobiliariaNombre || canalNombre;
        try {
          var inmoCfg = await getJSON('inmobiliaria:' + a.inmobiliariaSlug);
          if (inmoCfg && inmoCfg.colorPrimario) color = inmoCfg.colorPrimario;
        } catch (e) {}
      }
      out.push({
        email:  a.email,
        nombre: a.nombre || '',
        canal:  canalSlug,
        canalNombre: canalNombre,
        color: color,
        fondoAviso: fondoAviso,
        link:   linkCotizacion(canalSlug, codigoReal),
        // prefijo/codigo = clave REAL de registro (indep/remax/mudafy/c21 +
        // código propio), NO la marca de arriba — es lo que necesita cualquier
        // consumidor externo (ej. cron-asesores-viernes.js) para leer el
        // índice {prefijo}:asesor:{codigo}:mudanzas armado en cotizaciones.js.
        prefijo: canal.prefijo,
        codigo:  codigoReal,
        linkBaja: linkBaja(a.email, 'asesores-semanal')
      });
    }
  }

  // ── Inmobiliarias (la agencia en sí, api/inmobiliarias.js) — reciben el
  // mismo mail con SU PROPIO link directo (sin código de asesor), tengan o no
  // tengan asesores cargados: desde el 2026-08-07 cobran el 5% ellas mismas
  // cuando un cliente entra directo por ese link. Antes quedaban afuera por
  // completo si no tenían ningún asesor. Si el contacto de la inmobiliaria ya
  // recibió el mail como asesor (mismo email), no se le duplica.
  try {
    var slugsInmo = (await getJSON('inmobiliarias:lista')) || [];
    for (var si = 0; si < slugsInmo.length; si++) {
      var inmo = await getJSON('inmobiliaria:' + slugsInmo[si]);
      if (!inmo || inmo.activa === false) continue;
      if (!validEmail(inmo.contactoEmail)) continue;
      var kInmo = String(inmo.contactoEmail).toLowerCase().trim();
      if (suprimidos[kInmo]) continue;
      if (vistos[kInmo]) continue;
      vistos[kInmo] = true;
      out.push({
        email:  inmo.contactoEmail,
        nombre: inmo.contactoNombre || inmo.nombre || '',
        canal:  slugsInmo[si],
        canalNombre: inmo.nombre || slugsInmo[si],
        color: inmo.colorPrimario || '#003580',
        fondoAviso: '#F5F8FC',
        link:   SITE + '/inmobiliaria/' + slugsInmo[si],
        // Sin prefijo/codigo (no es un asesor de canal) — cron-asesores-viernes.js
        // usa inmobiliariaSlug para leer inmobiliaria:{slug}:mudanzas en vez del
        // índice {prefijo}:asesor:{codigo}:mudanzas.
        prefijo: null,
        codigo:  null,
        inmobiliariaSlug: slugsInmo[si],
        linkBaja: linkBaja(inmo.contactoEmail, 'asesores-semanal')
      });
    }
  } catch (e) { console.warn('No se pudieron sumar inmobiliarias al mail semanal:', e.message); }

  // ── Suscriptos extra (no asesores, no inmobiliarias) — ver SUSCRIPTOS_EXTRA
  // más arriba. Mismo filtro de baja y de dedupe que todo lo demás; sin link
  // propio (cae al CTA genérico /asesores).
  for (var ex = 0; ex < (extras || []).length; ex++) {
    var e2 = extras[ex];
    if (!e2 || !validEmail(e2.email)) continue;
    var kEx = String(e2.email).toLowerCase().trim();
    if (suprimidos[kEx]) continue;
    if (vistos[kEx]) continue;
    vistos[kEx] = true;
    out.push({
      email:  e2.email,
      nombre: e2.nombre || '',
      canal:  null,
      canalNombre: e2.canalNombre || null,
      color: e2.color || '#22C36A',
      fondoAviso: e2.fondoAviso || '#F5F7FA',
      link:   null,
      prefijo: null,
      codigo:  null,
      linkBaja: linkBaja(e2.email, 'asesores-semanal')
    });
  }

  return out;
}

// ── Contenido semanal: se revisa y se carga a mano, semana por semana,
// junto con el usuario — no hay rotación automática de variantes pre-
// escritas (se sacó a propósito: se prefiere revisar antes de mandar cada
// vez). {nombre} se reemplaza por el primer nombre del asesor. cierreIndep/
// cierre: independientes tiene su propio cierre por el tema regalo vs.
// comisión (opcional). emiTitulo/emiTexto opcionales, caen al default si no
// vienen (ver bodyHtml).
//
// Se indexa por número de semana ISO (ver numeroSemanaISO más abajo) —
// agregar acá la entrada de la semana que sigue cuando se defina el
// contenido con el usuario. Si una semana no tiene entrada, el cron NO
// manda nada esa semana (ver handler: se frena antes de tocar Redis/Resend).
var CONTENIDO_SEMANAS = {
  33: { // lunes 2026-08-10 — anuncio de producto (novedades de Emi)
    titulo: 'Novedades para vos, {nombre} 📣',
    lead: 'Esta semana metimos tres mejoras en Emi que te pueden servir directo — sin que tengas que cambiar nada de cómo laburás hoy.',
    bulletsLabel: 'Lo que sumamos:',
    bullets: [
      'Si tu cliente prefiere resolverlo por WhatsApp en vez del formulario, Emi ya reconoce que viene de tu link y el pedido le queda atribuido a vos igual — <strong>misma comisión</strong>.',
      'Antes de publicar, Emi le muestra al cliente el PDF del pedido y le pregunta si está todo bien — llegan más precisos al mudancero, con <strong>menos sorpresas el día de la mudanza</strong>.',
      'Si tu cliente no habla español, no hay drama — <strong>Emi traduce todo</strong> antes de que le llegue al mudancero.',
      'Recordá que Emi también recibe fotos y audios — tu cliente no necesita escribir todo, le puede mandar una <strong>nota de voz</strong> contándole y listo.'
    ],
    cierre: 'Como siempre, tu link es el mismo — no cambia nada de tu lado.'
  },
  34: { // lunes 2026-08-17 — regalo personalizado en compraventa
    titulo: 'Tu cliente ahora recibe un regalo pensado para él, {nombre} 🎁',
    lead: 'Simplificamos el beneficio de compraventa: antes escalaba según el tamaño de la operación, ahora es directamente un regalo personalizado para tu cliente.',
    bulletsLabel: 'Lo que cambió:',
    bullets: [
      'Menos para explicar en la primera charla — ya no hay que entrar en escalas ni tramos, es "tu cliente tiene un regalo pensado para él".',
      'Sigue siendo en vez de comisión para vos en compraventa, como siempre — eso no cambió.',
      'Tu link y tu forma de derivar son exactamente iguales.'
    ],
    cierre: 'Como siempre, tu link es el mismo — no cambia nada de tu lado.'
  }
};

function numeroSemanaISO(d) {
  var fecha = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  var dow = fecha.getUTCDay() || 7;
  fecha.setUTCDate(fecha.getUTCDate() + 4 - dow);
  var inicioAno = new Date(Date.UTC(fecha.getUTCFullYear(), 0, 1));
  return Math.ceil((((fecha - inicioAno) / 86400000) + 1) / 7);
}
// Devuelve el contenido cargado para la semana actual, o null si todavía no
// se definió nada — el handler tiene que chequear esto antes de mandar.
function varianteSemana() {
  var ahora = new Date();
  var ar = new Date(ahora.getTime() - 180 * 60 * 1000); // hora Argentina (UTC-3 fijo)
  var semana = numeroSemanaISO(ar);
  return CONTENIDO_SEMANAS[semana] || null;
}

// ── PLANTILLA DEL EMAIL ──
// canal (opcional): { canalNombre, color, fondoAviso, tituloOverride, footerNota }
// — si no viene (ej. modo test sin match), cae al branding genérico de MudateYa.
// tituloOverride/footerNota: para SUSCRIPTOS_EXTRA que no son asesores (ej.
// alguien que solo quiere estar al tanto) — reemplazan el título y el pie
// pensados para un asesor real, sin tocar el resto del contenido de la semana.
function emailRecordatorio(nombre, ctaHref, canal) {
  var primerNombre = ((nombre || '').trim().split(' ')[0]) || 'Hola';
  var v = varianteSemana();
  if (!v) return null; // sin contenido cargado para esta semana — el caller decide qué hacer
  var esIndep = canal && canal.canalNombre === 'Asesores independientes';
  var tituloFinal = ((canal && canal.tituloOverride) ? canal.tituloOverride : v.titulo).replace('{nombre}', primerNombre);
  return {
    subject: tituloFinal.replace(/\s*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\s*/gu, ' ').trim(),
    html: bodyHtml({
      canalNombre: canal && canal.canalNombre,
      esInmobiliaria: !!(canal && canal.inmobiliariaSlug),
      color:       (canal && canal.color) || '#22C36A',
      fondoAviso:  (canal && canal.fondoAviso) || '#F5F7FA',
      titulo: tituloFinal,
      lead:   v.lead,
      bulletsLabel: v.bulletsLabel,
      bullets: v.bullets,
      cta:     'Ir a mi link →',
      ctaHref: ctaHref || (SITE + '/asesores'),
      cierre:  (esIndep && v.cierreIndep) ? v.cierreIndep : v.cierre,
      footerNota: canal && canal.footerNota,
      linkBaja: canal && canal.linkBaja,
      emiTitulo: v.emiTitulo || '📱 ¿Preferís que lo resuelva Emi por vos?',
      emiTexto: v.emiTexto || 'Contale los datos del cliente y ella carga el pedido directo, atribuido a tu código — el cliente recibe los presupuestos sin tener que entrar a ningún lado. O si preferís, te repite el link para mandárselo vos.'
    })
  };
}

function bodyHtml(p) {
  var bullets = p.bullets.map(function(b) {
    return '<li style="margin:6px 0">' + b + '</li>';
  }).join('');
  var marcaCanal = p.canalNombre
    ? '<span style="color:rgba(255,255,255,.75);font-size:15px;margin-left:10px">× ' + p.canalNombre + '</span>'
    : '';
  return '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">' +
    '<div style="background:#003580;padding:22px 28px;text-align:center">' +
      '<span style="font-family:Bebas Neue,Arial,sans-serif;font-size:30px;font-weight:900;letter-spacing:2px;color:#fff">MUDATE</span>' +
      '<span style="font-family:Bebas Neue,Arial,sans-serif;font-size:30px;font-weight:900;letter-spacing:2px;color:#22C36A">YA</span>' +
      marcaCanal +
    '</div>' +
    '<div style="padding:28px">' +
      '<h2 style="margin:0 0 12px;color:#0F1923;font-size:20px">' + p.titulo + '</h2>' +
      '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">' + p.lead + '</p>' +
      '<div style="background:' + p.fondoAviso + ';border-radius:12px;padding:14px 20px;margin-bottom:18px">' +
        '<div style="font-size:12px;font-weight:700;color:' + p.color + ';text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">' + (p.bulletsLabel || 'En 2 minutos:') + '</div>' +
        '<ul style="margin:0;padding-left:20px;color:#0F1923;font-size:13px;line-height:1.5">' + bullets + '</ul>' +
      '</div>' +
      '<div style="text-align:center;margin:24px 0">' +
        '<a href="' + p.ctaHref + '" style="display:inline-block;background:' + p.color + ';color:#fff;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none">' + p.cta + '</a>' +
      '</div>' +
      '<p style="color:#475569;font-size:13px;line-height:1.6;margin:0">' + p.cierre + '</p>' +
      '<div style="background:#F0FFF4;border:1px solid #BBF7D0;border-radius:10px;padding:14px 16px;margin-top:20px;text-align:center">' +
        '<div style="font-size:13px;color:#166534;font-weight:600;margin-bottom:8px">' + (p.emiTitulo || '📱 Y si te resulta más rápido, hacelo por WhatsApp con Emi') + '</div>' +
        (p.emiTexto ? '<div style="font-size:12px;color:#475569;line-height:1.6;margin-bottom:12px">' + p.emiTexto + '</div>' : '') +
        '<a href="' + WA_EMI + '" style="display:inline-block;background:#22C36A;color:#fff;text-decoration:none;padding:9px 20px;border-radius:8px;font-size:13px;font-weight:700">Escribirle a Emi →</a>' +
      '</div>' +
      '<div style="margin-top:20px;padding-top:20px;border-top:1px solid #EEF1F5;text-align:center">' +
        '<div style="font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#94A3B8;margin-bottom:8px">Seguinos en IG</div>' +
        '<a href="https://www.instagram.com/mudateya.ar/" style="color:#003580;font-weight:700;font-size:14px;text-decoration:none">@mudateya.ar</a>' +
      '</div>' +
      '<p style="color:#94A3B8;font-size:11px;text-align:center;margin:24px 0 0;border-top:1px solid #E2E8F0;padding-top:16px">' +
        (p.footerNota
          ? p.footerNota
          : (p.esInmobiliaria
            ? 'Recibís este recordatorio porque ' + (p.canalNombre || 'tu inmobiliaria') + ' es inmobiliaria aliada de MudateYa.'
            : 'Recibís este recordatorio porque sos asesor' + (p.canalNombre ? ' de ' + p.canalNombre : '') + '.')) +
        (p.linkBaja
          ? ' ¿No querés recibirlos más? <a href="' + p.linkBaja + '" style="color:#94A3B8;text-decoration:underline">Darte de baja</a>.'
          : ' ¿No querés recibirlos más? Respondé este mail con <strong>BAJA</strong>.') +
      '</p>' +
    '</div>' +
  '</div>';
}

// ── HANDLER ──
module.exports = async function handler(req, res) {
  // Skip silencioso en deployments preview (Vercel corre crons en previews sin
  // el header x-vercel-cron; devolvíamos 401 y ensuciaba los logs).
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    return res.status(200).json({ ok: true, skipped: true, reason: 'no-production-env', env: process.env.VERCEL_ENV });
  }

  // Seguridad: solo Vercel Cron o admin con token
  var esVercelCron = require('./_auth').esCronVercel(req);
  var esAdmin      = require('./_auth').esAdmin(req);
  if (!esVercelCron && !esAdmin) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: 'RESEND_API_KEY no configurado' });
  }

  var resend = new Resend(process.env.RESEND_API_KEY);
  var esDry  = req.query && req.query.dry === '1';
  var testTo = req.query && req.query.test ? String(req.query.test).trim() : '';

  try {
    // ── SIN CONTENIDO CARGADO PARA ESTA SEMANA: no manda nada, ni de prueba.
    // Se revisa y se agrega a CONTENIDO_SEMANAS junto con el usuario antes de
    // cada envío — no hay contenido por defecto que salga solo. No consume
    // la marca de idempotencia (así, si más tarde en la semana se carga el
    // contenido y se dispara a mano, todavía puede mandar).
    if (!varianteSemana()) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'sin-contenido-cargado-esta-semana' });
    }

    // ── MODO TEST: mandar una sola muestra y cortar ──
    if (testTo) {
      if (!validEmail(testTo)) return res.status(400).json({ error: 'Email de test inválido' });
      // Si el mail de test es un asesor de canal, usamos su link REAL de cotización.
      var lista0 = await recolectarDestinatarios(SUSCRIPTOS_EXTRA);
      var match = null;
      for (var m = 0; m < lista0.length; m++) {
        if (lista0[m].email.toLowerCase() === testTo.toLowerCase()) { match = lista0[m]; break; }
      }
      var muestra = emailRecordatorio(match ? match.nombre : 'Asesor de prueba', match ? match.link : null, match);
      var rt = await resend.emails.send({
        from: 'MudateYa Asesores <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
        to: testTo, subject: muestra.subject, html: muestra.html,
        headers: headersListUnsub(match ? match.linkBaja : null)
      });
      if (rt && rt.error) return res.status(502).json({ error: rt.error });
      return res.status(200).json({
        ok: true, test: true, enviadoA: testTo,
        esAsesorDeCanal: !!match,
        canal: match ? match.canal : null,
        link:  match ? match.link : null
      });
    }

    // ── IDEMPOTENCIA: marca por semana (clave = lunes en hora AR) ──
    // SET ... NX devuelve 'OK' si la seteó, o null si ya existía → ya corrió hoy.
    var claveSemana = 'asesores:recordatorio-semanal:' + fechaAR();
    if (!esDry) {
      var marca = await redisCall('set', [claveSemana, new Date().toISOString(), 'EX', '1296000', 'NX']);
      if (marca !== 'OK') {
        return res.status(200).json({ ok: true, skipped: true, reason: 'ya-enviado-esta-semana', clave: claveSemana });
      }
    }

    // ── Recolectar destinatarios (canales) y enviar ──
    var lista = await recolectarDestinatarios(SUSCRIPTOS_EXTRA);
    var resumen = { total: lista.length, enviados: 0, errores: 0, destinatarios: [], fallidos: [] };

    for (var i = 0; i < lista.length; i++) {
      var d = lista[i];

      if (esDry) {
        resumen.destinatarios.push({ email: d.email, canal: d.canal, link: d.link });
        resumen.enviados++;
        continue;
      }

      var mail = emailRecordatorio(d.nombre, d.link, d);
      try {
        var r = await resend.emails.send({
          from: 'MudateYa Asesores <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
          to: d.email, subject: mail.subject, html: mail.html,
          headers: headersListUnsub(d.linkBaja)
        });
        if (r && r.error) throw new Error(typeof r.error === 'string' ? r.error : JSON.stringify(r.error));
        resumen.enviados++;
        resumen.destinatarios.push({ email: d.email, canal: d.canal });
      } catch (e) {
        resumen.errores++;
        resumen.fallidos.push({ email: d.email, error: e.message });
        console.warn('Error enviando recordatorio semanal a ' + d.email + ':', e.message);
      }
      // Respiro para no pegarle al rate limit de Resend
      await new Promise(function(ok){ setTimeout(ok, 120); });
    }

    return res.status(200).json({ ok: true, dry: esDry, ...resumen });
  } catch (e) {
    console.error('Error en cron-asesores-semanal:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

// Reexportado para que cron-asesores-viernes.js (resumen semanal) reuse
// exactamente la misma lista/marca de asesores en vez de duplicarla — una
// función es un objeto en JS, esto no afecta que Vercel use module.exports
// como handler.
module.exports.recolectarDestinatarios = recolectarDestinatarios;
module.exports.CANALES = CANALES;
module.exports.SITE = SITE;
module.exports.WA_EMI = WA_EMI;
module.exports.getJSON = getJSON;
module.exports.redisCall = redisCall;
module.exports.validEmail = validEmail;
module.exports.headersListUnsub = headersListUnsub;
// Reexportado para cron-recordar-contenido-asesores.js (aviso de los
// domingos): necesita saber si YA hay contenido cargado para el lunes que
// viene, y si lo hay, armar el mismo preview que recibiría un asesor real —
// sin duplicar el template acá.
module.exports.numeroSemanaISO = numeroSemanaISO;
module.exports.CONTENIDO_SEMANAS = CONTENIDO_SEMANAS;
module.exports.emailRecordatorio = emailRecordatorio;
