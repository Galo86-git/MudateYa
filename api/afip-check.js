// api/afip-check.js — DIAGNÓSTICO TEMPORAL, se borra después de confirmar que
// la integración con AFIP/ARCA (api/_afip.js) funciona con las credenciales
// reales cargadas en Vercel. Admin-only.
//
// GET /api/afip-check?cuit=20325076799  (si no se pasa cuit, usa AFIP_CUIT mismo
// — el propio CUIT del certificado, que sabemos con certeza que es real/activo).

var { esAdmin } = require('./_auth');
var { validarCuit } = require('./_afip');

// Diagnostica el FORMATO de una variable *_B64 sin exponer nunca su contenido
// real — solo mira si empieza con el encabezado PEM (señal de que se pegó el
// archivo tal cual, SIN pasar por base64) o si decodifica a algo con pinta de
// PEM válido. Nada de esto revela la clave/certificado en sí.
function diagnosticarB64(valor, marcadoresValidos) {
  if (!valor) return { presente: false };
  var largo = valor.length;
  var pareceRawPem = /^\s*-----BEGIN/.test(valor); // no se codificó a base64, se pegó el archivo posta
  var decoded = '';
  try { decoded = Buffer.from(valor, 'base64').toString('utf8'); } catch (e) {}
  var decodedTienePem = marcadoresValidos.some(function (m) { return decoded.indexOf(m) !== -1; });
  // Chequeos estructurales extra — nunca exponen el contenido, solo su "forma".
  var caracteresNoBase64 = (valor.match(/[^A-Za-z0-9+/=\s]/g) || []).length;
  return {
    presente: true,
    largo: largo,
    pareceQueNoEstaEnBase64_sePegoElArchivoCrudo: pareceRawPem,
    decodificaAUnPemValido: decodedTienePem,
    largoDecodificado: decoded.length,
    contieneLaPalabraBEGINenAlgunLado: valor.indexOf('BEGIN') !== -1,
    empiezaConComillaOApostrofe: /^["']/.test(valor),
    terminaConComillaOApostrofe: /["']$/.test(valor),
    contieneBarraNLiteral_backslash_n: valor.indexOf('\\n') !== -1,
    cantidadDeCaracteresQueNoSonBase64Valido: caracteresNoBase64,
    primerCaracter_soloElTipo: /[A-Za-z]/.test(valor[0]) ? 'letra' : /[0-9]/.test(valor[0]) ? 'numero' : 'simbolo(' + valor[0] + ')',
  };
}

module.exports = async function handler(req, res) {
  if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
  try {
    var cuit = (req.query && req.query.cuit) || process.env.AFIP_CUIT;
    var envOk = {
      AFIP_CUIT: !!process.env.AFIP_CUIT,
      AFIP_CERT_B64: diagnosticarB64(process.env.AFIP_CERT_B64, ['BEGIN CERTIFICATE']),
      AFIP_KEY_B64: diagnosticarB64(process.env.AFIP_KEY_B64, ['BEGIN PRIVATE KEY', 'BEGIN RSA PRIVATE KEY']),
      AFIP_ENV: process.env.AFIP_ENV || 'prod (default)',
    };
    var t0 = Date.now();
    var resultado = await validarCuit(cuit);
    return res.status(200).json({ ok: true, envOk: envOk, cuitProbado: cuit, ms: Date.now() - t0, resultado: resultado });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
};
