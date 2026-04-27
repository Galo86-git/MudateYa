// api/actualizar-mudancero.js
// Actualiza datos y fotos del mudancero en Redis + Vercel Blob

const { put } = require('@vercel/blob');

async function redisCall(method, ...args) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  const r = await fetch(
    `${url}/${[method,...args].map(encodeURIComponent).join('/')}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}
async function getJSON(key) {
  const v = await redisCall('GET', key);
  return v ? JSON.parse(v) : null;
}
async function setJSON(key, value) {
  await redisCall('SET', key, JSON.stringify(value));
}

async function subirFotoBlob(base64, nombre) {
  if (!base64 || !process.env.BLOB_READ_WRITE_TOKEN) return '';
  if (!base64.startsWith('data:image')) return base64; // ya es URL
  try {
    const base64Data = base64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const mimeMatch = base64.match(/^data:(image\/\w+);base64,/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    const ext = mimeType.split('/')[1] || 'jpg';
    const blob = await put(`mudateya/mudanceros/${nombre}-${Date.now()}.${ext}`, buffer, {
      access: 'public', contentType: mimeType,
    });
    return blob.url;
  } catch(e) {
    console.warn('Error subiendo foto:', e.message);
    return '';
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: leer perfil completo desde Redis (incluye preciosLeads) ──
  if (req.method === 'GET') {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Falta email' });
    try {
      const perfil = await getJSON(`mudancero:perfil:${email}`);
      if (!perfil) return res.status(404).json({ error: 'Perfil no encontrado' });
      return res.status(200).json({ ok: true, perfil });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const data = req.body;
  if (!data.email) return res.status(400).json({ error: 'Falta email' });

  try {
    const perfil = await getJSON(`mudancero:perfil:${data.email}`);
    if (!perfil) return res.status(404).json({ error: 'Perfil no encontrado' });

    const emailSlug = data.email.replace(/[@.]/g, '-');

    // Subir fotos nuevas si vienen en base64
    let fotoUrl     = perfil.foto      || '';
    let fotoCamionUrl = perfil.fotoCamion || '';
    let fotosVehUrls  = perfil.fotosVehiculo || [];

    if (data.foto && data.foto.startsWith('data:image')) {
      fotoUrl = await subirFotoBlob(data.foto, emailSlug + '-perfil') || fotoUrl;
    }
    if (data.fotoCamion && data.fotoCamion.startsWith('data:image')) {
      fotoCamionUrl = await subirFotoBlob(data.fotoCamion, emailSlug + '-camion') || fotoCamionUrl;
    }
    if (data.fotosVehiculo && Array.isArray(data.fotosVehiculo) && data.fotosVehiculo.length) {
      fotosVehUrls = [];
      for (var i = 0; i < data.fotosVehiculo.length; i++) {
        var f = data.fotosVehiculo[i];
        if (f.startsWith('data:image')) {
          var url = await subirFotoBlob(f, emailSlug + '-veh-' + i);
          if (url) fotosVehUrls.push(url);
        } else if (f.startsWith('http')) {
          fotosVehUrls.push(f); // ya es URL, mantener
        }
      }
      if (!fotosVehUrls.length) fotosVehUrls = perfil.fotosVehiculo || [];
    }

    // Actualizar campos del perfil
    const actualizado = Object.assign({}, perfil, {
      nombre:       data.nombre       || perfil.nombre,
      empresa:      data.empresa      !== undefined ? data.empresa : perfil.empresa,
      telefono:     data.telefono     || perfil.telefono,
      zonaBase:     data.zonaBase     || perfil.zonaBase,
      zonasExtra:   data.zonasExtra   !== undefined ? data.zonasExtra : perfil.zonasExtra,
      vehiculo:     data.vehiculo     || perfil.vehiculo,
      cantVehiculos:data.cantVehiculos|| perfil.cantVehiculos,
      equipo:       data.equipo       || perfil.equipo,
      servicios:    data.servicios    !== undefined ? data.servicios : perfil.servicios,
      dias:         data.dias         !== undefined ? data.dias : perfil.dias,
      horarios:     data.horarios     !== undefined ? data.horarios : perfil.horarios,
      anticipacion: data.anticipacion || perfil.anticipacion,
      extra:        data.extra        !== undefined ? data.extra : perfil.extra,
      sinEstres:    data.sinEstres    !== undefined ? data.sinEstres : perfil.sinEstres,
      sitioWeb:     data.sitioWeb     !== undefined ? data.sitioWeb : perfil.sitioWeb,
      metodoCobro:  data.metodoCobro  || perfil.metodoCobro,
      cbu:          data.cbu          !== undefined ? data.cbu : perfil.cbu,
      emailMP:      data.emailMP      !== undefined ? data.emailMP : perfil.emailMP,
      titularCuenta:data.titularCuenta!== undefined ? data.titularCuenta : perfil.titularCuenta,
      // ── Modelo nuevo: niveles de servicio + precios por nivel ──
      // Se guardan en Redis para que el catálogo público los vea.
      serviciosActivos: Array.isArray(data.serviciosActivos)
        ? data.serviciosActivos
        : (perfil.serviciosActivos || null),
      seguroMudanza:    data.seguroMudanza !== undefined ? !!data.seguroMudanza : !!perfil.seguroMudanza,
      preciosEsencial:  data.preciosEsencial !== undefined ? data.preciosEsencial : (perfil.preciosEsencial || null),
      preciosIntegral:  data.preciosIntegral !== undefined ? data.preciosIntegral : (perfil.preciosIntegral || null),
      preciosLlave:     data.preciosLlave    !== undefined ? data.preciosLlave    : (perfil.preciosLlave    || null),
      precioFleteNuevo: data.precioFleteNuevo!== undefined ? data.precioFleteNuevo: (perfil.precioFleteNuevo|| ''),
      precios: {
        amb1: data.precio1amb || perfil.precios?.amb1 || '',
        amb2: data.precio2amb || perfil.precios?.amb2 || '',
        amb3: data.precio3amb || perfil.precios?.amb3 || '',
        amb4: data.precio4amb || perfil.precios?.amb4 || '',
        flete:data.precioFlete|| perfil.precios?.flete|| '',
        porKm:data.precioPorKm!== undefined ? data.precioPorKm : (perfil.precios?.porKm || ''),
      },
      // Precios para Leads Plan Referidos Inmobiliarios (25% comisión)
      // Estructura: 5 tamaños × 3 packs. Cada nivel guardado como número (0 si vacío).
      // Si data.preciosLeads viene → reemplaza el bloque entero.
      // Si no viene → preserva lo que ya estaba en Redis (no rompe).
      preciosLeads: data.preciosLeads !== undefined ? data.preciosLeads : (perfil.preciosLeads || {
        amb1:    { esencial: 0, integral: 0, llave: 0 },
        amb2:    { esencial: 0, integral: 0, llave: 0 },
        amb3:    { esencial: 0, integral: 0, llave: 0 },
        amb4:    { esencial: 0, integral: 0, llave: 0 },
        amb5plus:{ esencial: 0, integral: 0, llave: 0 }
      }),
      foto:          fotoUrl,
      fotoCamion:    fotoCamionUrl,
      fotosVehiculo: fotosVehUrls,
      ultimaActualizacion: new Date().toISOString(),
    });

    await setJSON(`mudancero:perfil:${data.email}`, actualizado);

    return res.status(200).json({ ok: true });
  } catch(e) {
    console.error('Error actualizando perfil:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
