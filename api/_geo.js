// api/_geo.js — Validación/normalización de direcciones con Google Geocoding.
// Vercel ignora los archivos de /api que empiezan con "_": no se deploya como función.
//
// QUÉ RESUELVE
//   Confirma que una dirección EXISTE, la normaliza (calle, número, localidad) y
//   devuelve coordenadas (lat/lng) para geo-match. Restringe a Argentina.
//
// VARIABLE DE ENTORNO
//   GOOGLE_MAPS_API_KEY  -> key de Google Cloud con "Geocoding API" habilitada.
//   Si no está seteada, geocodificar() devuelve {ok:false} y el flujo sigue sin
//   validar (no bloquea la creación del pedido).

async function geocodificar(direccion) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  const dir = String(direccion || '').trim();
  if (!key) return { ok: false, motivo: 'sin_key' };
  if (!dir) return { ok: false, motivo: 'sin_direccion' };

  try {
    const url = 'https://maps.googleapis.com/maps/api/geocode/json'
      + '?address=' + encodeURIComponent(dir)
      + '&region=ar&components=country:AR&language=es'
      + '&key=' + key;
    const r = await fetch(url);
    const d = await r.json();

    if (d.status && d.status !== 'OK' && d.status !== 'ZERO_RESULTS') {
      // REQUEST_DENIED / OVER_QUERY_LIMIT / etc — lo logueamos para diagnosticar.
      console.warn('geocodificar status:', d.status, '—', d.error_message || '');
      return { ok: false, motivo: d.status };
    }
    if (d.status === 'ZERO_RESULTS' || !d.results || !d.results.length) {
      return { ok: false, existe: false, motivo: 'no_encontrada' };
    }

    const res = d.results[0];
    const comp = {};
    (res.address_components || []).forEach(function (c) {
      (c.types || []).forEach(function (t) { comp[t] = c.long_name; });
    });
    const loc = (res.geometry && res.geometry.location) || {};
    const tieneCalle  = !!comp.route;
    const tieneNumero = !!comp.street_number;

    return {
      ok: true,
      existe: true,
      formatted: res.formatted_address || dir,
      lat: loc.lat,
      lng: loc.lng,
      // ROOFTOP = exacta; APPROXIMATE = solo zona/localidad.
      precision: (res.geometry && res.geometry.location_type) || '',
      partial: !!res.partial_match,
      calle: comp.route || '',
      numero: comp.street_number || '',
      localidad: comp.locality || comp.administrative_area_level_2 || '',
      provincia: comp.administrative_area_level_1 || '',
      // "completa" = tiene calle Y número (no es solo un barrio/zona).
      completa: tieneCalle && tieneNumero,
    };
  } catch (e) {
    console.warn('geocodificar:', e.message);
    return { ok: false, motivo: e.message };
  }
}

// Distancia por RUTA (km) entre origen y destino (Distance Matrix, modo driving).
// Acepta strings (direcciones) o {lat,lng}. Devuelve km redondeado o null.
async function distanciaKm(origen, destino) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key || !origen || !destino) return null;
  const fmt = function (x) { return (x && typeof x === 'object' && x.lat != null) ? (x.lat + ',' + x.lng) : String(x); };
  try {
    const url = 'https://maps.googleapis.com/maps/api/distancematrix/json'
      + '?origins=' + encodeURIComponent(fmt(origen))
      + '&destinations=' + encodeURIComponent(fmt(destino))
      + '&mode=driving&region=ar&language=es&key=' + key;
    const r = await fetch(url);
    const d = await r.json();
    if (d.status && d.status !== 'OK') {
      console.warn('distanciaKm status:', d.status, '—', d.error_message || '');
    }
    const el = d.rows && d.rows[0] && d.rows[0].elements && d.rows[0].elements[0];
    if (el && el.status === 'OK' && el.distance && el.distance.value) {
      return Math.round(el.distance.value / 1000);
    }
    return null;
  } catch (e) { console.warn('distanciaKm:', e.message); return null; }
}

// Distancia en línea recta (km) entre dos coords {lat,lng}. Fallback si Distance
// Matrix no está disponible.
function haversineKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371, toRad = function (x) { return x * Math.PI / 180; };
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)));
}

module.exports = { geocodificar, distanciaKm, haversineKm };
