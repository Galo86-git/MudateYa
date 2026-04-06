// api/upload-foto.js
// Recibe una imagen como body binario, la sube a Vercel Blob y devuelve la URL.
// El browser llama a este endpoint al seleccionar cada foto (antes del submit).

const { put } = require('@vercel/blob');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-carpeta, x-nombre');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Método no permitido' });

  try {
    var carpeta   = req.headers['x-carpeta'] || 'mudanceros/tmp';
    var nombre    = req.headers['x-nombre']  || ('foto-' + Date.now());
    var mediaType = (req.headers['content-type'] || 'image/jpeg').split(';')[0];
    var ext       = mediaType.split('/')[1].replace('jpeg', 'jpg');
    var pathname  = carpeta + '/' + nombre + '-' + Date.now() + '.' + ext;

    // Leer body como buffer
    var chunks = [];
    await new Promise(function(resolve, reject) {
      req.on('data', function(chunk) { chunks.push(chunk); });
      req.on('end', resolve);
      req.on('error', reject);
    });
    var buffer = Buffer.concat(chunks);

    if (!buffer.length) {
      return res.status(400).json({ error: 'Archivo vacío' });
    }

    var result = await put(pathname, buffer, {
      access: 'public',
      contentType: mediaType,
    });

    return res.status(200).json({ ok: true, url: result.url });

  } catch(e) {
    console.error('Error en upload-foto:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
