// api/blog-lista.js — Devuelve las notas de blog generadas automáticamente
// (cron-blog.js) para que el índice /blog las liste solo. JSON liviano.

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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400');
  try {
    const indice = (await getJSON('blog:indice')) || [];
    const posts = [];
    for (const slug of indice.slice(0, 60)) {
      const p = await getJSON(`blog:post:${slug}`);
      if (!p) continue;
      posts.push({ slug: p.slug, titulo: p.titulo, tag: p.tag || '', resumen: p.resumen || p.metaDescripcion || '', fecha: p.fecha });
    }
    return res.status(200).json({ ok: true, posts });
  } catch (e) {
    return res.status(200).json({ ok: false, posts: [], error: e.message });
  }
};
