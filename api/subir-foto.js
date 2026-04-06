// api/subir-foto.js
// Sube una foto en base64 a Vercel Blob y devuelve la URL pública

const { put } = require('@vercel/blob');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    const { foto, nombre, tipo } = req.body;
    if (!foto) return res.status(400).json({ error: 'Falta la foto' });

    // Convertir base64 a Buffer
    const base64Data = foto.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    // Detectar tipo de imagen
    const mimeMatch = foto.match(/^data:(image\/\w+);base64,/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    const ext = mimeType.split('/')[1] || 'jpg';

    // Nombre del archivo
    const filename = `mudateya/${tipo || 'foto'}/${nombre || Date.now()}-${Date.now()}.${ext}`;

    // Subir a Vercel Blob
    const blob = await put(filename, buffer, {
      access: 'public',
      contentType: mimeType,
    });

    return res.status(200).json({ ok: true, url: blob.url });
  } catch(e) {
    console.error('Error subiendo foto:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
