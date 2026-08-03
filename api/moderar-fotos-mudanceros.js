// api/moderar-fotos-mudanceros.js
//
// Revisión RETROACTIVA de fotos ya subidas (perfil + vehículo) de TODOS los
// mudanceros: busca un teléfono visible en la imagen (mismo chequeo que ya
// corre al subir una foto NUEVA en mi-cuenta.html, pero acá barre lo que ya
// estaba cargado de antes). Admin-only.
//
//   GET  /api/moderar-fotos-mudanceros?token=ADMIN_TOKEN&offset=0&limit=5
//     -> PREVIEW (dry-run): revisa un lote de perfiles, lista qué fotos tienen
//        un teléfono visible. NO borra nada. Devuelve "siguienteOffset" para
//        seguir revisando el resto en otra llamada (evita timeouts).
//
//   POST /api/moderar-fotos-mudanceros?token=ADMIN_TOKEN&offset=0&limit=5  { "apply": true }
//     -> APLICA sobre ese mismo lote: saca la foto del perfil (perfil.foto='' o
//        se filtra de fotosVehiculo/fotoCamion) Y borra el archivo de Vercel Blob.
//
// No llama a /api/analizar-foto (ese endpoint tiene rate-limit de 5/min por IP,
// pensado para un usuario subiendo UNA foto — acá llamamos a Claude directo).

var { esAdmin } = require('./_auth');
const { redisPipeline } = require('./_ia');
const { del } = require('@vercel/blob');
const { Resend } = require('resend');

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

var PROMPT_MODERACION = '¿Aparece escrito o visible en esta imagen un número de teléfono (cartel, adhesivo, remera, escrito a mano, etc.)? No cuentes patentes de vehículos ni numeración de calle/piso. Respondé SOLO con JSON válido: {"tieneTelefono": true|false, "telefonoDetectado": "el texto visto, o vacío si no hay"}';

var SCHEMA_MODERACION = {
  type: 'object',
  additionalProperties: false,
  required: ['tieneTelefono', 'telefonoDetectado'],
  properties: {
    tieneTelefono:     { type: 'boolean' },
    telefonoDetectado: { type: 'string' },
  },
};

// Descarga la imagen y le pregunta a Claude si tiene un teléfono visible.
// Fail-open: cualquier error (fetch caído, imagen rota, IA sin responder) se
// interpreta como "no se pudo revisar" y NO se marca como violación.
async function analizarUrl(url) {
  try {
    var imgRes = await fetch(url);
    if (!imgRes.ok) return { revisada: false };
    var buf = Buffer.from(await imgRes.arrayBuffer());
    if (!buf.length) return { revisada: false };
    var mediaType = (imgRes.headers.get('content-type') || 'image/jpeg').split(';')[0];
    var base64 = buf.toString('base64');

    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: PROMPT_MODERACION },
          ],
        }],
        output_config: { format: { type: 'json_schema', schema: SCHEMA_MODERACION } },
      }),
    });
    if (!r.ok) return { revisada: false };
    var data = await r.json();
    var texto = (data.content || []).map(function (b) { return b.text || ''; }).join('');
    var analisis = JSON.parse(texto.trim());
    return { revisada: true, tieneTelefono: !!analisis.tieneTelefono, telefonoDetectado: analisis.telefonoDetectado || '' };
  } catch (e) {
    console.warn('analizarUrl ' + url + ':', e.message);
    return { revisada: false };
  }
}

// Junta las fotos "públicas" de un perfil (perfil + vehículo), sin repetir URL
// (fotoCamion suele ser fotosVehiculo[0]). NO toca el DNI: ahí un teléfono no
// es una violación, es parte normal del documento.
function fotosDelPerfil(p) {
  var vistas = {};
  var fotos = [];
  function agregar(campo, url) {
    if (!url || vistas[url]) return;
    vistas[url] = true;
    fotos.push({ campo: campo, url: url });
  }
  agregar('foto', p.foto);
  (Array.isArray(p.fotosVehiculo) ? p.fotosVehiculo : []).forEach(function (u) { agregar('fotosVehiculo', u); });
  agregar('fotoCamion', p.fotoCamion);
  return fotos;
}

// ── Mail al mudancero avisando que le sacamos una foto ──
async function avisarFotoBorrada(perfil, cantidad) {
  if (!process.env.RESEND_API_KEY) return;
  var resend = new Resend(process.env.RESEND_API_KEY);
  var primerNombre = (perfil.nombre || '').split(' ')[0] || 'Hola';
  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
    to: perfil.email,
    subject: 'Te sacamos una foto de tu perfil en MudateYa',
    html:
      '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">' +
      '<div style="background:#003580;padding:20px 28px">' +
        '<span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#fff">Mudate</span>' +
        '<span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#22C36A">Ya</span>' +
      '</div>' +
      '<div style="padding:28px">' +
        '<h2 style="margin:0 0 10px;color:#0F1923;font-size:20px">Hola, ' + primerNombre + '</h2>' +
        '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 16px">Sacamos ' + (cantidad > 1 ? 'algunas fotos' : 'una foto') + ' de tu perfil (de perfil o del vehículo) porque mostraba' + (cantidad > 1 ? 'n' : '') + ' un teléfono o email de contacto. No lo permitimos porque los clientes tienen que contactarte siempre a través de MudateYa, no directo.</p>' +
        '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 20px">Si querés, subí otra foto sin esos datos desde tu cuenta.</p>' +
        '<div style="text-align:center;margin:20px 0">' +
          '<a href="https://mudateya.ar/mi-cuenta" style="display:inline-block;background:#22C36A;color:#003580;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:14px">Subir una nueva foto →</a>' +
        '</div>' +
        '<p style="color:#94A3B8;font-size:11px;margin:0">¿Preguntas? Escribinos a <a href="mailto:hola&#64;mudateya.ar" style="color:#1A6FFF;font-weight:600">hola&#64;mudateya.ar</a></p>' +
      '</div>' +
      '</div>',
  });
}

module.exports = async function handler(req, res) {
  if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada' });

  try {
    var offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    // Default bajo a propósito: cada foto es un fetch + una llamada a Claude
    // (~1-3s cada una) hechos en serie. Con muchos mudanceros/fotos por perfil,
    // un límite alto puede pasarse del timeout de la función serverless.
    var limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 30);

    var todosEmails = (await getJSON('mudanceros:todos')) || [];
    var lote = todosEmails.slice(offset, offset + limit);

    var perfiles = [];
    for (var off = 0; off < lote.length; off += 100) {
      var sub = lote.slice(off, off + 100);
      var vals = await redisPipeline(sub.map(function (e) { return ['GET', 'mudancero:perfil:' + e]; }));
      vals.forEach(function (v) { if (v) { try { perfiles.push(JSON.parse(v)); } catch (e) {} } });
    }

    var hallazgos = [];
    var revisadasCount = 0;
    for (var pi = 0; pi < perfiles.length; pi++) {
      var p = perfiles[pi];
      if (!p || p.estado === 'rechazado') continue;
      var fotos = fotosDelPerfil(p);
      for (var fi = 0; fi < fotos.length; fi++) {
        var f = fotos[fi];
        var resultado = await analizarUrl(f.url);
        if (!resultado.revisada) continue;
        revisadasCount++;
        if (resultado.tieneTelefono) {
          hallazgos.push({
            email: p.email, nombre: p.nombre, empresa: p.empresa || '',
            campo: f.campo, url: f.url, telefonoDetectado: resultado.telefonoDetectado,
          });
        }
      }
    }

    var siguienteOffset = offset + limit < todosEmails.length ? offset + limit : null;

    if (req.method === 'GET') {
      return res.status(200).json({
        offset: offset, limit: limit, totalPerfiles: todosEmails.length,
        perfilesRevisados: perfiles.length, fotosRevisadas: revisadasCount,
        hallazgos: hallazgos, siguienteOffset: siguienteOffset,
      });
    }

    if (req.method === 'POST') {
      var apply = !!(req.body && req.body.apply === true);
      if (!apply) {
        return res.status(400).json({
          error: 'Mandá { "apply": true } en el body para borrar las fotos encontradas.',
          preview: { hallazgos: hallazgos, siguienteOffset: siguienteOffset },
        });
      }

      var borradas = [];
      // Agrupamos por email para tocar cada perfil una sola vez aunque tenga
      // varias fotos marcadas.
      var porEmail = {};
      hallazgos.forEach(function (h) { (porEmail[h.email] = porEmail[h.email] || []).push(h); });

      for (var email in porEmail) {
        try {
          var perfil = await getJSON('mudancero:perfil:' + email);
          if (!perfil) continue;
          var urlsABorrar = porEmail[email].map(function (h) { return h.url; });

          if (urlsABorrar.indexOf(perfil.foto) !== -1) perfil.foto = '';
          if (Array.isArray(perfil.fotosVehiculo)) {
            perfil.fotosVehiculo = perfil.fotosVehiculo.filter(function (u) { return urlsABorrar.indexOf(u) === -1; });
          }
          if (urlsABorrar.indexOf(perfil.fotoCamion) !== -1) {
            perfil.fotoCamion = (perfil.fotosVehiculo && perfil.fotosVehiculo[0]) || '';
          }
          await setJSON('mudancero:perfil:' + email, perfil);

          for (var ui = 0; ui < urlsABorrar.length; ui++) {
            try {
              var blobToken = process.env.BLOB_FOTO_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;
              await del(urlsABorrar[ui], { token: blobToken });
              borradas.push({ email: email, url: urlsABorrar[ui] });
            } catch (e) { console.warn('Borrar blob ' + urlsABorrar[ui] + ':', e.message); }
          }

          try { await avisarFotoBorrada(perfil, urlsABorrar.length); } catch (e) { console.warn('Email foto borrada ' + email + ':', e.message); }
        } catch (e) { console.warn('Procesar ' + email + ':', e.message); }
      }

      return res.status(200).json({ ok: true, total: borradas.length, borradas: borradas, siguienteOffset: siguienteOffset });
    }

    return res.status(405).json({ error: 'Método no permitido' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
