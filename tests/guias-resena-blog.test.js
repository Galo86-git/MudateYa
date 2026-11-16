// Guías nuevas del blog (barrio cerrado y edificios en San Isidro), invitación de reseña de Google y regla "el blog no publica precios".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const leer = (f) => fs.readFileSync(path.join(RAIZ, f), 'utf8');
const GUIAS = [['blog-mudanza-a-barrio-cerrado.html', 'mudanza-a-barrio-cerrado'], ['blog-ingreso-mudanza-edificio-san-isidro.html', 'ingreso-mudanza-edificio-san-isidro']];

test('guías: canonical, título de hasta 65 caracteres, datos estructurados, sin precios ni descuentos, intermediario aclarado', () => {
  for (const [archivo, slug] of GUIAS) {
    const h = leer(archivo);
    assert.ok(h.includes('<link rel="canonical" href="https://mudateya.ar/blog/' + slug + '"/>'), slug + ' canonical');
    assert.ok(/<title>([^<]*)<\/title>/.exec(h)[1].length <= 65, slug + ': título largo');
    const ld = [...h.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    assert.deepStrictEqual(ld.map((x) => x['@type']), ['BlogPosting', 'BreadcrumbList', 'FAQPage'], slug);
    assert.doesNotMatch(h, /descuento|[$]\s?[0-9]/i, slug + ': MudateYa no publica precios ni descuentos');
    assert.match(h, /MudateYa es un intermediario/, slug);
    assert.ok(h.includes('_vercel/insights'), slug + ' analytics');
  }
});

test('guías: están en el sitemap, en las rutas de Vercel y en el índice del blog', () => {
  const xml = leer('sitemap.xml'), vj = JSON.parse(leer('vercel.json')), blog = leer('blog.html');
  for (const [archivo, slug] of GUIAS) {
    assert.strictEqual(xml.split('<loc>https://mudateya.ar/blog/' + slug + '</loc>').length - 1, 1, slug + ' sitemap');
    const regla = (vj.rewrites || []).find((r) => r.source === '/blog/' + slug);
    assert.ok(regla && regla.destination === '/' + archivo, slug + ' ruta');
    assert.ok(blog.includes('href="/blog/' + slug + '"'), slug + ' índice del blog');
  }
});

test('reseña de Google: apagada sin enlace https; con enlace, invita una vez, sin incentivos y sobre la experiencia con MudateYa', () => {
  const w = require('../api/whatsapp');
  const antes = process.env.GOOGLE_RESENAS_URL;
  try {
    delete process.env.GOOGLE_RESENAS_URL;
    assert.strictEqual(w.notaResenaGoogle(), '');
    process.env.GOOGLE_RESENAS_URL = 'http://sitio-inseguro.com/x';
    assert.strictEqual(w.notaResenaGoogle(), '');
    process.env.GOOGLE_RESENAS_URL = 'https://g.page/r/EJEMPLO/review';
    const n = w.notaResenaGoogle();
    assert.ok(n.includes('https://g.page/r/EJEMPLO/review'));
    assert.match(n, /UNA sola vez/); assert.match(n, /No ofrezcas nada a cambio/); assert.match(n, /no pidas que la opinión sea positiva/); assert.match(n, /no el trabajo de la empresa de mudanzas/);
  } finally { if (antes === undefined) delete process.env.GOOGLE_RESENAS_URL; else process.env.GOOGLE_RESENAS_URL = antes; }
});

test('blog automático: nunca publica montos en pesos', () => {
  const cron = require('../api/cron-blog');
  assert.strictEqual(cron.tieneMontos({ cuerpoHtml: '<p>Una mudanza sale alrededor de $350.000</p>' }), true);
  assert.strictEqual(cron.tieneMontos({ titulo: 'Desde $ 120.000', cuerpoHtml: '<p>x</p>' }), true);
  assert.strictEqual(cron.tieneMontos({ metaDescripcion: 'Precios desde $50', cuerpoHtml: '' }), true);
  assert.strictEqual(cron.tieneMontos({ titulo: 'Cómo elegir un mudancero', cuerpoHtml: '<p>Pagás con Mercado Pago o transferencia. Cada mudancero fija su cotización.</p>' }), false);
});
