// api/enviar-invitacion-inmobiliarias.js
// ── ONE-OFF (solo admin / cron) ──
// Invita a inmobiliarias INDEPENDIENTES de AMBA, Córdoba y Rosario (no son
// clientes actuales, encontradas por prospección web) a sumarse a MudateYa
// vía /inmobiliarias-registro. Ese mismo alta les da el link para que cada
// asesor de su equipo se registre después — un solo CTA cubre las dos cosas.
// Excluidas a propósito: RE/MAX, Century 21/C21, Mudafy y KEYMEX (franquicias
// con su propio flujo dedicado).
//
// Mail genérico desde hola@mudateya.ar.
//
// DEDUP contra inmobiliarias que YA están en la plataforma: por email (mismo
// índice que usa /api/inmobiliarias?action=solicitar-alta, solicitud-inmo:
// email:{email}) o por teléfono (últimos 8 dígitos, inmocontacto:tel8-idx,
// mismo índice que usa Emi por WhatsApp) — ver ./_inmobiliarias-dedupe.js,
// mismo patrón que ./_mudanceros-dedupe.js. Si cualquiera de los dos
// matchea, se saltea (no se manda).
//
// IDEMPOTENCIA propia de esta campaña: guarda los emails ya invitados en
// Redis (clave invitacion-inmobiliarias:enviados). Si se corre de nuevo, no
// duplica.
//
// SEGURIDAD: admin con ?token=ADMIN_TOKEN, o Vercel Cron (header Authorization
// Bearer CRON_SECRET — mismo mecanismo que enviar-invitacion-mudanceros.js).
//   GET ?token=…              → DRY: cuenta pendientes/enviados/ya-inmobiliarias, NO envía nada.
//   GET ?token=…&test=x@y.com → envía UNA muestra a esa dirección (no marca, no chequea dedup).
//   GET ?token=…&apply=1      → ENVÍA a los pendientes (una sola corrida).
//   Vercel Cron                → aplica automático (agendado para las 9AM ART del 2026-08-08;
//                                 idempotente, así que si el cron sigue corriendo días después
//                                 no reenvía nada).

const { Resend } = require('resend');
const { esAdmin, esCronVercel } = require('./_auth');
const { linkBaja } = require('./_baja');
const { yaEsInmobiliaria } = require('./_inmobiliarias-dedupe');

async function redisCall(method, args) {
  var url = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  var r = await fetch(url + '/' + method + '/' + args.map(encodeURIComponent).join('/'), {
    headers: { Authorization: 'Bearer ' + token }
  });
  var data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}
async function getJSON(k) { var v = await redisCall('get', [k]); if (!v) return null; try { return JSON.parse(v); } catch(e) { return null; } }
async function setJSON(k, v) { return redisCall('set', [k, JSON.stringify(v)]); }

function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim()); }
function esc(s) { return String(s || '').replace(/[<>&"]/g, function(c){ return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]; }); }
function chunk(arr, size) { var out = []; for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; }

var CLAVE_ENVIADOS = 'invitacion-inmobiliarias:enviados';

// ── Prospectos: inmobiliarias independientes en AMBA, Córdoba y Rosario ──
// Encontradas por búsqueda web (sitio propio de cada una), NO son
// inmobiliarias ya registradas en MudateYa — eso se chequea aparte en
// caliente contra Redis (ver yaEsInmobiliaria). Excluye explícitamente
// franquicias (RE/MAX, C21, Mudafy, KEYMEX) y las ~20 sin email confirmado
// (esas van por WhatsApp en otro momento, no por este script).
var PROSPECTOS = [
  // AMBA
  { n: 'Palermo Propiedades', region: 'AMBA', e: 'clientes@palermopropiedades.com' },
  { n: 'Caballito Propiedades', region: 'AMBA', e: 'caballitoprop@gmail.com' },
  { n: 'Montaña Inmobiliaria', region: 'AMBA', e: 'caballito@montanainmobiliaria.com' },
  { n: 'Oppel Barrancas', region: 'AMBA', e: 'barrancas@oppel.com.ar' },
  { n: 'Red Gestionar', region: 'AMBA', e: 'giselle@redgestionar.com.ar' },
  { n: 'Inmobiliaria Colucci', region: 'AMBA', e: 'info@inmobiliariacolucci.com.ar' },
  { n: 'Céspedes Propiedades', region: 'AMBA', e: 'cespedes.propiedades@live.com.ar' },
  { n: 'Riviol Propiedades', region: 'AMBA', e: 'riviol2010@hotmail.com' },
  { n: 'JT Inmobiliaria', region: 'AMBA', e: 'info@jtinmobiliaria.com.ar' },
  { n: "D'Amato Propiedades", region: 'AMBA', e: 'contacto@damatopropiedades.com.ar' },
  { n: 'Fernández Inmobiliaria', region: 'AMBA', e: 'info@fernandez-inmob.com.ar' },
  { n: 'Zona Norte Inmobiliaria', region: 'AMBA', e: 'info@zonanorteinmobiliaria.com' },
  { n: 'Escobar Inmobiliaria', region: 'AMBA', e: 'javieralejandroin@gmail.com' },
  { n: 'Oppel Pilar', region: 'AMBA', e: 'pilar@oppel.com.ar' },
  { n: 'Morroni Propiedades', region: 'AMBA', e: 'info@morronipropiedades.com.ar' },
  { n: 'Battista Inmobiliaria', region: 'AMBA', e: 'info@ibattista.com.ar' },
  { n: 'C. Castillo Propiedades', region: 'AMBA', e: 'info@ccastilloprop.com' },
  { n: 'Villalobos – Profesionales Inmobiliarios', region: 'AMBA', e: 'info@villalobosprop.com' },
  { n: 'Centro Obligado Inmobiliaria', region: 'AMBA', e: 'info@centroobligado.com.ar' },
  { n: 'JJ Villanueva Propiedades', region: 'AMBA', e: 'jjvillanueva2201@hotmail.com' },
  { n: 'Koatz Inmobiliaria', region: 'AMBA', e: 'consultas@koatzinmobiliaria.com.ar' },
  { n: 'Duarte Nogueira', region: 'AMBA', e: 'nogueirapropiedades@hotmail.com' },
  { n: 'Cavanna Inmobiliaria', region: 'AMBA', e: 'info@inmobiliariacavanna.com' },
  // Córdoba
  { n: 'Plan D', region: 'Córdoba', e: 'reclamos@plan-d.com.ar' },
  { n: 'Liendo Bienes Raíces', region: 'Córdoba', e: 'inmobiliarialiendo@gmail.com' },
  { n: 'Inmobiliaria Claudia Blanco', region: 'Córdoba', e: 'inmobiliariaclaudiab@gmail.com' },
  { n: 'Alberdi Negocios Inmobiliarios', region: 'Córdoba', e: 'corporacion@alberdinmobiliaria.com.ar' },
  { n: 'Firmus', region: 'Córdoba', e: 'consultas@firmus.com.ar' },
  { n: 'Inmobiliaria Caffaratti', region: 'Córdoba', e: 'info@rcaffaratti.com' },
  { n: 'Taiana Propiedades', region: 'Córdoba', e: 'info@taianapropiedades.com' },
  { n: 'Costamagna Inmobiliaria', region: 'Córdoba', e: 'comercial@inmocostamagna.com' },
  { n: 'ML Inmobiliaria', region: 'Córdoba', e: 'info@ml-inmobiliaria.com' },
  { n: 'Grupo Enlace Inmobiliaria', region: 'Córdoba', e: 'info@grupoenlace.com.ar' },
  { n: 'Calsina Hnos.', region: 'Córdoba', e: 'info@calsinahnos.com.ar' },
  { n: 'Carolina Vázquez Gestión Inmobiliaria', region: 'Córdoba', e: 'inmocarolinavazquez@gmail.com' },
  { n: 'Gisela Castaldi Servicios Inmobiliarios', region: 'Córdoba', e: 'info@giselacastaldi.com.ar' },
  { n: 'Inmobiliaria Pehuen', region: 'Córdoba', e: 'sucursal1@pehueninmobiliaria.com.ar' },
  { n: 'Inmobiliaria MC', region: 'Córdoba', e: 'inmobiliaria_mc@live.com.ar' },
  { n: 'Comincini Inmobiliaria', region: 'Córdoba', e: 'comincini.inmob@gmail.com' },
  { n: 'MMLUISA Inmobiliaria', region: 'Córdoba', e: 'mmluisapropiedades@gmail.com' },
  { n: 'VC Inmobiliaria', region: 'Córdoba', e: 'info@inmobiliariavc.com.ar' },
  { n: 'Inmobiliaria Cernotto', region: 'Córdoba', e: 'cernotto@arnet.com.ar' },
  { n: 'Inmobiliaria Espinosa', region: 'Córdoba', e: 'inmobiliariaespinosa@yahoo.com' },
  // Rosario
  { n: 'Villegas Bienes Raíces', region: 'Rosario', e: 'agustin@villegasbienesraices.com' },
  { n: 'Hausprop', region: 'Rosario', e: 'info@hausprop.com' },
  { n: 'Berbari + Bienes y Servicios Inmobiliarios', region: 'Rosario', e: 'berbariprop@gmail.com' },
  { n: 'Nora Pereyra Negocios Inmobiliarios', region: 'Rosario', e: 'norapereyrainmventas@gmail.com' },
  { n: 'Rubén Valerio Inmobiliaria', region: 'Rosario', e: 'rubenvalerioinmobiliaria@gmail.com' },
  { n: 'Bertollo Buenas Raíces', region: 'Rosario', e: 'info@bertollo.com.ar' },
  { n: 'Beltrán Inmobiliaria SRL', region: 'Rosario', e: 'info@beltraninmobiliaria.com.ar' },
  { n: 'Lux Propiedades', region: 'Rosario', e: 'consultas@luxpropiedades.com' },
  { n: 'Uno Propiedades', region: 'Rosario', e: 'info@uno-propiedades.com.ar' },
  { n: 'CAI Inmobiliaria', region: 'Rosario', e: 'info@inmobiliariacai.com.ar' },
  { n: 'Azcuénaga Inmobiliaria', region: 'Rosario', e: 'info@azcuenagainmobiliaria.ar' },
  { n: 'Javier Rodríguez Inmobiliaria', region: 'Rosario', e: 'irodriguezjavier@gmail.com' },
  { n: 'Altos de Funes Inmobiliaria', region: 'Rosario', e: 'contacto@altosdefunes.com.ar' },
  { n: 'MTM Inmobiliaria', region: 'Rosario', e: 'info@mtminmobiliaria.com.ar' },
  { n: 'García & Andreu', region: 'Rosario', e: 'info@garciaandreu.com.ar' },
  { n: 'Moriconi Inmobiliaria', region: 'Rosario', e: 'norte@moriconi.com.ar' },
  { n: 'Inmobiliaria Echesortu', region: 'Rosario', e: 'info@inmobiliariaechesortu.com' },
  { n: 'Jumito Inmobiliaria SRL', region: 'Rosario', e: 'jumitoinmobiliaria@gmail.com' },
  { n: 'Fontana Inmobiliaria SRL', region: 'Rosario', e: 'info@fontanainmobiliaria.com.ar' },
  { n: 'Rondeau Propiedades', region: 'Rosario', e: 'rondeaupropiedades@gmail.com' },
  { n: 'Pérez Hernández Negocios Inmobiliarios', region: 'Rosario', e: 'inmobiliaria@perezhernandez.com.ar' },
  // ── Barrida 2026-08-17 (Google Maps, AMBA/Córdoba/Rosario) — 45 nuevas,
  // dedupeadas contra las de arriba por email (5 resultaron ser la misma
  // inmobiliaria ya cargada con otro nombre: Taiana, Caffaratti, Costamagna,
  // Uno Propiedades, Echesortu — no se repiten). Cada una con email
  // confirmado en su propio sitio/redes (mismo criterio que el resto de la
  // lista). Se excluyeron a propósito las que ya son parte de una red con
  // flujo propio (2 oficinas RE/MAX que aparecieron en la búsqueda). Se
  // suma tel para el dedup por teléfono (ver _inmobiliarias-dedupe.js) —
  // las entradas viejas no lo tenían. ──
  { n: 'Pablo Hyland Asesor Inmobiliario', region: 'AMBA', e: 'info@pablohyland.com', tel: '011 3654-0110' },
  { n: 'Baigun Realty | Negocios Inmobiliarios', region: 'AMBA', e: 'info@baigunrealty.com', tel: '011 5263-3332' },
  { n: 'GODOY Asesores Inmobiliarios', region: 'AMBA', e: 'info@godoyasesores.com', tel: '011 4793-1900' },
  { n: 'BUENOS AIRES Inmobiliaria', region: 'AMBA', e: 'buenosairesinmobiliaria@yahoo.com.ar', tel: '011 5373-4000' },
  { n: 'Central Real Estate Argentina', region: 'AMBA', e: 'central@maxre.com.ar', tel: '4789-3700' },
  { n: 'Hamra Propiedades', region: 'AMBA', e: 'hamrapropiedades@gmail.com', tel: '011 4963-9333' },
  { n: 'Fauro Propiedades - Recoleta', region: 'AMBA', e: 'info@fauropropiedades.com.ar', tel: '011 4807-9301' },
  { n: 'NARVAEZ Inmobiliaria', region: 'AMBA', e: 'Info@narvaez.com.ar', tel: '011 4743-2090' },
  { n: 'MGNI (M. Götz Negocios Inmobiliarios)', region: 'AMBA', e: 'info@mgotz.com', tel: '011 5329-7248' },
  { n: 'YM Real Estate', region: 'AMBA', e: 'Bienesraices@ym.com.ar', tel: '011 2460-4007' },
  { n: 'VINELLI INMOBILIARIA', region: 'AMBA', e: 'oli@vinelli.com.ar', tel: '011 3137-1501' },
  { n: 'Martín Fonseca Propiedades', region: 'AMBA', e: 'info@martinfonsecaprop.com', tel: '011 4793-9039' },
  { n: 'ZARATE Gestión Inmobiliaria', region: 'AMBA', e: 'info@zaratepropiedades.com.ar', tel: '011 4793-2605' },
  { n: 'Lareu Propiedades', region: 'AMBA', e: 'info@lareupropiedades.com', tel: '011 15-6708-7718' },
  { n: 'Rosana Moyano Negocios Inmobiliarios', region: 'AMBA', e: 'info@rosanamoyano.com.ar', tel: '011 4747-9420' },
  { n: 'Noguero Propiedades', region: 'AMBA', e: 'nogueropropiedades@gmail.com', tel: '011 5180-7180' },
  { n: 'NOVOA PROPIEDADES', region: 'AMBA', e: 'info@novoaprop.com', tel: '011 4743-2552' },
  { n: 'FARINA Propiedades', region: 'AMBA', e: 'info@farinaprop.com.ar', tel: '011 6009-0101' },
  { n: 'Viramonte Noguer Propiedades', region: 'AMBA', e: 'info@viramontenoguer.com.ar', tel: '011 15-5852-1395' },
  { n: 'Reynolds Propiedades', region: 'AMBA', e: 'info@reynoldspropiedades.com', tel: '011 4794-4100' },
  { n: 'Oberti Busso Inmobiliaria', region: 'Córdoba', e: 'oberti.busso@gmail.com', tel: '0351 510-7888' },
  { n: 'JB SRUR | Inmobiliaria + Desarrollista', region: 'Córdoba', e: 'recepcion@jbsrur.com.ar', tel: '0351 460-8800' },
  { n: 'Maristany Servicios Inmobiliarios', region: 'Córdoba', e: 'maristany.inmobiliaria@gmail.com', tel: '0351 650-4749' },
  { n: 'Inmobiliaria Cordoba', region: 'Córdoba', e: 'cbainmob@gmail.com', tel: '0351 241-5056' },
  { n: 'Propuestas Inmobiliarias S.A', region: 'Córdoba', e: 'info@propuestas-inmobiliarias.com', tel: '0351 651-2008' },
  { n: 'Inmobiliaria Ballesteros (Nueva Córdoba)', region: 'Córdoba', e: 'inmobiliariaballesteros@gmail.com', tel: '0351 15-511-2648' },
  { n: 'VAES Propiedades - Inmobiliaria de Córdoba', region: 'Córdoba', e: 'consultas@vaespropiedades.com.ar', tel: '0351 423-0066' },
  { n: 'Conexar Inmuebles', region: 'Córdoba', e: 'info@conexarinmuebles.com', tel: '03537 15-31-9704' },
  { n: 'Aldo Peppino - Servicios Inmobiliarios', region: 'Córdoba', e: 'info@aldopeppino.com.ar', tel: '0351 429-0055' },
  { n: 'NOBLES RAICES', region: 'Córdoba', e: 'info@noblesraices.com', tel: '0351 425-4060' },
  { n: 'López Baena Propiedades', region: 'Córdoba', e: 'maximilianol@lopezbaena.com.ar', tel: '0351 396-2652' },
  { n: 'Prisma Propiedades', region: 'Córdoba', e: 'consultas.prismapropiedades@gmail.com', tel: '0351 863-8624' },
  { n: 'Meade Inmobiliaria', region: 'Córdoba', e: 'info@meade.com.ar', tel: '0351 424-4444' },
  { n: 'COSA Propiedades Inmobiliaria Rosario', region: 'Rosario', e: 'contacto@cosapropiedades.com', tel: '0341 426-2550' },
  { n: 'Imperia Propiedades', region: 'Rosario', e: 'alvaro@imperiapropiedades.com', tel: '0341 625-8588' },
  { n: 'Inmobiliaria Escala Propiedades', region: 'Rosario', e: 'contacto@escalapropiedades.com.ar', tel: '0341 372-4336' },
  { n: 'Bassini Negocios Inmobiliarios', region: 'Rosario', e: 'contacto@bassiniinmobiliaria.com', tel: '0341 550-7167' },
  { n: 'Banchio Propiedades', region: 'Rosario', e: 'ventas@banchio.com', tel: '0341 440-0618' },
  { n: 'GARGARELLA INMOBILIARIA', region: 'Rosario', e: 'info@gargarella.com.ar', tel: '0341 449-4637' },
  { n: 'Sebastian Ramasco Padilla Negocios Inmobiliarios', region: 'Rosario', e: 'ventas@sramascopadilla.com.ar', tel: '0341 528-0028' },
  { n: 'Inmobiliaria Piazza', region: 'Rosario', e: 'info@piazzainmobiliaria.com.ar', tel: '0341 838-5120' },
  { n: 'Adrián Giaganti Negocios Inmobiliarios', region: 'Rosario', e: 'info@giaganti.com.ar', tel: '0341 438-1111' },
  { n: 'Ducler Inmobiliaria | Alquileres y Ventas en Rosario', region: 'Rosario', e: 'info@ducler.com.ar', tel: '0341 654-8008' },
  { n: 'Alsedá Inmuebles', region: 'Rosario', e: 'info@alseda.com.ar', tel: '0341 558-0638' },
  { n: 'Excellence Servicios Inmobiliarios', region: 'Rosario', e: 'mragusa@inmobiliariaexcellence.com', tel: '0341 311-2022' },
  // ── Mendoza — barrida 2026-08-10 (solo con email confirmado en su propia web) ──
  { n: 'Irrera Inmobiliaria', region: 'Mendoza', e: 'irrerainmobiliaria@yahoo.com.ar' },
  { n: 'Fernando Puebla Inmobiliaria', region: 'Mendoza', e: 'info@fpinmobiliaria.com.ar' }
];

function emailInvitacion(o) {
  var nm = esc(o.n || 'equipo');
  var linkB = linkBaja(o.e, 'invitacion-inmobiliarias');
  return {
    subject: o.n + ': sumate a MudateYa y dale un beneficio a tus asesores',
    html:
      '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">' +
        '<div style="background:#003580;padding:22px 28px;text-align:center">' +
          '<span style="font-family:Arial Black,Arial,sans-serif;font-size:28px;font-weight:900;letter-spacing:2px;color:#fff">MUDATE</span>' +
          '<span style="font-family:Arial Black,Arial,sans-serif;font-size:28px;font-weight:900;letter-spacing:2px;color:#22C36A">YA</span>' +
        '</div>' +
        '<div style="padding:28px">' +
          '<h2 style="margin:0 0 12px;color:#0F1923;font-size:20px">Hola, equipo de ' + nm + ' 👋</h2>' +
          '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">Te escribimos desde <strong>MudateYa</strong>, un marketplace argentino de mudanzas y fletes verificados. Le damos a tus clientes una forma simple y confiable de mudarse — y a tu inmobiliaria y a tus asesores, un beneficio por recomendarlo.</p>' +
          '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">Te registrás una vez como inmobiliaria y, a partir de ahí, cada asesor de tu equipo se suma con su propio link — sin que tengas que hacer nada más.</p>' +
          '<div style="background:#F5F7FA;border-radius:12px;padding:14px 20px;margin-bottom:18px;text-align:center">' +
            '<span style="display:inline-block;margin:4px 8px;font-size:12px;font-weight:700;color:#003580;background:#E5ECF6;padding:6px 12px;border-radius:999px">Sin costo de alta</span>' +
            '<span style="display:inline-block;margin:4px 8px;font-size:12px;font-weight:700;color:#003580;background:#E5ECF6;padding:6px 12px;border-radius:999px">Registro en 30 segundos</span>' +
            '<span style="display:inline-block;margin:4px 8px;font-size:12px;font-weight:700;color:#003580;background:#E5ECF6;padding:6px 12px;border-radius:999px">Cada asesor, su propio link</span>' +
          '</div>' +
          '<div style="text-align:center;margin:20px 0">' +
            '<a href="https://mudateya.ar/inmobiliarias-registro" style="display:inline-block;background:#22C36A;color:#fff;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none">Sumar mi inmobiliaria →</a>' +
          '</div>' +
          '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0">Si tenés dudas, respondé este mail y te contamos más.</p>' +
          '<p style="color:#94A3B8;font-size:11px;text-align:center;margin:22px 0 0;border-top:1px solid #E2E8F0;padding-top:16px">Recibís este correo porque tu inmobiliaria figura en tu zona. <a href="' + linkB + '" style="color:#94A3B8;text-decoration:underline">Darte de baja</a>.<br>MudateYa · hola@mudateya.ar · mudateya.ar</p>' +
        '</div>' +
      '</div>'
  };
}

function payloadDe(o) {
  var m = emailInvitacion(o);
  var link = linkBaja(o.e, 'invitacion-inmobiliarias');
  return {
    from: 'MudateYa <hola@mudateya.ar>', to: o.e, subject: m.subject, html: m.html,
    headers: {
      'List-Unsubscribe': '<' + link + '>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    }
  };
}

module.exports = async function handler(req, res) {
  var esVercelCron = esCronVercel(req);
  // En previews (no producción) el cron no debe enviar nada.
  if (esVercelCron && process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    return res.status(200).json({ ok: true, skipped: true, reason: 'no-production-env' });
  }
  if (!esVercelCron && !esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
  if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY no configurado' });

  var resend = new Resend(process.env.RESEND_API_KEY);
  var testTo = req.query && req.query.test ? String(req.query.test).trim() : '';
  var apply  = esVercelCron || (req.query && req.query.apply === '1');

  try {
    // ── TEST: una muestra (no marca, no chequea dedup) ──
    if (testTo) {
      if (!validEmail(testTo)) return res.status(400).json({ error: 'Email de test inválido' });
      var rt = await resend.emails.send(payloadDe({ n: 'Palermo Propiedades', e: testTo }));
      if (rt && rt.error) return res.status(502).json({ error: rt.error });
      return res.status(200).json({ ok: true, test: true, enviadoA: testTo });
    }

    // ── Ya invitados en esta campaña ──
    var enviados = (await getJSON(CLAVE_ENVIADOS)) || [];
    var enviadosSet = {}; enviados.forEach(function(e){ enviadosSet[String(e).toLowerCase()] = 1; });
    var suprimidos = (await redisCall('smembers', ['baja:emails'])) || [];
    var suprSet = {}; suprimidos.forEach(function(e){ suprSet[String(e).toLowerCase()] = 1; });

    // ── Filtrar: no repetidos de esta campaña, no suprimidos, y no ya-inmobiliarias ──
    var candidatos = PROSPECTOS.filter(function(o){
      var k = o.e.toLowerCase();
      return !enviadosSet[k] && !suprSet[k];
    });
    var pendientes = [];
    var yaInmobiliarias = [];
    for (var c = 0; c < candidatos.length; c++) {
      var o = candidatos[c];
      if (await yaEsInmobiliaria(o)) yaInmobiliarias.push(o.n + ' <' + o.e + '>');
      else pendientes.push(o);
    }

    // ── DRY (sin apply): informa, no envía ──
    if (!apply) {
      return res.status(200).json({
        ok: true, dry: true,
        totalProspectos: PROSPECTOS.length,
        yaInvitados: enviados.length,
        suprimidos: suprimidos.length,
        yaInmobiliarias: yaInmobiliarias.length,
        yaInmobiliariasMuestra: yaInmobiliarias.slice(0, 8),
        pendientes: pendientes.length,
        muestra: pendientes.slice(0, 8).map(function(o){ return o.n + ' <' + o.e + '>'; })
      });
    }

    // ── APPLY: enviar. Preferimos batch (rápido); si no está disponible o falla,
    //    caemos a envío uno por uno para no perder el lote. ──
    var resumen = { enviados: 0, errores: 0, fallidos: [], omitidosYaInmobiliarias: yaInmobiliarias.length };
    async function _marcar(email){ enviados.push(email); await setJSON(CLAVE_ENVIADOS, enviados); }
    async function _enviarUno(o){
      var r1 = await resend.emails.send(payloadDe(o));
      if (r1 && r1.error) throw new Error(typeof r1.error === 'string' ? r1.error : JSON.stringify(r1.error));
    }
    var hayBatch = !!(resend.batch && typeof resend.batch.send === 'function');
    var grupos = chunk(pendientes, 100);
    for (var g = 0; g < grupos.length; g++) {
      var unoAUno = !hayBatch;
      if (hayBatch) {
        try {
          var rb = await resend.batch.send(grupos[g].map(payloadDe));
          if (rb && rb.error) throw new Error(typeof rb.error === 'string' ? rb.error : JSON.stringify(rb.error));
          for (var b = 0; b < grupos[g].length; b++) { await _marcar(grupos[g][b].e); resumen.enviados++; }
        } catch (eb) {
          resumen.fallidos.push({ lote: g, modo: 'batch', error: eb.message });
          unoAUno = true; // reintentamos el lote uno por uno
        }
      }
      if (unoAUno) {
        for (var q = 0; q < grupos[g].length; q++) {
          var o = grupos[g][q];
          try { await _enviarUno(o); await _marcar(o.e); resumen.enviados++; }
          catch (e2) { resumen.errores++; resumen.fallidos.push({ email: o.e, error: e2.message }); }
          await new Promise(function(ok){ setTimeout(ok, 130); });
        }
      }
    }
    return res.status(200).json({ ok: true, aplicado: true, batchDisponible: hayBatch, ...resumen });
  } catch (e) {
    console.error('Error en enviar-invitacion-inmobiliarias:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
