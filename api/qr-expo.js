// api/qr-expo.js
// QR (PNG) para el roll-up de la Expo Real Estate 2026 (Hilton Puerto Madero,
// 12-13 de agosto). Apunta a /expo, la landing con las 2 opciones (Inmobiliaria
// / Asesor). Público, sin auth — es solo una imagen para imprimir.
// Mismo patrón que el QR de asesores en api/c21.js (?action=qr).

module.exports = async function handler(req, res) {
  try {
    const QRCode = require('qrcode');
    const url = 'https://mudateya.ar/expo';
    const png = await QRCode.toBuffer(url, {
      type: 'png',
      width: 1200,     // resolución alta para impresión en roll-up
      margin: 2,
      color: { dark: '#001A40', light: '#FFFFFF' },
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).end(png);
  } catch (e) {
    console.error('qr-expo:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
