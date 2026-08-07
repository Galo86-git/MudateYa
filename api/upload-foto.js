// api/upload-foto.js
const { put } = require('@vercel/blob');

// Antes este endpoint no validaba nada del lado del servidor: el límite de
// "5MB, solo imágenes" que ven los usuarios es puramente de la UI (cliente),
// así que cualquiera podía pegarle directo con curl y subir un archivo de
// cualquier tamaño y tipo, público, bajo el dominio de MudateYa. Auth de
// sesión queda pendiente (lo llaman varios flujos de distintos tipos de
// usuario — mudancero, admin — sin un token compartido hoy), pero el tamaño
// y el tipo real del archivo sí se pueden validar acá sin tocar ningún
// caller.
const TIPOS_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const MAX_BYTES = 8 * 1024 * 1024; // 8MB — con margen sobre el límite de 5MB que ya pide la UI

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-carpeta, x-nombre');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Método no permitido' });

  var token = process.env.BLOB_FOTO_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;

  try {
    var carpeta   = req.headers['x-carpeta'] || 'mudanceros/tmp';
    var nombre    = req.headers['x-nombre']  || ('foto-' + Date.now());
    var mediaType = (req.headers['content-type'] || 'image/jpeg').split(';')[0].toLowerCase().trim();

    if (TIPOS_PERMITIDOS.indexOf(mediaType) === -1) {
      return res.status(400).json({ error: 'Tipo de archivo no permitido. Solo imágenes (jpg, png, webp, heic).' });
    }

    var ext       = mediaType.split('/')[1].replace('jpeg', 'jpg');
    var pathname  = carpeta + '/' + nombre + '-' + Date.now() + '.' + ext;

    var chunks = [];
    var total = 0;
    var demasiadoGrande = false;
    await new Promise(function(resolve, reject) {
      req.on('data', function(chunk) {
        total += chunk.length;
        if (total > MAX_BYTES) {
          demasiadoGrande = true;
          req.destroy();
          resolve();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', resolve);
      req.on('error', reject);
      req.on('close', resolve);
    });

    if (demasiadoGrande) {
      return res.status(413).json({ error: 'Archivo demasiado grande (máximo 8MB).' });
    }

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
