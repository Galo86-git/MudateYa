// api/buscar-mudanceros.js
// Devuelve mudanceros aprobados filtrados por zona

// Normaliza texto: minúsculas, sin tildes, sin puntuación extra
function norm(str) {
  return (str || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Extrae palabras clave relevantes de una dirección
// Ej: "Av. El Éxodo 150, San Salvador de Jujuy, Jujuy" → ["jujuy", "san salvador"]
function extraerPalabrasZona(direccion) {
  var n = norm(direccion);
  // Sacar palabras irrelevantes
  var stopwords = ['de', 'del', 'la', 'las', 'los', 'el', 'en', 'y', 'av', 'ave', 'avenida',
    'calle', 'blvd', 'ruta', 'provincia', 'ciudad', 'argentina', 'ar'];
  return n.split(/[\s,]+/)
    .filter(function(p) { return p.length > 2 && !stopwords.includes(p); });
}

// Verifica si un mudancero cubre la zona buscada
function cubreZona(mudancero, palabrasBuscadas) {
  var zonaBase   = norm(mudancero[5] || '');
  var zonasExtra = norm(mudancero[6] || '');
  var cobertura  = zonaBase + ' ' + zonasExtra;

  // Match directo: alguna palabra de la búsqueda aparece en la cobertura del mudancero
  var matchDirecto = palabrasBuscadas.some(function(p) {
    return cobertura.includes(p);
  });
  if (matchDirecto) return true;

  // Match inverso: alguna palabra de la cobertura del mudancero aparece en la búsqueda
  var palabrasCobertura = extraerPalabrasZona(cobertura);
  var matchInverso = palabrasCobertura.some(function(p) {
    return palabrasBuscadas.some(function(b) { return b.includes(p) || p.includes(b); });
  });
  if (matchInverso) return true;

  return false;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { zona, desde, hasta } = req.query;
  const sheetUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;

  if (!sheetUrl) return res.status(200).json({ mudanceros: [], sinCobertura: true });

  try {
    const response = await fetch(sheetUrl);
    const data = await response.json();
    const rows = data.rows || [];

    // Filtrar solo aprobados
    let aprobados = rows.filter(r => (r[21] || '').toLowerCase() === 'aprobado');

    // Construir texto de búsqueda desde los parámetros disponibles
    const textoBusqueda = zona || (desde || '') + ' ' + (hasta || '');

    if (textoBusqueda.trim().length > 2) {
      const palabrasBuscadas = extraerPalabrasZona(textoBusqueda);

      const conCobertura = aprobados.filter(r => cubreZona(r, palabrasBuscadas));

      // Si no hay ninguno con cobertura explícita, devolver vacío — NO fallback
      if (conCobertura.length === 0) {
        return res.status(200).json({ mudanceros: [], total: 0, sinCobertura: true });
      }

      aprobados = conCobertura;
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

    return res.status(200).json({ mudanceros, total: mudanceros.length, sinCobertura: false });

  } catch (error) {
    console.error('Error buscando mudanceros:', error);
    return res.status(200).json({ mudanceros: [], error: error.message });
  }
};
