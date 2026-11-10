// api/_dni-privado.js
//
// Fotos de DNI en un store PRIVADO de Vercel Blob. Antes se subían con
// access:'public' (api/upload-foto.js): cualquiera con la URL —o que adivinara
// una ruta— veía el documento. Ahora:
//   - el archivo vive en el store privado (BLOB_READ_WRITE_TOKEN, el mismo que
//     usa el Círculo con access:'private');
//   - en el perfil guardamos el PATHNAME ("dni/{hash}/frente-....jpg"), no una URL;
//   - se lee SOLO a través de api/dni.js, que exige admin o la sesión del dueño.
//
// Si BLOB_READ_WRITE_TOKEN apuntara a un store público, put(access:'private')
// falla (no hay forma de que el archivo termine público por accidente).
//
// Vercel ignora los archivos de /api que empiezan con "_".

const crypto = require('crypto');
const blobLib = require('@vercel/blob');

const PREFIJO = 'dni/';
const MAX_BYTES = 8 * 1024 * 1024;
const TIPOS = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

// Carpeta derivada del email por hash: el pathname no expone el email.
function carpetaDe(email) {
  const h = crypto.createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex').slice(0, 16);
  return PREFIJO + h + '/';
}

function esPathnameDni(v) {
  return typeof v === 'string' && v.indexOf(PREFIJO) === 0 && v.indexOf('..') === -1 && v.length < 200;
}

// ¿Este pathname es de una carpeta de ese email? Evita que alguien apunte su
// perfil al archivo de otro y lo lea por el proxy.
function perteneceA(pathname, email) {
  return esPathnameDni(pathname) && !!email && pathname.indexOf(carpetaDe(email)) === 0;
}

// Valida que los primeros bytes sean realmente una imagen (no confiar en el
// Content-Type que manda el cliente).
function tipoRealDeImagen(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf.slice(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') {
    const marca = buf.slice(8, 12).toString('latin1');
    if (/^(heic|heix|hevc|hevx|mif1|msf1|heim|heis)$/.test(marca)) return 'image/heic';
  }
  return null;
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heic' };

// Sube un DNI y devuelve el pathname. Lanza si el archivo no es imagen o si el
// store no es privado.
async function subirDni(buffer, email, lado) {
  const tipo = tipoRealDeImagen(buffer);
  if (!tipo) throw new Error('El archivo no es una imagen válida');
  if (buffer.length > MAX_BYTES) throw new Error('Archivo demasiado grande');
  const ladoOk = lado === 'dorso' ? 'dorso' : 'frente';
  const pathname = carpetaDe(email) + ladoOk + '-' + Date.now() + '-' + crypto.randomBytes(6).toString('hex') + '.' + EXT[tipo];
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('Blob no configurado');
  const r = await blobLib.put(pathname, buffer, { access: 'private', contentType: tipo, token: token });
  return r.pathname || pathname;
}

function aBuffer(stream) {
  return new Promise(function (resolve, reject) {
    if (stream && typeof stream.getReader === 'function') {
      const reader = stream.getReader();
      const chunks = [];
      (function pump() {
        reader.read().then(function (r) {
          if (r.done) { resolve(Buffer.concat(chunks)); return; }
          chunks.push(Buffer.from(r.value));
          pump();
        }).catch(reject);
      })();
    } else if (stream && typeof stream.on === 'function') {
      const chunks2 = [];
      stream.on('data', function (c) { chunks2.push(Buffer.from(c)); });
      stream.on('end', function () { resolve(Buffer.concat(chunks2)); });
      stream.on('error', reject);
    } else {
      reject(new Error('stream desconocido'));
    }
  });
}

async function leerDni(pathname) {
  if (!esPathnameDni(pathname)) throw new Error('pathname inválido');
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  // @vercel/blob >= 2.3 (antes no existía get ni access:'private'). Devuelve null si no existe.
  const result = await blobLib.get(pathname, { access: 'private', token: token });
  if (!result || result.statusCode !== 200 || !result.stream) throw new Error('no encontrada');
  const buffer = await aBuffer(result.stream);
  return { buffer: buffer, contentType: (result.blob && result.blob.contentType) || 'image/jpeg' };
}

module.exports = { PREFIJO, MAX_BYTES, TIPOS, carpetaDe, esPathnameDni, perteneceA, tipoRealDeImagen, subirDni, leerDni };
