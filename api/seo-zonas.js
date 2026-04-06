// api/seo-zonas.js
// Páginas SEO para barrios y zonas — mudanzas-en-palermo, fletes-en-belgrano, etc.

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

// ── Datos de zonas ──────────────────────────────────────────────
const ZONAS = {
  // CABA
  'palermo':          { nombre:'Palermo', zona:'CABA', tipo:'barrio', precioBase:850000 },
  'belgrano':         { nombre:'Belgrano', zona:'CABA', tipo:'barrio', precioBase:820000 },
  'caballito':        { nombre:'Caballito', zona:'CABA', tipo:'barrio', precioBase:800000 },
  'flores':           { nombre:'Flores', zona:'CABA', tipo:'barrio', precioBase:780000 },
  'almagro':          { nombre:'Almagro', zona:'CABA', tipo:'barrio', precioBase:790000 },
  'villa-crespo':     { nombre:'Villa Crespo', zona:'CABA', tipo:'barrio', precioBase:800000 },
  'nunez':            { nombre:'Núñez', zona:'CABA', tipo:'barrio', precioBase:830000 },
  'recoleta':         { nombre:'Recoleta', zona:'CABA', tipo:'barrio', precioBase:900000 },
  'san-telmo':        { nombre:'San Telmo', zona:'CABA', tipo:'barrio', precioBase:820000 },
  'villa-urquiza':    { nombre:'Villa Urquiza', zona:'CABA', tipo:'barrio', precioBase:790000 },
  'devoto':           { nombre:'Villa Devoto', zona:'CABA', tipo:'barrio', precioBase:780000 },
  'liniers':          { nombre:'Liniers', zona:'CABA', tipo:'barrio', precioBase:760000 },
  'mataderos':        { nombre:'Mataderos', zona:'CABA', tipo:'barrio', precioBase:750000 },
  'boedo':            { nombre:'Boedo', zona:'CABA', tipo:'barrio', precioBase:780000 },
  'caba':             { nombre:'CABA', zona:'CABA', tipo:'zona', precioBase:830000 },
  // GBA
  'san-isidro':       { nombre:'San Isidro', zona:'GBA Norte', tipo:'ciudad', precioBase:870000 },
  'tigre':            { nombre:'Tigre', zona:'GBA Norte', tipo:'ciudad', precioBase:850000 },
  'vicente-lopez':    { nombre:'Vicente López', zona:'GBA Norte', tipo:'ciudad', precioBase:860000 },
  'san-martin':       { nombre:'San Martín', zona:'GBA Norte', tipo:'ciudad', precioBase:800000 },
  'moron':            { nombre:'Morón', zona:'GBA Oeste', tipo:'ciudad', precioBase:790000 },
  'merlo':            { nombre:'Merlo', zona:'GBA Oeste', tipo:'ciudad', precioBase:770000 },
  'moreno':           { nombre:'Moreno', zona:'GBA Oeste', tipo:'ciudad', precioBase:760000 },
  'lanus':            { nombre:'Lanús', zona:'GBA Sur', tipo:'ciudad', precioBase:780000 },
  'quilmes':          { nombre:'Quilmes', zona:'GBA Sur', tipo:'ciudad', precioBase:790000 },
  'avellaneda':       { nombre:'Avellaneda', zona:'GBA Sur', tipo:'ciudad', precioBase:780000 },
  'lomas-de-zamora':  { nombre:'Lomas de Zamora', zona:'GBA Sur', tipo:'ciudad', precioBase:770000 },
  // Interior
  'rosario':          { nombre:'Rosario', zona:'Santa Fe', tipo:'ciudad', precioBase:820000 },
  'cordoba':          { nombre:'Córdoba', zona:'Córdoba', tipo:'ciudad', precioBase:830000 },
  'mendoza':          { nombre:'Mendoza', zona:'Mendoza', tipo:'ciudad', precioBase:810000 },
};

function fmt(n) {
  return '$' + Math.round(n/1000)*1000 === n
    ? '$' + n.toLocaleString('es-AR')
    : '$' + Math.round(n).toLocaleString('es-AR');
}

function generarHTML(barrio, datos, esFlete, mudanceros, esSinEstres) {
  const tipoStr = esSinEstres ? 'mudanza sin estrés' : esFlete ? 'flete' : 'mudanza';
  const tiposStr = esFlete ? 'fletes' : 'mudanzas';
  const proveedorStr = esFlete ? 'fletero' : 'mudancero';
  const proveedoresStr = esFlete ? 'fleteros' : 'mudanceros';
  const precioMin = fmt(datos.precioBase * 0.7);
  const precioMax = fmt(datos.precioBase * 1.5);
  const precioPromedio = fmt(datos.precioBase);
  const siteUrl = 'https://mudateya.ar';

  const mudancerosHTML = mudanceros.length > 0
    ? mudanceros.slice(0, 6).map(m => `
      <div style="background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:16px;display:flex;gap:12px;align-items:center">
        <div style="width:48px;height:48px;border-radius:50%;background:#003580;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:16px;flex-shrink:0">
          ${(m.nombre||'MV').slice(0,2).toUpperCase()}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;color:#0F1923">${m.nombre}${m.empresa ? ' · ' + m.empresa : ''}</div>
          <div style="font-size:13px;color:#475569">📍 ${m.zonaBase} · ${m.vehiculo}</div>
          ${m.calificacion ? `<div style="font-size:12px;color:#F59E0B">★ ${m.calificacion} (${m.nroResenas} reseñas)</div>` : ''}
        </div>
        <a href="${siteUrl}?desde=${encodeURIComponent(datos.nombre)}" style="background:#1A6FFF;color:#fff;padding:8px 14px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;white-space:nowrap">Cotizar</a>
      </div>`).join('')
    : `<div style="background:#F4F6F9;border-radius:12px;padding:24px;text-align:center;color:#475569">
        <div style="font-size:2rem;margin-bottom:8px">🚛</div>
        <div style="font-weight:600;margin-bottom:4px">Sé el primero en ${datos.nombre}</div>
        <div style="font-size:13px;margin-bottom:16px">Registrate como ${proveedorStr} verificado y empezá a recibir clientes hoy.</div>
        <a href="${siteUrl}/mudanceros" style="background:#22C36A;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">Registrarme gratis →</a>
      </div>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${tipoStr.charAt(0).toUpperCase()+tipoStr.slice(1)}s en ${datos.nombre} — Precios y ${proveedoresStr} verificados | MudateYa</title>
<meta name="description" content="Encontrá ${proveedoresStr} verificados en ${datos.nombre}. Comparás precios reales, leés reseñas y elegís sin compromiso. Precio promedio: ${precioPromedio}. Publicá gratis en MudateYa."/>
<meta name="keywords" content="${tiposStr} ${datos.nombre}, ${tipoStr} económico ${datos.nombre}, ${proveedoresStr} ${datos.nombre}, precio ${tipoStr} ${datos.nombre}, ${tipoStr} barato ${datos.nombre}"/>
<link rel="canonical" href="${siteUrl}/${tiposStr}-en-${barrio}"/>
<meta property="og:title" content="${tipoStr.charAt(0).toUpperCase()+tipoStr.slice(1)}s en ${datos.nombre} | MudateYa"/>
<meta property="og:description" content="${proveedoresStr.charAt(0).toUpperCase()+proveedoresStr.slice(1)} verificados en ${datos.nombre}. Precio promedio: ${precioPromedio}."/>
<meta property="og:url" content="${siteUrl}/${tiposStr}-en-${barrio}"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',sans-serif;color:#0F1923;background:#F5F7FA}
.nav{background:#003580;padding:0 1.5rem;height:56px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
.nav-logo{font-size:20px;font-weight:900;color:#fff;text-decoration:none;letter-spacing:.5px}
.nav-logo span{color:#22C36A}
.nav-cta{background:#22C36A;color:#003580;padding:8px 16px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:700}
.hero{background:linear-gradient(135deg,#003580 0%,#1A6FFF 100%);padding:3rem 1.5rem;text-align:center}
.hero h1{font-size:clamp(1.6rem,4vw,2.4rem);font-weight:800;color:#fff;margin-bottom:.75rem;line-height:1.2}
.hero h1 em{color:#22C36A;font-style:normal}
.hero-sub{font-size:1rem;color:rgba(255,255,255,.85);margin-bottom:2rem;max-width:600px;margin-left:auto;margin-right:auto}
.hero-cta{display:inline-block;background:#22C36A;color:#003580;padding:14px 32px;border-radius:12px;font-size:16px;font-weight:800;text-decoration:none}
.container{max-width:800px;margin:0 auto;padding:2rem 1.5rem}
.section{margin-bottom:2.5rem}
.section h2{font-size:1.3rem;font-weight:700;color:#0F1923;margin-bottom:1rem;padding-bottom:.5rem;border-bottom:2px solid #E2E8F0}
.precios-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:1rem}
.precio-card{background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:16px;text-align:center}
.precio-card .label{font-size:11px;color:#94A3B8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-family:monospace}
.precio-card .valor{font-size:1.3rem;font-weight:700;color:#1A6FFF}
.mudanceros-lista{display:flex;flex-direction:column;gap:10px}
.faq{display:flex;flex-direction:column;gap:12px}
.faq-item{background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:16px}
.faq-item h3{font-size:15px;font-weight:600;color:#0F1923;margin-bottom:6px}
.faq-item p{font-size:14px;color:#475569;line-height:1.6}
.cta-box{background:linear-gradient(135deg,#003580,#1A6FFF);border-radius:16px;padding:2rem;text-align:center;color:#fff}
.cta-box h2{font-size:1.4rem;font-weight:800;margin-bottom:.5rem}
.cta-box p{font-size:14px;opacity:.9;margin-bottom:1.5rem}
.cta-box a{display:inline-block;background:#22C36A;color:#003580;padding:13px 28px;border-radius:10px;font-weight:800;font-size:15px;text-decoration:none}
.breadcrumb{font-size:12px;color:#94A3B8;margin-bottom:1.5rem}
.breadcrumb a{color:#1A6FFF;text-decoration:none}
.tags{display:flex;flex-wrap:wrap;gap:8px;margin-top:1rem}
.tag{background:#EEF4FF;color:#1A6FFF;padding:6px 12px;border-radius:20px;font-size:12px;font-weight:500;text-decoration:none}
footer{background:#003580;color:rgba(255,255,255,.7);text-align:center;padding:2rem 1.5rem;font-size:13px;margin-top:3rem}
footer a{color:#22C36A;text-decoration:none}
@media(max-width:600px){.precios-grid{grid-template-columns:1fr}}
</style>
</head>
<body>

<nav class="nav">
  <a href="${siteUrl}" class="nav-logo">Mudate<span>Ya</span></a>
  <a href="${siteUrl}" class="nav-cta">Cotizar gratis →</a>
</nav>

<div class="hero">
  <h1>${tipoStr.charAt(0).toUpperCase()+tipoStr.slice(1)}s en <em>${datos.nombre}</em> —<br>Verificados y con precios reales</h1>
  <p class="hero-sub">Encontrá ${proveedoresStr} verificados en ${datos.nombre}. Comparás precios, leés reseñas reales y elegís sin compromiso. Publicar es gratis.</p>
  <a href="${siteUrl}" class="hero-cta">Publicar mi ${tipoStr} gratis →</a>
</div>

<div class="container">

  <div class="breadcrumb">
    <a href="${siteUrl}">MudateYa</a> › <a href="${siteUrl}/${tiposStr}-en-${barrio}">${tipoStr.charAt(0).toUpperCase()+tipoStr.slice(1)}s en ${datos.nombre}</a>
  </div>

  <div class="section">
    <h2>💰 ¿Cuánto cuesta un ${tipoStr} en ${datos.nombre}?</h2>
    <div class="precios-grid">
      <div class="precio-card"><div class="label">Mínimo</div><div class="valor">${precioMin}</div></div>
      <div class="precio-card"><div class="label">Promedio</div><div class="valor">${precioPromedio}</div></div>
      <div class="precio-card"><div class="label">Máximo</div><div class="valor">${precioMax}</div></div>
    </div>
    <p style="font-size:13px;color:#94A3B8">Precios orientativos en ARS para ${tipoStr} de 2 ambientes en ${datos.nombre}. Los precios varían según distancia, piso, ascensor y servicios adicionales.</p>
  </div>

  <div class="section">
    <h2>🚛 ${proveedoresStr.charAt(0).toUpperCase()+proveedoresStr.slice(1)} verificados en ${datos.nombre}</h2>
    <div class="mudanceros-lista">${mudancerosHTML}</div>
  </div>

  <div class="section">
    <h2>❓ Preguntas frecuentes sobre ${tiposStr} en ${datos.nombre}</h2>
    <div class="faq">
      <div class="faq-item">
        <h3>¿Cuánto cuesta un ${tipoStr} en ${datos.nombre}?</h3>
        <p>El precio promedio de un ${tipoStr} en ${datos.nombre} es de <strong>${precioPromedio}</strong> para 2 ambientes. El precio final depende de la distancia, cantidad de muebles, piso sin ascensor y servicios adicionales como embalaje.</p>
      </div>
      <div class="faq-item">
        <h3>¿Cómo contratar un ${proveedorStr} verificado en ${datos.nombre}?</h3>
        <p>En MudateYa podés publicar tu ${tipoStr} gratis y recibir cotizaciones de ${proveedoresStr} con DNI verificado, fotos del vehículo y reseñas reales de clientes anteriores. Sin intermediarios y con pago seguro por Mercado Pago.</p>
      </div>
      <div class="faq-item">
        <h3>¿Qué incluye el servicio de ${tipoStr} en ${datos.nombre}?</h3>
        <p>Depende del ${proveedorStr} que elijas. La mayoría incluye carga, traslado y descarga. Algunos ofrecen embalaje, desmontaje de muebles y guardamuebles. Podés ver exactamente qué incluye cada ${proveedorStr} en su perfil.</p>
      </div>
      <div class="faq-item">
        <h3>¿Es seguro pagar online?</h3>
        <p>Sí. MudateYa usa Mercado Pago para todos los pagos. El dinero queda retenido hasta que confirmás que el servicio fue completado correctamente. Si hay algún problema, MudateYa media la situación.</p>
      </div>
      <div class="faq-item">
        <h3>¿Cuánto tarda en llegar una cotización?</h3>
        <p>En menos de 24 horas recibís cotizaciones de ${proveedoresStr} disponibles en ${datos.nombre}. Podés elegir entre recibir las primeras 5 cotizaciones automáticamente o seleccionar vos mismo los ${proveedoresStr} que te interesan.</p>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>🗺 Zonas relacionadas</h2>
    <div class="tags">
      <a href="${siteUrl}/${tiposStr}-en-caba" class="tag">${tipoStr.charAt(0).toUpperCase()+tipoStr.slice(1)}s en CABA</a>
      <a href="${siteUrl}/${tiposStr}-en-palermo" class="tag">${tipoStr.charAt(0).toUpperCase()+tipoStr.slice(1)}s en Palermo</a>
      <a href="${siteUrl}/${tiposStr}-en-belgrano" class="tag">${tipoStr.charAt(0).toUpperCase()+tipoStr.slice(1)}s en Belgrano</a>
      <a href="${siteUrl}/${tiposStr}-en-san-isidro" class="tag">${tipoStr.charAt(0).toUpperCase()+tipoStr.slice(1)}s en San Isidro</a>
      <a href="${siteUrl}/${tiposStr}-en-caballito" class="tag">${tipoStr.charAt(0).toUpperCase()+tipoStr.slice(1)}s en Caballito</a>
      <a href="${siteUrl}/${tiposStr}-en-rosario" class="tag">${tipoStr.charAt(0).toUpperCase()+tipoStr.slice(1)}s en Rosario</a>
    </div>
  </div>

  <div class="cta-box">
    <h2>¿Necesitás un ${tipoStr} en ${datos.nombre}?</h2>
    <p>Publicá gratis y recibí cotizaciones de ${proveedoresStr} verificados en menos de 24hs.</p>
    <a href="${siteUrl}">Publicar mi ${tipoStr} gratis →</a>
  </div>

</div>

<footer>
  <p>© 2026 <a href="${siteUrl}">MudateYa</a> — El primer marketplace de mudanzas y fletes de Argentina</p>
  <p style="margin-top:8px"><a href="${siteUrl}/terminos">Términos</a> · <a href="${siteUrl}/privacidad">Privacidad</a> · <a href="mailto:hola@mudateya.ar">hola@mudateya.ar</a></p>
</footer>

</body>
</html>`;
}

module.exports = async function handler(req, res) {
  const url = req.url || '';
  const path = url.split('?')[0].replace(/^\//, '');

  // Detectar tipo y barrio desde la URL
  // mudanzas-en-palermo, fletes-en-san-isidro
  const matchMudanza   = path.match(/^mudanzas-en-(.+)$/);
  const matchFlete     = path.match(/^fletes-en-(.+)$/);
  const matchSinEstres = path.match(/^mudanza-sin-estres-(.+)$/);
  const matchCompleta  = path.match(/^mudanza-completa-(.+)$/);

  const match = matchMudanza || matchFlete || matchSinEstres || matchCompleta;
  if (!match) return res.status(404).send('Not found');

  const barrio = match[1].toLowerCase();
  const esFlete = !!matchFlete;
  const esSinEstres = !!(matchSinEstres || matchCompleta);
  const datos = ZONAS[barrio];

  if (!datos) {
    return res.status(404).send('Zona no encontrada');
  }

  // Intentar cargar mudanceros reales de Redis
  let mudanceros = [];
  try {
    const todos = await getJSON('mudanceros:todos') || [];
    for (const email of todos) {
      try {
        const p = await getJSON(`mudancero:perfil:${email}`);
        if (!p || p.estado !== 'aprobado') continue;
        const zonaMatch = (p.zonaBase||'').toLowerCase().includes(datos.nombre.toLowerCase()) ||
                          (p.zonasExtra||'').toLowerCase().includes(datos.nombre.toLowerCase()) ||
                          (p.zonaBase||'').toLowerCase().includes(datos.zona.toLowerCase());
        if (zonaMatch && (!esSinEstres || p.sinEstres)) mudanceros.push(p);
      } catch(e) { continue; }
    }
  } catch(e) { mudanceros = []; }

  const html = generarHTML(barrio, datos, esFlete, mudanceros, esSinEstres);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).send(html);
};
