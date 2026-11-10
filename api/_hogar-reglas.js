// api/_hogar-reglas.js
//
// Reglas de negocio de MYA Hogar en funciones PURAS: no tocan Redis ni leen el reloj. Reciben la hora
// (`ahora`) y los precios como parámetros, así se prueban sin esperar al viernes y no hay sorpresas.
// Lo que está decidido con el usuario (ver memoria/chat de 2026-11):
//   - Modo directo: $1.500 por contacto, el cliente elige varios y paga una vez. Sin garantía.
//   - Modo abierto: $5.000 de gestión cuando el cliente paga, tras el OK del proveedor.
//   - Al proveedor: primer trabajo gestionado gratis POR DNI; después $5.000 por trabajo gestionado.
//   - Se liquida los viernes 18:00 (hora Argentina). Si no paga, se bloquea el lunes 09:00.
//   - Cliente: 15 min → recordatorio → 15 min más → se cancela todo. Proveedor: 10 min para responder.
//   - Horario de pedidos 7 a 19; las urgencias 24 h solo para quienes lo declaran.
// Los precios son pesos fijos y se actualizan mes a mes: viven en Redis (hogar:config:precios) y estos
// son los valores por defecto.

const PRECIOS_DEFAULT = Object.freeze({
  contactoDirecto: 1500,
  gestionAbierto: 5000,
  vigenteDesde: '2026-11-01',
});

const MIN = 60 * 1000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;
const OFFSET_AR_MS = -3 * HORA; // Argentina no tiene horario de verano

const LIMITES = Object.freeze({
  clienteRecordatorioMin: 15,
  clienteCancelaMin: 30,
  proveedorRespondeMin: 10,
  maxContactosDirecto: 20,
  horarioDesde: 7,
  horarioHasta: 19,
});

function validarPrecios(p) {
  const ok = p && Number.isInteger(p.contactoDirecto) && p.contactoDirecto > 0 && Number.isInteger(p.gestionAbierto) && p.gestionAbierto > 0;
  if (!ok) throw new Error('Precios inválidos: contactoDirecto y gestionAbierto deben ser pesos enteros positivos');
  return p;
}

// ── Plata ──

function totalModoDirecto(nContactos, precios) {
  const p = validarPrecios(precios || PRECIOS_DEFAULT);
  if (!Number.isInteger(nContactos) || nContactos < 1 || nContactos > LIMITES.maxContactosDirecto) {
    throw new Error('Cantidad de contactos inválida (1 a ' + LIMITES.maxContactosDirecto + ')');
  }
  return nContactos * p.contactoDirecto;
}

// Cargo al proveedor por un trabajo gestionado (modo abierto, cuando el cliente pagó).
// yaUsoGratis: ¿este DNI ya consumió su primer trabajo gratis? Devuelve qué registrar en el libro.
function cargoPorTrabajoGestionado(yaUsoGratis, precios) {
  const p = validarPrecios(precios || PRECIOS_DEFAULT);
  if (!yaUsoGratis) {
    return { monto: p.gestionAbierto, condonado: true, asientos: [
      { tipo: 'cargo_gestion', monto: p.gestionAbierto },
      { tipo: 'condonacion_gestion', monto: p.gestionAbierto },
    ] };
  }
  return { monto: p.gestionAbierto, condonado: false, asientos: [{ tipo: 'cargo_gestion', monto: p.gestionAbierto }] };
}

// ── Tiempo (todo en hora Argentina, UTC-3) ──

function partesAR(ahora) {
  const d = new Date(ahora.getTime() + OFFSET_AR_MS); // getUTC* sobre el desplazado = hora de Argentina
  return { anio: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate(), hora: d.getUTCHours(), min: d.getUTCMinutes(), dow: d.getUTCDay() };
}

function fechaAR(ahora) {
  const p = partesAR(ahora);
  return p.anio + '-' + String(p.mes).padStart(2, '0') + '-' + String(p.dia).padStart(2, '0');
}

// Instante (Date) de las hh:mm de Argentina del día de `ahora` desplazado `dias`.
function instanteAR(ahora, dias, hh, mm) {
  const d = new Date(ahora.getTime() + OFFSET_AR_MS);
  const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + dias, hh, mm || 0, 0);
  return new Date(utc - OFFSET_AR_MS);
}

// Último viernes 18:00 (hora AR) que ya pasó (o es ahora). Es el cierre de la semana de liquidación.
function ultimoCierre(ahora) {
  const p = partesAR(ahora);
  let atras = (p.dow - 5 + 7) % 7; // días desde el viernes
  let cierre = instanteAR(ahora, -atras, 18, 0);
  if (cierre.getTime() > ahora.getTime()) cierre = new Date(cierre.getTime() - 7 * DIA); // hoy es viernes pero antes de las 18
  return cierre;
}

// Período que se liquida en un cierre: del viernes 18:00 anterior al viernes 18:00 del cierre.
function periodoDeLiquidacion(ahora) {
  const hasta = ultimoCierre(ahora);
  const desde = new Date(hasta.getTime() - 7 * DIA);
  return { desde, hasta, clave: fechaAR(hasta) };
}

// A qué cierre pertenece un movimiento hecho en `cuando`: el primer viernes 18:00 posterior.
function cierreQueCorresponde(cuando) {
  const previo = ultimoCierre(cuando);
  const esExacto = previo.getTime() === cuando.getTime();
  return new Date(previo.getTime() + (esExacto ? 0 : 7 * DIA));
}

// Cuándo se bloquea a un proveedor que no pagó el cierre: el lunes siguiente 09:00 (63 h después del viernes 18:00).
function bloqueoDesde(cierre) {
  return new Date(cierre.getTime() + 63 * HORA);
}

// cierresImpagos: lista de Date de cierres cuya deuda sigue sin pagarse.
function estaBloqueado(ahora, cierresImpagos) {
  return (cierresImpagos || []).some((c) => bloqueoDesde(c).getTime() <= ahora.getTime());
}

// Estado del reloj del cliente después de recibir los contactos/propuesta.
function estadoRelojCliente(inicio, ahora, yaRecordado) {
  const min = (ahora.getTime() - inicio.getTime()) / MIN;
  if (min >= LIMITES.clienteCancelaMin) return 'cancelar';
  if (min >= LIMITES.clienteRecordatorioMin && !yaRecordado) return 'recordar';
  return 'esperando';
}

function proveedorVencido(enviado, ahora) {
  return (ahora.getTime() - enviado.getTime()) / MIN >= LIMITES.proveedorRespondeMin;
}

// Horario general de pedidos. Las urgencias de proveedores que declaran 24 h se manejan aparte (urgente24h).
function dentroDeHorario(ahora, urgente24h) {
  if (urgente24h) return true;
  const h = partesAR(ahora).hora;
  return h >= LIMITES.horarioDesde && h < LIMITES.horarioHasta;
}

// ── Horario de cada profesional (lo carga él, libre) y cruce con lo que pide el cliente ──
// Formato: { lun: [{ d: '08:00', h: '12:00' }, { d: '15:00', h: '19:00' }], mar: [...], ..., dom: [] }
//   - hasta 2 tramos por día; 'h' puede ser '24:00' (un día de 24 horas es 00:00 a 24:00: no hace falta otra bandera);
//   - un día sin tramos = no atiende.
// Todo en hora Argentina. Se usa para decidir A QUIÉN SE LE AVISA un pedido de la gestión de MYA:
//   - "lo antes posible" → a quienes están disponibles AHORA según su horario;
//   - día + franja (mañana 8 a 13, tarde 13 a 18) → a quienes tienen ese día un tramo que se cruce con la franja.
const DIAS_SEM = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];
const FRANJA_RANGO = Object.freeze({ manana: [8 * 60, 13 * 60], tarde: [13 * 60, 18 * 60] });
const MIN_SUPERPOSICION = 30;   // minutos de cruce con la franja para considerarlo disponible
const MIN_RESTANTE = 30;        // minutos que le tienen que quedar de su tramo para avisarle "ahora"

function aMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  const hh = Number(m[1]); const mm = Number(m[2]);
  if (mm > 59 || hh > 24 || (hh === 24 && mm > 0)) return null;
  return hh * 60 + mm;
}

// Devuelve { ok, errores }. Cada tramo: desde < hasta, sin cruces entre tramos del mismo día, máximo 2 por día.
function validarHorario(h) {
  const errores = [];
  if (!h || typeof h !== 'object') return { ok: false, errores: ['falta el horario'] };
  DIAS_SEM.forEach(function (d) {
    const tramos = h[d];
    if (tramos === undefined) { errores.push(d + ': falta el día (poné [] si no atiende)'); return; }
    if (!Array.isArray(tramos) || tramos.length > 2) { errores.push(d + ': hasta 2 tramos por día'); return; }
    const mins = tramos.map(function (t) { return [aMin(t && t.d), aMin(t && t.h)]; });
    mins.forEach(function (m, i) { if (m[0] == null || m[1] == null) errores.push(d + ': el tramo ' + (i + 1) + ' tiene una hora inválida'); else if (m[0] >= m[1]) errores.push(d + ': el tramo ' + (i + 1) + ' termina antes de empezar'); });
    if (mins.length === 2 && mins.every(function (m) { return m[0] != null && m[1] != null; })) {
      const a = mins[0]; const b = mins[1];
      if (a[0] < b[1] && b[0] < a[1]) errores.push(d + ': los tramos se pisan');
    }
  });
  return { ok: errores.length === 0, errores: errores };
}

function tramosDe(h, dow) {
  return ((h && h[DIAS_SEM[dow]]) || []).map(function (t) { return [aMin(t.d), aMin(t.h)]; }).filter(function (m) { return m[0] != null && m[1] != null && m[0] < m[1]; });
}

// Hasta cuándo sigue un tramo: si termina a las 24:00 y el día siguiente arranca a las 00:00, es continuo (un día de 24 horas
// no se corta a medianoche). Devuelve el fin en minutos desde las 00:00 del día del tramo (puede pasar de 1440).
function finContinuo(h, dow, fin, vuelta) {
  if (fin < 1440 || (vuelta || 0) >= 2) return fin;
  const sig = tramosDe(h, (dow + 1) % 7).filter(function (m) { return m[0] === 0; })[0];
  return sig ? 1440 + finContinuo(h, (dow + 1) % 7, sig[1], (vuelta || 0) + 1) : fin;
}

// ¿Está disponible ahora? (le tienen que quedar al menos 30 minutos del tramo)
function disponibleAhora(h, ahora, minRestante) {
  const p = partesAR(ahora);
  const min = p.hora * 60 + p.min;
  const resto = minRestante != null ? minRestante : MIN_RESTANTE;
  return tramosDe(h, p.dow).some(function (m) { return m[0] <= min && min + resto <= finContinuo(h, p.dow, m[1]); });
}

// ¿Tiene ese día (AAAA-MM-DD, hora AR) un tramo que se cruce al menos 30 minutos con la franja?
function disponibleEnFranja(h, ymd, franja) {
  const r = FRANJA_RANGO[franja];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!r || !m) return false;
  const dow = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return tramosDe(h, dow).some(function (t) { return Math.min(t[1], r[1]) - Math.max(t[0], r[0]) >= MIN_SUPERPOSICION; });
}

// Para el filtro "Atiende hoy": le queda al menos un tramo de hoy con 30 minutos por delante.
function atiendeHoy(h, ahora) {
  const p = partesAR(ahora);
  const min = p.hora * 60 + p.min;
  return tramosDe(h, p.dow).some(function (m) { return finContinuo(h, p.dow, m[1]) - Math.max(m[0], min) >= MIN_RESTANTE; });
}

// agenda: { asap: true } | { fecha: 'AAAA-MM-DD', franja: 'manana'|'tarde' } (lo que guarda Emi en el pedido)
function cumpleAgenda(h, agenda, ahora) {
  if (!agenda) return false;
  if (agenda.asap) return disponibleAhora(h, ahora);
  return disponibleEnFranja(h, agenda.fecha, agenda.franja);
}

module.exports = {
  PRECIOS_DEFAULT, LIMITES, validarPrecios, totalModoDirecto, cargoPorTrabajoGestionado,
  partesAR, fechaAR, ultimoCierre, periodoDeLiquidacion, cierreQueCorresponde, bloqueoDesde, estaBloqueado,
  estadoRelojCliente, proveedorVencido, dentroDeHorario,
  DIAS_SEM, FRANJA_RANGO, validarHorario, disponibleAhora, disponibleEnFranja, atiendeHoy, cumpleAgenda,
};
