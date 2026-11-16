// Páginas por zona nuevas (Acassuso, Béccar, Zona Norte): sin precios ni descuentos, con datos estructurados, en el sitemap y con enlaces que existen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const leer = (f) => fs.readFileSync(path.join(RAIZ, f), 'utf8');
const SLUGS = ['mudanzas-en-acassuso', 'mudanzas-en-beccar', 'mudanzas-en-zona-norte'];

test('cada página nueva: canonical, título, datos estructurados válidos, analytics, sin precios ni descuentos', () => {
  for (const s of SLUGS) {
    const h = leer(s + '.html');
    assert.ok(h.includes('<link rel="canonical" href="https://mudateya.ar/' + s + '"/>'), s + ' canonical');
    assert.match(h, /<title>Mudanzas en [^<]+ \| MudateYa<\/title>/, s);
    const ld = [...h.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    assert.deepStrictEqual(ld.map((x) => x['@type']), ['Service', 'FAQPage', 'BreadcrumbList'], s);
    assert.ok(ld[1].mainEntity.length >= 5, s + ': preguntas frecuentes');
    assert.ok(h.includes('_vercel/insights'), s + ' analytics');
    assert.doesNotMatch(h, /descuento|oferta especial|\$\s?\d/i, s + ': MudateYa no publica precios ni descuentos (los fija cada mudancero)');
  }
});

test('el contenido de cada página es propio (no es la misma plantilla con otro nombre)', () => {
  const parrafo = (s) => /<h2>Mudanzas en [^<]+: lo que conviene saber<\/h2>\s*<p>([^<]+)<\/p>/.exec(leer(s + '.html'))[1];
  const ps = SLUGS.map(parrafo);
  assert.strictEqual(new Set(ps).size, 3);
  for (const p of ps) assert.ok(p.length > 300);
});

test('están en el sitemap una sola vez y los enlaces internos de la página de Zona Norte apuntan a páginas que existen', () => {
  const xml = leer('sitemap.xml');
  for (const s of SLUGS) assert.strictEqual(xml.split('<loc>https://mudateya.ar/' + s + '</loc>').length - 1, 1, s);
  const h = leer('mudanzas-en-zona-norte.html');
  const zonas = /<div class="zones">(.*?)<\/div>/.exec(h)[1];
  const hrefs = [...zonas.matchAll(/href="\/([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 10);
  for (const href of hrefs) assert.ok(fs.existsSync(path.join(RAIZ, href + '.html')), 'no existe ' + href);
});

test('las páginas vecinas enlazan a las nuevas', () => {
  for (const f of ['mudanzas-en-san-isidro', 'mudanzas-en-martinez', 'mudanzas-en-olivos', 'mudanzas-en-vicente-lopez']) {
    const h = leer(f + '.html');
    for (const s of SLUGS) assert.ok(h.includes('href="/' + s + '"'), f + ' → ' + s);
  }
});

test('cada página por zona (mudanzas-en-* y fletes-en-*) tiene su ruta en vercel.json: sin ruta, la URL canónica da 404 y solo anda el .html', () => {
  const vj = JSON.parse(leer('vercel.json'));
  const fuentes = new Set((vj.rewrites || []).map((r) => r.source));
  const sinRuta = fs.readdirSync(RAIZ).filter((f) => /^(mudanzas|fletes)-en-.*[.]html$/.test(f)).map((f) => '/' + f.replace('.html', '')).filter((u) => !fuentes.has(u));
  assert.deepStrictEqual(sinRuta, []);
});

test('el sitio no dice "pago protegido" ni variantes (no es una garantía formal): se describe solo cómo se paga', () => {
  const malos = [];
  for (const f of fs.readdirSync(RAIZ).filter((n) => /[.](html|txt)$/.test(n) && !['terminos.html', 'cobrar.html'].includes(n))) {
    if (/protegid[oa]s?/i.test(leer(f))) malos.push(f);
  }
  assert.deepStrictEqual(malos, []);
});
