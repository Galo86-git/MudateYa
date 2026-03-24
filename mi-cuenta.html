// api/actualizar-mudancero.js
// Actualiza los datos de un mudancero en Google Sheets

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const data = req.body;
  if (!data.email) return res.status(400).json({ error: 'Falta email' });

  const sheetUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!sheetUrl) return res.status(500).json({ error: 'Sheet no configurado' });

  try {
    const response = await fetch(sheetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'update-mudancero',
        email: data.email,
        values: [
          '',                    // 0: Fecha (no tocar)
          data.nombre || '',     // 1
          data.empresa || '',    // 2
          data.telefono || '',   // 3
          data.email || '',      // 4
          data.zonaBase || '',   // 5
          data.zonasExtra || '', // 6
          '',                    // 7: Distancia
          data.vehiculo || '',   // 8
          data.cantVehiculos||'',// 9
          data.equipo || '',     // 10
          data.servicios || '',  // 11
          data.dias || '',       // 12
          data.horarios || '',   // 13
          data.anticipacion||'', // 14
          data.precio1amb || '', // 15
          data.precio2amb || '', // 16
          data.precio3amb || '', // 17
          data.precio4amb || '', // 18
          data.precioFlete || '',// 19
          data.extra || '',      // 20
        ],
      }),
    });

    const result = await response.json();
    if (result.error) throw new Error(result.error);

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error actualizando mudancero:', error);
    return res.status(500).json({ error: error.message });
  }
};
