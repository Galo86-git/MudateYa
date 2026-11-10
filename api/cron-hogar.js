// api/cron-hogar.js
//
// Proceso por minuto de MYA Hogar (cron de Vercel: * * * * *). La lógica vive en api/_hogar-cron.js.
//   - Vercel Cron: corre un ciclo (buzón de Talo, plata sin asociar, devoluciones, avisos).
//   - Admin: GET ?accion=estado → latido y cuántos avisos hay pendientes.
//            POST (cuerpo { forzar: true }) → corre un ciclo ahora, completo (todas las tareas).
// APAGADO por defecto: no hace nada (ni toca Redis ni Talo) hasta que HOGAR_PAGOS_ACTIVO=1.

const { esAdmin, esCronVercel } = require('./_auth');
const cron = require('./_hogar-cron');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const esCron = esCronVercel(req);
  const admin = !esCron && esAdmin(req);
  if (!esCron && !admin) return res.status(401).json({ error: 'no autorizado' });
  if (process.env.HOGAR_PAGOS_ACTIVO !== '1') return res.status(200).json({ ok: true, inactivo: true });

  try {
    if (admin && req.method === 'GET' && req.query && req.query.accion === 'estado') {
      return res.status(200).json({ ok: true, ...(await cron.resumenEstado()) });
    }
    const r = await cron.cicloConLock(null, { forzar: admin && !!(req.body && req.body.forzar) });
    return res.status(200).json({ ok: !r.errores || r.errores.length === 0, ...r });
  } catch (e) {
    console.error('cron-hogar:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
