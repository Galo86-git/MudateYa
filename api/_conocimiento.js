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

// ── Precios REALES de referencia (packs + legacy, de perfiles aprobados) ──
// Mismo criterio que datosReales() de cron-blog.js pero sumando también los
// packs (Esencial/Integral/Llave), que es el modelo de precios actual — el
// legacy solo ya no alcanza para reflejar bien el mercado real.
async function preciosPromedio() {
  try {
    const todos = (await getJSON('mudanceros:todos')) || [];
    const acc = { amb1: [], amb2: [], amb3: [], amb4: [] };
    let n = 0;
    for (const email of todos.slice(0, 300)) {
      const p = await getJSON(`mudancero:perfil:${email}`);
      if (!p || p.estado !== 'aprobado') continue;
      const fuentes = [p.precios, p.preciosEsencial, p.preciosIntegral, p.preciosLlave].filter(Boolean);
      if (!fuentes.length) continue;
      let sumo = false;
      fuentes.forEach((pack) => {
        ['amb1', 'amb2', 'amb3', 'amb4'].forEach((k) => {
          const v = parseInt(String(pack[k] || '').replace(/\D/g, ''));
          if (v > 0) { acc[k].push(v); sumo = true; }
        });
      });
      if (sumo) n++;
    }
    const prom = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
    return { muestras: n, amb1: prom(acc.amb1), amb2: prom(acc.amb2), amb3: prom(acc.amb3), amb4: prom(acc.amb4) };
  } catch (e) {
    console.warn('preciosPromedio:', e.message);
    return { muestras: 0 };
  }
}

function bloquePrecios(d) {
  if (!d || !d.muestras) {
    return 'PRECIOS: no hay datos reales de precios disponibles ahora mismo. NO inventes cifras — hablá de precios en términos relativos (qué los sube o baja: distancia, piso sin ascensor, volumen), sin dar montos.';
  }
  const l = [];
  if (d.amb1) l.push(`- Monoambiente/1 ambiente: ronda los ${fmt(d.amb1)}`);
  if (d.amb2) l.push(`- 2 ambientes: ronda los ${fmt(d.amb2)}`);
  if (d.amb3) l.push(`- 3 ambientes: ronda los ${fmt(d.amb3)}`);
  if (d.amb4) l.push(`- 4 ambientes o más: ronda los ${fmt(d.amb4)}`);
  return (
    `PRECIOS DE REFERENCIA (promedio real de mudanceros de MudateYa, ${d.muestras} perfiles — ` +
    `sirve para dar una idea, el precio final lo pone cada mudancero en su cotización):\n${l.join('\n')}\n` +
    `Si te preguntan cuánto sale, podés tirar esta cifra COMO REFERENCIA aproximada (aclarando que varía según distancia, piso/ascensor, volumen) — nunca la des como precio cerrado ni la fuerces si no viene a cuento.`
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

async function claudeTexto(system, userText) {
  const r = await fetch(ANTHROPIC, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL_LIGHT, max_tokens: 1200, system, messages: [{ role: 'user', content: userText }] }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error('anthropic ' + r.status + ' ' + JSON.stringify(d).slice(0, 200));
  return ((d.content || [])[0] || {}).text || '';
}

// Semilla de tono/estructura para que la destilación NO suene a resumen
// genérico de IA — reusa exactamente el estilo que ya está probado en Emi.
const ESTILO_SEMILLA = `Cómo funciona: 1) Cargás el pedido (origen, destino, fecha, detalles). 2) Va a mudanceros verificados de tu zona. 3) Recibís hasta 5 presupuestos. 4) Elegís y pagás la seña. 5) Coordinás con el mudancero.
Los 3 niveles de mudanza: Esencial (vehículo+chofer, carga y descarga), Integral (+ embalaje básico, desarmado/armado de muebles), Llave en Mano (+ cajas y papel, seguro ampliado, limpieza post-mudanza).
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
    `Sacá paja de marketing/navegación/CSS. Sé preciso y breve: bullets cortos, sin inventar nada que no esté en el texto fuente. Como referencia de nivel de detalle esperado (no la copies, es solo el estilo):\n${ESTILO_SEMILLA}`;

  const userText =
    `Contenido real extraído de mudateya.ar (HTML ya limpiado, puede tener ruido residual — ignoralo):\n\n${fuente}\n\n` +
    `Armá la base de conocimiento destilada. Estructurala con estos títulos si hay info: QUÉ ES / CÓMO FUNCIONA, NIVELES DE SERVICIO, PAGOS, COBERTURA, MUDATEYA MOBILITY, PREGUNTAS FRECUENTES. Si algún título no tiene info real en el texto fuente, omitilo (no inventes).`;

  const destilado = await claudeTexto(system, userText);
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
