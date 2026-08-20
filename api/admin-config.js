// api/admin-config.js
// Devuelve configuración pública del admin (solo el Google Client ID).
//
// ANTES también devolvía la lista de ADMIN_EMAILS sin ningún chequeo — no es
// dato de usuarios, pero le regalaba a cualquiera la lista exacta de qué
// cuentas de Google atacar (phishing/credential stuffing) para entrar al
// panel. El gate real siempre fue server-side (api/admin-sesion.js valida el
// id_token contra Google y recién ahí chequea ADMIN_EMAILS) — el cliente
// nunca necesitó la lista, solo la usaba para una UX cosmética.

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  return res.status(200).json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  });
};
