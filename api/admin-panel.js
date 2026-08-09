// api/admin-panel.js — Datos para el panel en vivo (panel-vivo.html).
// SOLO LECTURA, SOLO ADMIN. Cada sección se puede pedir por separado
// (?seccion=escalaciones|salud|asesores|mudanceros|social) o todas juntas
// (sin ?seccion). Pensado para que el frontend haga polling.
//
// Fuentes de cada sección:
//   escalaciones → panel:escalaciones (Redis list, la llena derivarHumano en whatsapp.js)
//   salud        → panel:salud-historial (Redis list, la llena cron-healthcheck.js)
//   asesores     → mudanzas:activas filtrando m.partnerAsesor (mismo índice que ya usa
//                  action=admin-comisiones-asesores en cotizaciones.js)
//   mudanceros   → mudanceros:todos + mudancero:perfil:{id}, misma señal de vida
//                  (ultimaActividad/ultimaActualizacion/fechaRegistro) que cron-recordar-perfil.js
//   social       → Vercel Web Analytics API (necesita VERCEL_API_TOKEN + VERCEL_PROJECT_ID,
//                  y VERCEL_TEAM_ID si es proyecto de team) + último snapshot de Instagram
//                  guardado por cron-resumen-instagram.js (ig:insights:ultima) — si falta
//                  alguna credencial, esa mitad se devuelve como no-disponible, con el motivo.

var { esAdmin } = require('./_auth');

async function redisCall(method, ...args) {
  var url = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  var r = await fetch(url + '/' + [method, ...args].map(encodeURIComponent).join('/'), {
    headers: { Authorization: 'Bearer ' + token },
  });
  var d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}
async function getJSON(k) { var v = await redisCall('GET', k); if (!v) return null; try { return JSON.parse(v); } catch (e) { return null; } }
async function lrangeJSON(key, hasta) {
  var raw = (await redisCall('LRANGE', key, 0, hasta)) || [];
  return raw.map(function (s) { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
}

function inicioSemanaISO() {
  var ahora = new Date();
  var ar = new Date(ahora.getTime() - 180 * 60 * 1000);
  var dow = ar.getUTCDay();
  var diasDesdeLunes = (dow === 0) ? 6 : (dow - 1);
  var lunes = new Date(ar.getTime() - diasDesdeLunes * 24 * 60 * 60 * 1000);
  return new Date(Date.UTC(lunes.getUTCFullYear(), lunes.getUTCMonth(), lunes.getUTCDate(), 3, 0, 0)).toISOString();
}
function diasDesde(iso) {
  if (!iso) return 99999;
  var t = new Date(iso).getTime();
  if (isNaN(t)) return 99999;
  return Math.floor((Date.now() - t) / 86400000);
}
function ultimaSenal(p) {
  var ts = [p.ultimaActividad, p.ultimaActualizacion, p.fechaRegistro]
    .filter(Boolean).map(function (f) { return new Date(f).getTime(); }).filter(function (t) { return !isNaN(t); });
  return ts.length ? Math.max.apply(null, ts) : 0;
}

// ── Escalaciones de Emi ──
async function seccionEscalaciones() {
  var items = await lrangeJSON('panel:escalaciones', 49);
  var hace24h = Date.now() - 24 * 60 * 60 * 1000;
  var ultimas24h = items.filter(function (i) { return i.ts >= hace24h; });
  return {
    total: items.length,
    ultimas24h: ultimas24h.length,
    porTipo24h: {
      urgente: ultimas24h.filter(function (i) { return i.tipo === 'urgente'; }).length,
      reclamo: ultimas24h.filter(function (i) { return i.tipo === 'reclamo'; }).length,
      bug: ultimas24h.filter(function (i) { return i.tipo === 'bug'; }).length,
      otro: ultimas24h.filter(function (i) { return i.tipo === 'otro'; }).length,
    },
    items: items,
  };
}

// ── Salud técnica ──
async function seccionSalud() {
  var hist = await lrangeJSON('panel:salud-historial', 49);
  var actual = hist[0] || null;
  var hace7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
  var ultimos7d = hist.filter(function (h) { return h.ts >= hace7d; });
  function caidas(servicio) { return ultimos7d.filter(function (h) { return h[servicio] === false; }).length; }
  return {
    actual: actual,
    corridas7d: ultimos7d.length,
    caidasUltimos7d: { redis: caidas('redis'), resend: caidas('resend'), mercadopago: caidas('mercadopago') },
    historial: hist,
  };
}

// ── Asesores: derivados/cotizados/con seña/completados de esta semana, a nivel negocio ──
async function seccionAsesores() {
  var activas = (await getJSON('mudanzas:activas')) || [];
  var desde = inicioSemanaISO();
  var stats = { clientesDerivados: 0, conPresupuestos: 0, conSenia: 0, completadas: 0 };
  var lote = activas.slice(-500); // tope defensivo
  for (var i = 0; i < lote.length; i++) {
    var m = await getJSON('mudanza:' + lote[i]);
    if (!m || !m.partnerAsesor) continue;
    if (!m.fechaPublicacion || String(m.fechaPublicacion) < desde) continue;
    stats.clientesDerivados++;
    if ((m.cotizaciones || []).length > 0) stats.conPresupuestos++;
    if (m.anticipoPagado === true) stats.conSenia++;
    if (m.estado === 'completada') stats.completadas++;
  }
  return stats;
}

// ── Mudanceros: quiénes dieron señal de vida reciente vs. quiénes están silenciosos ──
async function seccionMudanceros() {
  var ids = (await getJSON('mudanceros:todos')) || [];
  var lote = ids.slice(-300);
  var activos = 0, tibios = 0, dormidos = 0;
  var masDormidos = [];
  for (var i = 0; i < lote.length; i++) {
    var p = await getJSON('mudancero:perfil:' + lote[i]);
    if (!p || p.estado !== 'aprobado') continue;
    var d = diasDesde(new Date(ultimaSenal(p)).toISOString());
    if (d <= 2) activos++;
    else if (d <= 14) tibios++;
    else { dormidos++; masDormidos.push({ nombre: p.nombre || '', email: p.email || lote[i], dias: d }); }
  }
  masDormidos.sort(function (a, b) { return b.dias - a.dias; });
  return { activos: activos, tibios: tibios, dormidos: dormidos, total: activos + tibios + dormidos, masDormidos: masDormidos.slice(0, 8) };
}

// ── Social: tráfico real (Vercel Web Analytics API) + último snapshot de Instagram ──
async function vercelAnalytics() {
  var token = process.env.VERCEL_API_TOKEN, projectId = process.env.VERCEL_PROJECT_ID, teamId = process.env.VERCEL_TEAM_ID;
  if (!token || !projectId) return { disponible: false, motivo: 'Falta VERCEL_API_TOKEN y/o VERCEL_PROJECT_ID en las variables de entorno.' };
  var base = 'https://api.vercel.com/v1/query/web-analytics/visits/aggregate';
  var since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  var until = new Date().toISOString().slice(0, 10);
  function qs(params) {
    var p = Object.assign({ projectId: projectId, since: since, until: until }, params || {});
    if (teamId) p.teamId = teamId;
    return new URLSearchParams(p).toString();
  }
  try {
    var rTotal = await fetch(base + '?' + qs({ by: 'day' }), { headers: { Authorization: 'Bearer ' + token } });
    var dTotal = await rTotal.json();
    if (!rTotal.ok) return { disponible: false, motivo: 'Vercel API: ' + (dTotal && dTotal.error && dTotal.error.message || rTotal.status) };
    var pageviews7d = 0, visitors7d = 0;
    (dTotal.data || []).forEach(function (row) { pageviews7d += row.pageviews || 0; visitors7d += row.visitors || 0; });

    var rRef = await fetch(base + '?' + qs({ by: 'referrerHostname', limit: '5' }), { headers: { Authorization: 'Bearer ' + token } });
    var dRef = await rRef.json();
    var topReferrers = rRef.ok ? (dRef.data || []).map(function (r) { return { fuente: r.referrerHostname || '(directo)', visitas: r.pageviews }; }) : [];

    var rRuta = await fetch(base + '?' + qs({ by: 'route', limit: '5' }), { headers: { Authorization: 'Bearer ' + token } });
    var dRuta = await rRuta.json();
    var topRutas = rRuta.ok ? (dRuta.data || []).map(function (r) { return { ruta: r.route, visitas: r.pageviews }; }) : [];

    return { disponible: true, pageviews7d: pageviews7d, visitors7d: visitors7d, topReferrers: topReferrers, topRutas: topRutas };
  } catch (e) {
    return { disponible: false, motivo: e.message };
  }
}
async function instagramUltimoSnapshot() {
  var snap = await getJSON('ig:insights:ultima');
  if (!snap) return { disponible: false, motivo: 'Todavía no corrió cron-resumen-instagram.js con éxito (necesita el permiso instagram_business_manage_insights en IG_ACCESS_TOKEN).' };
  return { disponible: true, snapshot: snap };
}
async function seccionSocial() {
  var web = await vercelAnalytics();
  var ig = await instagramUltimoSnapshot();
  return { web: web, instagram: ig };
}

var SECCIONES = {
  escalaciones: seccionEscalaciones,
  salud: seccionSalud,
  asesores: seccionAsesores,
  mudanceros: seccionMudanceros,
  social: seccionSocial,
};

module.exports = async function handler(req, res) {
  if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
  var seccion = req.query && req.query.seccion;

  try {
    if (seccion) {
      if (!SECCIONES[seccion]) return res.status(400).json({ error: 'Sección inválida. Usá: ' + Object.keys(SECCIONES).join(', ') });
      var dato = await SECCIONES[seccion]();
      return res.status(200).json({ ok: true, seccion: seccion, data: dato });
    }
    var nombres = Object.keys(SECCIONES);
    var resultados = await Promise.all(nombres.map(function (n) { return SECCIONES[n](); }));
    var todo = {};
    nombres.forEach(function (n, i) { todo[n] = resultados[i]; });
    return res.status(200).json({ ok: true, data: todo });
  } catch (e) {
    console.error('admin-panel:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
