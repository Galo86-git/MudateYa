// Upstash simulado (solo los comandos que usan el backup y la restauracion).
const http = require('node:http');

function crearMock() {
  const db = new Map(); // k -> {t, v, exp}
  function ejecutar(c) {
    const [op, k, ...r] = c;
    const o = String(op).toUpperCase();
    const e = db.get(k);
    switch (o) {
      case 'SCAN': return ['0', [...db.keys()]];
      case 'TYPE': return e ? e.t : 'none';
      case 'PTTL': return !e ? -2 : e.exp ? e.exp : -1;
      case 'GET': return e ? e.v : null;
      case 'HGETALL': return e ? Object.entries(e.v).flat() : [];
      case 'LRANGE': return e ? e.v : [];
      case 'SMEMBERS': return e ? [...e.v] : [];
      case 'ZRANGE': return e ? e.v.flatMap((x) => [x.m, String(x.s)]) : [];
      case 'EXISTS': return db.has(k) ? 1 : 0;
      case 'DEL': { const had = db.delete(k); return had ? 1 : 0; }
      case 'SET': { const px = r.indexOf('PX'); db.set(k, { t: 'string', v: r[0], exp: px >= 0 ? Number(r[px + 1]) : 0 }); return 'OK'; }
      case 'HSET': { const h = {}; for (let i = 0; i < r.length; i += 2) h[r[i]] = r[i + 1]; db.set(k, { t: 'hash', v: h, exp: 0 }); return Object.keys(h).length; }
      case 'RPUSH': db.set(k, { t: 'list', v: [...r], exp: 0 }); return r.length;
      case 'SADD': db.set(k, { t: 'set', v: new Set(r), exp: 0 }); return r.length;
      case 'ZADD': { const z = []; for (let i = 0; i < r.length; i += 2) z.push({ s: Number(r[i]), m: r[i + 1] }); db.set(k, { t: 'zset', v: z, exp: 0 }); return z.length; }
      case 'PEXPIRE': { if (db.get(k)) db.get(k).exp = Number(r[0]); return 1; }
      default: throw new Error('comando no soportado en el mock: ' + o);
    }
  }
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const cmds = JSON.parse(body);
      const out = cmds.map((c) => { try { return { result: ejecutar(c) }; } catch (e) { return { error: e.message }; } });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(out));
    });
  });
  return { db, server };
}

module.exports = { crearMock };
