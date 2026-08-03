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
    if (!mudanza.clienteWA) return res.status(400).json({ error: 'Este pedido no tiene WhatsApp del cliente cargado' });

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
        var textoSugerencia = `¡Hola ${nomCli}! ${c.mudanceroNombre || 'El mudancero'} te cotizó tu ${mudanza.tipo || 'mudanza'}, pero pidió visitarte para confirmar el precio final.\n\nSi querés evitarte la visita, respondeme por acá con fotos de lo que hay que mudar o contame más detalles por escrito — se los paso al mudancero para que ajuste el precio sin necesidad de ir. 📷`;
        try {
          var r = await enviarPlantilla(mudanza.clienteWA, 'sugerencia_fotos_relevamiento',
            { 1: nomCli, 2: c.mudanceroNombre || 'El mudancero', 3: mudanza.tipo || 'mudanza' }, textoSugerencia);
          enviados.push({ mudanceroNombre: c.mudanceroNombre, resultado: r });
        } catch (e) { enviados.push({ mudanceroNombre: c.mudanceroNombre, error: e.message }); }
      }
      return res.status(200).json({ ok: true, enviados: enviados });
    }

    return res.status(405).json({ error: 'Método no permitido' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
