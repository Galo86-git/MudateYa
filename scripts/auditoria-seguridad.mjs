#!/usr/bin/env node
// scripts/auditoria-seguridad.mjs
//
// Auditoría de seguridad de MudateYa. Corre sola todos los días desde
// .github/workflows/seguridad-diaria.yml y manda mail SOLO si encuentra algo.
//
// No arregla nada ni toca producción: solo lee el repo y hace requests GET de
// lectura al sitio. Pensada para detectar DERIVA — o sea, que algo que hoy está
// bien deje de estarlo sin que nos demos cuenta (una dependencia que estrena
// CVE, un endpoint nuevo que quedó sin auth, una clave pegada por error, el
// certificado por vencer).
//
// Lo que ya sabemos y aceptamos vive en scripts/seguridad-allowlist.json, así
// el mail diario es 100% señal: si llega, hay algo nuevo para mirar.
//
// Uso:
//   node scripts/auditoria-seguridad.mjs            # reporte + mail si hay hallazgos
//   node scripts/auditoria-seguridad.mjs --json     # volcado crudo (para armar baseline)
//   node scripts/auditoria-seguridad.mjs --sin-mail # nunca manda mail (probar local)
//   node scripts/auditoria-seguridad.mjs --sin-red  # saltea chequeos contra el sitio vivo

import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITIO = process.env.SITE_URL || 'https://mudateya.ar';
const ARGS = new Set(process.argv.slice(2));
const SIN_RED = ARGS.has('--sin-red');

const ALTA = 'ALTA', MEDIA = 'MEDIA', BAJA = 'BAJA';
const ORDEN = { [ALTA]: 0, [MEDIA]: 1, [BAJA]: 2 };

const hallazgos = [];
const errores = [];

function reportar(sev, chequeo, titulo, detalle, arreglo) {
  hallazgos.push({ sev, chequeo, titulo, detalle, arreglo });
}

const allowlist = leerJson(path.join(RAIZ, 'scripts', 'seguridad-allowlist.json')) || {};
const permitido = (clave, valor) => (allowlist[clave] || []).includes(valor);

function leerJson(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function leer(f) {
  try { return fs.readFileSync(path.join(RAIZ, f), 'utf8'); } catch { return ''; }
}

function git(...args) {
  return execFileSync('git', args, { cwd: RAIZ, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// ---------------------------------------------------------------------------
// 1. Dependencias con vulnerabilidades conocidas
// ---------------------------------------------------------------------------
function revisarDependencias() {
  if (!fs.existsSync(path.join(RAIZ, 'package-lock.json'))) {
    reportar(MEDIA, 'deps', 'No hay package-lock.json versionado',
      'Sin lockfile, cada deploy puede instalar versiones distintas de las que probaste, ' +
      'y el escaneo de vulnerabilidades pierde precisión.',
      'Correr `npm install --package-lock-only` y commitear package-lock.json.');
    return;
  }
  // npm audit sale con código != 0 cuando encuentra vulnerabilidades: ese es
  // justamente el caso que nos interesa, así que el stdout igual sirve.
  // En Windows hay que pasar por el shell (Node ya no ejecuta .cmd directo);
  // el comando es una constante, no se arma con datos de afuera.
  const opciones = { cwd: RAIZ, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] };
  let salida = '';
  try {
    salida = process.platform === 'win32'
      ? execSync('npm.cmd audit --json --omit=dev', opciones)
      : execFileSync('npm', ['audit', '--json', '--omit=dev'], opciones);
  } catch (e) {
    salida = e.stdout || '';
  }
  const datos = (() => { try { return JSON.parse(salida); } catch { return null; } })();
  if (!datos || !datos.vulnerabilities) {
    errores.push('npm audit no devolvió JSON parseable');
    return;
  }
  for (const [nombre, v] of Object.entries(datos.vulnerabilities)) {
    if (!['critical', 'high'].includes(v.severity)) continue;
    if (permitido('cvesAceptadas', nombre)) continue;
    const via = (v.via || []).map(x => (typeof x === 'string' ? x : x.title)).filter(Boolean);
    reportar(v.severity === 'critical' ? ALTA : MEDIA, 'deps',
      `Dependencia vulnerable: ${nombre} (${v.severity})`,
      `${via.join(' · ') || 'sin detalle'}${v.isDirect ? ' — es dependencia directa' : ' — viene arrastrada por otra'}.`,
      v.fixAvailable ? 'Hay fix disponible: `npm audit fix` (revisar que no rompa nada).'
                     : 'Todavía no hay fix upstream: evaluar reemplazar el paquete o fijar versión.');
  }
}

// ---------------------------------------------------------------------------
// 2. Claves y secretos pegados en el repo
// ---------------------------------------------------------------------------
const PATRONES_SECRETO = [
  ['clave Anthropic',      /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['clave OpenAI',         /\bsk-(?!ant-)[A-Za-z0-9]{32,}/],
  ['clave Resend',         /\bre_[A-Za-z0-9]{20,}/],
  ['SID de Twilio',        /\bAC[0-9a-f]{32}\b/],
  ['clave de API Twilio',  /\bSK[0-9a-f]{32}\b/],
  ['token MercadoPago',    /\b(?:APP_USR|TEST)-[0-9A-Za-z-]{24,}/],
  ['clave AWS',            /\bAKIA[0-9A-Z]{16}\b/],
  ['clave Google API',     /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['token GitHub',         /\bgh[pousr]_[A-Za-z0-9]{36}\b/],
  ['token Slack',          /\bxox[baprs]-[0-9A-Za-z-]{10,}/],
  ['token Vercel Blob',    /\bvercel_blob_rw_[A-Za-z0-9_]{20,}/],
  ['clave privada',        /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['secreto hardcodeado',  /\b(?:api_?key|auth_?token|secret|password|passwd|contrase[nñ]a)\s*[:=]\s*['"`][A-Za-z0-9_\-+/]{24,}['"`]/i],
];

const EXT_TEXTO = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.md', '.yml', '.yaml', '.txt', '.css', '.sh', '.env']);
// Este script y su allowlist contienen los patrones a propósito: no se escanean a sí mismos.
const NO_ESCANEAR = new Set(['scripts/auditoria-seguridad.mjs', 'scripts/seguridad-allowlist.json']);

function revisarSecretos() {
  let archivos;
  try {
    archivos = git('ls-files').split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    errores.push('no se pudo listar archivos versionados con git');
    return;
  }

  for (const f of archivos) {
    if (/(^|\/)\.env(\..+)?$/.test(f) && !f.endsWith('.example')) {
      reportar(ALTA, 'secretos', `Archivo de entorno versionado: ${f}`,
        'Un .env commiteado expone todas las claves de producción a cualquiera con acceso al repo.',
        'Sacarlo del repo (`git rm --cached`), rotar TODAS las claves que contenía y confirmar que .gitignore lo cubre.');
    }
  }

  for (const f of archivos) {
    if (NO_ESCANEAR.has(f)) continue;
    if (!EXT_TEXTO.has(path.extname(f))) continue;
    const contenido = leer(f);
    if (!contenido) continue;
    for (const [etiqueta, patron] of PATRONES_SECRETO) {
      const m = contenido.match(patron);
      if (!m) continue;
      // `secreto hardcodeado` es el patrón genérico: si el valor sale de process.env
      // en la misma línea, es un falso positivo.
      const linea = contenido.slice(0, m.index).split('\n').length;
      const textoLinea = contenido.split('\n')[linea - 1] || '';
      if (/process\.env\./.test(textoLinea)) continue;
      if (permitido('secretosAceptados', `${f}:${etiqueta}`)) continue;
      reportar(ALTA, 'secretos', `Posible ${etiqueta} en ${f}:${linea}`,
        `Coincidencia: ${m[0].slice(0, 12)}… (recortada a propósito).`,
        'Si es una clave real: rotarla YA en el proveedor, sacarla del código y moverla a variable de entorno. ' +
        'Si es un ejemplo o un falso positivo, agregarlo a scripts/seguridad-allowlist.json.');
    }
  }
}

// ---------------------------------------------------------------------------
// 3 y 4. Endpoints: crons sin proteger y endpoints sin autenticación
// ---------------------------------------------------------------------------
// Cualquiera de estas marcas cuenta como "el endpoint verifica quién llama":
// sesión, token de admin, secreto interno, firma HMAC (_baja) o firma de Twilio.
const RE_AUTH = /esAdmin|verificarToken|emailAdmin|sesionValida|esMudanceroDe|esClienteDe|tokenDeReq|ADMIN_TOKEN|ADMIN_EMAILS|INTERNAL_API_SECRET|BAJA_SECRET|require\(['"]\.\/_baja['"]\)|validarFirmaTwilio|verifyAuthenticationResponse|IG_VERIFY_TOKEN|CRON_SECRET|esCronVercel/;
const RE_ESCRIBE = /redisCall\(\s*['"](?:set|setex|del|hset|hdel|lpush|rpush|sadd|srem|zadd|incr|expire)/i;

function endpointsDeCron() {
  const v = leerJson(path.join(RAIZ, 'vercel.json')) || {};
  const paths = (v.crons || []).map(c => c.path);
  return new Set(paths.map(p => p.replace(/^\/api\//, '') + '.js'));
}

function revisarEndpoints() {
  const dirApi = path.join(RAIZ, 'api');
  if (!fs.existsSync(dirApi)) return;
  const crons = endpointsDeCron();
  const archivos = fs.readdirSync(dirApi).filter(f => f.endsWith('.js') && !f.startsWith('_'));

  for (const f of archivos) {
    const contenido = leer(path.join('api', f));
    const tieneAuth = RE_AUTH.test(contenido);

    if (crons.has(f)) {
      // Un cron sin protección es una URL pública que cualquiera puede disparar
      // en loop: manda mails/WhatsApp reales y quema crédito de API.
      if (!/esCronVercel|CRON_SECRET/.test(contenido) && !permitido('cronsPublicos', f)) {
        reportar(ALTA, 'endpoints', `Cron sin protección: /api/${f.replace(/\.js$/, '')}`,
          'Está listado en vercel.json como cron pero no valida CRON_SECRET, así que cualquiera ' +
          'que conozca la URL puede ejecutarlo las veces que quiera.',
          'Agregar al inicio del handler: `if (!esCronVercel(req)) return res.status(401).json({ error: "no autorizado" });`');
      }
      continue;
    }

    if (tieneAuth) continue;
    if (permitido('endpointsPublicos', f)) continue;

    // api/_seguridad.js no identifica al usuario, pero sí limita origen y ritmo:
    // un endpoint público con eso puesto está mucho mejor que uno desnudo.
    const conEscudo = /require\(['"]\.\/_seguridad['"]\)/.test(contenido);
    const escribe = RE_ESCRIBE.test(contenido);
    reportar(escribe ? ALTA : (conEscudo ? BAJA : MEDIA), 'endpoints',
      `Endpoint sin autenticación${escribe ? ' que escribe datos' : ''}: /api/${f.replace(/\.js$/, '')}`,
      escribe
        ? 'No valida identidad y además modifica datos en Redis: cualquiera puede escribir sin ser nadie.'
        : conEscudo
          ? 'Público a propósito, con allowlist de origins y rate limit de api/_seguridad.js. Se registra nada más.'
          : 'No hay ninguna verificación de identidad ni límite de uso. Puede ser correcto si es un endpoint ' +
            'público a propósito, pero conviene confirmarlo.',
      'Si debe ser público, agregarlo a "endpointsPublicos" en scripts/seguridad-allowlist.json. ' +
      'Si no, exigir sesión/admin antes de procesar el request.');
  }
}

// ---------------------------------------------------------------------------
// 5. CORS abierto en endpoints autenticados
// ---------------------------------------------------------------------------
// Nota de criterio: MudateYa autentica con token en header (no con cookies), así
// que `Allow-Origin: *` por sí solo NO deja que otra web actúe en nombre de un
// usuario logueado — el navegador no le presta el token. Por eso es BAJA: vale
// registrarlo, no despertar a nadie. Lo que sí es grave es combinarlo con
// `Allow-Credentials: true`, porque ahí el navegador SÍ manda las credenciales.
function revisarCors() {
  const dirApi = path.join(RAIZ, 'api');
  if (!fs.existsSync(dirApi)) return;
  for (const f of fs.readdirSync(dirApi).filter(x => x.endsWith('.js') && !x.startsWith('_'))) {
    const contenido = leer(path.join('api', f));
    const abierto = /Access-Control-Allow-Origin['"]\s*,\s*['"]\*['"]/.test(contenido);
    if (!abierto || !RE_AUTH.test(contenido)) continue;
    if (permitido('corsAceptado', f)) continue;
    const conCredenciales = /Access-Control-Allow-Credentials['"]\s*,\s*['"]?true/.test(contenido);
    reportar(conCredenciales ? ALTA : BAJA, 'cors',
      `CORS abierto en endpoint autenticado: /api/${f.replace(/\.js$/, '')}`,
      conCredenciales
        ? 'Combina `Allow-Origin: *` con `Allow-Credentials: true`: cualquier web puede hacer requests ' +
          'con las credenciales del usuario logueado. Esto sí es explotable.'
        : 'Responde `Allow-Origin: *`. Con auth por header el riesgo es bajo, pero deja la API ' +
          'llamable desde cualquier página.',
      'Usar el allowlist de origins de api/_seguridad.js (función `cors`) en lugar del comodín.');
  }
}

// ---------------------------------------------------------------------------
// 6. Headers de seguridad en producción
// ---------------------------------------------------------------------------
const HEADERS_ESPERADOS = [
  ['strict-transport-security', ALTA, 'Fuerza HTTPS: sin esto, un atacante en la misma red puede degradar la conexión a HTTP.'],
  ['x-content-type-options', MEDIA, 'Evita que el navegador adivine el tipo de archivo y ejecute como script algo que no lo es.'],
  ['referrer-policy', BAJA, 'Evita filtrar la URL completa (con parámetros) a sitios externos.'],
  ['content-security-policy', MEDIA, 'Limita de dónde se puede cargar y ejecutar código: es la principal defensa contra XSS.'],
];

async function revisarHeaders() {
  if (SIN_RED) return;
  let r;
  try {
    r = await fetch(SITIO, { redirect: 'follow', headers: { 'user-agent': 'MudateYa-Auditoria' } });
  } catch (e) {
    reportar(ALTA, 'headers', `El sitio no responde: ${SITIO}`,
      `Error al conectar: ${e.message}`,
      'Verificar el estado del deploy en Vercel y que el dominio resuelva.');
    return;
  }
  const tieneFrameGuard = r.headers.get('x-frame-options') ||
    /frame-ancestors/i.test(r.headers.get('content-security-policy') || '');
  if (!tieneFrameGuard && !permitido('headersAceptados', 'x-frame-options')) {
    reportar(MEDIA, 'headers', 'Falta protección contra clickjacking',
      'No hay X-Frame-Options ni `frame-ancestors` en CSP: otra web puede embeber mudateya.ar en un iframe ' +
      'invisible y hacer que un usuario haga clics sin darse cuenta.',
      "Agregar en vercel.json el header `X-Frame-Options: SAMEORIGIN` para todas las rutas.");
  }
  for (const [h, sev, porque] of HEADERS_ESPERADOS) {
    if (r.headers.get(h)) continue;
    if (permitido('headersAceptados', h)) continue;
    reportar(sev, 'headers', `Falta el header ${h}`, porque,
      `Agregarlo en la sección "headers" de vercel.json con source "/(.*)".`);
  }
}

// ---------------------------------------------------------------------------
// 7. Vencimiento del certificado TLS
// ---------------------------------------------------------------------------
function revisarCertificado() {
  if (SIN_RED) return Promise.resolve();
  const host = new URL(SITIO).hostname;
  return new Promise(resolve => {
    const sock = tls.connect({ host, port: 443, servername: host, timeout: 15000 }, () => {
      const cert = sock.getPeerCertificate();
      sock.end();
      if (!cert || !cert.valid_to) { errores.push('no se pudo leer el certificado TLS'); return resolve(); }
      const dias = Math.floor((new Date(cert.valid_to) - new Date()) / 86400000);
      if (dias < 0) {
        reportar(ALTA, 'tls', `El certificado de ${host} está VENCIDO`,
          `Venció el ${cert.valid_to}. Los navegadores muestran pantalla roja de advertencia.`,
          'Revisar el dominio en Vercel; normalmente se renueva solo, así que un vencimiento indica un problema de DNS.');
      } else if (dias < 21) {
        reportar(dias < 10 ? ALTA : MEDIA, 'tls', `El certificado de ${host} vence en ${dias} días`,
          `Vence el ${cert.valid_to} y todavía no se renovó.`,
          'Vercel renueva automáticamente ~30 días antes; si no lo hizo, revisar que los registros DNS estén correctos.');
      }
      resolve();
    });
    sock.on('error', e => { errores.push(`TLS: ${e.message}`); resolve(); });
    sock.on('timeout', () => { sock.destroy(); errores.push('TLS: timeout'); resolve(); });
  });
}

// ---------------------------------------------------------------------------
// 8. Sondas: endpoints sensibles que responden sin credenciales
// ---------------------------------------------------------------------------
// Solo GET, sin body y sin token. Si devuelve 200, es que está sirviendo datos
// a cualquiera. 401/403/404/405 son todas respuestas correctas.
const SONDAS_POR_DEFECTO = [
  '/api/admin-panel', '/api/admin-config', '/api/admin-uso-proveedores',
  '/api/admin-ver-conversacion', '/api/admin-fotos',
];

async function revisarSondas() {
  if (SIN_RED) return;
  const sondas = allowlist.sondas || SONDAS_POR_DEFECTO;
  for (const ruta of sondas) {
    try {
      const r = await fetch(SITIO + ruta, { headers: { 'user-agent': 'MudateYa-Auditoria' } });
      if (r.status !== 200) continue;
      const cuerpo = (await r.text()).slice(0, 400).replace(/\s+/g, ' ');
      // Un 200 puede ser esperado (config pública para la pantalla de login).
      // Lo que nunca debería viajar sin credenciales son mails, teléfonos o tokens.
      const filtra = /[\w.+-]+@[\w-]+\.[\w.]+|"(?:token|secret|apiKey|password)"|\+54\s?9?\s?\d{6,}/i.test(cuerpo);
      if (permitido('sondasPublicas', ruta) && !filtra) continue;
      reportar(filtra ? ALTA : MEDIA, 'sondas',
        filtra ? `${ruta} filtra datos sensibles sin credenciales`
               : `${ruta} responde 200 sin credenciales`,
        `Un GET anónimo devolvió: ${cuerpo.slice(0, 200)}…`,
        filtra
          ? 'Sacar del payload público lo que no necesita el navegador antes de loguearse, ' +
            'o exigir `esAdmin(req)` y devolver 401.'
          : 'Si el 200 es a propósito, agregar la ruta a "sondasPublicas" en scripts/seguridad-allowlist.json. ' +
            'Si no, exigir `esAdmin(req)` al inicio del handler.');
    } catch (e) {
      errores.push(`sonda ${ruta}: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 9. ¿La clave de Google Maps del navegador sigue restringida?
// ---------------------------------------------------------------------------
// La clave de Maps viaja en el HTML a todo el mundo: no se puede ocultar, así que
// lo único que la protege es la restricción por referrer HTTP en Google Cloud.
// Este chequeo la prueba como lo haría un atacante: un request desde un servidor,
// SIN header Referer. Si Google contesta, la clave sirve desde cualquier lado y
// cualquiera puede gastar contra la cuenta.
//
// Ojo con el historial: la restricción se sacó una vez para que Emi (que llama
// desde el server, ver api/_geo.js) pudiera geocodificar. La solución correcta es
// tener DOS claves — una del navegador con referrer, otra del server sin él —
// y este chequeo existe para avisar si la del navegador vuelve a quedar abierta.
async function revisarClaveMaps() {
  if (SIN_RED) return;
  let archivos;
  try {
    archivos = git('ls-files').split('\n').filter(f => f.endsWith('.html'));
  } catch { return; }

  const claves = new Map(); // clave -> archivo donde apareció
  for (const f of archivos) {
    for (const m of leer(f).matchAll(/\bAIza[0-9A-Za-z_-]{35}\b/g)) {
      if (!claves.has(m[0])) claves.set(m[0], f);
    }
  }

  for (const [clave, archivo] of claves) {
    if (permitido('clavesMapsAceptadas', clave.slice(0, 12))) continue;
    try {
      const url = 'https://maps.googleapis.com/maps/api/geocode/json'
        + '?address=' + encodeURIComponent('Av. Corrientes 1000, CABA')
        + '&key=' + clave;
      const d = await (await fetch(url)).json();
      // REQUEST_DENIED es la respuesta BUENA: significa que Google rechazó el
      // llamado por no venir de un origen permitido (o por API no habilitada).
      if (d.status === 'REQUEST_DENIED') continue;
      if (d.status === 'OK' || d.status === 'ZERO_RESULTS') {
        reportar(ALTA, 'clave-maps', `La clave de Google Maps de ${archivo} no tiene restricción de origen`,
          `Google respondió "${d.status}" a un request sin Referer. Esa clave está publicada en el HTML: ` +
          'cualquiera la copia y hace llamados facturados a la cuenta de Google de MudateYa.',
          'Separar en dos claves: la del navegador restringida por referrer a mudateya.ar/*, y una nueva ' +
          'sin restricción de origen (solo Geocoding API) para el server/Emi en GOOGLE_MAPS_API_KEY. ' +
          'Sumar cuota diaria y alerta de presupuesto en Google Cloud.');
      }
    } catch (e) {
      errores.push(`clave Maps de ${archivo}: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Reporte y envío
// ---------------------------------------------------------------------------
function agrupar() {
  hallazgos.sort((a, b) => ORDEN[a.sev] - ORDEN[b.sev] || a.chequeo.localeCompare(b.chequeo));
  return hallazgos;
}

function textoPlano() {
  const l = [];
  const cuenta = s => hallazgos.filter(h => h.sev === s).length;
  l.push(`Auditoría de seguridad — MudateYa`);
  l.push(`Sitio: ${SITIO}`);
  l.push(`Altas: ${cuenta(ALTA)} · Medias: ${cuenta(MEDIA)} · Bajas: ${cuenta(BAJA)}`);
  l.push('');
  for (const h of agrupar()) {
    l.push(`[${h.sev}] ${h.titulo}`);
    l.push(`  ${h.detalle}`);
    l.push(`  → ${h.arreglo}`);
    l.push('');
  }
  if (errores.length) {
    l.push('Chequeos que no se pudieron completar:');
    errores.forEach(e => l.push(`  - ${e}`));
  }
  return l.join('\n');
}

function html() {
  const color = { [ALTA]: '#b42318', [MEDIA]: '#b54708', [BAJA]: '#475467' };
  const esc = s => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const cuenta = s => hallazgos.filter(h => h.sev === s).length;
  const filas = agrupar().map(h => `
    <div style="border-left:4px solid ${color[h.sev]};padding:10px 14px;margin:0 0 14px">
      <div style="font:600 14px/1.4 system-ui,sans-serif;color:${color[h.sev]}">${h.sev} · ${esc(h.titulo)}</div>
      <div style="font:14px/1.5 system-ui,sans-serif;color:#344054;margin-top:4px">${esc(h.detalle)}</div>
      <div style="font:13px/1.5 system-ui,sans-serif;color:#667085;margin-top:6px">→ ${esc(h.arreglo)}</div>
    </div>`).join('');
  return `<div style="max-width:640px;margin:0 auto;font-family:system-ui,sans-serif">
    <h2 style="font-size:18px;color:#101828;margin:0 0 4px">Auditoría de seguridad — MudateYa</h2>
    <p style="font-size:13px;color:#667085;margin:0 0 18px">
      ${SITIO} · ${cuenta(ALTA)} altas, ${cuenta(MEDIA)} medias, ${cuenta(BAJA)} bajas
    </p>
    ${filas}
    ${errores.length ? `<p style="font-size:12px;color:#667085">No se pudieron completar: ${esc(errores.join(' · '))}</p>` : ''}
    <p style="font-size:12px;color:#98a2b3;margin-top:24px">
      Este mail se manda solo si hay hallazgos nuevos. Lo ya revisado y aceptado vive en
      scripts/seguridad-allowlist.json.
    </p>
  </div>`;
}

async function mandarMail() {
  const clave = process.env.RESEND_API_KEY;
  const destino = process.env.MAIL_SEGURIDAD || process.env.ADMIN_EMAIL;
  if (!clave || !destino) {
    console.log('\n(Sin RESEND_API_KEY o destinatario: no se manda mail.)');
    return;
  }
  const altas = hallazgos.filter(h => h.sev === ALTA).length;
  const asunto = altas
    ? `🔴 Seguridad MudateYa: ${altas} hallazgo${altas > 1 ? 's' : ''} de severidad alta`
    : `🟠 Seguridad MudateYa: ${hallazgos.length} hallazgo${hallazgos.length > 1 ? 's' : ''} para revisar`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${clave}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'MudateYa Seguridad <noreply@mudateya.ar>',
      to: destino.split(',').map(s => s.trim()).filter(Boolean),
      subject: asunto,
      html: html(),
      text: textoPlano(),
    }),
  });
  console.log(r.ok ? `\nMail enviado a ${destino}.` : `\nFalló el envío del mail: ${r.status} ${await r.text()}`);
}

// ---------------------------------------------------------------------------
async function main() {
  revisarDependencias();
  revisarSecretos();
  revisarEndpoints();
  revisarCors();
  await revisarHeaders();
  await revisarCertificado();
  await revisarSondas();
  await revisarClaveMaps();

  if (ARGS.has('--json')) {
    console.log(JSON.stringify({ hallazgos: agrupar(), errores }, null, 2));
    return;
  }

  console.log(textoPlano());

  if (process.env.GITHUB_STEP_SUMMARY) {
    const resumen = hallazgos.length
      ? '## Auditoría de seguridad\n\n' + agrupar().map(h => `- **${h.sev}** — ${h.titulo}`).join('\n')
      : '## Auditoría de seguridad\n\nSin hallazgos nuevos.';
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, resumen + '\n');
  }

  const relevantes = hallazgos.some(h => h.sev === ALTA || h.sev === MEDIA);
  if (relevantes && !ARGS.has('--sin-mail')) await mandarMail();
  if (!hallazgos.length) console.log('Sin hallazgos nuevos. Todo lo conocido está en el allowlist.');

  // Sale con error si hay algo grave, para que GitHub marque la corrida en rojo.
  process.exit(hallazgos.some(h => h.sev === ALTA) ? 1 : 0);
}

main().catch(e => { console.error('La auditoría falló:', e); process.exit(2); });
