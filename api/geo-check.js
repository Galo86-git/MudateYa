// api/geo-check.js — Diagnóstico rápido de GOOGLE_MAPS_API_KEY del lado del servidor.
// Solo devuelve si la variable está presente y su largo (NO el valor).
// Con ?geo=1 hace una geocodificación de prueba para ver el status real de Google.
//   GET /api/geo-check        -> { keyPresente, keyLen }
//   GET /api/geo-check?geo=1   -> + { geocode: { ok, motivo, formatted } }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const key = process.env.GOOGLE_MAPS_API_KEY || '';
  const out = { keyPresente: !!key, keyLen: key.length };

  if ((req.query || {}).geo === '1') {
    if (!key) {
      out.geocode = { ok: false, motivo: 'sin_key_en_vercel' };
    } else {
      try {
        const { geocodificar, distanciaKm } = require('./_geo');
        const g = await geocodificar('Av. Cabildo 2000, CABA');
        out.geocode = { ok: g.ok, existe: g.existe, motivo: g.motivo, formatted: g.formatted || null };
        out.km_test = await distanciaKm('Av. Cabildo 2000, CABA', 'Av. Rivadavia 5000, CABA');
      } catch (e) {
        out.geocode = { ok: false, motivo: 'error:' + e.message };
      }
    }
  }

  return res.status(200).json(out);
};
