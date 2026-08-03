// api/cron-conocimiento.js — Sincroniza la base de conocimiento de los bots
// (WhatsApp + Instagram) desde la propia web, 1x/día. Ver api/_conocimiento.js.
//
// Interruptor: CONOCIMIENTO_AUTO=0 lo apaga (default: activo).
// Se puede disparar a mano (admin-gated) con x-admin-token en vez de esperar
// al cron: GET /api/cron-conocimiento con ese header.

const { generarConocimiento, obtenerConocimiento } = require('./_conocimiento');

module.exports = async function handler(req, res) {
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    return res.status(200).json({ ok: true, skipped: 'no-prod' });
  }
  const esVercelCron = req.headers['x-vercel-cron'] === '1';
  let esAdminReq = false;
  try { esAdminReq = require('./_auth').esAdmin(req); } catch (_) {}
  if (!esVercelCron && !esAdminReq) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  // ?action=ver (solo admin) — lee lo que ya está guardado, sin regenerar
  // (rápido, sin gastar otra llamada a Claude). Para chequear la CALIDAD del
  // texto destilado, no solo si el proceso corrió sin errores.
  if (req.query && req.query.action === 'ver') {
    if (!esAdminReq) return res.status(401).json({ error: 'No autorizado' });
    const registro = await obtenerConocimiento();
    return res.status(200).json(registro || { ok: false, error: 'Todavía no se generó nada' });
  }
  if (process.env.CONOCIMIENTO_AUTO === '0' || process.env.CONOCIMIENTO_AUTO === 'false') {
    return res.status(200).json({ ok: true, skipped: 'CONOCIMIENTO_AUTO apagado' });
  }
  try {
    const registro = await generarConocimiento();
    return res.status(200).json({
      ok: true,
      generadoEn: registro.generadoEn,
      muestrasPrecios: registro.muestrasPrecios,
      largoTexto: registro.texto.length,
    });
  } catch (e) {
    console.error('cron-conocimiento:', e.message);
    return res.status(200).json({ ok: false, error: e.message });
  }
};
