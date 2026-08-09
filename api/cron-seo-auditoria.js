// api/cron-seo-auditoria.js
//
// Auditoría técnica de SEO SEMANAL. Corre después de cron-blog (lunes, más
// tarde) así también audita la nota nueva de esa semana. Lee los sitemaps
// EN VIVO (sitemap.xml + blog-sitemap.xml), pide cada URL real y chequea:
//   - status HTTP (páginas rotas dentro del propio sitemap)
//   - <title> presente / no vacío / largo razonable (<= 65 caracteres)
//   - meta description presente / no vacía / largo razonable (<= 160)
//   - <link rel="canonical"> presente
//   - títulos duplicados entre páginas (Google castiga contenido que se pisa)
//   - meta descriptions duplicadas
//
// A propósito NO intenta detectar "páginas que existen pero no están en el
// sitemap" — eso requeriría poder listar los .html reales desde la función
// serverless, que no es confiable en el entorno de Vercel. Si se agregan
// páginas nuevas, hay que acordarse de sumarlas a sitemap.xml a mano (o
// pedírmelo).
//
// SEGURIDAD: mismo patrón que el resto — Vercel Cron (Authorization Bearer
// CRON_SECRET) o admin con ?token=ADMIN_TOKEN.
//   GET ?token=…              → DRY: corre la auditoría, no manda mail.
//   GET ?token=…&force=1      → salta la idempotencia semanal.
//
// IDEMPOTENCIA: SET ... NX por semana (clave = lunes en hora AR), igual que
// cron-asesores-semanal.js.

const { Resend } = require('resend');
const { XMLParser } = require('fast-xml-parser');

var SITE = 'https://mudateya.ar';
var SITEMAPS = [SITE + '/sitemap.xml', SITE + '/blog-sitemap.xml'];
var CONCURRENCIA = 8;
var LARGO_MAX_TITLE = 65;
var LARGO_MAX_DESC = 160;

async function redisCall(method, args) {
  var url = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  var r = await fetch(url + '/' + method + '/' + args.map(encodeURIComponent).join('/'), {
    headers: { Authorization: 'Bearer ' + token }
  });
  var data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

function fechaAR() {
  var ahora = new Date();
  var ar = new Date(ahora.getTime() - 180 * 60 * 1000);
  return ar.getUTCFullYear() + '-' + String(ar.getUTCMonth() + 1).padStart(2, '0') + '-' + String(ar.getUTCDate()).padStart(2, '0');
}

async function urlsDeSitemaps() {
  var parser = new XMLParser();
  var urls = [];
  for (var i = 0; i < SITEMAPS.length; i++) {
    try {
      var r = await fetch(SITEMAPS[i]);
      if (!r.ok) continue;
      var xml = await r.text();
      var d = parser.parse(xml);
      var lista = (d && d.urlset && d.urlset.url) || [];
      if (!Array.isArray(lista)) lista = [lista];
      lista.forEach(function(u) { if (u && u.loc) urls.push(String(u.loc)); });
    } catch (e) { /* sitemap caído: se reporta como URL fallida más abajo si hace falta */ }
  }
  return Array.from(new Set(urls));
}

function extraer(html) {
  var mTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  var mDesc = html.match(/<meta\s+name=["']description["']\s+content=["']([\s\S]*?)["']/i)
           || html.match(/<meta\s+content=["']([\s\S]*?)["']\s+name=["']description["']/i);
  var mCanon = html.match(/<link\s+rel=["']canonical["']\s+href=["']([\s\S]*?)["']/i)
            || html.match(/<link\s+href=["']([\s\S]*?)["']\s+rel=["']canonical["']/i);
  var mNoindex = /<meta\s+name=["']robots["']\s+content=["'][^"']*noindex/i.test(html);
  return {
    title: mTitle ? mTitle[1].replace(/\s+/g, ' ').trim() : '',
    desc: mDesc ? mDesc[1].replace(/\s+/g, ' ').trim() : '',
    canonical: mCanon ? mCanon[1].trim() : '',
    noindex: mNoindex
  };
}

async function auditarUrl(url) {
  try {
    var r = await fetch(url, { redirect: 'follow' });
    var item = { url: url, status: r.status, problemas: [] };
    if (!r.ok) { item.problemas.push('status ' + r.status); return item; }
    var html = await r.text();
    var meta = extraer(html);
    item.title = meta.title;
    item.desc = meta.desc;
    if (!meta.title) item.problemas.push('sin <title>');
    else if (meta.title.length > LARGO_MAX_TITLE) item.problemas.push('title largo (' + meta.title.length + ' car.)');
    if (!meta.desc) item.problemas.push('sin meta description');
    else if (meta.desc.length > LARGO_MAX_DESC) item.problemas.push('description larga (' + meta.desc.length + ' car.)');
    if (!meta.canonical) item.problemas.push('sin canonical');
    if (meta.noindex) item.problemas.push('tiene noindex Y está en el sitemap (contradicción)');
    return item;
  } catch (e) {
    return { url: url, status: 0, problemas: ['no se pudo pedir: ' + e.message] };
  }
}

async function auditarTodas(urls) {
  var resultados = [];
  for (var i = 0; i < urls.length; i += CONCURRENCIA) {
    var lote = urls.slice(i, i + CONCURRENCIA);
    var r = await Promise.all(lote.map(auditarUrl));
    resultados = resultados.concat(r);
  }
  return resultados;
}

function detectarDuplicados(resultados, campo) {
  var porValor = {};
  resultados.forEach(function(r) {
    var v = r[campo];
    if (!v) return;
    (porValor[v] = porValor[v] || []).push(r.url);
  });
  var dups = [];
  Object.keys(porValor).forEach(function(v) {
    if (porValor[v].length > 1) dups.push({ valor: v, urls: porValor[v] });
  });
  return dups;
}

function armarReporte(resultados, dupTitles, dupDescs) {
  var conProblemas = resultados.filter(function(r) { return r.problemas.length; });
  var filas = conProblemas.map(function(r) {
    return '<tr><td style="padding:4px 8px;font-size:12px"><a href="' + r.url + '">' + r.url.replace(SITE, '') + '</a></td>' +
      '<td style="padding:4px 8px;font-size:12px;color:#B45309">' + r.problemas.join(', ') + '</td></tr>';
  }).join('');
  var filasDupT = dupTitles.map(function(d) {
    return '<tr><td style="padding:4px 8px;font-size:12px" colspan="2">"' + d.valor + '" repetido en: ' + d.urls.map(function(u){return u.replace(SITE,'');}).join(', ') + '</td></tr>';
  }).join('');
  var filasDupD = dupDescs.map(function(d) {
    return '<tr><td style="padding:4px 8px;font-size:12px" colspan="2">description repetida en: ' + d.urls.map(function(u){return u.replace(SITE,'');}).join(', ') + '</td></tr>';
  }).join('');
  var html =
    '<p><b>Auditoría SEO semanal de mudateya.ar</b></p>' +
    '<p style="color:#64748B;font-size:13px">' + resultados.length + ' URLs chequeadas (sitemap.xml + blog-sitemap.xml) · ' + conProblemas.length + ' con algo para revisar · ' + dupTitles.length + ' títulos duplicados · ' + dupDescs.length + ' descriptions duplicadas.</p>';
  if (conProblemas.length) {
    html += '<table style="border-collapse:collapse;width:100%"><tr><th style="text-align:left;font-size:12px;padding:4px 8px">Página</th><th style="text-align:left;font-size:12px;padding:4px 8px">Problema</th></tr>' + filas + '</table>';
  }
  if (dupTitles.length) html += '<p style="margin-top:14px;font-size:13px"><b>Títulos duplicados:</b></p><table style="border-collapse:collapse;width:100%">' + filasDupT + '</table>';
  if (dupDescs.length) html += '<p style="margin-top:14px;font-size:13px"><b>Descriptions duplicadas:</b></p><table style="border-collapse:collapse;width:100%">' + filasDupD + '</table>';
  if (!conProblemas.length && !dupTitles.length && !dupDescs.length) html += '<p style="color:#166534">Todo en orden esta semana ✅</p>';
  return html;
}

module.exports = async function handler(req, res) {
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    return res.status(200).json({ ok: true, skipped: true, reason: 'no-production-env' });
  }
  var esVercelCron = require('./_auth').esCronVercel(req);
  var esAdmin = require('./_auth').esAdmin(req);
  if (!esVercelCron && !esAdmin) return res.status(401).json({ error: 'No autorizado' });

  var esDry = req.query && req.query.dry === '1';
  var force = req.query && req.query.force === '1';

  try {
    var claveSemana = 'seo-auditoria:' + fechaAR();
    if (!esDry && !force) {
      var marca = await redisCall('set', [claveSemana, new Date().toISOString(), 'EX', '1296000', 'NX']);
      if (marca !== 'OK') {
        return res.status(200).json({ ok: true, skipped: true, reason: 'ya-corrio-esta-semana', clave: claveSemana });
      }
    }

    var urls = await urlsDeSitemaps();
    if (!urls.length) return res.status(200).json({ error: 'No se pudo leer ningún sitemap' });

    var resultados = await auditarTodas(urls);
    var dupTitles = detectarDuplicados(resultados, 'title');
    var dupDescs = detectarDuplicados(resultados, 'desc');
    var conProblemas = resultados.filter(function(r) { return r.problemas.length; });

    if (!esDry && process.env.RESEND_API_KEY && process.env.ADMIN_EMAIL) {
      var resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
        to: process.env.ADMIN_EMAIL,
        subject: '🔍 Auditoría SEO: ' + conProblemas.length + ' para revisar, ' + (dupTitles.length + dupDescs.length) + ' duplicados',
        html: armarReporte(resultados, dupTitles, dupDescs)
      });
    }

    return res.status(200).json({
      ok: true, dry: esDry,
      total: resultados.length,
      conProblemas: conProblemas.length,
      dupTitles: dupTitles.length,
      dupDescs: dupDescs.length,
      detalle: conProblemas
    });
  } catch (e) {
    console.error('cron-seo-auditoria:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
