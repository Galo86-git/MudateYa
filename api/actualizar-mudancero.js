// api/actualizar-mudancero.js
// Actualiza datos y fotos del mudancero en Redis + Vercel Blob

const { put } = require('@vercel/blob');
const { actualizarPerfilMudancero } = require('./_perfil-mudancero');

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-session-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // AUTH: solo el propio mudancero (token de sesión) o un admin pueden leer o
  // modificar el perfil. Sin esto, cualquiera con el email podía sobrescribir
  // precios y el CBU de cobro (redirigir los pagos).
  async function autorizar(email) {
    if (!email) return false;
    try { if (require('./_auth').esAdmin(req)) return true; } catch (e) {}
    try { return await require('./_sesion').esMudanceroDe(req, email); } catch (e) { return false; }
  }

  // ── GET: leer perfil completo desde Redis (incluye preciosLeads) ──
  if (req.method === 'GET') {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Falta email' });
    if (!(await autorizar(email))) return res.status(401).json({ error: 'No autorizado' });
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
  if (!(await autorizar(data.email))) return res.status(401).json({ error: 'No autorizado' });

  try {
    const perfil = await getJSON(`mudancero:perfil:${data.email}`);
    if (!perfil) return res.status(404).json({ error: 'Perfil no encontrado' });

    const emailSlug = data.email.replace(/[@.]/g, '-');

    // Subir fotos nuevas si vienen en base64, aceptar URLs si ya están subidas
    let fotoUrl     = perfil.foto      || '';
    let fotoCamionUrl = perfil.fotoCamion || '';
    let fotosVehUrls  = perfil.fotosVehiculo || [];
    let dniFrenteUrl  = perfil.dniFrente || '';
    let dniDorsoUrl   = perfil.dniDorso  || '';
    let dniAnalisisData = perfil.dniAnalisis || null;

    // Foto de perfil: aceptar base64 (subir) o URL ya subida (mantener)
    if (data.foto !== undefined) {
      if (data.foto && data.foto.startsWith && data.foto.startsWith('data:image')) {
        fotoUrl = await subirFotoBlob(data.foto, emailSlug + '-perfil') || fotoUrl;
      } else if (data.foto && data.foto.startsWith && data.foto.startsWith('http')) {
        fotoUrl = data.foto;
      }
    }
    // Foto camión (legacy single)
    if (data.fotoCamion !== undefined) {
      if (data.fotoCamion && data.fotoCamion.startsWith && data.fotoCamion.startsWith('data:image')) {
        fotoCamionUrl = await subirFotoBlob(data.fotoCamion, emailSlug + '-camion') || fotoCamionUrl;
      } else if (data.fotoCamion && data.fotoCamion.startsWith && data.fotoCamion.startsWith('http')) {
        fotoCamionUrl = data.fotoCamion;
      }
    }
    // Fotos vehículo (array): mezcla de base64 (subir) y URLs (mantener)
    if (data.fotosVehiculo && Array.isArray(data.fotosVehiculo) && data.fotosVehiculo.length) {
      fotosVehUrls = [];
      for (var i = 0; i < data.fotosVehiculo.length; i++) {
        var f = data.fotosVehiculo[i];
        if (!f) continue;
        if (f.startsWith('data:image')) {
          var url = await subirFotoBlob(f, emailSlug + '-veh-' + i);
          if (url) fotosVehUrls.push(url);
        } else if (f.startsWith('http')) {
          fotosVehUrls.push(f); // ya es URL, mantener
        }
      }
      if (!fotosVehUrls.length) fotosVehUrls = perfil.fotosVehiculo || [];
    }
    // DNI frente: base64 o URL
    if (data.dniFrente !== undefined) {
      if (data.dniFrente && data.dniFrente.startsWith && data.dniFrente.startsWith('data:image')) {
        dniFrenteUrl = await subirFotoBlob(data.dniFrente, emailSlug + '-dni-frente') || dniFrenteUrl;
      } else if (data.dniFrente && data.dniFrente.startsWith && data.dniFrente.startsWith('http')) {
        dniFrenteUrl = data.dniFrente;
      }
    }
    // DNI dorso: base64 o URL
    if (data.dniDorso !== undefined) {
      if (data.dniDorso && data.dniDorso.startsWith && data.dniDorso.startsWith('data:image')) {
        dniDorsoUrl = await subirFotoBlob(data.dniDorso, emailSlug + '-dni-dorso') || dniDorsoUrl;
      } else if (data.dniDorso && data.dniDorso.startsWith && data.dniDorso.startsWith('http')) {
        dniDorsoUrl = data.dniDorso;
      }
    }
    // DNI análisis (objeto con datos extraídos del DNI por OpenAI)
    if (data.dniAnalisis !== undefined) {
      dniAnalisisData = data.dniAnalisis || dniAnalisisData;
    }

    // ── Actualizar campos del perfil, con LOCK ──────────────────────────
    // actualizarPerfilMudancero() vuelve a leer el perfil de Redis DENTRO
    // del lock (perfilFresco) — es la copia que hace de base del merge, no
    // la `perfil` de más arriba (que pudo quedar vieja mientras se subían
    // las fotos). Así, si otra escritura (cotizar, cron, admin) tocó el
    // perfil mientras tanto, no la pisamos con una copia stale y viceversa.
    var actualizado = await actualizarPerfilMudancero(data.email, function(perfilFresco) {
      Object.assign(perfilFresco, {
        nombre:       data.nombre       || perfilFresco.nombre,
        empresa:      data.empresa      !== undefined ? data.empresa : perfilFresco.empresa,
        telefono:     data.telefono     || perfilFresco.telefono,
        zonaBase:     data.zonaBase     || perfilFresco.zonaBase,
        zonasExtra:   data.zonasExtra   !== undefined ? data.zonasExtra : perfilFresco.zonasExtra,
        vehiculo:     data.vehiculo     || perfilFresco.vehiculo,
        cantVehiculos:data.cantVehiculos|| perfilFresco.cantVehiculos,
        equipo:       data.equipo       || perfilFresco.equipo,
        servicios:    data.servicios    !== undefined ? data.servicios : perfilFresco.servicios,
        dias:         data.dias         !== undefined ? data.dias : perfilFresco.dias,
        horarios:     data.horarios     !== undefined ? data.horarios : perfilFresco.horarios,
        anticipacion: data.anticipacion || perfilFresco.anticipacion,
        extra:        data.extra        !== undefined ? data.extra : perfilFresco.extra,
        sinEstres:    data.sinEstres    !== undefined ? data.sinEstres : perfilFresco.sinEstres,
        sitioWeb:     data.sitioWeb     !== undefined ? data.sitioWeb : perfilFresco.sitioWeb,
        metodoCobro:  data.metodoCobro  || perfilFresco.metodoCobro,
        // Cómo cobra / cómo aparece el precio en el sitio: 'fijo' | 'porHora'.
        // Lo elige el mudancero (obligatorio). Se preserva si no viene en el update.
        tipoCobro:    data.tipoCobro    !== undefined ? data.tipoCobro : (perfilFresco.tipoCobro || ''),
        cbu:          data.cbu          !== undefined ? data.cbu : perfilFresco.cbu,
        emailMP:      data.emailMP      !== undefined ? data.emailMP : perfilFresco.emailMP,
        titularCuenta:data.titularCuenta!== undefined ? data.titularCuenta : perfilFresco.titularCuenta,
        // ── Modelo nuevo: niveles de servicio + precios por nivel ──
        // Se guardan en Redis para que el catálogo público los vea.
        serviciosActivos: Array.isArray(data.serviciosActivos)
          ? data.serviciosActivos
          : (perfilFresco.serviciosActivos || null),
        seguroMudanza:    data.seguroMudanza !== undefined ? !!data.seguroMudanza : !!perfilFresco.seguroMudanza,
        preciosEsencial:  data.preciosEsencial !== undefined ? data.preciosEsencial : (perfilFresco.preciosEsencial || null),
        preciosIntegral:  data.preciosIntegral !== undefined ? data.preciosIntegral : (perfilFresco.preciosIntegral || null),
        preciosLlave:     data.preciosLlave    !== undefined ? data.preciosLlave    : (perfilFresco.preciosLlave    || null),
        precioFleteNuevo: data.precioFleteNuevo!== undefined ? data.precioFleteNuevo: (perfilFresco.precioFleteNuevo|| ''),
        // Descripción predeterminada de cada pack (qué incluye) — se precarga sola
        // en la nota al cotizar, para no tipearla de cero en cada pedido.
        notaEsencial:     data.notaEsencial !== undefined ? String(data.notaEsencial).slice(0,300) : (perfilFresco.notaEsencial || ''),
        notaIntegral:     data.notaIntegral !== undefined ? String(data.notaIntegral).slice(0,300) : (perfilFresco.notaIntegral || ''),
        notaLlave:        data.notaLlave    !== undefined ? String(data.notaLlave).slice(0,300)    : (perfilFresco.notaLlave    || ''),
        precios: {
          amb1: data.precio1amb || perfilFresco.precios?.amb1 || '',
          amb2: data.precio2amb || perfilFresco.precios?.amb2 || '',
          amb3: data.precio3amb || perfilFresco.precios?.amb3 || '',
          amb4: data.precio4amb || perfilFresco.precios?.amb4 || '',
          flete:data.precioFlete|| perfilFresco.precios?.flete|| '',
          porKm:data.precioPorKm!== undefined ? data.precioPorKm : (perfilFresco.precios?.porKm || ''),
        },
        // Precios para Leads Plan Referidos Inmobiliarios (25% comisión)
        // Estructura: 5 tamaños × 3 packs. Cada nivel guardado como número (0 si vacío).
        // Si data.preciosLeads viene → reemplaza el bloque entero.
        // Si no viene → preserva lo que ya estaba en Redis (no rompe).
        preciosLeads: data.preciosLeads !== undefined ? data.preciosLeads : (perfilFresco.preciosLeads || {
          amb1:    { esencial: 0, integral: 0, llave: 0 },
          amb2:    { esencial: 0, integral: 0, llave: 0 },
          amb3:    { esencial: 0, integral: 0, llave: 0 },
          amb4:    { esencial: 0, integral: 0, llave: 0 },
          amb5plus:{ esencial: 0, integral: 0, llave: 0 }
        }),
        foto:          fotoUrl,
        fotoCamion:    fotoCamionUrl,
        fotosVehiculo: fotosVehUrls,
        dniFrente:     dniFrenteUrl,
        dniDorso:      dniDorsoUrl,
        dniAnalisis:   dniAnalisisData,
        ultimaActualizacion: new Date().toISOString(),
      });

      // ── AUTO-PROMOTE de pre-registrado → completo ──
      // Si el perfil cumple los requisitos mínimos para empezar a recibir pedidos,
      // marcamos estadoOnboarding='completo' para que desaparezca el badge "Pre-reg" en admin.
      // El estado de aprobación (pendiente_revision/aprobado/rechazado) NO cambia acá; eso lo
      // sigue manejando el admin manualmente.
      function _toNum(v) {
        if (v === null || v === undefined || v === '') return 0;
        return parseInt(String(v).replace(/\./g,'').replace(/[^0-9]/g,''), 10) || 0;
      }
      function _packTienePrecio(pk) {
        if (!pk || typeof pk !== 'object') return false;
        return _toNum(pk.amb1) > 0 || _toNum(pk.amb2) > 0 || _toNum(pk.amb3) > 0 || _toNum(pk.amb4) > 0;
      }
      var estadoOnboardingPrevio = perfilFresco.estadoOnboarding;
      var sa = Array.isArray(perfilFresco.serviciosActivos) ? perfilFresco.serviciosActivos : [];
      var algunPrecio =
        (sa.indexOf('esencial') !== -1 && _packTienePrecio(perfilFresco.preciosEsencial)) ||
        (sa.indexOf('integral') !== -1 && _packTienePrecio(perfilFresco.preciosIntegral)) ||
        (sa.indexOf('llave')    !== -1 && _packTienePrecio(perfilFresco.preciosLlave)) ||
        (sa.indexOf('flete')    !== -1 && _toNum(perfilFresco.precioFleteNuevo) > 0);
      var tieneVehiculo  = !!perfilFresco.vehiculo;
      var tieneFotoVeh   = (Array.isArray(perfilFresco.fotosVehiculo) && perfilFresco.fotosVehiculo.filter(Boolean).length > 0) || !!perfilFresco.fotoCamion;
      var tieneDni       = !!perfilFresco.dniFrente;
      var tieneCobro     = !!perfilFresco.cbu || !!perfilFresco.emailMP;
      var tieneTipoCobro = perfilFresco.tipoCobro === 'fijo' || perfilFresco.tipoCobro === 'porHora';

      if (tieneVehiculo && algunPrecio && tieneFotoVeh && tieneDni && tieneCobro && tieneTipoCobro) {
        perfilFresco.estadoOnboarding = 'completo';
        // Si era pre-registrado, registramos cuándo completó el onboarding
        if (estadoOnboardingPrevio === 'pre-registrado') {
          perfilFresco.fechaCompletoOnboarding = new Date().toISOString();
        }
      }
    });
    if (!actualizado) return res.status(404).json({ error: 'Perfil no encontrado' });

    // Índice teléfono→mudancero para reconocimiento instantáneo en el bot de WhatsApp.
    try {
      const _tel8 = String(actualizado.telefono || '').replace(/\D/g, '').slice(-8);
      if (_tel8.length === 8) await redisCall('HSET', 'mudanceros:tel8-idx', _tel8, data.email);
    } catch (e) { console.warn('idx tel8:', e.message); }

    // ── AUTO-APROBACIÓN instantánea ──
    // Si con esta edición el perfil quedó completo y sin señal de fraude, se aprueba
    // solo (manda el mail de alta). No espera al admin. Se apaga con AUTO_APROBAR_ACTIVO=0.
    let autoAprobado = false;
    try {
      const r = await require('./_aprobar').intentar(data.email);
      autoAprobado = r.accion === 'aprobado';
    } catch (e) { console.warn('auto-aprobar:', e.message); }

    return res.status(200).json({ ok: true, autoAprobado });
  } catch(e) {
    console.error('Error actualizando perfil:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
