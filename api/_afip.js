// api/_afip.js
// Integración con ARCA/AFIP: WSAA (autenticación) + WS Constancia de Inscripción
// (padrón A5). Valida el CUIT de un mudancero contra el padrón real de ARCA.
//
// Módulo INTERNO — sin handler HTTP propio a propósito (no exporta un
// `module.exports = function(req,res)`), así queda inerte si alguien le pega
// por URL directa (mismo patrón que _auth.js/_plantillas.js/_geo.js). Se usa
// server-to-server desde registrar-mudancero.js durante el alta real — nunca
// como endpoint público de "consultá cualquier CUIT gratis" (sería un leak de
// datos de terceros: nombre, domicilio fiscal, etc. de cualquier persona).
//
// Dependencias:   npm i node-forge fast-xml-parser  (agregadas a package.json)
//
// Variables de entorno (cargarlas DIRECTO en Vercel, nunca en un archivo del
// repo — mismo criterio que RESEND_API_KEY/UPSTASH_REDIS_REST_TOKEN/etc.):
//   AFIP_CUIT       = 20325076799            (CUIT dueño del certificado)
//   AFIP_CERT_B64   = <certificado .crt en base64>
//   AFIP_KEY_B64    = <clave privada .key en base64>
// Opcional:
//   AFIP_ENV        = "prod" (default) | "homo"
//
// Si falta cualquier variable o AFIP está caído/lento, las funciones de acá
// devuelven null/lanzan un error controlado — quien las llama (registrar-
// mudancero.js) SIEMPRE tiene que poder seguir con la validación local sola,
// nunca bloquear un alta porque ARCA esté teniendo un mal día.

const forge = require('node-forge');
const { XMLParser } = require('fast-xml-parser');

const SERVICE = 'ws_sr_constancia_inscripcion';
const ENV = process.env.AFIP_ENV === 'homo' ? 'homo' : 'prod';

// Si algún dominio da error de DNS/redirect, probar el equivalente en el otro
// dominio (afip.gov.ar <-> arca.gov.ar): mantienen ambos durante la transición.
const ENDPOINTS = {
  prod: {
    wsaa: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
    padron: 'https://aws.arca.gov.ar/sr-padron/webservices/personaServiceA5',
  },
  homo: {
    wsaa: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
    padron: 'https://awshomo.arca.gov.ar/sr-padron/webservices/personaServiceA5',
  },
}[ENV];

const xmlParser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true });

// ── Redis (mismo patrón manual de fetch que usa el resto del repo — sin SDK) ──
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
async function setJSON(k, v, exSeconds) {
  const str = JSON.stringify(v);
  if (exSeconds) await redisCall('SET', k, str, 'EX', String(exSeconds));
  else await redisCall('SET', k, str);
}
const TA_CACHE_KEY = `afip:ta:${ENV}:${SERVICE}`;

// fetch con timeout corto: un webservice de AFIP lento no puede colgar un alta.
async function fetchConTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 10000);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Busca la primera aparición de una key en un objeto anidado (respuestas SOAP).
function findKey(obj, key) {
  if (obj == null || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  for (const k of Object.keys(obj)) {
    const found = findKey(obj[k], key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function getCredentials() {
  const cert = Buffer.from(process.env.AFIP_CERT_B64 || '', 'base64').toString('utf8');
  const key = Buffer.from(process.env.AFIP_KEY_B64 || '', 'base64').toString('utf8');
  if (!cert.includes('BEGIN CERTIFICATE')) throw new Error('AFIP_CERT_B64 ausente o inválido');
  if (!key.includes('PRIVATE KEY')) throw new Error('AFIP_KEY_B64 ausente o inválido');
  return { cert, key };
}

// --- 1) TRA: Ticket de Requerimiento de Acceso -------------------------------
function buildTRA() {
  const now = Date.now();
  const gen = new Date(now - 60_000).toISOString();      // -1 min de margen de reloj
  const exp = new Date(now + 10 * 60_000).toISOString(); // +10 min de validez
  return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${Math.floor(now / 1000)}</uniqueId>
    <generationTime>${gen}</generationTime>
    <expirationTime>${exp}</expirationTime>
  </header>
  <service>${SERVICE}</service>
</loginTicketRequest>`;
}

// --- 2) Firma CMS (PKCS#7) del TRA -------------------------------------------
function signTRA(tra, certPem, keyPem) {
  const cert = forge.pki.certificateFromPem(certPem);
  const key = forge.pki.privateKeyFromPem(keyPem);
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(tra, 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256, // si WSAA lo rechaza, probar forge.pki.oids.sha1
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign();
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return forge.util.encode64(der);
}

// --- 3) LoginCms contra WSAA -> { token, sign, expiration } ------------------
async function loginWSAA() {
  const { cert, key } = getCredentials();
  const cms = signTRA(buildTRA(), cert, key);

  const envelope = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Header/>
  <soapenv:Body><wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body>
</soapenv:Envelope>`;

  const resp = await fetchConTimeout(ENDPOINTS.wsaa, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '' },
    body: envelope,
  }, 10000);
  const body = await resp.text();
  const parsed = xmlParser.parse(body);

  const ret = findKey(parsed, 'loginCmsReturn');
  if (!ret) {
    const fault = findKey(parsed, 'faultstring');
    throw new Error(`WSAA fault: ${fault || body.slice(0, 400)}`);
  }
  const inner = xmlParser.parse(ret); // el return trae el loginTicketResponse como XML escapado
  const cred = findKey(inner, 'credentials') || {};
  const header = findKey(inner, 'header') || {};
  if (!cred.token || !cred.sign) throw new Error(`WSAA sin credenciales: ${String(ret).slice(0, 400)}`);
  return { token: cred.token, sign: cred.sign, expiration: header.expirationTime };
}

// --- 4) Token cacheado en Redis (el TA de WSAA vale ~12hs) -------------------
// Importante: NUNCA pedir un TA nuevo si hay uno vigente; WSAA responde
// "El CEE ya posee un TA valido..." y falla. Por eso se cachea.
async function getAuth() {
  const cached = await getJSON(TA_CACHE_KEY);
  if (cached && cached.token && cached.sign) return cached;

  const ta = await loginWSAA();
  const secondsLeft = Math.floor((new Date(ta.expiration).getTime() - Date.now()) / 1000);
  const ttl = Math.max(60, secondsLeft - 600); // 10 min de margen antes del vencimiento
  const auth = { token: ta.token, sign: ta.sign };
  await setJSON(TA_CACHE_KEY, auth, ttl);
  return auth;
}

// --- 5) getPersona_v2 contra el padrón A5 -----------------------------------
async function getPersona(cuit) {
  const idPersona = String(cuit).replace(/\D/g, '');
  const { token, sign } = await getAuth();

  const envelope = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a5="http://a5.soap.ws.server.puc.sr/">
  <soapenv:Header/>
  <soapenv:Body>
    <a5:getPersona_v2>
      <token>${token}</token>
      <sign>${sign}</sign>
      <cuitRepresentada>${process.env.AFIP_CUIT}</cuitRepresentada>
      <idPersona>${idPersona}</idPersona>
    </a5:getPersona_v2>
  </soapenv:Body>
</soapenv:Envelope>`;

  const resp = await fetchConTimeout(ENDPOINTS.padron, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '' },
    body: envelope,
  }, 10000);
  const body = await resp.text();
  const parsed = xmlParser.parse(body);

  const fault = findKey(parsed, 'faultstring');
  if (fault) {
    // Token vencido/inválido -> limpiar cache para reintentar en la próxima llamada
    if (/token|sign|expir/i.test(String(fault))) await redisCall('DEL', TA_CACHE_KEY);
    throw new Error(`Padrón fault: ${fault}`);
  }
  return findKey(parsed, 'persona') || findKey(parsed, 'personaReturn') || null;
}

// --- Helper de alto nivel: valida un CUIT contra el padrón real -------------
// Nunca tira si falta configuración: devuelve {disponible:false} en vez de
// romper el flujo de registro (AFIP es "nice to have", no un requisito duro).
async function validarCuit(cuit) {
  if (!process.env.AFIP_CERT_B64 || !process.env.AFIP_KEY_B64 || !process.env.AFIP_CUIT) {
    return { disponible: false, motivo: 'AFIP no configurado' };
  }
  try {
    const persona = await getPersona(cuit);
    if (!persona) return { disponible: true, existe: false };
    const dg = persona.datosGenerales || {};
    const nombre =
      dg.razonSocial ||
      [dg.nombre, dg.apellido].filter(Boolean).join(' ').trim() ||
      null;
    return {
      disponible: true,
      existe: true,
      cuit: String(cuit).replace(/\D/g, ''),
      nombre,
      apellido: dg.apellido || null,
      tipoPersona: dg.tipoPersona || null, // FISICA | JURIDICA
      estadoClave: dg.estadoClave || null, // ACTIVO | INACTIVO...
      esMonotributista: !!persona.datosMonotributo,
      esResponsableInscripto: !!persona.datosRegimenGeneral,
      domicilioFiscal: dg.domicilioFiscal || null,
    };
  } catch (e) {
    console.warn('validarCuit AFIP:', e.message);
    return { disponible: false, motivo: e.message };
  }
}

module.exports = { getPersona, validarCuit };
