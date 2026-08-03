// api/afip-check.js — DIAGNÓSTICO TEMPORAL, se borra después de confirmar que
// la integración con AFIP/ARCA (api/_afip.js) funciona con las credenciales
// reales cargadas en Vercel. Admin-only.
//
// GET /api/afip-check?cuit=20325076799  (si no se pasa cuit, usa AFIP_CUIT mismo
// — el propio CUIT del certificado, que sabemos con certeza que es real/activo).

var { esAdmin } = require('./_auth');
var { validarCuit } = require('./_afip');

module.exports = async function handler(req, res) {
  if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
  try {
    var cuit = (req.query && req.query.cuit) || process.env.AFIP_CUIT;
    var envOk = {
      AFIP_CUIT: !!process.env.AFIP_CUIT,
      AFIP_CERT_B64: !!process.env.AFIP_CERT_B64,
      AFIP_KEY_B64: !!process.env.AFIP_KEY_B64,
      AFIP_ENV: process.env.AFIP_ENV || 'prod (default)',
    };
    var t0 = Date.now();
    var resultado = await validarCuit(cuit);
    return res.status(200).json({ ok: true, envOk: envOk, cuitProbado: cuit, ms: Date.now() - t0, resultado: resultado });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
};
