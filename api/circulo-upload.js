// api/circulo-upload.js
// Sube una foto comprimida (base64 en JSON) al store PRIVADO de Vercel Blob.
// Devuelve el pathname (no la URL), porque en un store privado la URL no es pública:
// las fotos se sirven después vía /api/circulo-foto.

var blobLib = require('@vercel/blob');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    var data = req.body && req.body.data;
    if (!data || String(data).indexOf(',') === -1) {
      return res.status(400).json({ error: 'Falta la imagen' });
    }

    var base64 = String(data).split(',')[1];
    var buffer = Buffer.from(base64, 'base64');
    if (buffer.length > 4200000) {
      return res.status(413).json({ error: 'La imagen es muy pesada' });
    }

    var nombre = 'circulo/' + Date.now() + '-' + Math.random().toString(16).slice(2, 8) + '.jpg';
    var token = process.env.BLOB_READ_WRITE_TOKEN;
    var blob = await blobLib.put(nombre, buffer, { access: 'private', contentType: 'image/jpeg', token: token });

    return res.status(200).json({ pathname: blob.pathname });
  } catch (e) {
    console.error('circulo-upload:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
