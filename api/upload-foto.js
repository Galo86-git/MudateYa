// api/upload-foto.js
const { put } = require('@vercel/blob');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-carpeta, x-nombre');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Método no permitido' });

  var token = process.env.BLOB_FOTO_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;
  console.log('TOKEN FOTOS presente:', !!token, '— primeros 10 chars:', token ? token.slice(0,10) : 'UNDEFINED');

  try {
    var carpeta   = req.headers['x-carpeta'] || 'mudanceros/tmp';
    var nombre    = req.headers['x-nombre']  || ('foto-' + Date.now());
    var mediaType = (req.headers['content-type'] || 'image/jpeg').split(';')[0];
    var ext       = mediaType.split('/')[1].replace('jpeg', 'jpg');
    var pathname  = carpeta + '/' + nombre + '-' + Date.now() + '.' + ext;

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
      token: token,
    });

    return res.status(200).json({ ok: true, url: result.url });

  } catch(e) {
    console.error('Error en upload-foto:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

module.exports.config = {
  api: { bodyParser: false },
};
