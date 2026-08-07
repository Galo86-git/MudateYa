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

// Frases de cobertura nacional — sin esto "toda argentina" se reducía a
// "toda" (stopwords descarta "argentina") y nunca matcheaba nada real.
var COMODINES_ZONA = ['toda argentina', 'todo el pais', 'toda la argentina', 'nacional', 'todo el territorio', 'todas las zonas'];
function esComodinNacional(cobertura) {
  return COMODINES_ZONA.some(function(k) { return cobertura.includes(k); });
}

// La Plata / Mar del Plata: mismo agujero y misma solución que en
// api/match-mudanceros.js (ver ese archivo para el comentario completo) —
// comparten la palabra "Plata" pero son ciudades reales a ~400km. Este
// archivo hoy no lo llama nadie (confirmado en una auditoría), pero se
// arregla igual para no dejarlo como trampa lista para el día que se reuse.
function esLaPlataCiudad(texto) {
  if (texto.includes('mar del plata')) return false;
  return /(^|\s)la plata(\s|$)/.test(texto);
}
function esMarDelPlataCiudad(texto) {
  return texto.includes('mar del plata');
}

// Verifica si un mudancero cubre la zona buscada
function cubreZona(mudancero, palabrasBuscadas, textoBusqueda) {
  var zonaBase   = norm(mudancero[5] || '');
  var zonasExtra = norm(mudancero[6] || '');
  var cobertura  = zonaBase + ' ' + zonasExtra;

  if (esComodinNacional(cobertura)) return true;

  if (textoBusqueda) {
    if (esLaPlataCiudad(textoBusqueda) && esLaPlataCiudad(cobertura)) return true;
    if (esMarDelPlataCiudad(textoBusqueda) && esMarDelPlataCiudad(cobertura)) return true;
  }
  var esAmbigua = function(w) { return w === 'plata'; };

  // Coincidencia EXACTA de palabra completa — antes había acá un match por
  // substring crudo (palabra de búsqueda contra el string entero de
  // cobertura) que hacía que "san" matcheara "Santa Fe"/"Santiago" por ser
  // prefijo. Se saca: exact-match + fallback con longitud mínima cubren los
  // casos legítimos sin ese agujero.
  var palabrasCobertura = extraerPalabrasZona(cobertura);
  var matchExacto = palabrasCobertura.some(function(p) {
    return !esAmbigua(p) && palabrasBuscadas.indexOf(p) !== -1;
  });
  if (matchExacto) return true;

  // Fallback por substring: solo palabras largas (6+) en ambos lados.
  var matchInverso = palabrasCobertura.some(function(p) {
    if (esAmbigua(p) || p.length < 6) return false;
    return palabrasBuscadas.some(function(b) { return !esAmbigua(b) && b.length >= 6 && (b.includes(p) || p.includes(b)); });
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

      const conCobertura = aprobados.filter(r => cubreZona(r, palabrasBuscadas, norm(textoBusqueda)));

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
