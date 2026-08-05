// api/moderar-contacto-mudanceros.js
//
// Detecta mudanceros que pegaron su email o teléfono en la descripción del
// perfil ("Contá tu experiencia, especialidades..." → campo `extra`) para que
// el cliente los contacte directo y esquivar la plataforma. Admin-only.
//
//   GET  /api/moderar-contacto-mudanceros?token=ADMIN_TOKEN
//     -> PREVIEW (dry-run): lista quién tiene contacto pegado en la descripción,
//        con el fragmento detectado. NO banea a nadie.
//
//   POST /api/moderar-contacto-mudanceros?token=ADMIN_TOKEN   { "apply": true }
//     -> APLICA: a cada uno que matchea le pone estado='rechazado' (los saca
//        del catálogo, mismo mecanismo que un rechazo manual desde admin-aprobar.js)
//        y le manda un mail explicando el motivo.
//
// Los perfiles ya 'rechazado' se ignoran (no hace falta re-banear).

var { esAdmin } = require('./_auth');
const { Resend } = require('resend');
const { redisPipeline } = require('./_ia');

async function redisCall(method, ...args) {
  var url   = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  var response = await fetch(
    url + '/' + [method, ...args].map(encodeURIComponent).join('/'),
    { headers: { Authorization: 'Bearer ' + token } }
  );
  var data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}
async function getJSON(key) {
  var val = await redisCall('GET', key);
  if (!val) return null;
  try { return JSON.parse(val); } catch (e) { return null; }
}
async function setJSON(key, value) {
  return redisCall('SET', key, JSON.stringify(value));
}

// ── Detectores (heurística: prioriza no dejar pasar contacto por sobre no
//    marcar falsos positivos — por eso el GET es un dry-run, se revisa antes
//    de banear de verdad). ──
function extraerEmail(texto) {
  var m = String(texto || '').match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  return m ? m[0] : null;
}
function extraerTelefono(texto) {
  // Busca corridas de dígitos con separadores típicos de teléfono (espacio,
  // guión, punto, paréntesis) que sumen 8+ dígitos SIN cruzar letras — así
  // "tengo 15 años y 200 mudanzas hechas" no dispara falso positivo,
  // pero "11-2233-4455" o "1122334455" sí.
  var candidatos = String(texto || '').match(/\(?\+?\d[\d\s().\-]{6,}\d/g) || [];
  for (var i = 0; i < candidatos.length; i++) {
    var digitos = candidatos[i].replace(/\D/g, '');
    if (digitos.length >= 8) return candidatos[i].trim();
  }
  return null;
}

async function detectar() {
  var emails = (await getJSON('mudanceros:todos')) || [];
  var hallazgos = [];
  for (var off = 0; off < emails.length; off += 100) {
    var lote = emails.slice(off, off + 100);
    var vals = await redisPipeline(lote.map(function (e) { return ['GET', 'mudancero:perfil:' + e]; }));
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      if (!v) continue;
      var p; try { p = JSON.parse(v); } catch (e) { continue; }
      if (!p || p.estado === 'rechazado') continue;
      var extra = p.extra || '';
      var contactoEmail = extraerEmail(extra);
      var contactoTelefono = extraerTelefono(extra);
      if (contactoEmail || contactoTelefono) {
        hallazgos.push({
          email: p.email,
          nombre: p.nombre,
          empresa: p.empresa || '',
          estadoActual: p.estado,
          extra: extra,
          contactoEmail: contactoEmail,
          contactoTelefono: contactoTelefono,
        });
      }
    }
  }
  return hallazgos;
}

module.exports = async function handler(req, res) {
  if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });

  try {
    var hallazgos = await detectar();

    if (req.method === 'GET') {
      return res.status(200).json({ total: hallazgos.length, hallazgos: hallazgos });
    }

    if (req.method === 'POST') {
      var apply = !!(req.body && req.body.apply === true);
      if (!apply) {
        return res.status(400).json({
          error: 'Mandá { "apply": true } en el body para aplicar el baneo.',
          preview: { total: hallazgos.length, hallazgos: hallazgos },
        });
      }

      var baneados = [];
      var { actualizarPerfilMudancero } = require('./_perfil-mudancero');
      for (var i = 0; i < hallazgos.length; i++) {
        var h = hallazgos[i];
        try {
          var previo = await getJSON('mudancero:perfil:' + h.email);
          if (!previo || previo.estado === 'rechazado') continue;
          var perfil = await actualizarPerfilMudancero(h.email, function (perfil) {
            perfil.estado = 'rechazado';
            perfil.fechaCambioEstado = new Date().toISOString();
            perfil.motivoRechazo = 'Datos de contacto (email o teléfono) detectados en la descripción del perfil — viola la política de no intermediación.';
          });
          if (!perfil) continue;
          try { await avisarBaneo(perfil); } catch (e) { console.warn('Email baneo ' + h.email + ':', e.message); }
          baneados.push(h.email);
        } catch (e) { console.warn('Banear ' + h.email + ':', e.message); }
      }
      return res.status(200).json({ ok: true, total: baneados.length, baneados: baneados });
    }

    return res.status(405).json({ error: 'Método no permitido' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

// ── Mail al mudancero avisando por qué se dio de baja su perfil ──
async function avisarBaneo(perfil) {
  if (!process.env.RESEND_API_KEY) return;
  var resend = new Resend(process.env.RESEND_API_KEY);
  var primerNombre = (perfil.nombre || '').split(' ')[0] || 'Hola';
  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
    to: perfil.email,
    subject: 'Tu perfil en MudateYa fue dado de baja',
    html:
      '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">' +
      '<div style="background:#003580;padding:20px 28px">' +
        '<span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#fff">Mudate</span>' +
        '<span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#22C36A">Ya</span>' +
      '</div>' +
      '<div style="padding:28px">' +
        '<h2 style="margin:0 0 10px;color:#0F1923;font-size:20px">Hola, ' + primerNombre + '</h2>' +
        '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 16px">Dimos de baja tu perfil en MudateYa porque detectamos un email o teléfono de contacto en el campo de descripción/experiencia. No lo permitimos porque los clientes tienen que cotizar y coordinar siempre a través de la plataforma.</p>' +
        '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 20px">Si querés volver a activar tu perfil, respondé este mail y lo revisamos — solo hace falta que saques esos datos de la descripción.</p>' +
        '<p style="color:#94A3B8;font-size:11px;margin:0">¿Preguntas? Escribinos a <a href="mailto:hola&#64;mudateya.ar" style="color:#1A6FFF;font-weight:600">hola&#64;mudateya.ar</a></p>' +
      '</div>' +
      '</div>',
  });
}
