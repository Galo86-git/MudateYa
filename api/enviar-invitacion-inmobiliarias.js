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
// DEDUP contra inmobiliarias que YA están en la plataforma: reusa el mismo
// índice que usa el propio /api/inmobiliarias?action=solicitar-alta para
// evitar altas duplicadas — GET solicitud-inmo:email:{email}. Si existe,
// se saltea (no se manda).
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

// true si ese email ya corresponde a una inmobiliaria registrada/solicitada
// en MudateYa (mismo índice que usa /api/inmobiliarias?action=solicitar-alta
// para no crear altas duplicadas).
async function yaEsInmobiliaria(o) {
  var existente = await redisCall('get', ['solicitud-inmo:email:' + o.e.toLowerCase()]);
  return !!existente;
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
