// api/circulo-foto.js
// Sirve una foto del store PRIVADO de Vercel Blob.
// La URL directa del blob privado no es pública, así que la traemos con get() y la streameamos.
// Uso desde el front:  <img src="/api/circulo-foto?pathname=circulo%2F123-ab.jpg">

var blobLib = require('@vercel/blob');

// Junta un stream (web o node) en un Buffer. Las fotos son chicas (~300KB).
function aBuffer(stream) {
  return new Promise(function (resolve, reject) {
    if (stream && typeof stream.getReader === 'function') {
      var reader = stream.getReader();
      var chunks = [];
      function pump() {
        reader.read().then(function (r) {
          if (r.done) { resolve(Buffer.concat(chunks)); return; }
          chunks.push(Buffer.from(r.value));
          pump();
        }).catch(reject);
      }
      pump();
    } else if (stream && typeof stream.on === 'function') {
      var chunks2 = [];
      stream.on('data', function (c) { chunks2.push(Buffer.from(c)); });
      stream.on('end', function () { resolve(Buffer.concat(chunks2)); });
      stream.on('error', reject);
    } else {
      reject(new Error('stream desconocido'));
    }
  });
}

module.exports = async function handler(req, res) {
  try {
    var pathname = req.query.pathname;
    if (!pathname) return res.status(400).json({ error: 'Falta pathname' });

    // TODO (gate de socio): cuando exista la sesión de /c/[slug], validar acá
    // que la request tenga sesión válida ANTES de servir la foto.
    // Por ahora queda abierto para poder probar la carga.

    var token = process.env.BLOB_READ_WRITE_TOKEN;
    var result = await blobLib.get(pathname, { access: 'private', token: token });
    var buffer = await aBuffer(result.stream);

    res.setHeader('Content-Type', (result.blob && result.blob.contentType) || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.status(200).send(buffer);
  } catch (e) {
    console.error('circulo-foto:', e.message);
    return res.status(404).json({ error: 'No encontrada' });
  }
};
