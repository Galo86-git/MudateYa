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

module.exports = {
  PRECIOS_DEFAULT, LIMITES, validarPrecios, totalModoDirecto, cargoPorTrabajoGestionado,
  partesAR, fechaAR, ultimoCierre, periodoDeLiquidacion, cierreQueCorresponde, bloqueoDesde, estaBloqueado,
  estadoRelojCliente, proveedorVencido, dentroDeHorario,
};
