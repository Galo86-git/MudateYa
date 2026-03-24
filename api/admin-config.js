// api/admin-config.js
// Devuelve configuración pública del admin (Google Client ID, emails autorizados)

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  return res.status(200).json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    adminEmails: (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean),
  });
};
