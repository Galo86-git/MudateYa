// api/_hogar-media.js
//
// Fotos que manda el cliente de MYA Hogar por WhatsApp. Se guardan en el store PRIVADO de Blob (el mismo de los DNI,
// api/_dni-privado.js): nunca en el público. Los profesionales las van a ver recién cuando exista el acceso autenticado
// y la moderación (que no muestren teléfonos ni direcciones); hasta entonces solo se guardan.
//
// Pendiente (anotado, no urgente): limpiar las fotos de conversaciones abandonadas (Blob no vence solo).
//
// Vercel ignora los archivos de /api que empiezan con "_".

const crypto = require('crypto');
const dniPriv = require('./_dni-privado');

const MAX_BYTES = 5 * 1024 * 1024;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' };

// base64 → pathname privado. `clave` agrupa las fotos de una conversación/pedido (ya saneada por el llamador).
// Devuelve null si no es una imagen válida o si falla el guardado (nunca tira: Emi sigue la conversación).
async function guardarFotoPrivada(base64, clave) {
  try {
    if (!base64) return null;
    const buf = Buffer.from(base64, 'base64');
    if (!buf.length || buf.length > MAX_BYTES) return null;
    const tipo = dniPriv.tipoRealDeImagen(buf); // mira los bytes, no confía en el Content-Type de Twilio
    if (!tipo || !EXT[tipo]) return null;
    if (!dniPriv.hayStorePrivado()) return null;
    const blob = require('@vercel/blob');
    const pathname = 'hogar/fotos/' + String(clave).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) + '/' + Date.now() + '-' + crypto.randomBytes(5).toString('hex') + '.' + EXT[tipo];
    const r = await dniPriv.conTimeout(blob.put(pathname, buf, { access: 'private', contentType: tipo, token: dniPriv.tokenPrivado() }), 12000, 'guardar foto');
    return r.pathname || pathname;
  } catch (e) {
    console.warn('guardarFotoPrivada:', e.message);
    return null;
  }
}

module.exports = { guardarFotoPrivada, MAX_BYTES };
