// api/blog-post.js — Sirve una nota de blog generada automáticamente (guardada en
// Redis por cron-blog.js) en /blog/{slug}, server-rendered con SEO completo
// (title, description, canonical, Open Graph y schema Article). Mismo look que el
// resto del blog. Si el slug no existe, redirige a /blog.

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

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fechaLarga(iso) {
  try {
    return new Date(iso).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Argentina/Buenos_Aires' });
  } catch (e) { return ''; }
}

const CSS = `
:root{--navy:#003580;--green:#22C36A;--gold:#C6A464;--ink:#0b1b33;--muted:#5b6b82;--bg:#f6f8fc}
*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,Arial,sans-serif;color:var(--ink);background:#fff;line-height:1.7}
a{color:var(--navy)}.wrap{max-width:820px;margin:0 auto;padding:0 20px}
.wrap-wide{max-width:1040px;margin:0 auto;padding:0 20px}
header.nav{position:sticky;top:0;background:#fff;border-bottom:1px solid #e7ecf3;z-index:10}
.nav .wrap-wide{display:flex;align-items:center;justify-content:space-between;height:64px}
.brand{font-family:'Bebas Neue',Inter,sans-serif;font-size:26px;letter-spacing:1px;color:var(--navy);text-decoration:none;font-weight:700}
.brand span{color:var(--green)}
.nav-links{display:flex;align-items:center;gap:18px}
.nav-links a.txt{text-decoration:none;color:var(--ink);font-weight:600;font-size:15px}
.btn{display:inline-block;background:var(--green);color:#04231a;font-weight:700;padding:12px 22px;border-radius:10px;text-decoration:none}
.btn.nav-cta{padding:9px 16px}
.hero{background:linear-gradient(160deg,#003580,#00224f);color:#fff;padding:48px 0 40px}
.hero h1{font-size:clamp(26px,4.4vw,40px);margin:0 0 12px;line-height:1.15}
.breadcrumb{font-size:13px;color:#9fb3d1;margin:0 0 14px}
.breadcrumb a{color:#cfe0ff;text-decoration:none}
.tag-hero{display:inline-block;background:rgba(255,255,255,.15);color:#cfe0ff;font-size:13px;font-weight:600;padding:4px 12px;border-radius:999px;margin-bottom:14px}
.post-meta{color:#a9bcda;font-size:14px;margin-top:12px}
.post{padding:44px 0 8px}
.post h2{font-size:25px;margin:38px 0 14px;line-height:1.25}
.post h3{font-size:19px;color:var(--navy);margin:26px 0 8px}
.post p{margin:0 0 16px;font-size:17px}
.post ul,.post ol{margin:0 0 18px;padding-left:22px}
.post li{margin:0 0 9px;font-size:17px}
.inline-cta{background:var(--navy);color:#fff;border-radius:14px;padding:26px 24px;margin:32px 0;text-align:center}
.inline-cta p{color:#cfe0ff;margin:0 0 16px;font-size:17px}
.inline-cta .btn{margin:0}
.cta{background:var(--navy);color:#fff;text-align:center;padding:52px 0}
.cta h2{color:#fff;font-size:26px;margin:0 0 10px}.cta p{color:#cfe0ff;margin:0 0 22px}
footer{background:#0a1b33;color:#9fb3d1;padding:34px 0;font-size:14px}
footer a{color:#cfe0ff;text-decoration:none}
`;

function render(post) {
  const url = `https://mudateya.ar/blog/${post.slug}`;
  const desc = post.metaDescripcion || post.resumen || '';
  const fecha = fechaLarga(post.fecha);
  const schema = {
    '@context': 'https://schema.org', '@type': 'BlogPosting',
    headline: post.titulo, description: desc, url,
    datePublished: post.fecha, dateModified: post.fecha,
    image: 'https://mudateya.ar/og-image_2.jpg',
    author: { '@type': 'Organization', name: 'MudateYa' },
    publisher: { '@type': 'Organization', name: 'MudateYa', url: 'https://mudateya.ar/', logo: { '@type': 'ImageObject', url: 'https://mudateya.ar/og-image_2.jpg' } },
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
  };
  const breadcrumb = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Inicio', item: 'https://mudateya.ar/' },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: 'https://mudateya.ar/blog' },
      { '@type': 'ListItem', position: 3, name: post.titulo, item: url },
    ],
  };
  return `<!doctype html><html lang="es"><head>
<title>${esc(post.titulo)} — MudateYa</title>
<meta name="description" content="${esc(desc)}"/>
<link rel="canonical" href="${url}"/>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<meta name="theme-color" content="#003580"/>
<meta name="robots" content="index,follow"/>
<meta property="og:type" content="article"/>
<meta property="og:site_name" content="MudateYa"/>
<meta property="og:locale" content="es_AR"/>
<meta property="og:title" content="${esc(post.titulo)}"/>
<meta property="og:description" content="${esc(desc)}"/>
<meta property="og:url" content="${url}"/>
<meta property="og:image" content="https://mudateya.ar/og-image_2.jpg"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${esc(post.titulo)}"/>
<meta name="twitter:description" content="${esc(desc)}"/>
<meta name="twitter:image" content="https://mudateya.ar/og-image_2.jpg"/>
<link rel="icon" href="/favicon.ico" sizes="any"/>
<link rel="icon" type="image/svg+xml" href="/favicon.svg"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>
<script type="application/ld+json">${JSON.stringify(schema)}</script>
<script type="application/ld+json">${JSON.stringify(breadcrumb)}</script>
<style>${CSS}</style>
</head><body>
<header class="nav"><div class="wrap-wide"><a class="brand" href="/">MUDATE<span>YA</span></a><div class="nav-links"><a class="txt" href="/blog">Blog</a><a class="btn nav-cta" href="/mi-mudanza">Cotizar gratis →</a></div></div></header>
<section class="hero"><div class="wrap">
<p class="breadcrumb"><a href="/">Inicio</a> › <a href="/blog">Blog</a> › ${esc(post.titulo)}</p>
${post.tag ? `<span class="tag-hero">${esc(post.tag)}</span>` : ''}
<h1>${esc(post.titulo)}</h1>
${fecha ? `<p class="post-meta">Publicado el ${fecha}</p>` : ''}
</div></section>
<article class="post"><div class="wrap">
${post.cuerpoHtml}
<div class="inline-cta"><p>¿Te vas a mudar? Compará presupuestos de mudanceros verificados en 2 minutos.</p><a class="btn" href="/mi-mudanza">Cotizar gratis →</a></div>
</div></article>
<section class="cta"><div class="wrap">
<h2>¿Listo para mudarte?</h2>
<p>Compará precios de mudanceros verificados y pagá seguro con Mercado Pago o transferencia bancaria.</p>
<a class="btn" href="/mi-mudanza">Cotizar gratis en 2 minutos →</a>
</div></section>
<footer><div class="wrap-wide">© MudateYa — Marketplace de mudanzas y fletes de Argentina · <a href="/">Inicio</a> · <a href="/blog">Blog</a> · <a href="/contacto">Contacto</a> · <a href="/terminos">Términos</a> · <a href="/privacidad">Privacidad</a></div></footer>
</body></html>`;
}

module.exports = async function handler(req, res) {
  const slug = (req.query && req.query.slug) || '';
  if (!slug) { res.statusCode = 302; res.setHeader('Location', '/blog'); return res.end(); }

  let post = null;
  try { post = await getJSON(`blog:post:${slug}`); } catch (e) { /* noop */ }

  if (!post) { res.statusCode = 302; res.setHeader('Location', '/blog'); return res.end(); }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800');
  res.statusCode = 200;
  return res.end(render(post));
};
