// api/enviar-propuestas-clubes.js
// ── ONE-OFF (solo admin/cron, no se repite) ──
// Manda la propuesta de MYA Mobility (relocation de jugadores y cuerpo
// técnico) a los 24 clubes de fútbol argentinos con mail institucional
// confirmado en su sitio oficial (relevado 2026-08-08). Adjunta el PDF de
// una página (MudateYa-Mobility-Clubes-propuesta.pdf). CTA único a
// contacto@mudateya.ar, sin mencionar costos (se definen caso a caso, como
// ya dice la landing /relocation-clubes-de-futbol).
//
// Quedaron afuera por no tener mail institucional publicado (solo
// formulario web o página de prensa dada de baja): Talleres de Córdoba,
// Newell's Old Boys.
//
// IDEMPOTENCIA: manda una sola vez (clave Redis abajo). Si el cron se queda
// corriendo después, no vuelve a mandar nada — mismo patrón que
// enviar-propuestas-garantias.js.
//
// GET  ?token=ADMIN_TOKEN              → preview, no manda nada.
// POST ?token=ADMIN_TOKEN {apply:true} → fuerza el envío ahora (ignora la hora).

var { esAdmin, esCronVercel } = require('./_auth');
var { linkBaja } = require('./_baja');

var FLAG_ENVIADO = 'propuestas-clubes:enviado';
var PDF_NOMBRE = 'MudateYa-Mobility-Clubes-propuesta.pdf';
var PDF_BASE64 = 'JVBERi0xLjQKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBvYmoKPDwKL0YxIDIgMCBSIC9GMiAzIDAgUgo+PgplbmRvYmoKMiAwIG9iago8PAovQmFzZUZvbnQgL0hlbHZldGljYSAvRW5jb2RpbmcgL1dpbkFuc2lFbmNvZGluZyAvTmFtZSAvRjEgL1N1YnR5cGUgL1R5cGUxIC9UeXBlIC9Gb250Cj4+CmVuZG9iagozIDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhLUJvbGQgL0VuY29kaW5nIC9XaW5BbnNpRW5jb2RpbmcgL05hbWUgL0YyIC9TdWJ0eXBlIC9UeXBlMSAvVHlwZSAvRm9udAo+PgplbmRvYmoKNCAwIG9iago8PAovQ29udGVudHMgOCAwIFIgL01lZGlhQm94IFsgMCAwIDU5NS4yNzU2IDg0MS44ODk4IF0gL1BhcmVudCA3IDAgUiAvUmVzb3VyY2VzIDw8Ci9Gb250IDEgMCBSIC9Qcm9jU2V0IFsgL1BERiAvVGV4dCAvSW1hZ2VCIC9JbWFnZUMgL0ltYWdlSSBdCj4+IC9Sb3RhdGUgMCAvVHJhbnMgPDwKCj4+IAogIC9UeXBlIC9QYWdlCj4+CmVuZG9iago1IDAgb2JqCjw8Ci9QYWdlTW9kZSAvVXNlTm9uZSAvUGFnZXMgNyAwIFIgL1R5cGUgL0NhdGFsb2cKPj4KZW5kb2JqCjYgMCBvYmoKPDwKL0F1dGhvciAoXChhbm9ueW1vdXNcKSkgL0NyZWF0aW9uRGF0ZSAoRDoyMDI2MDgwODA2MTg1MC0wMycwMCcpIC9DcmVhdG9yIChcKHVuc3BlY2lmaWVkXCkpIC9LZXl3b3JkcyAoKSAvTW9kRGF0ZSAoRDoyMDI2MDgwODA2MTg1MC0wMycwMCcpIC9Qcm9kdWNlciAoUmVwb3J0TGFiIFBERiBMaWJyYXJ5IC0gXChvcGVuc291cmNlXCkpIAogIC9TdWJqZWN0IChcKHVuc3BlY2lmaWVkXCkpIC9UaXRsZSAoTXVkYXRlWWEgTW9iaWxpdHkgXDIwNCBSZWxvY2F0aW9uIHBhcmEgY2x1YmVzIGRlIGZcMzcydGJvbCkgL1RyYXBwZWQgL0ZhbHNlCj4+CmVuZG9iago3IDAgb2JqCjw8Ci9Db3VudCAxIC9LaWRzIFsgNCAwIFIgXSAvVHlwZSAvUGFnZXMKPj4KZW5kb2JqCjggMCBvYmoKPDwKL0ZpbHRlciBbIC9BU0NJSTg1RGVjb2RlIC9GbGF0ZURlY29kZSBdIC9MZW5ndGggMTcxNAo+PgpzdHJlYW0KR2F1MEM+dVRLOydSZTwyMzAyYCZXMFpNakk5T18/JVFjb2tSV2JQYUduST9GTVFzIWNmc0tGPl5FX0YtVGE8JSJHJHVfTj1MbjFdVVxmJGA3PihxJ11aTS1QU2AwNVwkSGImLEpBcmtTbGlMaCtkSl4iLjZdai5AO29YcGhOJEtySSttW1BTLWohZ1NRSCdzak0uaSNMMXM7IkkiSi1nXywqRjQ5aUwkTlYnR2RsQWhHaVFzNFNqdGY1SVRVM2BlXHNQVm0/RSRJcT4idEAsXm5IMltsZWZITUQ/QyhnaEhfQltxJGdoMTZpTmBzJVZwOFkuYCIrdEUuMyVgXmJqRStKW2Jxbip0VU83J3BPb3RHKlJIcTpXJ0RhaGtFJW4nJm5tdCwpLy0+PExESytwLjhqKHBGPSUxMWx0Jl40KmpETD1ILTRoaXRLSURoWVwkb19mOGUmZl91SSFVTGdvXUdXLGMsbz5NX3Q8JmhvMDJISGE+WnViSUBlaz08Xy1VWCM0VyxuIWVnLSctLTZZYlxBdWlaMUNwI0teaSoxYFYuZDdvPUddTDQ8RU44PFsmViFzcyEnVlVYPVcnYzpULSpSZzc5WDhjcF88aGhpQSc3KElnXThwXTY0I2MtZm0+NEYqYEZcPkkzXjQsdWlHZGw+Vy1xaSgmNVBRSXRlPTEvXjszJ3Ewc0FDXUtjI003TUNpMyQ6QWRQZjZWXWFIci1OPWYmbSxIPl1OSTsnWC9tU21cJVxAMjkwVHJRVT9SKV4+RWkpY1ItIWBGNj0tdCwxMCs8W2RQLSpScmdZLWBgS21UXzdeNiFqYToiWVQyRVkmcToxO208UTMkJ1pwTDplbVxPOG4lXTIwR1tZcTBzYXB1MnAvTjgkUyplcydnZFEjcnA6OUxtdVoqWVYpRydWJV1xPSIhN0RiL0gsYDE0TkgtT2JTQEddTk9hIj4jOV5ENSZeWjxBVzlDaDtDSnBVWjBBQE9RJjkpWCtvXi1aOjdHRmoobixIR15hPz9WaS4sbDNSKTZRJ0EoRDtLcUEvaGltRy9BbklNYFNHYTwlLiQ0QiNIXlpLK0I5WmItUF1bQS5eZXBbUSJfMUs3JzJfZ20vXW8iZ0olUHFebUBEcDg2YDhJZWIwaThnVyg1OEhWQ3NQISZGQzgwYCJoXDxtUSc2TlRbQVVCVHRETTIwL0lnM0dDImtLU1MuO1BKNEJrI1l0LW9NPW8nJWojbTJOZ3BIaHRtLlVfMDxfcGxVNmVpQlZuOlpdWzpUNiVFbTdTcz9MUiQkOCxAQEA+NiNCb15LVz9OL0NVSWsuPGpwXEdZNzFCL1JJY2ZzXGxBdWdSTTh1InJfMF5vNFN1UCpVLC9MWjRuIV1hWElNTHRJR2gldDsuUEhWalZ0OzcyJy5pS29OPyFNNm1BKDEkMWBOKEs7S3BjKDQvLiJERihja3ItWEIwSHRBakVhW1kwZl44Wm4oaDElKjVnIkJsLW9zOkdtXjAvVihoazNidDBGW0hIIXE2I3BBcz83aVtwaitZSS04KScnTCwvLUheVjYjckRmWGZeKC1SRVM9T2d1TCdiNk9Wc0AxPVQ3ZzBHTG9NMVs9U2IzaXFhJz1US1dXYjBuJD9HO0ondWNWbWtNaUc6R1RwIzhAKVlsZkw7RFtBbXFQKk5NQlEhYyFLcmY6Ui1QalhxYXJ1MUwjLlVCTiRDKik8UTY2a3VHWy1lIjRmXnFcSCZJXW5VNjwpLGJEdU1URVVYUEI0SFAhO2lCZSZxPWM5LjZgZUByWWduXTpLYSEiIj9lMTgmJUhtKFBeJWoiRUteJm80QDRhR2NhW1csJ0N1SS83KSphLldsLmBQZiFYKCVYXHBhWDszOFh0MD9dJTtoRyxZVDVrNVRzMCs6TEdNKnBCTyJncGRJVFh0UUpsOVI7MTpMTEIyMkVjMzxXNlBoMzopYmRtVy1uSDIwWE1kJ0NOaztWP3MwZGxJcFtcOzF1JSRRZyEobmRbbDBqKHMrL0ZNKzI3Uj9WamdJOTJrRV5AMmguRStTUiMiSmlWaDo1LUldIitCL2Y5Uy1LZkhxcHNsXT1wbl9iPm84YWpPMnI6dXQ+bzdxc2NucjdzZiFJY1BwKCtAJD5JPjVXVzNvImBTamUja25cXUVPWWpLQSZyKGIzcjtJMiZHaWZVJ01XUURXOV9PWFw3Y0krN1dyck1mWUIhWnEscFJCQkhXSyVkI0hZXVxdbjdlZnVCS0ZQI0VecionUUhIUlxCPi5tSjAyVWQ9Nk5+PmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDkKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDYxIDAwMDAwIG4gCjAwMDAwMDAxMDIgMDAwMDAgbiAKMDAwMDAwMDIwOSAwMDAwMCBuIAowMDAwMDAwMzIxIDAwMDAwIG4gCjAwMDAwMDA1MjQgMDAwMDAgbiAKMDAwMDAwMDU5MiAwMDAwMCBuIAowMDAwMDAwOTE3IDAwMDAwIG4gCjAwMDAwMDA5NzYgMDAwMDAgbiAKdHJhaWxlcgo8PAovSUQgCls8NmQxN2M3MmM5ZTExNDlkNTMxNGNkZDk2ZjY2ZTYzMzU+PDZkMTdjNzJjOWUxMTQ5ZDUzMTRjZGQ5NmY2NmU2MzM1Pl0KJSBSZXBvcnRMYWIgZ2VuZXJhdGVkIFBERiBkb2N1bWVudCAtLSBkaWdlc3QgKG9wZW5zb3VyY2UpCgovSW5mbyA2IDAgUgovUm9vdCA1IDAgUgovU2l6ZSA5Cj4+CnN0YXJ0eHJlZgoyNzgxCiUlRU9GCg==';

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
async function getJSON(k) { var v = await redisCall('get', [k]); if (!v) return null; try { return JSON.parse(v); } catch (e) { return null; } }
async function setJSON(k, v) { return redisCall('set', [k, JSON.stringify(v)]); }
function esc(s) { return String(s || '').replace(/[<>&"]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]; }); }

// ── 16 clubes del AMBA (CABA + GBA) con mail institucional confirmado en su
// sitio oficial (2026-08-08). Se achicó de 24 a esto: se sacaron los que no
// son AMBA (Rosario Central, Godoy Cruz, Instituto, Belgrano, Central
// Córdoba SdE, Unión, Colón, Sarmiento de Junín) — a pedido, se dejaron los
// 2 de La Plata (Estudiantes, Gimnasia) aunque el AMBA oficial (INDEC) no
// incluye Gran La Plata, por la cercanía práctica.
// Afuera además por no tener mail institucional publicado (solo
// formulario web o página de prensa dada de baja): Talleres de Córdoba,
// Newell's Old Boys.
var CLUBES = [
  { n: 'River Plate', nombreCompleto: 'Club Atlético River Plate', e: 'club@cariverplate.com.ar' },
  { n: 'Boca Juniors', nombreCompleto: 'Club Atlético Boca Juniors', e: 'infosocios@bocajuniors.com.ar' },
  { n: 'Racing Club', nombreCompleto: 'Racing Club', e: 'prensa@racingclub.com.ar' },
  { n: 'Independiente', nombreCompleto: 'Club Atlético Independiente', e: 'socios@clubaindependiente.com.ar' },
  { n: 'San Lorenzo', nombreCompleto: 'Club Atlético San Lorenzo de Almagro', e: 'socios@sanlorenzo.com.ar' },
  { n: 'Vélez Sarsfield', nombreCompleto: 'Club Atlético Vélez Sarsfield', e: 'rrpp@velezsarsfield.com.ar' },
  { n: 'Estudiantes de La Plata', nombreCompleto: 'Club Estudiantes de La Plata', e: 'consultas@estudiantesdelaplata.com' },
  { n: 'Argentinos Juniors', nombreCompleto: 'Asociación Atlética Argentinos Juniors', e: 'info@argentinosjuniors.com.ar' },
  { n: 'Huracán', nombreCompleto: 'Club Atlético Huracán', e: 'socios@cahuracan.com' },
  { n: 'Banfield', nombreCompleto: 'Club Atlético Banfield', e: 'socios@clubabanfield.com.ar' },
  { n: 'Lanús', nombreCompleto: 'Club Atlético Lanús', e: 'contacto@clublanus.com' },
  { n: 'Defensa y Justicia', nombreCompleto: 'Club Social y Deportivo Defensa y Justicia', e: 'prensa@defensayjusticia.org.ar' },
  { n: 'Platense', nombreCompleto: 'Club Atlético Platense', e: 'prensa@cap.org.ar' },
  { n: 'Tigre', nombreCompleto: 'Club Atlético Tigre', e: 'info@catigre.com.ar' },
  { n: 'Barracas Central', nombreCompleto: 'Club Atlético Barracas Central', e: 'info@barracascentral.com' },
  { n: 'Gimnasia La Plata', nombreCompleto: 'Club de Gimnasia y Esgrima La Plata', e: 'mesadeentrada@gimnasia.org.ar' },
];

function emailPropuesta(o) {
  var nombreCompleto = esc(o.nombreCompleto);
  var linkB = linkBaja(o.e, 'propuestas-clubes');
  return {
    subject: 'MudateYa Mobility — Relocation para el plantel y el cuerpo técnico',
    html:
      '<div style="font-family:Georgia,\'Times New Roman\',serif;max-width:640px;margin:0 auto;background:#ffffff">' +
      '<div style="background:#003580;padding:28px 36px">' +
      '<span style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#fff;letter-spacing:.2px">Mudate<span style="color:#8FB4E8">Ya</span></span>' +
      '<span style="font-family:Arial,sans-serif;font-size:12px;color:#B8CCEA;margin-left:10px;letter-spacing:.4px;text-transform:uppercase">Mobility</span>' +
      '</div>' +
      '<div style="padding:36px 40px 8px">' +
      '<p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#0F1923;margin:0 0 14px">Estimados,</p>' +
      '<p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#334155;margin:0 0 14px">Nos dirigimos a ' + nombreCompleto + ' para presentar <strong>MudateYa Mobility</strong>, la línea de relocation corporativo de MudateYa, empresa establecida en el mercado argentino de mudanzas y relocation.</p>' +
      '<p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#334155;margin:0 0 14px">Cada temporada el club suma jugadores y cuerpo técnico —nacionales y extranjeros— que llegan a una ciudad nueva con la familia a cuestas. Nos ocupamos de que esa mudanza no le reste foco a nadie: vivienda cerca del predio de entrenamiento, mudanza y, si hace falta, reinserción escolar de los hijos — todo coordinado por un único responsable, de punta a punta.</p>' +
      '<p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#334155;margin:0 0 28px">Les dejamos adjunta una propuesta de una página con el detalle. Quedamos a disposición para coordinar una reunión.</p>' +
      '</div>' +
      '<div style="text-align:center;padding:8px 40px 34px">' +
      '<a href="mailto:contacto@mudateya.ar" style="display:inline-block;background:#003580;color:#fff;padding:14px 34px;border-radius:6px;text-decoration:none;font-family:Arial,sans-serif;font-weight:700;font-size:14px;letter-spacing:.2px">contacto@mudateya.ar</a>' +
      '<div style="font-family:Arial,sans-serif;font-size:12px;color:#94A3B8;margin-top:12px">mudateya.ar/relocation-clubes-de-futbol</div>' +
      '</div>' +
      '<div style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:18px 40px;text-align:center">' +
      '<p style="font-family:Arial,sans-serif;font-size:10.5px;color:#94A3B8;margin:0">MudateYa Mobility · mudateya.ar · Buenos Aires, Argentina · ' +
      '<a href="' + linkB + '" style="color:#94A3B8">darse de baja</a></p>' +
      '</div>' +
      '</div>',
  };
}

function payloadDe(o) {
  var m = emailPropuesta(o);
  var link = linkBaja(o.e, 'propuestas-clubes');
  return {
    from: 'MudateYa Mobility <contacto@mudateya.ar>', to: o.e, subject: m.subject, html: m.html,
    attachments: [{ filename: PDF_NOMBRE, content: PDF_BASE64 }],
    headers: {
      'List-Unsubscribe': '<mailto:hola@mudateya.ar?subject=BAJA>, <' + link + '>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

module.exports = async function handler(req, res) {
  var esVercelCron = false;
  try { esVercelCron = esCronVercel(req); } catch (e) {}
  var admin = false;
  try { admin = esAdmin(req); } catch (e) {}
  if (!esVercelCron && !admin) return res.status(401).json({ error: 'No autorizado' });
  if (!process.env.RESEND_API_KEY) return res.status(200).json({ error: 'sin RESEND_API_KEY' });

  var apply = esVercelCron || (req.method === 'POST' && req.body && req.body.apply === true);

  if (!apply) {
    return res.status(200).json({
      ok: true, modo: 'preview', total: CLUBES.length,
      destinatarios: CLUBES.map(function (o) { return { club: o.n, email: o.e }; }),
      nota: 'POST con {"apply":true} y token admin para mandarlo ahora (o esperá al cron de las 9am).',
    });
  }

  var yaEnviado = await getJSON(FLAG_ENVIADO);
  if (yaEnviado) {
    return res.status(200).json({ ok: true, yaEnviado: true, cuando: yaEnviado, nota: 'Ya se mandó antes, no se repite.' });
  }

  var { Resend } = require('resend');
  var resend = new Resend(process.env.RESEND_API_KEY);
  var resultados = [];

  for (var i = 0; i < CLUBES.length; i++) {
    var o = CLUBES[i];
    try {
      var envio = await resend.emails.send(payloadDe(o));
      if (envio && envio.error) throw new Error(envio.error.message || JSON.stringify(envio.error));
      resultados.push({ club: o.n, email: o.e, ok: true, id: (envio && envio.data && envio.data.id) || null });
    } catch (e) {
      resultados.push({ club: o.n, email: o.e, ok: false, error: e.message });
    }
    await new Promise(function (ok) { setTimeout(ok, 130); });
  }

  await setJSON(FLAG_ENVIADO, new Date().toISOString());
  return res.status(200).json({ ok: true, resultados: resultados });
};
