// api/_conocimiento.js
// Base de conocimiento de los bots (WhatsApp + Instagram), sincronizada SOLA
// desde la propia web de MudateYa en vez de vivir hardcodeada en cada prompt.
//
// Módulo INTERNO — sin handler HTTP propio (mismo patrón que _afip.js/_geo.js):
// Vercel ignora los archivos de /api que empiezan con "_", no se deployan
// como función. Lo dispara api/cron-conocimiento.js (1x/día).
//
// Qué hace generarConocimiento():
//   1) Junta PRECIOS REALES de mudanceros aprobados (packs + legacy) — nunca
//      inventados, mismo espíritu que datosReales() de cron-blog.js.
//   2) Trae el texto de un puñado de páginas reales del sitio (home, MudateYa
//      Mobility, FAQ de contacto) y le saca el HTML (solo texto plano).
//   3) Le pide a Claude que lo destile en un bloque compacto, en el mismo
//      tono/estructura que ya usaban los prompts (no un resumen genérico).
//   4) Lo guarda en Redis. Los bots lo leen en cada respuesta con
//      obtenerConocimiento() — si Redis está vacío o algo falla, cada bot
//      tiene su propio texto fijo de respaldo (fail-soft, nunca se rompe el
//      flujo principal por esto).

const SITE_URL = process.env.SITE_URL || 'https://mudateya.ar';
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const MODEL_LIGHT = process.env.CLAUDE_MODEL_LIGHT || 'claude-haiku-4-5';
const CONOCIMIENTO_KEY = 'bot:conocimiento';

async function redisCall(method, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/${[method, ...args].map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d = await r.json();
  return d.result;
}
async function getJSON(k) { const v = await redisCall('GET', k); return v ? JSON.parse(v) : null; }
async function setJSON(k, v) { await redisCall('SET', k, JSON.stringify(v)); }

const fmt = (n) => '$' + Number(n || 0).toLocaleString('es-AR');

function mediana(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// Descarta valores disparatados frente al RESTO DE SU MISMO grupo (ej: un
// mudancero que tipeó mal un precio y quedó con varios ceros de más — pasó
// en la práctica: un solo outlier en un grupo chico dispara el promedio a
// millones). Se calibra con la propia mediana del grupo, no con un techo fijo
// en pesos (que quedaría viejo con la inflación).
function sinOutliers(arr) {
  if (arr.length < 3) return arr; // muy pocos puntos: no hay con qué comparar
  const m = mediana(arr);
  if (!m) return arr;
  const limpio = arr.filter((v) => v <= m * 8 && v >= m / 8);
  if (limpio.length !== arr.length) {
    console.warn('preciosPromedio: descarté outliers', arr.filter((v) => !limpio.includes(v)), 'vs mediana', m);
  }
  return limpio;
}

const AMBIENTES = ['amb1', 'amb2', 'amb3', 'amb4'];
const NOMBRES_AMB = { amb1: 'Monoambiente/1 ambiente', amb2: '2 ambientes', amb3: '3 ambientes', amb4: '4 ambientes o más' };
const NIVELES = [
  { key: 'esencial', campo: 'preciosEsencial', label: 'Esencial' },
  { key: 'integral', campo: 'preciosIntegral', label: 'Integral' },
  { key: 'llave', campo: 'preciosLlave', label: 'Llave en Mano' },
];

// Junta los valores de precio de un perfil (packs + legacy) en un acumulador
// { amb1: {esencial:[],integral:[],llave:[],general:[]}, ... }. Se usa una vez
// para el cohorte "fijo" y otra para "porHora" — MISMOS campos del perfil,
// pero el número significa cosas distintas según tipoCobro (precio total del
// trabajo vs. tarifa horaria), así que nunca se mezclan en el mismo cálculo.
function sumarPerfil(acc, p) {
  let sumo = false;
  NIVELES.forEach((niv) => {
    const pack = p[niv.campo];
    if (!pack) return;
    AMBIENTES.forEach((k) => {
      const v = parseInt(String(pack[k] || '').replace(/\D/g, ''));
      if (v > 0) { acc[k][niv.key].push(v); sumo = true; }
    });
  });
  if (p.precios) {
    AMBIENTES.forEach((k) => {
      const v = parseInt(String(p.precios[k] || '').replace(/\D/g, ''));
      if (v > 0) { acc[k].general.push(v); sumo = true; }
    });
  }
  return sumo;
}
function accVacio() {
  const acc = {};
  AMBIENTES.forEach((k) => {
    acc[k] = { general: [] };
    NIVELES.forEach((niv) => { acc[k][niv.key] = []; });
  });
  return acc;
}
function centralPorAmbiente(acc) {
  const central = (arr) => mediana(sinOutliers(arr));
  const porAmbiente = {};
  AMBIENTES.forEach((k) => {
    porAmbiente[k] = { general: central(acc[k].general) };
    NIVELES.forEach((niv) => { porAmbiente[k][niv.key] = central(acc[k][niv.key]); });
  });
  return porAmbiente;
}

// ── Precios REALES de referencia, DESGLOSADOS POR NIVEL (Esencial/Integral/
// Llave en Mano) y por tamaño — de perfiles aprobados. Separa dos cohortes
// que NO se pueden promediar juntos: tipoCobro='fijo' (precio total del
// trabajo) vs 'porHora' (tarifa horaria) — son unidades distintas. Usa
// MEDIANA (no promedio simple): con pocas muestras, un solo valor mal cargado
// puede disparar un promedio a un número absurdo; la mediana no se mueve.
async function preciosPromedio() {
  try {
    const todos = (await getJSON('mudanceros:todos')) || [];
    const accFijo = accVacio();
    const accHora = accVacio();
    let nFijo = 0, nHora = 0;
    for (const email of todos.slice(0, 300)) {
      const p = await getJSON(`mudancero:perfil:${email}`);
      if (!p || p.estado !== 'aprobado') continue;
      if (p.tipoCobro === 'porHora') {
        if (sumarPerfil(accHora, p)) nHora++;
      } else if (p.tipoCobro === 'fijo') {
        if (sumarPerfil(accFijo, p)) nFijo++;
      }
      // sin tipoCobro seteado: no se sabe qué unidad es, se descarta (no se adivina).
    }
    return {
      muestras: nFijo,
      porAmbiente: centralPorAmbiente(accFijo),
      muestrasPorHora: nHora,
      porAmbientePorHora: centralPorAmbiente(accHora),
    };
  } catch (e) {
    console.warn('preciosPromedio:', e.message);
    return { muestras: 0, muestrasPorHora: 0 };
  }
}

function filasPrecios(porAmbiente) {
  const l = [];
  AMBIENTES.forEach((k) => {
    const fila = porAmbiente[k];
    if (!fila) return;
    const porNivel = NIVELES.map((niv) => (fila[niv.key] ? `${niv.label} ${fmt(fila[niv.key])}` : null)).filter(Boolean);
    if (porNivel.length) {
      l.push(`- ${NOMBRES_AMB[k]}: ${porNivel.join(' · ')}`);
    } else if (fila.general) {
      l.push(`- ${NOMBRES_AMB[k]}: ronda los ${fmt(fila.general)} (sin desglose por nivel)`);
    }
  });
  return l;
}

function bloquePrecios(d) {
  const filasFijo = d && d.muestras ? filasPrecios(d.porAmbiente || {}) : [];
  const filasHora = d && d.muestrasPorHora ? filasPrecios(d.porAmbientePorHora || {}) : [];

  if (!filasFijo.length && !filasHora.length) {
    return 'PRECIOS: no hay datos reales de precios disponibles ahora mismo. NO inventes cifras — hablá de precios en términos relativos (qué los sube o baja: distancia, piso sin ascensor, volumen), sin dar montos.';
  }

  const partes = [];
  if (filasFijo.length) {
    partes.push(
      `PRECIOS DE REFERENCIA — PRECIO FIJO (promedio real de ${d.muestras} mudanceros que cobran precio fijo por el trabajo completo, desglosado por nivel cuando hay dato):\n${filasFijo.join('\n')}`
    );
  }
  if (filasHora.length) {
    partes.push(
      `TARIFA POR HORA (promedio real de ${d.muestrasPorHora} mudanceros que cobran por hora en vez de precio fijo — estos números son $/hora, NO el total del trabajo; el total depende de cuántas horas tome):\n${filasHora.join('\n')}`
    );
  }
  partes.push(
    'Si te preguntan cuánto sale: fijate primero si ese mudancero cobra fijo o por hora (lo sabés cuando cotiza). Usá estos números SOLO como referencia aproximada general (aclarando que varía según distancia, piso/ascensor, volumen) — nunca los des como precio cerrado ni los fuerces si no viene a cuento. Nunca confundas un precio fijo con una tarifa horaria.'
  );
  return partes.join('\n\n');
}

// ── Texto plano de una URL propia del sitio (sin tags/scripts/estilos) ──
async function textoDePagina(path) {
  try {
    const r = await fetch(`${SITE_URL}${path}`, { headers: { 'User-Agent': 'MudateYaBot/1.0' } });
    if (!r.ok) return '';
    const html = await r.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(h1|h2|h3|h4|p|li|div|br|section)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&aacute;/g, 'á').replace(/&eacute;/g, 'é')
      .replace(/&iacute;/g, 'í').replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú').replace(/&ntilde;/g, 'ñ')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{2,}/g, '\n')
      .split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
      .slice(0, 8000); // cap por página: no hace falta el texto entero para destilar lo importante
  } catch (e) {
    console.warn('textoDePagina', path, e.message);
    return '';
  }
}

async function claudeTexto(system, userText, maxTokens) {
  const r = await fetch(ANTHROPIC, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL_LIGHT, max_tokens: maxTokens || 2500, system, messages: [{ role: 'user', content: userText }] }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error('anthropic ' + r.status + ' ' + JSON.stringify(d).slice(0, 200));
  return ((d.content || [])[0] || {}).text || '';
}

// Semilla de tono/estructura para que la destilación NO suene a resumen
// genérico de IA — reusa exactamente el estilo que ya está probado en Emi.
const ESTILO_SEMILLA = `Cómo funciona: 1) Cargás el pedido (origen, destino, fecha, detalles). 2) Va a mudanceros verificados de tu zona. 3) Recibís hasta 5 presupuestos. 4) Elegís y pagás la seña. 5) Coordinás con el mudancero.
Los 3 niveles de mudanza: Esencial (vehículo+chofer, carga y descarga), Integral (+ embalaje básico, desarmado/armado de muebles), Llave en Mano (+ cajas y papel, seguro ampliado). La limpieza post-mudanza NO es parte de Llave en Mano para clientes del marketplace — solo aplica en compraventas coordinadas por asesores inmobiliarios (otro flujo, no lo menciones acá salvo que la fuente lo confirme).
Pagos: 50% de seña al reservar + 50% al completar. Protegido (Mercado Pago o transferencia con CVU único). Cada presupuesto vale 7 días.
Cobertura: CABA y Gran Buenos Aires; interior (Rosario, Córdoba, Mendoza) según disponibilidad.`;

// ── Genera y guarda el bloque de conocimiento sincronizado ──
async function generarConocimiento() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY no configurada');

  const [home, mobility, contacto, precios] = await Promise.all([
    textoDePagina('/'),
    textoDePagina('/mya-mobility'),
    textoDePagina('/contacto'),
    preciosPromedio(),
  ]);

  const fuente = [
    home && `=== HOME (mudateya.ar) ===\n${home}`,
    mobility && `=== MUDATEYA MOBILITY (mya-mobility) ===\n${mobility}`,
    contacto && `=== CONTACTO / FAQ ===\n${contacto}`,
  ].filter(Boolean).join('\n\n');

  if (!fuente) throw new Error('no pude traer texto de ninguna página del sitio');

  const system =
    `Destilás el contenido real del sitio web de MudateYa (marketplace argentino de mudanzas/fletes) en una BASE DE CONOCIMIENTO compacta para un asistente de WhatsApp/Instagram. ` +
    `El asistente ya sabe hablar en tono rioplatense/casual por su cuenta — vos NO escribís diálogo ni ejemplos de conversación, solo los HECHOS que necesita para no inventar nada: qué es MudateYa, cómo funciona paso a paso, los niveles de servicio y qué incluye cada uno, cómo son los pagos, la cobertura geográfica, qué es MudateYa Mobility (relocation B2B: para quién es — inmobiliarias/desarrolladoras, clubes de fútbol, colegios, cuerpo diplomático, empresas de Vaca Muerta — y que se coordina por contacto@mudateya.ar) y cualquier pregunta frecuente real que encuentres (del FAQ). ` +
    `Sacá paja de marketing/navegación/CSS. Sé preciso y breve: bullets cortos con guion ("- "), sin inventar nada que no esté en el texto fuente. FORMATO: texto plano nomás — nada de Markdown pesado (sin #, ##, **negrita**, tablas con |, líneas ---, emojis de título). Es texto que va DENTRO de un prompt para que lea una IA, no un documento para mostrarle a una persona. Como referencia de nivel de detalle y formato esperado (no la copies, es solo el estilo):\n${ESTILO_SEMILLA}`;

  const userText =
    `Contenido real extraído de mudateya.ar (HTML ya limpiado, puede tener ruido residual — ignoralo):\n\n${fuente}\n\n` +
    `Armá la base de conocimiento destilada, en texto plano (sin Markdown). Estructurala con estos títulos EN MAYÚSCULA seguidos de ":" si hay info real (ej "PAGOS:"): QUE ES / COMO FUNCIONA, NIVELES DE SERVICIO, PAGOS, COBERTURA, MUDATEYA MOBILITY, PREGUNTAS FRECUENTES. Si algún título no tiene info real en el texto fuente, omitilo (no inventes). Sé conciso: mejor que falte una FAQ menor a que se corte a mitad de frase.`;

  const destilado = await claudeTexto(system, userText, 2500);
  if (!destilado || destilado.length < 50) throw new Error('destilado vacío o demasiado corto');

  const texto = `${destilado.trim()}\n\n${bloquePrecios(precios)}`;
  const registro = {
    texto,
    generadoEn: new Date().toISOString(),
    muestrasPrecios: precios.muestras || 0,
    muestrasPreciosPorHora: precios.muestrasPorHora || 0,
  };
  await setJSON(CONOCIMIENTO_KEY, registro);
  return registro;
}

// ── Lectura para los bots (fail-soft: null si no hay nada o algo falla) ──
async function obtenerConocimiento() {
  try {
    return await getJSON(CONOCIMIENTO_KEY);
  } catch (e) {
    console.warn('obtenerConocimiento:', e.message);
    return null;
  }
}

module.exports = { generarConocimiento, obtenerConocimiento, preciosPromedio };
