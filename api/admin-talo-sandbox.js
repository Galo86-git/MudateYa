// api/admin-talo-sandbox.js
//
// Consola de pruebas de los cobros de MYA Hogar contra el SANDBOX de Talo (plata de mentira).
// La usa admin-seguridad.html. Solo admin.
//
// Aislamiento:
//   - Talo: usa api/_talo-sandbox.js, que tiene la URL del sandbox fija. Nunca toca la API real.
//   - Datos: todo se guarda con el prefijo `sandbox:` (api/_redis.js → prefijoClaves). No se mezcla con
//     el libro de cargos real ni con ninguna entidad de Hogar real.
//
// Acciones (POST JSON { accion, ... }):
//   estado                    → ¿hay credenciales de sandbox? ¿se puede pedir token?
//   escenario { nombre }      → corre un escenario completo y devuelve un informe paso a paso
//   limpiar                   → borra los datos de prueba (solo las claves `sandbox:hogar:*`)
//
// Escenarios: exacto | menos | completar | mas | tarde

const { esAdmin } = require('./_auth');
const { crearCliente } = require('./_redis');
const { crearTaloSandbox } = require('./_talo-sandbox');
const talo = require('./_talo');
const pagos = require('./_hogar-pagos');
const libro = require('./_hogar-libro');
const datos = require('./_hogar-datos');

const PREFIJO = 'sandbox:';
const MONTO = 4500;       // 3 contactos × $1.500
const GESTION = 5000;

const ESCENARIOS = {
  exacto:    { titulo: 'Pago exacto', descripcion: 'El cliente paga justo lo pedido.' },
  menos:     { titulo: 'Pago de menos', descripcion: 'El cliente transfiere menos de lo pedido (y no completa).' },
  completar: { titulo: 'Pago de menos y después completa', descripcion: 'Transfiere una parte y luego el resto. Confirma si Talo suma las dos transferencias al mismo alias.' },
  mas:       { titulo: 'Pago de más (+$100) + devolución', descripcion: 'Transfiere un poco de más; Talo lo asocia, se acredita lo esperado y se devuelve la diferencia por Talo.' },
  sobrepago: { titulo: 'Pago de más GRANDE (+$500): plata sin asociar + alerta', descripcion: 'Talo no asocia al pago una transferencia que se pasa mucho del monto. Verifica que el control de transferencias sin asociar la detecte y avise al equipo.' },
  tarde:     { titulo: 'Pago tardío (modo abierto) + devolución total', descripcion: 'El pedido ya venció cuando llega el pago: se devuelve todo por Talo.' },
};

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const pesos = (n) => '$' + Number(n || 0).toLocaleString('es-AR');

// ── Informe ──
function nuevoInforme() {
  const pasos = []; const hallazgos = [];
  return {
    pasos, hallazgos,
    paso(titulo, detalle) { pasos.push({ titulo, ok: null, detalle: detalle || '' }); },
    chequeo(texto, cumple, detalle) { pasos.push({ titulo: texto, ok: !!cumple, detalle: detalle || '' }); if (!cumple) hallazgos.push(texto + (detalle ? ' — ' + detalle : '')); },
    nota(texto) { pasos.push({ titulo: texto, ok: null, detalle: '' }); },
  };
}

// Espera (con tope) a que Talo vea al menos `minimo` pesos recibidos.
async function esperarMonto(t, paymentId, minimo, topeMs, pasoMs) {
  const t0 = Date.now(); let p = null;
  for (;;) {
    p = await t.consultarPagoCompleto(paymentId);
    const seg = Math.round((Date.now() - t0) / 100) / 10;
    if (p.montoPagado >= minimo) return { pago: p, seg };
    if (Date.now() - t0 > topeMs) return { pago: p, seg, vencio: true };
    await dormir(pasoMs != null ? pasoMs : 1500);
  }
}

async function resumen(deps, solicitudId, paymentId) {
  const { redis } = deps;
  const p = await deps.talo.consultarPagoCompleto(paymentId).catch(() => null);
  const sol = await datos.leer('solicitud', solicitudId, { redis });
  const cli = await libro.entradasDeTrabajo(solicitudId, { redis }); // solo ESTA prueba (los cobros y devoluciones llevan el id del pedido)
  const reem = [];
  for (const id of await datos.ids('reembolso', { redis })) {
    const r = await datos.leer('reembolso', id, { redis });
    if (r && r.paymentId === paymentId) reem.push({ id, estado: r.estado, monto: r.monto, motivo: r.motivo });
  }
  const ef = (await pagos.efectosPendientes(deps, 200)).filter((e) => e.solicitudId === solicitudId).map((e) => e.tipo);
  return {
    talo: p && { estado: p.estado, pedido: p.montoPedido, pagado: p.montoPagado, acreditado: p.acreditado, comision: p.comision, reembolsado: p.reembolsado, refunds: p.refunds.map((x) => x.estado) },
    solicitud: sol && { estado: sol.estado },
    libro: cli.map((e) => ({ tipo: e.tipo, monto: e.monto, neto: e.neto })),
    reembolsos: reem, avisos: ef,
  };
}

// Crea la solicitud de prueba y el pago en Talo sandbox.
async function crearPrueba(deps, informe, opts) {
  const id = 'test-' + Date.now().toString(36);
  const modo = opts.modo; const monto = opts.monto;
  const clase = modo === 'abierto' ? 'gestion' : 'contactos';
  const vigenteHasta = modo === 'abierto' ? new Date(deps.ahora.getTime() + (opts.vencida ? -60 * 1000 : 30 * 60 * 1000)).toISOString() : null;
  await datos.crear('solicitud', id, { modo, estado: 'esperando_pago', clienteId: 'cli-prueba', cobro: { monto, clase }, vigenteHasta }, { redis: deps.redis, ahora: deps.ahora });
  const pago = await deps.talo.crearPago({ monto, externalId: pagos.armarExternalId(clase, id), webhookUrl: deps.webhookUrl, motivo: 'Prueba Hogar ' + id });
  informe.paso('Pago de prueba creado en Talo sandbox', 'Pedido ' + id + ' · ' + (modo === 'abierto' ? 'gestión' : '3 contactos') + ' · ' + pesos(monto) + ' · ' + (pago.alias || pago.cvu) + ' · ID en Talo: ' + pago.paymentId);
  informe.chequeo('Talo devolvió un CVU/alias para transferir', !!(pago.cvu || pago.alias), pago.cvu ? 'CVU ' + pago.cvu : 'sin CVU en la respuesta');
  return { solicitudId: id, paymentId: pago.paymentId, cvu: pago.cvu, monto };
}

async function transferir(deps, informe, p, monto, etiqueta, acumulado) {
  await deps.talo.faucet(p.cvu, monto);
  const tope = deps.topeEsperaMs != null ? deps.topeEsperaMs : 40000;
  const esp = await esperarMonto(deps.talo, p.paymentId, acumulado, tope, deps.pasoMs);
  const titulo = 'Talo registró la transferencia de ' + pesos(monto) + (etiqueta ? ' (' + etiqueta + ')' : '');
  const detalle = esp.vencio
    ? 'Después de ' + Math.round(tope / 1000) + ' s Talo seguía mostrando ' + pesos(esp.pago.montoPagado) + ' recibidos (estado ' + esp.pago.estado + ')'
    : 'tardó ' + esp.seg + ' s · estado ' + esp.pago.estado + ' · recibido ' + pesos(esp.pago.montoPagado) + ' · acreditado ' + pesos(esp.pago.acreditado) + ' · comisión/impuestos ' + pesos(esp.pago.comision);
  informe.chequeo(titulo, !esp.vencio, detalle);
  return esp.pago;
}

async function ejecutarYConciliar(deps, informe, reembolsoId, topeMs) {
  await pagos.ejecutarReembolso(reembolsoId, deps);
  informe.paso('Devolución pedida a Talo', reembolsoId);
  const t0 = Date.now(); let r = { estado: 'en_proceso' };
  while (Date.now() - t0 < topeMs) {
    await dormir(deps.pasoMs != null ? deps.pasoMs : 1500);
    r = await pagos.conciliarReembolso(reembolsoId, deps);
    if (r.estado !== 'en_proceso') break;
  }
  informe.chequeo('La devolución terminó en Talo', r.estado === 'completado', 'estado final: ' + r.estado + ' (' + Math.round((Date.now() - t0) / 100) / 10 + ' s)');
  return r;
}

const decisionTxt = (proc) => (proc && proc.decision ? proc.decision.accion + ' (' + proc.decision.motivo + ')' : JSON.stringify(proc));
const accionDe = (proc) => (proc && proc.decision ? proc.decision.accion : null);

// Corre un escenario. Si algo falla en el medio, el informe conserva lo que ya pasó y marca dónde se cortó
// (antes se perdía todo y solo se veía el mensaje de error).
async function correrEscenario(nombre, deps) {
  if (!ESCENARIOS[nombre]) throw new Error('Escenario desconocido: ' + nombre);
  const informe = nuevoInforme();
  try { await cuerpoEscenario(nombre, deps, informe); }
  catch (e) { informe.chequeo('La prueba se interrumpió', false, e.message); }
  return informe;
}

async function cuerpoEscenario(nombre, deps, informe) {
  informe.nota('Modo de prueba: Talo SANDBOX y datos aislados (sandbox:). No se mueve plata real ni se toca el libro real.');

  if (nombre === 'sobrepago') {
    const p = await crearPrueba(deps, informe, { modo: 'directo', monto: MONTO });
    const t0 = new Date(Date.now() - 60 * 1000).toISOString();
    await deps.talo.faucet(p.cvu, MONTO + 500);
    informe.paso('Se simuló una transferencia de ' + pesos(MONTO + 500) + ' (500 de más) al CVU del pago de ' + pesos(MONTO));
    const e1 = await esperarMonto(deps.talo, p.paymentId, MONTO, 20000, deps.pasoMs);
    informe.paso(
      e1.vencio ? 'Talo NO asoció esa transferencia al pago (sigue con ' + pesos(e1.pago.montoPagado) + ' recibidos, estado ' + e1.pago.estado + ')' : 'Talo SÍ la asoció al pago (estado ' + e1.pago.estado + ', recibido ' + pesos(e1.pago.montoPagado) + ')',
      e1.vencio ? 'Es lo esperado: la plata quedó en la cuenta sin dueño. Sin aviso del pago, solo el control de transferencias sin asociar puede detectarla.' : 'Talo cambió su comportamiento: ya asocia pagos de más grandes.');
    const barrido = await pagos.revisarSinAsociar(deps, { desde: t0 });
    informe.chequeo('El control detecta transferencias sin asociar', !e1.vencio || barrido.sinAsociar >= 1, 'revisó ' + barrido.revisadas + ' transacciones · sin asociar: ' + barrido.sinAsociar + ' · avisos nuevos: ' + barrido.nuevas);
    const ef = (await pagos.efectosPendientes(deps, 200)).filter((e) => e.motivo === 'transferencia_sin_asociar');
    informe.chequeo('Se anotó el aviso al equipo', !e1.vencio || ef.length >= 1, ef.length + ' aviso(s): ' + ef.map((e) => pesos(e.bruto)).join(', '));
    const otra = await pagos.revisarSinAsociar(deps, { desde: t0 });
    informe.chequeo('Revisar de nuevo no repite el aviso', otra.nuevas === 0, 'avisos nuevos: ' + otra.nuevas);
    informe.detalle = { barrido, avisos: ef };
    return;
  }

  if (nombre === 'tarde') {
    const p = await crearPrueba(deps, informe, { modo: 'abierto', monto: GESTION, vencida: true });
    const enTalo = await transferir(deps, informe, p, GESTION, 'después de vencido el pedido', GESTION);
    const proc = await pagos.procesarPago(p.paymentId, deps);
    informe.chequeo('El sistema decidió DEVOLVER TODO', accionDe(proc) === 'devolver_todo', decisionTxt(proc));
    const r = await resumen(deps, p.solicitudId, p.paymentId);
    informe.chequeo('No se asentó ningún cobro', r.libro.length === 0, JSON.stringify(r.libro));
    informe.chequeo('El pedido no se reactivó', !!r.solicitud && r.solicitud.estado === 'esperando_pago' && enTalo.montoPagado >= GESTION, JSON.stringify(r.solicitud));
    informe.chequeo('Se pidió devolver ' + pesos(GESTION), r.reembolsos.length === 1 && r.reembolsos[0].monto === GESTION, JSON.stringify(r.reembolsos));
    if (r.reembolsos[0]) await ejecutarYConciliar(deps, informe, r.reembolsos[0].id, 25000);
    informe.detalle = await resumen(deps, p.solicitudId, p.paymentId);
    return;
  }

  const abierto = nombre === 'menos' || nombre === 'completar';
  const monto = abierto ? GESTION : MONTO;
  const p = await crearPrueba(deps, informe, { modo: abierto ? 'abierto' : 'directo', monto });
  let enTalo; let proc; let r;

  if (nombre === 'exacto') {
    enTalo = await transferir(deps, informe, p, monto, '', monto);
    informe.chequeo('La unidad del monto es PESOS (no centavos)', enTalo.montoPagado === monto,
      'se transfirieron ' + pesos(monto) + ' y Talo muestra ' + enTalo.montoPagado + (enTalo.montoPagado === monto * 100 ? ' → está en CENTAVOS: hay que dividir por 100' : ''));
    proc = await pagos.procesarPago(p.paymentId, deps);
    informe.chequeo('El sistema decidió ACREDITAR', accionDe(proc) === 'acreditar', decisionTxt(proc));
    const proc2 = await pagos.procesarPago(p.paymentId, deps);
    informe.chequeo('Un aviso repetido no duplica nada', accionDe(proc2) === 'ignorar', 'segunda vez: ' + accionDe(proc2));
    r = await resumen(deps, p.solicitudId, p.paymentId);
    informe.chequeo('Una sola entrada en el libro, por ' + pesos(monto), r.libro.length === 1 && r.libro[0].monto === monto, JSON.stringify(r.libro));
    informe.chequeo('El libro registra lo que realmente entró (neto de comisión)', !!r.libro[0] && r.libro[0].neto > 0 && r.libro[0].neto <= monto, 'neto ' + pesos(r.libro[0] && r.libro[0].neto));
  }

  if (nombre === 'menos') {
    enTalo = await transferir(deps, informe, p, 3000, 'de menos', 3000);
    informe.chequeo('Talo marca el pago como UNDERPAID', enTalo.estado === 'UNDERPAID', 'estado: ' + enTalo.estado);
    proc = await pagos.procesarPago(p.paymentId, deps);
    informe.chequeo('El sistema decidió ESPERAR el resto (no acredita)', accionDe(proc) === 'esperar', decisionTxt(proc));
    r = await resumen(deps, p.solicitudId, p.paymentId);
    informe.chequeo('No se asentó nada en el libro', r.libro.length === 0, JSON.stringify(r.libro));
    informe.chequeo('Se anotó el aviso al cliente (faltan $2.000)', r.avisos.includes('cliente_pago_insuficiente'), JSON.stringify(r.avisos));
  }

  if (nombre === 'completar') {
    enTalo = await transferir(deps, informe, p, 3000, 'primera parte', 3000);
    proc = await pagos.procesarPago(p.paymentId, deps);
    informe.chequeo('Con la primera parte, el sistema espera', accionDe(proc) === 'esperar', decisionTxt(proc));
    enTalo = await transferir(deps, informe, p, 2000, 'segunda parte, al MISMO alias', 5000);
    informe.chequeo('Talo SUMA las dos transferencias del mismo alias', enTalo.montoPagado >= 5000,
      'Talo muestra recibido ' + pesos(enTalo.montoPagado) + ' y estado ' + enTalo.estado + (enTalo.montoPagado < 5000 ? ' → NO las suma: el cliente no puede completar al mismo alias' : ''));
    informe.chequeo('Talo pasa el pago a SUCCESS', enTalo.estado === 'SUCCESS', 'estado: ' + enTalo.estado);
    proc = await pagos.procesarPago(p.paymentId, deps);
    informe.chequeo('Con el total, el sistema ACREDITA', accionDe(proc) === 'acreditar', decisionTxt(proc));
    r = await resumen(deps, p.solicitudId, p.paymentId);
    informe.chequeo('Una sola entrada en el libro, por ' + pesos(GESTION), r.libro.length === 1 && r.libro[0].monto === GESTION, JSON.stringify(r.libro));
  }

  if (nombre === 'mas') {
    enTalo = await transferir(deps, informe, p, MONTO + 100, '100 de más', MONTO + 100);
    informe.chequeo('Talo marca el pago como OVERPAID', enTalo.estado === 'OVERPAID', 'estado: ' + enTalo.estado);
    proc = await pagos.procesarPago(p.paymentId, deps);
    informe.chequeo('El sistema ACREDITA lo esperado', accionDe(proc) === 'acreditar', decisionTxt(proc));
    r = await resumen(deps, p.solicitudId, p.paymentId);
    informe.chequeo('En el libro queda lo esperado (' + pesos(MONTO) + '), no lo recibido', r.libro.length === 1 && r.libro[0].monto === MONTO, JSON.stringify(r.libro));
    informe.chequeo('Se pidió devolver la diferencia ($100)', r.reembolsos.length === 1 && r.reembolsos[0].monto === 100, JSON.stringify(r.reembolsos));
    if (r.reembolsos[0]) await ejecutarYConciliar(deps, informe, r.reembolsos[0].id, 25000);
  }

  informe.detalle = await resumen(deps, p.solicitudId, p.paymentId);
}

async function limpiar(redisBase) {
  const claves = (await redisBase.scanAll(PREFIJO + 'hogar:*')).filter((k) => k.indexOf(PREFIJO + 'hogar:') === 0);
  for (let i = 0; i < claves.length; i += 100) await redisBase.pipeline(claves.slice(i, i + 100).map((k) => ['DEL', k]));
  return claves.length;
}

function armarDeps(extra) {
  const base = process.env.SITE_URL || 'https://mudateya.ar';
  return Object.assign({
    redis: crearCliente({ prefijoClaves: PREFIJO }),
    talo: crearTaloSandbox(),
    ahora: new Date(),
    webhookUrl: base + '/api/hogar-talo-webhook',
  }, extra || {});
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!esAdmin(req)) return res.status(401).json({ error: 'no autorizado' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  const b = req.body || {};
  try {
    if (b.accion === 'estado') {
      const t = crearTaloSandbox();
      const out = {
        credencialesSandbox: t.configurado(), fuente: t.fuente, urlSandbox: t.base,
        modoDeLaApp: talo.esProduccion() ? 'TALO_MODO=produccion (Mudanza cobra de verdad; esta consola NO lo toca)' : 'TALO_MODO no es produccion',
      };
      if (t.configurado()) {
        try { await t.token(true); out.tokenOk = true; } catch (e) { out.tokenOk = false; out.error = e.message; }
      } else {
        out.falta = 'TALO_SANDBOX_USER_ID, TALO_SANDBOX_CLIENT_ID y TALO_SANDBOX_CLIENT_SECRET (las credenciales de sandbox de Talo).';
      }
      return res.status(200).json({ ok: true, ...out });
    }
    if (b.accion === 'escenario') {
      const deps = armarDeps();
      if (!deps.talo.configurado()) return res.status(400).json({ error: 'Faltan las credenciales de sandbox de Talo (TALO_SANDBOX_*).' });
      if (!ESCENARIOS[b.nombre]) return res.status(400).json({ error: 'Escenario desconocido' });
      const informe = await correrEscenario(String(b.nombre), deps);
      return res.status(200).json({ ok: true, escenario: ESCENARIOS[b.nombre].titulo, resultado: informe.hallazgos.length ? 'revisar' : 'ok', hallazgos: informe.hallazgos, pasos: informe.pasos, detalle: informe.detalle });
    }
    if (b.accion === 'limpiar') {
      const n = await limpiar(crearCliente());
      return res.status(200).json({ ok: true, borradas: n });
    }
    return res.status(400).json({ error: 'accion inválida' });
  } catch (e) {
    console.error('admin-talo-sandbox:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

module.exports._correrEscenario = correrEscenario;
module.exports._ESCENARIOS = ESCENARIOS;
module.exports._limpiar = limpiar;
module.exports._PREFIJO = PREFIJO;
