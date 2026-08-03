// api/reenviar-sugerencia-fotos.js
//
// Reenvío puntual (admin) de la sugerencia "mandá fotos en vez de la visita"
// para un pedido YA cotizado antes de que existiera este chequeo automático
// (ver notificarCliente/pideVisitaPresencial en cotizaciones.js). Uso único,
// no un cron: para cotizaciones nuevas esto ya sale solo.
//
//   GET  /api/reenviar-sugerencia-fotos?token=ADMIN_TOKEN&mudanzaId=MYA-...
//     -> PREVIEW: busca el pedido, lista qué cotizaciones piden relevamiento/visita. No manda nada.
//
//   POST /api/reenviar-sugerencia-fotos?token=ADMIN_TOKEN&mudanzaId=MYA-...   { "apply": true }
//     -> Manda la plantilla sugerencia_fotos_relevamiento al cliente por cada
//        cotización que matchea (normalmente una sola).

var { esAdmin } = require('./_auth');
const { enviarPlantilla } = require('./_plantillas');
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

// Mismo detector que cotizaciones.js — si cambia ahí, actualizar acá también.
function pideVisitaPresencial(nota) {
  return /relevamiento|visitar|visita\s+(presencial|domiciliaria)|recorrer\s+el\s+(lugar|domicilio)|pasar\s+a\s+ver|ir\s+a\s+ver\s+(el|la)|necesita(mos)?\s+ver\s+el\s+lugar/i.test(String(nota || ''));
}

module.exports = async function handler(req, res) {
  if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });

  try {
    var mudanzaId = (req.query.mudanzaId || '').trim();
    if (!mudanzaId) return res.status(400).json({ error: 'Falta mudanzaId' });

    var mudanza = await getJSON('mudanza:' + mudanzaId);
    if (!mudanza) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (!mudanza.clienteWA && !mudanza.clienteEmail) return res.status(400).json({ error: 'Este pedido no tiene ni WhatsApp ni email del cliente cargado' });

    var cotizaciones = Array.isArray(mudanza.cotizaciones) ? mudanza.cotizaciones : [];
    var matches = cotizaciones.filter(function (c) { return c && pideVisitaPresencial(c.nota); });

    if (req.method === 'GET') {
      return res.status(200).json({
        mudanzaId: mudanzaId, cliente: mudanza.clienteNombre, clienteWA: mudanza.clienteWA,
        totalCotizaciones: cotizaciones.length,
        matches: matches.map(function (c) { return { mudanceroNombre: c.mudanceroNombre, nota: c.nota }; }),
      });
    }

    if (req.method === 'POST') {
      var apply = !!(req.body && req.body.apply === true);
      if (!apply) return res.status(400).json({ error: 'Mandá { "apply": true } para enviar.', matches: matches.length });
      if (!matches.length) return res.status(400).json({ error: 'Ninguna cotización de este pedido menciona relevamiento/visita.' });

      var nomCli = (mudanza.clienteNombre || '').split(' ')[0] || 'Hola';
      var enviados = [];
      for (var i = 0; i < matches.length; i++) {
        var c = matches[i];
        var resultado = { mudanceroNombre: c.mudanceroNombre };

        if (mudanza.clienteWA) {
          var textoSugerencia = `¡Hola ${nomCli}! ${c.mudanceroNombre || 'El mudancero'} te cotizó tu ${mudanza.tipo || 'mudanza'}, pero pidió visitarte para confirmar el precio final.\n\nSi querés evitarte la visita, respondeme por acá con fotos de lo que hay que mudar o contame más detalles por escrito — se los paso al mudancero para que ajuste el precio sin necesidad de ir. 📷`;
          try {
            resultado.whatsapp = await enviarPlantilla(mudanza.clienteWA, 'sugerencia_fotos_relevamiento',
              { 1: nomCli, 2: c.mudanceroNombre || 'El mudancero', 3: mudanza.tipo || 'mudanza' }, textoSugerencia);
          } catch (e) { resultado.whatsappError = e.message; }
        }

        // Mail: SOLO si el WhatsApp no se pudo entregar (fuera de ventana y sin
        // plantilla aprobada) — es un respaldo, no un segundo aviso duplicado.
        var whatsappOk = resultado.whatsapp && resultado.whatsapp.enviado === true;
        if (!whatsappOk && mudanza.clienteEmail) {
          try { await mandarMailSugerencia(mudanza, c, nomCli); resultado.mail = 'enviado (whatsapp no entregó)'; }
          catch (e) { resultado.mailError = e.message; }
        }

        enviados.push(resultado);
      }
      return res.status(200).json({ ok: true, enviados: enviados });
    }

    return res.status(405).json({ error: 'Método no permitido' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

// Mismo mail de respaldo que manda notificarCliente para cotizaciones nuevas
// (ver avisarSugerenciaFotosPorMail en cotizaciones.js) — acá duplicado porque
// este es un endpoint autocontenido, sin requerir internals de cotizaciones.js.
async function mandarMailSugerencia(mudanza, cotizacion, nomCli) {
  if (!process.env.RESEND_API_KEY || !mudanza.clienteEmail) return;
  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
    to: mudanza.clienteEmail,
    subject: `${cotizacion.mudanceroNombre || 'Un mudancero'} pidió visitarte antes de confirmar el precio`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
      <div style="background:#003580;padding:20px 28px">
        <span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#fff">Mudate</span><span style="font-family:Georgia,serif;font-size:22px;font-weight:900;color:#22C36A">Ya</span>
      </div>
      <div style="padding:28px">
        <p style="color:#0F1923;font-size:16px;line-height:1.7;margin:0 0 16px">Hola ${nomCli}, ¿cómo va?</p>
        <p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 16px"><strong>${cotizacion.mudanceroNombre || 'El mudancero'}</strong> te cotizó tu ${mudanza.tipo || 'mudanza'}, pero para confirmar el precio final pidió pasar a ver el lugar.</p>
        <p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 20px">Si te resulta más cómodo evitarte la visita, escribile a Emi (nuestra asistente) por WhatsApp con fotos de lo que hay que mudar, o contale un poco más por escrito — se lo pasamos al mudancero para que ajuste el precio sin necesidad de ir.</p>
        <div style="text-align:center;margin:20px 0">
          <a href="https://wa.me/12399462954?text=Hola%2C%20quiero%20mandar%20fotos%20de%20mi%20mudanza%20para%20evitar%20la%20visita" style="display:inline-block;background:#25D366;color:#fff;padding:13px 26px;border-radius:9px;text-decoration:none;font-weight:700;font-size:14px">Escribirle a Emi por WhatsApp →</a>
        </div>
        <div style="text-align:center;margin:4px 0 20px">
          <a href="https://mudateya.ar/mi-mudanza" style="display:inline-block;background:#F5F7FA;color:#003580;border:1px solid #E2E8F0;padding:11px 22px;border-radius:9px;text-decoration:none;font-weight:700;font-size:13px">Ver mi pedido →</a>
        </div>
        <p style="color:#94A3B8;font-size:11px;margin:0">Cualquier cosa, escribinos a <a href="mailto:hola&#64;mudateya.ar" style="color:#1A6FFF;font-weight:600">hola&#64;mudateya.ar</a></p>
      </div>
    </div>`,
  });
}
