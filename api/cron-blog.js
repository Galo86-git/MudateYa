// api/cron-blog.js — Generador automático de notas de blog (SEO), sin intervención.
//
// Flujo 100% automático (corre 1x/mes por cron, ver vercel.json):
//   1) Elige el próximo tema no usado de la lista TEMAS (rota; no repite).
//   2) Junta DATOS REALES del sistema (precios promedio de mudanceros aprobados)
//      para que la nota NO invente números.
//   3) Genera la nota con Claude (voz MudateYa, español AR), anclada a esos datos.
//   4) 2da pasada: otra IA REVISA (precisión, que no invente precios, marca/idioma).
//      - aprobado  → publica en Redis (blog:post:{slug}) + índice. Avisa al admin.
//      - rechazado → NO publica; le manda el borrador al admin por mail para que decida.
//   Así no tenés que escribir ni revisar nada; el control de calidad lo hace la 2da IA.
//
// Las notas publicadas se sirven en /blog/{slug} (api/blog-post.js) y aparecen solas
// en el índice /blog (blog.html hace fetch a /api/blog-lista).
//
// Interruptor: BLOG_AUTO=0 lo apaga. Por defecto está activo (default: publicar).

const { Resend } = require('resend');
const MODEL = 'claude-sonnet-4-5';

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
async function setJSON(k, v, ex) {
  const a = ['SET', k, JSON.stringify(v)];
  if (ex) a.push('EX', String(ex));
  return redisCall(...a);
}

// ── Temas evergreen que NO pisan las notas estáticas ya publicadas ──
const TEMAS = [
  { slug: 'mudanza-economica-como-gastar-menos', tag: 'Ahorro', titulo: 'Mudanza económica: cómo gastar menos sin dolores de cabeza' },
  { slug: 'mudanza-monoambiente-2-ambientes', tag: 'Departamentos', titulo: 'Mudar un monoambiente o 2 ambientes: qué esperar' },
  { slug: 'flete-o-mudanza-completa-cual-elegir', tag: 'Servicios', titulo: '¿Flete o mudanza completa? Cuál te conviene' },
  { slug: 'cuanto-tarda-una-mudanza', tag: 'Tiempos', titulo: '¿Cuánto tarda una mudanza? Tiempos reales por tamaño' },
  { slug: 'mudanza-de-oficina-sin-frenar-el-trabajo', tag: 'Empresas', titulo: 'Mudanza de oficina sin frenar el trabajo' },
  { slug: 'mudanza-fin-de-mes-como-conseguir-fletero', tag: 'Organización', titulo: 'Mudarte a fin de mes: cómo conseguir fletero igual' },
  { slug: 'que-lleva-un-seguro-de-mudanza', tag: 'Seguridad', titulo: 'Seguro de mudanza: qué cubre y por qué importa' },
  { slug: 'mudanza-con-piso-sin-ascensor', tag: 'Casos', titulo: 'Mudanza en un piso sin ascensor: cómo se cotiza' },
  { slug: 'como-elegir-un-mudancero-confiable', tag: 'Contratar', titulo: 'Cómo elegir un mudancero confiable' },
  { slug: 'mudanza-de-ultimo-momento-que-hacer', tag: 'Urgencias', titulo: 'Mudanza de último momento: qué hacer' },
  { slug: 'errores-comunes-al-mudarse', tag: 'Guías', titulo: 'Los 7 errores más comunes al mudarse (y cómo evitarlos)' },
  { slug: 'mudanza-entre-provincias-argentina', tag: 'Larga distancia', titulo: 'Mudanza entre provincias en Argentina: la guía' },
];

async function claude(system, userText, maxTokens) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL, max_tokens: maxTokens || 3000, system,
      messages: [{ role: 'user', content: userText }],
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error('anthropic ' + r.status + ' ' + JSON.stringify(d).slice(0, 200));
  return (d.content && d.content[0] && d.content[0].text) || '';
}
function parseJSON(txt) {
  const m = String(txt).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('sin JSON en la respuesta');
  return JSON.parse(m[0]);
}
const fmt = (n) => '$' + Number(n || 0).toLocaleString('es-AR');

// ── Datos REALES para anclar la nota (nada inventado) ──
async function datosReales() {
  try {
    const todos = (await getJSON('mudanceros:todos')) || [];
    const acc = { amb1: [], amb2: [], amb3: [] };
    let n = 0;
    for (const email of todos.slice(0, 200)) {
      const p = await getJSON(`mudancero:perfil:${email}`);
      if (!p || p.estado !== 'aprobado' || !p.precios) continue;
      ['amb1', 'amb2', 'amb3'].forEach((k) => {
        const v = parseInt(String(p.precios[k] || '').replace(/\D/g, ''));
        if (v > 0) acc[k].push(v);
      });
      n++;
    }
    const prom = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
    return { muestras: n, amb1: prom(acc.amb1), amb2: prom(acc.amb2), amb3: prom(acc.amb3) };
  } catch (e) { return { muestras: 0 }; }
}

function bloqueDatos(d) {
  if (!d || !d.muestras) {
    return 'NO tengo precios reales del sistema en este momento. NO inventes cifras exactas de precios; hablá de precios en términos relativos (qué los sube o baja) sin dar montos específicos.';
  }
  const l = [];
  if (d.amb1) l.push(`- Mudanza chica (1 ambiente/monoambiente): alrededor de ${fmt(d.amb1)}`);
  if (d.amb2) l.push(`- Mudanza de 2 ambientes: alrededor de ${fmt(d.amb2)}`);
  if (d.amb3) l.push(`- Mudanza de 3 ambientes: alrededor de ${fmt(d.amb3)}`);
  return `PRECIOS REALES DE REFERENCIA (promedio de mudanceros de MudateYa, ${d.muestras} perfiles). ` +
    `Si mencionás precios, usá SOLO estos como referencia aproximada (aclarando que varían según distancia, piso, etc.):\n` + l.join('\n');
}

async function generar(tema, datos) {
  const system =
    `Sos redactor de contenidos SEO de MudateYa, el marketplace argentino de mudanzas y fletes. ` +
    `Escribís en español rioplatense (voseo), claro, útil y cercano, sin sonar a folleto. ` +
    `Nunca inventás datos ni precios: si te doy precios de referencia, usás esos; si no, no das cifras exactas. ` +
    `El objetivo es posicionar en Google y ser genuinamente útil para alguien que se va a mudar en Argentina.`;
  const user =
    `Escribí una nota de blog sobre: "${tema.titulo}".\n\n` +
    `${bloqueDatos(datos)}\n\n` +
    `Requisitos:\n` +
    `- 700 a 1000 palabras.\n` +
    `- Estructurada con subtítulos <h2> y <h3>, párrafos <p> y alguna lista <ul><li>.\n` +
    `- Tono MudateYa: práctico, honesto, argentino. Sin promesas exageradas.\n` +
    `- Cerrá invitando a cotizar gratis en MudateYa (sin ser insistente).\n` +
    `- NO uses <h1> (el título va aparte). NO incluyas <html>, <head> ni <body>.\n\n` +
    `Devolvé SOLO un JSON con esta forma (sin texto adicional):\n` +
    `{"titulo": "...", "metaDescripcion": "máx 155 caracteres", "resumen": "1 frase para la card del índice", "cuerpoHtml": "<h2>...</h2><p>...</p>..."}`;
  const txt = await claude(system, user, 3500);
  return parseJSON(txt);
}

async function revisar(nota, datos) {
  const system =
    `Sos editor de calidad de MudateYa. Revisás notas de blog antes de publicarlas en el sitio real. ` +
    `Sos estricto: rechazás si hay datos o precios inventados/contradictorios con los de referencia, ` +
    `errores de hecho, español no argentino, tono de folleto/spam, o contenido inútil o riesgoso.`;
  const user =
    `Datos de precios de referencia que la nota DEBERÍA respetar:\n${bloqueDatos(datos)}\n\n` +
    `NOTA A REVISAR:\nTítulo: ${nota.titulo}\nMeta: ${nota.metaDescripcion}\n\n${nota.cuerpoHtml}\n\n` +
    `¿Se puede publicar tal cual en el sitio real de MudateYa? Devolvé SOLO un JSON: ` +
    `{"aprobado": true/false, "motivos": ["..."]}`;
  const txt = await claude(system, user, 500);
  return parseJSON(txt);
}

async function avisarAdmin(asunto, html) {
  if (!process.env.RESEND_API_KEY || !process.env.ADMIN_EMAIL) return;
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
      to: process.env.ADMIN_EMAIL, subject: asunto, html,
    });
  } catch (e) { console.warn('avisarAdmin blog:', e.message); }
}

module.exports = async function handler(req, res) {
  // Solo producción (evita correr en previews de Vercel).
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    return res.status(200).json({ ok: true, skipped: 'no-prod' });
  }
  if (process.env.BLOG_AUTO === '0' || process.env.BLOG_AUTO === 'false') {
    return res.status(200).json({ ok: true, skipped: 'BLOG_AUTO apagado' });
  }
  if (!process.env.ANTHROPIC_API_KEY) return res.status(200).json({ error: 'sin ANTHROPIC_API_KEY' });

  try {
    const usados = new Set((await getJSON('blog:generados')) || []);
    const tema = TEMAS.find((t) => !usados.has(t.slug));
    if (!tema) return res.status(200).json({ ok: true, info: 'todos los temas ya fueron generados' });

    const datos = await datosReales();
    const nota = await generar(tema, datos);
    if (!nota || !nota.cuerpoHtml || !nota.titulo) throw new Error('nota vacía');

    const review = await revisar(nota, datos);

    if (!review || !review.aprobado) {
      // No publica: le manda el borrador al admin para que decida.
      await avisarAdmin(
        `📝 Borrador de blog para revisar: ${nota.titulo}`,
        `<p>La 2da IA no aprobó auto-publicar esta nota. Motivos: ${((review && review.motivos) || []).join(' · ') || '—'}</p>` +
        `<hr><h2>${nota.titulo}</h2><p><i>${nota.metaDescripcion || ''}</i></p>${nota.cuerpoHtml}`
      );
      return res.status(200).json({ ok: true, publicado: false, tema: tema.slug, motivos: (review && review.motivos) || [] });
    }

    // Publicar
    const post = {
      slug: tema.slug,
      tag: nota.tag || tema.tag,
      titulo: nota.titulo,
      metaDescripcion: (nota.metaDescripcion || '').slice(0, 160),
      resumen: nota.resumen || nota.metaDescripcion || '',
      cuerpoHtml: nota.cuerpoHtml,
      fecha: new Date().toISOString(),
    };
    await setJSON(`blog:post:${tema.slug}`, post);
    const indice = (await getJSON('blog:indice')) || [];
    if (!indice.includes(tema.slug)) indice.unshift(tema.slug);
    await setJSON('blog:indice', indice);
    const gen = (await getJSON('blog:generados')) || [];
    gen.push(tema.slug);
    await setJSON('blog:generados', gen);

    await avisarAdmin(
      `✅ Nota de blog publicada automáticamente: ${nota.titulo}`,
      `<p>Se publicó en <a href="https://mudateya.ar/blog/${tema.slug}">mudateya.ar/blog/${tema.slug}</a>. ` +
      `Si algo no te cierra, la podés bajar borrando la key <code>blog:post:${tema.slug}</code>.</p>` +
      `<hr><h2>${nota.titulo}</h2>${nota.cuerpoHtml}`
    );

    return res.status(200).json({ ok: true, publicado: true, slug: tema.slug, muestrasPrecios: datos.muestras });
  } catch (e) {
    console.error('cron-blog:', e.message);
    return res.status(200).json({ error: e.message });
  }
};
