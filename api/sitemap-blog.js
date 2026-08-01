// api/sitemap-blog.js — Sitemap XML de las notas generadas automáticamente,
// servido en /blog-sitemap.xml. Referenciado desde robots.txt para que Google
// descubra las notas nuevas sin depender de JS. Se actualiza solo con cada nota.

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

module.exports = async function handler(req, res) {
  let urls = [];
  try {
    const indice = (await getJSON('blog:indice')) || [];
    for (const slug of indice.slice(0, 200)) {
      const p = await getJSON(`blog:post:${slug}`);
      if (!p) continue;
      const lastmod = (p.fecha || '').slice(0, 10);
      urls.push(
        `  <url><loc>https://mudateya.ar/blog/${slug}</loc>` +
        (lastmod ? `<lastmod>${lastmod}</lastmod>` : '') +
        `<changefreq>monthly</changefreq><priority>0.6</priority></url>`
      );
    }
  } catch (e) { /* devolvemos sitemap vacío pero válido */ }

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.join('\n') + (urls.length ? '\n' : '') +
    `</urlset>`;

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400');
  res.statusCode = 200;
  return res.end(xml);
};
