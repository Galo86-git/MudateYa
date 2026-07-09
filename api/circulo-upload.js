// api/circulo-upload.js
// Recibe una foto comprimida (base64 en JSON) y la guarda en Vercel Blob.
// Requiere: npm i @vercel/blob  +  store de Blob conectado (BLOB_READ_WRITE_TOKEN).

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

    // ~4.5MB es el límite de la función; comprimida en el cliente entra sobrada.
    if (buffer.length > 4200000) {
      return res.status(413).json({ error: 'La imagen es muy pesada' });
    }

    var nombre = 'circulo/' + Date.now() + '-' + Math.random().toString(16).slice(2, 8) + '.jpg';
    var blob = await blobLib.put(nombre, buffer, { access: 'public', contentType: 'image/jpeg' });

    return res.status(200).json({ url: blob.url });
  } catch (e) {
    console.error('circulo-upload:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
