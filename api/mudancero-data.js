// api/mudancero-data.js
// Busca un mudancero por email en Redis

async function redisCall(method, ...args) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/${[method,...args].map(encodeURIComponent).join('/')}`,
      { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    return d.result || null;
  } catch(e) { return null; }
}
async function getJSON(key) {
  const v = await redisCall('GET', key);
  return v ? JSON.parse(v) : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'Falta email' });

  // AUTH: solo el propio mudancero (con su token de sesión) o un admin pueden
  // leer el perfil. Antes cualquiera con el email accedía a todo (DNI, CBU, etc.).
  let autorizado = false;
  try { autorizado = require('./_auth').esAdmin(req); } catch (e) {}
  if (!autorizado) {
    try { autorizado = await require('./_sesion').esMudanceroDe(req, email); } catch (e) {}
  }
  if (!autorizado) return res.status(401).json({ error: 'No autorizado' });

  try {
    const perfil = await getJSON(`mudancero:perfil:${email}`);
    if (!perfil) return res.status(200).json({ found: false });

    // Devolver perfil completo + array compatible con panel viejo
    const p = perfil;
    const row = [
      p.id || '',                                         // 0
      p.nombre || '',                                     // 1
      p.empresa || '',                                    // 2
      p.telefono || '',                                   // 3
      p.email || '',                                      // 4
      p.zonaBase || '',                                   // 5
      p.zonasExtra || '',                                 // 6
      p.distancia || '',                                  // 7
      p.vehiculo || '',                                   // 8
      p.cantVehiculos || '1',                             // 9
      p.equipo || '',                                     // 10
      p.servicios || '',                                  // 11
      p.dias || '',                                       // 12
      p.horarios || '',                                   // 13
      p.anticipacion || '',                               // 14
      (p.precios && p.precios.amb1) || '',                // 15
      (p.precios && p.precios.amb2) || '',                // 16
      (p.precios && p.precios.amb3) || '',                // 17
      (p.precios && p.precios.amb4) || '',                // 18
      (p.precios && p.precios.flete) || '',               // 19
      p.extra || '',                                      // 20
      p.estado === 'aprobado' ? 'Aprobado'
        : p.estado === 'rechazado' ? 'Rechazado'
        : 'Pendiente',                                    // 21
    ];

    return res.status(200).json({
      found: true,
      mudancero: row,
      perfil: perfil, // objeto completo para fotos y campos nuevos
    });
  } catch(e) {
    console.error('Error en mudancero-data:', e.message);
    return res.status(200).json({ found: false });
  }
};
