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

// ── Precios REALES de referencia, DESGLOSADOS POR NIVEL (Esencial/Integral/
// Llave en Mano) y por tamaño — de perfiles aprobados. El legacy `precios`
// (viejo, sin distinguir nivel) queda como respaldo "general" solo para el
// tamaño/nivel donde no haya dato específico de ningún pack. Usa MEDIANA (no
// promedio simple): con pocas muestras, un solo valor mal cargado puede
// disparar un promedio a un número absurdo; la mediana no se mueve por eso.
async function preciosPromedio() {
  try {
    const todos = (await getJSON('mudanceros:todos')) || [];
    const acc = {};
    AMBIENTES.forEach((k) => {
      acc[k] = { general: [] };
      NIVELES.forEach((niv) => { acc[k][niv.key] = []; });
    });

    let n = 0;
    for (const email of todos.slice(0, 300)) {
      const p = await getJSON(`mudancero:perfil:${email}`);
      if (!p || p.estado !== 'aprobado') continue;
      // Los que cobran "por hora" (tipoCobro) tienen una TARIFA, no el precio
      // total del trabajo — mezclarlos con los de precio fijo arruina el
      // promedio (compara cosas distintas). Solo entran los de precio fijo.
      if (p.tipoCobro !== 'fijo') continue;
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
      if (sumo) n++;
    }
    const central = (arr) => mediana(sinOutliers(arr));
    const porAmbiente = {};
    AMBIENTES.forEach((k) => {
      porAmbiente[k] = { general: central(acc[k].general) };
      NIVELES.forEach((niv) => { porAmbiente[k][niv.key] = central(acc[k][niv.key]); });
    });
    return { muestras: n, porAmbiente };
  } catch (e) {
    console.warn('preciosPromedio:', e.message);
    return { muestras: 0 };
  }
}

function bloquePrecios(d) {
  if (!d || !d.muestras || !d.porAmbiente) {
    return 'PRECIOS: no hay datos reales de precios disponibles ahora mismo. NO inventes cifras — hablá de precios en términos relativos (qué los sube o baja: distancia, piso sin ascensor, volumen), sin dar montos.';
  }
  const l = [];
  AMBIENTES.forEach((k) => {
    const fila = d.porAmbiente[k];
    if (!fila) return;
    const porNivel = NIVELES.map((niv) => (fila[niv.key] ? `${niv.label} ${fmt(fila[niv.key])}` : null)).filter(Boolean);
    if (porNivel.length) {
      l.push(`- ${NOMBRES_AMB[k]}: ${porNivel.join(' · ')}`);
    } else if (fila.general) {
      // Sin desglose por nivel para este tamaño (perfiles con precio legacy
      // nomás, sin cargar los packs) — mejor una cifra general que nada.
      l.push(`- ${NOMBRES_AMB[k]}: ronda los ${fmt(fila.general)} (sin desglose por nivel)`);
    }
  });
  if (!l.length) {
    return 'PRECIOS: no hay datos reales de precios disponibles ahora mismo. NO inventes cifras — hablá de precios en términos relativos (qué los sube o baja: distancia, piso sin ascensor, volumen), sin dar montos.';
  }
  return (
    `PRECIOS DE REFERENCIA (promedio real de mudanceros de MudateYa, ${d.muestras} perfiles — desglosado por nivel de servicio ` +
    `cuando hay dato; sirve para dar una idea, el precio final lo pone cada mudancero en su cotización):\n${l.join('\n')}\n` +
    `Si te preguntan cuánto sale, podés tirar estas cifras COMO REFERENCIA aproximada por nivel (aclarando que varía según distancia, piso/ascensor, volumen) — nunca las des como precio cerrado ni las fuerces si no viene a cuento.`
  );
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
  const registro = { texto, generadoEn: new Date().toISOString(), muestrasPrecios: precios.muestras || 0 };
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
