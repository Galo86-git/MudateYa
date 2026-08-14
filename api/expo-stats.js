// api/expo-stats.js
// ── Admin ──
// Cuenta inmobiliarias y asesores independientes registrados con un
// "origen" puntual (ver expo.html, asesor-registro.html,
// inmobiliarias-registro.html — todos mandan ?origen=X).
//
// GET ?token=ADMIN_TOKEN&origen=expo-realestate-2026
//   → { origen, inmobiliarias: [...], asesores: [...], totalInmobiliarias, totalAsesores, total }

const { esAdmin } = require('./_auth');

async function redisCmd(args) {
  var url = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  var r = await fetch(url + '/' + args.map(encodeURIComponent).join('/'), {
    headers: { Authorization: 'Bearer ' + token }
  });
  var j = await r.json();
  return j.result;
}
async function getJSON(key) {
  var raw = await redisCmd(['GET', key]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

module.exports = async function handler(req, res) {
  if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
  var origen = String((req.query && req.query.origen) || '').trim();
  if (!origen) return res.status(400).json({ error: 'Falta ?origen=' });

  try {
    var slugsInmo = (await getJSON('inmobiliarias:lista')) || [];
    var inmobiliarias = [];
    for (var i = 0; i < slugsInmo.length; i++) {
      var inmo = await getJSON('inmobiliaria:' + slugsInmo[i]);
      if (inmo && inmo.origen === origen) {
        inmobiliarias.push({ nombre: inmo.nombre, slug: inmo.slug, fechaAlta: inmo.fechaAlta, contactoEmail: inmo.contactoEmail });
      }
    }

    var codigosAsesores = (await getJSON('indep:asesores')) || [];
    var asesores = [];
    for (var j = 0; j < codigosAsesores.length; j++) {
      var a = await getJSON('indep:asesor:' + codigosAsesores[j]);
      if (a && a.origen === origen) {
        asesores.push({ nombre: a.nombre, email: a.email, inmobiliaria: a.inmobiliaria, createdAt: a.createdAt });
      }
    }

    var idsDesarrolladoras = (await getJSON('desarrolladoras:contactos')) || [];
    var desarrolladoras = [];
    for (var k = 0; k < idsDesarrolladoras.length; k++) {
      var d = await getJSON('desarrolladora:contacto:' + idsDesarrolladoras[k]);
      if (d && d.origen === origen) {
        desarrolladoras.push({ empresa: d.empresa, nombre: d.nombre, email: d.email, createdAt: d.createdAt });
      }
    }

    return res.status(200).json({
      ok: true,
      origen: origen,
      totalInmobiliarias: inmobiliarias.length,
      totalAsesores: asesores.length,
      totalDesarrolladoras: desarrolladoras.length,
      total: inmobiliarias.length + asesores.length + desarrolladoras.length,
      inmobiliarias: inmobiliarias,
      asesores: asesores,
      desarrolladoras: desarrolladoras
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
