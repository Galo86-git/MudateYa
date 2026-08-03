// api/_aprobar.js — Auto-aprobación de mudanceros (sin admin).
//
// Regla: un perfil COMPLETO (DNI frente+dorso, vehículo, foto del vehículo, precios
// y datos de cobro) y SIN señal de fraude de identidad (semáforo no-rojo) se aprueba
// en el acto. Se dispara apenas el mudancero termina de cargar todo:
//   - alta completa   → api/registrar-mudancero.js
//   - completar perfil → api/actualizar-mudancero.js
//   - red de seguridad → api/cron-revisar-mudanceros.js (1x/día, agarra lo que se escape)
//
// Interruptor: AUTO_APROBAR_ACTIVO=0 lo apaga (default: ENCENDIDO). Con el flag off,
// no aprueba solo (queda para revisión manual del admin, como antes).

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
async function setJSON(k, v) { await redisCall('SET', k, JSON.stringify(v)); }

const numOf = (v) => parseInt(String(v || '').replace(/[^0-9]/g, '')) || 0;
// Requiere AL MENOS UN PACK del modelo nuevo (Esencial / Integral / Llave) con
// precios, o el flete nuevo. Los precios "legacy" (precios.amb1..amb4) NO alcanzan
// para auto-aprobar: el mudancero tiene que cargar un pack.
function tienePack(p) {
  const pack = (pk) => pk && (numOf(pk.amb1) || numOf(pk.amb2) || numOf(pk.amb3) || numOf(pk.amb4));
  return !!(pack(p.preciosEsencial) || pack(p.preciosIntegral) || pack(p.preciosLlave) || numOf(p.precioFleteNuevo));
}
function nivelIdentidad(p) {
  // OJO: evaluarIdentidad() (registrar-mudancero.js) guarda el semáforo como
  // `.semaforo`, no `.nivel` (admin.html también lee `.semaforo`). Antes este
  // helper leía `.nivel` — un campo que nunca existió — así que el semáforo
  // real (incluida la señal de AFIP) nunca frenaba la auto-aprobación.
  return (p.verificacion && p.verificacion.semaforo) || (p.dniAnalisis ? 'amarillo' : 'sin_dni');
}

// ¿El flag permite auto-aprobar? Default: ENCENDIDO (solo '0'/'false' lo apaga).
function activo() {
  return process.env.AUTO_APROBAR_ACTIVO !== '0' && process.env.AUTO_APROBAR_ACTIVO !== 'false';
}

// Clasifica un perfil: 'skip' | 'aprobar' | 'fraude' | 'revisar' (+ motivos).
function evaluar(p) {
  if (!p || (p.estado || '') !== 'pendiente_revision') return { accion: 'skip', motivos: [] };
  const m = [];
  if ((p.estadoOnboarding || '') !== 'completo') m.push('onboarding incompleto');
  if (!p.dniFrente || !p.dniDorso) m.push('faltan fotos del DNI');
  if (!p.vehiculo) m.push('sin vehículo');
  const tieneFotoVeh = !!(p.fotoCamion || (Array.isArray(p.fotosVehiculo) && p.fotosVehiculo.filter(Boolean).length));
  if (!tieneFotoVeh) m.push('sin foto del vehículo');
  if (!tienePack(p)) m.push('sin al menos un pack de precios');
  if (p.tipoCobro !== 'fijo' && p.tipoCobro !== 'porHora') m.push('sin elegir tipo de cobro (fijo o por hora)');
  const cobroOk = p.metodoCobro === 'mp' ? !!p.emailMP : !!p.cbu;
  if (!cobroOk) m.push('sin datos de cobro');

  // Identidad en rojo = posible fraude → NUNCA auto-aprobar (queda para el admin).
  if (nivelIdentidad(p) === 'rojo') {
    const detalle = (p.verificacion && Array.isArray(p.verificacion.motivos))
      ? p.verificacion.motivos.filter((x) => x.nivel === 'rojo').map((x) => x.texto).join(' · ')
      : 'identidad en rojo';
    return { accion: 'fraude', motivos: ['⚠️ ' + detalle, ...m] };
  }
  if (m.length === 0) return { accion: 'aprobar', motivos: [] };
  return { accion: 'revisar', motivos: m };
}

// Marca el objeto perfil como aprobado (MUTA, no guarda), lo saca de pendientes y
// manda el mail de alta con el link de Términos. Devuelve true.
async function aprobarEnObjeto(p) {
  p.estado = 'aprobado';
  p.terminosAceptados = p.terminosAceptados || false;
  p.fechaCambioEstado = new Date().toISOString();
  p.autoAprobado = new Date().toISOString();
  try {
    const pend = (await getJSON('mudanceros:pendientes')) || [];
    await setJSON('mudanceros:pendientes', pend.filter((e) => e !== p.email));
  } catch (_) {}
  try {
    await require('./admin-aprobar').enviarEmailAltaExitosa(p);
  } catch (e) { console.error('auto-alta mail:', e.message); }
  return true;
}

// Intenta auto-aprobar un perfil ya guardado (por email): evalúa, y si corresponde y
// el flag está encendido, aprueba y GUARDA. Devuelve { accion, motivos }.
async function intentar(email) {
  const p = await getJSON(`mudancero:perfil:${email}`);
  if (!p) return { accion: 'skip' };
  const r = evaluar(p);
  if (r.accion !== 'aprobar') return r;
  if (!activo()) return { accion: 'aprobaria', motivos: [] };
  await aprobarEnObjeto(p);
  await setJSON(`mudancero:perfil:${email}`, p);
  return { accion: 'aprobado' };
}

module.exports = { evaluar, activo, aprobarEnObjeto, intentar, getJSON, setJSON };
