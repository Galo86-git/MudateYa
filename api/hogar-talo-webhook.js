// api/hogar-talo-webhook.js
//
// Aviso de Talo para los cobros de MYA Hogar (modo directo, gestión, liquidación de proveedores).
// Mudanza tiene el suyo (api/transferencias.js?action=webhook): la cuenta de Talo es compartida.
//
// Talo manda solo { message, paymentId, externalId } y TODAVÍA NO FIRMA el aviso (X-Talo-Signature figura
// como "pronto"). Por eso acá no se confía en nada del cuerpo: se anota el paymentId y el procesamiento
// consulta la API de Talo con nuestro token (api/_hogar-pagos.js). Un aviso falso no mueve plata: como
// mucho dispara una consulta que no encuentra nada.
//
// Talo pide contestar 200 en menos de ~3 s y reintenta si no: se procesa con tope de tiempo y, si no
// alcanza, el aviso queda en el buzón y lo termina el proceso por minuto. Todo es idempotente.
//
// Apagado por defecto: HOGAR_PAGOS_ACTIVO=1 para activarlo.

const pagos = require('./_hogar-pagos');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Método no permitido' }); }
  if (process.env.HOGAR_PAGOS_ACTIVO !== '1') return res.status(200).json({ ok: true, inactivo: true });

  const b = req.body || {};
  const paymentId = String(b.paymentId || '');
  if (!paymentId) return res.status(200).json({ ok: true, ignorado: 'sin paymentId' });
  if (b.externalId && String(b.externalId).indexOf('hogar~') !== 0) return res.status(200).json({ ok: true, ignorado: 'no es de Hogar' });

  try {
    await pagos.anotarAviso(null, paymentId);
  } catch (e) {
    if (/paymentId inválido/.test(e.message)) return res.status(200).json({ ok: true, ignorado: 'paymentId inválido' });
    console.error('[hogar-webhook] no se pudo anotar el aviso:', e.message);
    return res.status(500).json({ error: 'No se pudo anotar' }); // Talo reintenta
  }

  // Intento inmediato con tope; si no llega, lo termina el proceso por minuto.
  try {
    await Promise.race([pagos.procesarBuzon(null, 5).catch((e) => console.error('[hogar-webhook] procesar:', e.message)), dormir(2500)]);
  } catch (e) { /* el aviso ya está anotado */ }
  return res.status(200).json({ ok: true });
};
