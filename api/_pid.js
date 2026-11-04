// api/_pid.js
// Identificador público y opaco de un mudancero para armar el link de su perfil
// (https://mudateya.ar/mudancero?p=<pid>). Se usa en vez del email para que el
// link que Emi le manda al cliente NO revele el email del mudancero antes de que
// se pague la seña (los datos de contacto se liberan recién con el anticipo).
// Es un hash estable (mismo email → mismo pid), no un secreto: solo evita que el
// email viaje en la URL. El perfil se resuelve buscando el pid en el catálogo.

const crypto = require('crypto');

function pidMudancero(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return '';
  return crypto.createHash('sha256').update('mya-perfil:' + e).digest('hex').slice(0, 16);
}

function urlPerfilMudancero(email, base) {
  const pid = pidMudancero(email);
  if (!pid) return '';
  return `${base || 'https://mudateya.ar'}/mudancero?p=${pid}`;
}

module.exports = { pidMudancero, urlPerfilMudancero };
