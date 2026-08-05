// api/_baja.js
// Helpers de baja (unsubscribe) compartidos.
// - firmar(email): firma HMAC corta para que el link de baja no sea falsificable.
// - linkBaja(email, campania): arma el link de baja de un clic.
// La lista de suprimidos vive en Redis como un SET: clave "baja:emails".
const crypto = require('crypto');

function secret() {
  return process.env.BAJA_SECRET
      || process.env.ADMIN_TOKEN
      || process.env.UPSTASH_REDIS_REST_TOKEN
      || 'mya-baja-fallback';
}

function firmar(email) {
  return crypto.createHmac('sha256', secret())
    .update(String(email || '').toLowerCase().trim())
    .digest('hex').slice(0, 16);
}

function linkBaja(email, campania) {
  return 'https://mudateya.ar/api/baja'
    + '?e=' + encodeURIComponent(String(email || '').toLowerCase().trim())
    + '&c=' + encodeURIComponent(campania || '')
    + '&s=' + firmar(email);
}

module.exports = { firmar, linkBaja };
