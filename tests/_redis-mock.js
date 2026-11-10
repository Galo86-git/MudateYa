// Upstash simulado: los comandos que usan el backup, la restauración y la capa de datos de Hogar.
// Pipeline por POST (/pipeline). Permite inyectar fallos de red/5xx para probar reintentos.
const http = require('node:http');

function globARegex(p) {
  return new RegExp('^' + String(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
}

function crearMock() {
  const db = new Map(); // k -> {t, v, exp}  (exp = ms restantes; 0 = sin vencimiento)
  const estado = { pedidos: 0, comandos: [], fallos: 0, estadoFallo: 503, demoraMs: 0 };

  function ejecutar(c) {
    const [op, k, ...r] = c;
    const o = String(op).toUpperCase();
    estado.comandos.push(c.map(String));
    const e = db.get(k);
    switch (o) {
      case 'SCAN': {
        const i = r.findIndex((x) => String(x).toUpperCase() === 'MATCH');
        const re = i >= 0 ? globARegex(r[i + 1]) : null;
        return ['0', [...db.keys()].filter((x) => !re || re.test(x))];
      }
      case 'TYPE': return e ? e.t : 'none';
      case 'PTTL': return !e ? -2 : e.exp ? e.exp : -1;
      case 'GET': return e && e.t === 'string' ? e.v : null;
      case 'HGETALL': return e ? Object.entries(e.v).flat() : [];
      case 'LRANGE': return e ? e.v : [];
      case 'LLEN': return e ? e.v.length : 0;
      case 'SMEMBERS': return e ? [...e.v] : [];
      case 'ZRANGE': {
        if (!e) return [];
        const conScores = r.some((x) => String(x).toUpperCase() === 'WITHSCORES');
        let a = Number(r[0]); let b = Number(r[1]);
        const n = e.v.length;
        if (a < 0) a = Math.max(0, n + a); if (b < 0) b = n + b;
        const trozo = e.v.slice(a, b + 1);
        return conScores ? trozo.flatMap((x) => [x.m, String(x.s)]) : trozo.map((x) => x.m);
      }
      case 'ZCARD': return e ? e.v.length : 0;
      case 'ZSCORE': { const x = e && e.v.find((y) => y.m === r[0]); return x ? String(x.s) : null; }
      case 'ZREM': { if (!e) return 0; const antes = e.v.length; e.v = e.v.filter((y) => !r.includes(y.m)); if (!e.v.length) db.delete(k); return antes - e.v.length; }
      case 'SREM': { if (!e) return 0; let n = 0; r.forEach((x) => { if (e.v.delete(x)) n++; }); return n; }
      case 'EXISTS': return db.has(k) ? 1 : 0;
      case 'DEL': { const had = db.delete(k); return had ? 1 : 0; }
      case 'SET': {
        const up = r.slice(1).map((x) => String(x).toUpperCase());
        const nx = up.includes('NX');
        if (nx && db.has(k)) return null;
        let exp = 0;
        const px = up.indexOf('PX'); const ex = up.indexOf('EX');
        if (px >= 0) exp = Number(r[1 + px + 1]);
        if (ex >= 0) exp = Number(r[1 + ex + 1]) * 1000;
        db.set(k, { t: 'string', v: r[0], exp });
        return 'OK';
      }
      case 'HSET': {
        const h = e && e.t === 'hash' ? e.v : {};
        for (let i = 0; i < r.length; i += 2) h[r[i]] = r[i + 1];
        db.set(k, { t: 'hash', v: h, exp: e ? e.exp : 0 });
        return Math.floor(r.length / 2);
      }
      case 'RPUSH': { const l = e && e.t === 'list' ? e.v : []; l.push(...r); db.set(k, { t: 'list', v: l, exp: e ? e.exp : 0 }); return l.length; }
      case 'SADD': { const s = e && e.t === 'set' ? e.v : new Set(); let n = 0; r.forEach((x) => { if (!s.has(x)) { s.add(x); n++; } }); db.set(k, { t: 'set', v: s, exp: e ? e.exp : 0 }); return n; }
      case 'ZADD': {
        const z = e && e.t === 'zset' ? e.v : [];
        let nuevos = 0;
        for (let i = 0; i < r.length; i += 2) {
          const s = Number(r[i]); const m = r[i + 1];
          const ya = z.find((x) => x.m === m);
          if (ya) ya.s = s; else { z.push({ s, m }); nuevos++; }
        }
        z.sort((a, b) => a.s - b.s || (a.m < b.m ? -1 : a.m > b.m ? 1 : 0));
        db.set(k, { t: 'zset', v: z, exp: e ? e.exp : 0 });
        return nuevos;
      }
      case 'PEXPIRE': { if (db.get(k)) db.get(k).exp = Number(r[0]); return 1; }
      case 'EXPIRE': { if (db.get(k)) db.get(k).exp = Number(r[0]) * 1000; return 1; }
      case 'EVAL': {
        // Único script soportado: liberar un lock solo si el token coincide.
        const key = r[1]; const token = r[2];
        const cur = db.get(key);
        if (cur && cur.v === token) { db.delete(key); return 1; }
        return 0;
      }
      default: throw new Error('comando no soportado en el mock: ' + o);
    }
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      estado.pedidos++;
      if (estado.demoraMs) await new Promise((x) => setTimeout(x, estado.demoraMs));
      if (estado.fallos > 0) { estado.fallos--; res.statusCode = estado.estadoFallo; res.end('fallo simulado'); return; }
      const cmds = JSON.parse(body);
      const out = cmds.map((c) => { try { return { result: ejecutar(c) }; } catch (err) { return { error: err.message }; } });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(out));
    });
  });
  return { db, server, estado };
}

module.exports = { crearMock };
