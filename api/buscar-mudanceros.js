// api/buscar-mudanceros.js
// Devuelve mudanceros aprobados filtrados por zona

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { zona } = req.query;
  const sheetUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;

  if (!sheetUrl) return res.status(200).json({ mudanceros: [] });

  try {
    const response = await fetch(sheetUrl);
    const data = await response.json();
    const rows = data.rows || [];

    // Filtrar solo aprobados
    let aprobados = rows.filter(r => (r[21] || '').toLowerCase() === 'aprobado');

    // Filtrar por zona si se especifica
    if (zona && zona.length > 2) {
      const zonaLower = zona.toLowerCase();
      const palabras = zonaLower.split(/[\s,]+/).filter(p => p.length > 2);

      aprobados = aprobados.filter(r => {
        const zonaBase = (r[5] || '').toLowerCase();
        const zonasExtra = (r[6] || '').toLowerCase();
        const cobertura = zonaBase + ' ' + zonasExtra;
        return palabras.some(p => cobertura.includes(p)) ||
               // Matching por región general
               (zonaLower.includes('caba') && cobertura.includes('caba')) ||
               (zonaLower.includes('palermo') && cobertura.includes('caba')) ||
               (zonaLower.includes('belgrano') && cobertura.includes('caba')) ||
               (zonaLower.includes('recoleta') && cobertura.includes('caba')) ||
               (zonaLower.includes('flores') && cobertura.includes('caba')) ||
               (zonaLower.includes('caballito') && cobertura.includes('caba')) ||
               (zonaLower.includes('san isidro') && cobertura.includes('gba norte')) ||
               (zonaLower.includes('vicente lópez') && cobertura.includes('gba norte')) ||
               (zonaLower.includes('tigre') && cobertura.includes('gba norte')) ||
               (zonaLower.includes('quilmes') && cobertura.includes('gba sur')) ||
               (zonaLower.includes('avellaneda') && cobertura.includes('gba sur')) ||
               (zonaLower.includes('morón') && cobertura.includes('gba oeste')) ||
               (zonaLower.includes('haedo') && cobertura.includes('gba oeste'));
      });

      // Si no hay resultados para la zona específica, mostrar todos los aprobados
      if (aprobados.length === 0) aprobados = rows.filter(r => (r[21] || '').toLowerCase() === 'aprobado');
    }

    // Mapear a formato útil para el frontend
    const mudanceros = aprobados.slice(0, 8).map(r => ({
      nombre:       r[1]  || '',
      empresa:      r[2]  || '',
      telefono:     r[3]  || '',
      email:        r[4]  || '',
      zonaBase:     r[5]  || '',
      zonasExtra:   r[6]  || '',
      vehiculo:     r[8]  || '',
      equipo:       r[10] || '',
      servicios:    r[11] || '',
      dias:         r[12] || '',
      horarios:     r[13] || '',
      precio1amb:   r[15] || '',
      precio2amb:   r[16] || '',
      precio3amb:   r[17] || '',
      precio4amb:   r[18] || '',
      precioFlete:  r[19] || '',
      notas:        r[20] || '',
      initials:     (r[1]||'MV').split(' ').slice(0,2).map(w=>w[0]||'').join('').toUpperCase(),
    }));

    return res.status(200).json({ mudanceros, total: mudanceros.length });
  } catch (error) {
    console.error('Error buscando mudanceros:', error);
    return res.status(200).json({ mudanceros: [], error: error.message });
  }
};
