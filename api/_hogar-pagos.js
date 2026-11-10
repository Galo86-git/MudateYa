// api/_hogar-pagos.js
//
// Cobros y devoluciones de MYA Hogar con Talo. Principio de Talo: cada operación tiene un CVU/alias ÚNICO,
// así que cada transferencia que entra ya sabe a qué pedido corresponde y se concilia en el momento.
//
// Lo que ESTE módulo agrega a ese principio (los puntos donde se rompe el dinero):
//   1. El aviso (webhook) de Talo es mínimo y NO viene firmado: solo se toma el paymentId y se VERIFICA
//      consultando la API de Talo. El monto esperado sale de NUESTROS registros, nunca del aviso.
//   2. Talo reenvía avisos: todo es idempotente. Un mismo pago nunca se carga dos veces en el libro.
//   3. La cuenta de Talo es compartida con Mudanza: solo se procesan pagos con external_id `hogar~...`.
//   4. Pago de menos / de más / tardío / vencido: cada caso tiene una decisión explícita y probada (decidir()).
//   5. Devoluciones: Talo permite reembolsar por API (total o parcial, asíncrono). Cada devolución tiene
//      estado, plazo de 24 h y alerta si se pasa. En esta etapa se EJECUTAN con un click del admin (no solas).
//   6. Los efectos (avisar al cliente, al proveedor, al equipo) se anotan en un buzón (outbox) y los ejecuta
//      otro proceso: si fallan, se reintentan sin repetir el cobro.
//
// Pesos enteros siempre. Sin Redis ni reloj propios: todo se inyecta (deps) para poder probarlo.
//
// Vercel ignora los archivos de /api que empiezan con "_".

const crypto = require('crypto');
const { cliente } = require('./_redis');
const libro = require('./_hogar-libro');
const datos = require('./_hogar-datos');

const PREFIJO_EXTERNAL = 'hogar';
const CLASES = { contactos: 'solicitud', gestion: 'solicitud', liq: 'liquidacion' };
const TOLERANCIA_PESOS = 1;            // diferencias de redondeo
const PLAZO_REEMBOLSO_MS = 24 * 60 * 60 * 1000;

// Los ids de Talo no tienen un formato documentado. Para usarlos como parte de una clave de Redis o de un id del libro
// (que solo aceptan letras, números y : _ . -), se usa tal cual si es compatible; si no, un hash estable. El id ORIGINAL
// se guarda siempre dentro del registro y es el que se le manda a Talo.
function idSeguro(id) {
  const s = String(id == null ? '' : id);
  if (/^[A-Za-z0-9:_.-]{3,100}$/.test(s)) return s;
  return 'p_' + crypto.createHash('sha1').update(s).digest('hex').slice(0, 24);
}

// ── external_id: viaja a Talo y vuelve en la consulta ──
function armarExternalId(clase, refId) {
  if (!CLASES[clase]) throw new Error('Clase de pago inválida: ' + clase);
  if (!/^[A-Za-z0-9:_.-]{3,100}$/.test(String(refId || ''))) throw new Error('refId inválido');
  return [PREFIJO_EXTERNAL, clase, refId].join('~');
}
function parsearExternalId(ext) {
  const p = String(ext || '').split('~');
  if (p.length !== 3 || p[0] !== PREFIJO_EXTERNAL || !CLASES[p[1]] || !/^[A-Za-z0-9:_.-]{3,100}$/.test(p[2])) return null;
  return { clase: p[1], refId: p[2], entidad: CLASES[p[1]] };
}

// ── Decisión: función PURA ──
// c: { clase, estadoTalo, esperado, pagado, ahora (Date), cvuVencido,
//      entidad: { estado, vigenteHasta }, registrado (lo ya cargado al libro de este pago) }
// Devuelve { accion, motivo, aAcreditar, excedente, aDevolver, falta }.
//   accion: 'esperar' | 'ignorar' | 'acreditar' | 'devolver_todo'
function decidir(c) {
  const esperado = c.esperado; const pagado = c.pagado;
  const venceMs = c.entidad && c.entidad.vigenteHasta ? new Date(c.entidad.vigenteHasta).getTime() : null;
  const vigente = !!c.entidad && c.entidad.estado === 'esperando_pago' && !c.cvuVencido && (venceMs == null || c.ahora.getTime() <= venceMs);
  const yaPagada = !!c.entidad && c.entidad.estado === 'pagada';

  if (!(esperado > 0)) return { accion: 'ignorar', motivo: 'sin_monto_esperado' };
  if (!(pagado > 0)) return { accion: c.estadoTalo === 'EXPIRED' ? 'ignorar' : 'esperar', motivo: c.estadoTalo === 'EXPIRED' ? 'vencido_sin_plata' : 'sin_pago_todavia' };

  const completo = pagado + TOLERANCIA_PESOS >= esperado;

  // Pago de un proveedor a MYA: se acredita lo que llegó (aunque sea parcial) y el saldo se calcula solo.
  if (c.clase === 'liq') {
    const nuevo = pagado - (c.registrado || 0);
    return { accion: nuevo > 0 ? 'acreditar' : 'ignorar', motivo: completo ? 'liquidacion_completa' : 'liquidacion_parcial', aAcreditar: Math.max(nuevo, 0), excedente: 0, falta: Math.max(esperado - pagado, 0) };
  }

  if (completo) {
    const excedente = Math.max(pagado - esperado, 0);
    if (yaPagada) return { accion: excedente > 0 ? 'acreditar' : 'ignorar', motivo: 'ya_acreditado', aAcreditar: 0, excedente };
    // Modo directo: se vende un contacto, no hay una oferta que venza → se honra aunque llegue tarde.
    if (c.clase === 'contactos') return { accion: 'acreditar', motivo: vigente ? 'ok' : 'tardio_honrado', aAcreditar: esperado, excedente };
    // Modo abierto: si el pedido ya caducó, el proveedor no está comprometido → se devuelve todo.
    if (c.clase === 'gestion') {
      return vigente ? { accion: 'acreditar', motivo: 'ok', aAcreditar: esperado, excedente }
                     : { accion: 'devolver_todo', motivo: 'tardio_pedido_caducado', aDevolver: pagado };
    }
  }

  // Pagó de menos (cliente): no se acredita. Mientras el pedido esté vigente se espera el resto;
  // si ya no, se devuelve lo que llegó.
  if (vigente) return { accion: 'esperar', motivo: 'insuficiente_esperando_resto', falta: esperado - pagado };
  return { accion: 'devolver_todo', motivo: 'insuficiente_y_vencido', aDevolver: pagado };
}

// ── Buzón de efectos (avisos): se anotan acá y los ejecuta otro proceso ──
const K = {
  outbox: (id) => 'hogar:outbox:e:' + id,
  outboxPend: 'hogar:outbox:pend',
  inbox: 'hogar:inbox:talo',
  // OJO: los nombres de lock de estas operaciones NO pueden coincidir con los de datos.actualizar()
  // ('hogar:lock:{tipo}:{id}'), porque se esperarían entre sí (interbloqueo).
  lockPago: (id) => 'hogar:lock:op-cobro:' + id,
  lockReembolso: (id) => 'hogar:lock:op-reembolso:' + id,
  sueltasHechas: 'hogar:sueltas:hechas',
};
const dep = (d) => ({ redis: (d && d.redis) || cliente(), talo: (d && d.talo) || require('./_talo'), ahora: (d && d.ahora) || new Date() });

async function encolarEfecto(r, ahora, id, efecto) {
  const ok = await r.setJSON(K.outbox(id), Object.assign({ id, estado: 'pendiente', creado: ahora.toISOString() }, efecto), { permanente: true, nx: true });
  if (ok) await r.cmd('ZADD', K.outboxPend, String(ahora.getTime()), id);
  return ok;
}
async function efectosPendientes(d, n) {
  const { redis: r } = dep(d);
  const ids = (await r.cmd('ZRANGE', K.outboxPend, '0', String((n || 50) - 1))) || [];
  const out = [];
  for (const id of ids) { const e = await r.getJSON(K.outbox(id)); if (e) out.push(e); }
  return out;
}
async function marcarEfectoHecho(d, id) {
  const { redis: r, ahora } = dep(d);
  const e = await r.getJSON(K.outbox(id));
  if (e) { e.estado = 'hecho'; e.hechoEn = ahora.toISOString(); await r.setJSON(K.outbox(id), e, { permanente: true }); }
  await r.cmd('ZREM', K.outboxPend, id);
}

// ── Buzón de avisos de Talo (para contestar 200 rápido y procesar sin perder nada) ──
async function anotarAviso(d, paymentId) {
  if (!/^[^\x00-\x1F\x7F]{3,120}$/.test(String(paymentId || ''))) throw new Error('paymentId inválido'); // cualquier texto sin caracteres de control
  const { redis: r, ahora } = dep(d);
  await r.cmd('ZADD', K.inbox, String(ahora.getTime()), String(paymentId)); // si ya estaba, solo actualiza la hora
}
async function procesarBuzon(d, n) {
  const { redis: r, ahora } = dep(d);
  const ids = (await r.cmd('ZRANGE', K.inbox, '0', String((n || 20) - 1))) || [];
  const res = { procesados: 0, fallidos: 0, atascados: [] };
  for (const id of ids) {
    try { await procesarPago(id, d); await r.cmd('ZREM', K.inbox, id); res.procesados++; }
    catch (e) {
      res.fallidos++;
      const desde = Number((await r.cmd('ZSCORE', K.inbox, id)) || 0);
      if (desde && ahora.getTime() - desde > 15 * 60 * 1000) res.atascados.push({ id, error: e.message });
    }
  }
  return res;
}

// ── Procesar un pago de Talo (verificado contra la API, con lock, idempotente) ──
// extra.sueltas: transferencias que Talo recibió para este pago pero NO asoció a él (ver revisarSinAsociar). Se suman a lo
// pagado, y si hay que devolver, la devolución es MANUAL (la API de devoluciones solo opera sobre plata asociada al pago).
async function procesarPago(paymentId, d, extra) {
  const { redis: r, talo, ahora } = dep(d);
  const pid = idSeguro(paymentId);
  return r.withLock(K.lockPago(pid), 30, async () => {
    const pago = await talo.consultarPagoCompleto(paymentId); // la verdad es la API, no el aviso
    const sueltas = (extra && Array.isArray(extra.sueltas)) ? extra.sueltas : [];
    if (sueltas.length) {
      pago.montoPagado += sueltas.reduce((t, x) => t + x.bruto, 0);
      pago.acreditado += sueltas.reduce((t, x) => t + x.neto, 0);
    }
    const datosManual = sueltas.length ? { manual: true, remitente: sueltas[0].remitente || null, transacciones: sueltas.map((x) => x.id) } : {};
    const ref = parsearExternalId(pago.externalId);
    if (!ref) return { ignorado: 'external_id ajeno (no es de Hogar)' };

    const entidad = await datos.leer(ref.entidad, ref.refId, { redis: r });
    if (!entidad) {
      // Entró plata por un pedido que no existe en nuestros registros: no se acredita nada, se avisa y se anota.
      await encolarEfecto(r, ahora, 'ef:' + pid + ':huerfano', { tipo: 'equipo_alerta', motivo: 'pago_sin_pedido', paymentId, externalId: pago.externalId, pagado: pago.montoPagado });
      return { huerfano: true };
    }

    // Registro del pago (se crea la primera vez que lo vemos).
    let reg = await datos.leer('pago', pid, { redis: r });
    if (!reg) {
      try { reg = await datos.crear('pago', pid, { paymentId, externalId: pago.externalId, clase: ref.clase, refId: ref.refId, estado: 'visto', registrado: 0 }, { redis: r, ahora }); }
      catch (e) { if (e instanceof datos.EntidadExistente) reg = await datos.leer('pago', pid, { redis: r }); else throw e; }
    }

    const esperado = ref.clase === 'liq' ? Number(entidad.monto) : Number(entidad.cobro && entidad.cobro.monto);
    const cvuVencido = pago.estado === 'EXPIRED' || (pago.expira && new Date(pago.expira).getTime() < ahora.getTime() && pago.montoPagado === 0);
    const dec = decidir({ clase: ref.clase, estadoTalo: pago.estado, esperado, pagado: pago.montoPagado, ahora, cvuVencido, entidad, registrado: reg.registrado || 0 });

    const proporcion = pago.montoPagado > 0 ? pago.acreditado / pago.montoPagado : 0;
    let registradoNuevo = reg.registrado || 0;

    if (dec.accion === 'acreditar' && dec.aAcreditar > 0) {
      if (ref.clase === 'liq') {
        const acumulado = (reg.registrado || 0) + dec.aAcreditar;
        await libro.registrar({ id: 'pago_proveedor:' + pid + ':' + acumulado, tipo: 'pago_proveedor', parteId: entidad.provId, monto: dec.aAcreditar, neto: Math.round(dec.aAcreditar * proporcion), refExterna: pid, nota: 'Talo ' + paymentId, trabajoId: null }, { redis: r, ahora });
        registradoNuevo = acumulado;
        await datos.actualizar('liquidacion', ref.refId, (l) => {
          l.pagos = l.pagos || {}; l.pagos[pid] = acumulado;
          l.pagado = Object.values(l.pagos).reduce((s, x) => s + x, 0);
          l.estado = l.pagado + TOLERANCIA_PESOS >= l.monto ? 'pagada' : 'parcial';
        }, { redis: r, ahora });
        await encolarEfecto(r, ahora, 'ef:' + pid + ':liq:' + acumulado, { tipo: 'proveedor_pago_registrado', provId: entidad.provId, liquidacionId: ref.refId, monto: dec.aAcreditar, falta: dec.falta });
      } else {
        const tipo = ref.clase === 'contactos' ? 'cobro_contactos' : 'cobro_gestion';
        await libro.registrar({ id: 'cobro:' + pid, tipo, parteId: entidad.clienteId || entidad.cliente || 'sin-cliente', monto: esperado, neto: Math.min(esperado, Math.round(esperado * proporcion)), refExterna: pid, nota: 'Talo ' + paymentId, trabajoId: entidad.id }, { redis: r, ahora });
        registradoNuevo = esperado;
        await datos.actualizar('solicitud', ref.refId, (s) => { if (s.estado !== 'pagada') { s.estado = 'pagada'; s.pagoId = paymentId; s.pagadoEn = ahora.toISOString(); } }, { redis: r, ahora });
        await encolarEfecto(r, ahora, 'ef:' + pid + ':pago_ok', { tipo: ref.clase === 'contactos' ? 'cliente_entregar_contactos' : 'cliente_pago_ok_gestion', solicitudId: entidad.id, motivo: dec.motivo });
      }
    }

    // Plata de más (cliente): se devuelve la diferencia.
    if (dec.excedente > 0 && ref.clase !== 'liq') {
      await solicitarReembolso(Object.assign({ paymentId, monto: dec.excedente, motivo: 'excedente', solicitudId: entidad.id }, datosManual), { redis: r, ahora });
    }
    // No se pudo honrar (tardío en modo abierto / insuficiente y vencido): se devuelve lo que llegó.
    if (dec.accion === 'devolver_todo') {
      await solicitarReembolso(Object.assign({ paymentId, monto: dec.aDevolver, motivo: dec.motivo, solicitudId: entidad.id }, datosManual), { redis: r, ahora });
      await encolarEfecto(r, ahora, 'ef:' + pid + ':devolucion', { tipo: 'cliente_devolucion', solicitudId: entidad.id, monto: dec.aDevolver, motivo: dec.motivo });
    }
    if (dec.accion === 'esperar' && dec.motivo === 'insuficiente_esperando_resto') {
      await encolarEfecto(r, ahora, 'ef:' + pid + ':falta:' + pago.montoPagado, { tipo: 'cliente_pago_insuficiente', solicitudId: entidad.id, pagado: pago.montoPagado, falta: dec.falta });
    }

    await datos.actualizar('pago', pid, (p) => {
      p.estado = dec.accion === 'acreditar' ? 'acreditado' : dec.accion === 'devolver_todo' ? 'a_devolver' : dec.accion === 'esperar' ? 'esperando' : p.estado;
      p.estadoTalo = pago.estado; p.pagadoVisto = pago.montoPagado; p.acreditadoVisto = pago.acreditado; p.comisionVista = pago.comision;
      p.registrado = registradoNuevo; p.ultimaDecision = { accion: dec.accion, motivo: dec.motivo, cuando: ahora.toISOString() };
    }, { redis: r, ahora });

    return { decision: dec, estadoTalo: pago.estado };
  }, { esperaMs: 5000 });
}

// ── Devoluciones ──
// Estados: solicitado → en_proceso → completado | fallido (se reintenta). Plazo: 24 h desde la solicitud.
async function solicitarReembolso(o, d) {
  const { redis: r, ahora } = dep(d);
  if (!o || !o.paymentId || !o.motivo) throw new Error('Falta paymentId o motivo');
  if (o.monto != null && !(Number.isInteger(o.monto) && o.monto > 0)) throw new Error('El monto a devolver debe ser un entero positivo');
  const id = idSeguro(o.paymentId) + '.' + String(o.motivo).replace(/[^A-Za-z0-9_-]/g, '_');
  try {
    const ent = await datos.crear('reembolso', id, {
      paymentId: o.paymentId, monto: o.monto != null ? o.monto : null, motivo: o.motivo, solicitudId: o.solicitudId || null,
      manual: !!o.manual, remitente: o.remitente || null, transacciones: o.transacciones || [],
      estado: 'solicitado', solicitadoEn: ahora.toISOString(), venceEn: new Date(ahora.getTime() + PLAZO_REEMBOLSO_MS).toISOString(), intentos: 0,
    }, { redis: r, ahora });
    await encolarEfecto(r, ahora, 'ef:reembolso:' + id + ':nuevo', { tipo: 'equipo_reembolso_pendiente', reembolsoId: id, paymentId: o.paymentId, monto: o.monto, motivo: o.motivo, venceEn: ent.venceEn, manual: !!o.manual, remitente: o.remitente || null });
    return { reembolso: ent, nuevo: true };
  } catch (e) {
    if (!(e instanceof datos.EntidadExistente)) throw e;
    const previo = await datos.leer('reembolso', id, { redis: r });
    if (previo && o.monto != null && previo.monto !== o.monto) {
      await encolarEfecto(r, ahora, 'ef:reembolso:' + id + ':monto:' + o.monto, { tipo: 'equipo_alerta', motivo: 'reembolso_monto_cambio', reembolsoId: id, antes: previo.monto, ahora: o.monto });
    }
    return { reembolso: previo, nuevo: false };
  }
}

// Ejecuta la devolución en Talo (la dispara el admin con un click, o un proceso automático más adelante).
async function ejecutarReembolso(id, d) {
  const { redis: r, talo, ahora } = dep(d);
  return r.withLock(K.lockReembolso(id), 30, async () => {
    const ent = await datos.leer('reembolso', id, { redis: r });
    if (!ent) throw new datos.EntidadInexistente(id);
    if (ent.estado === 'completado') return { ya: 'completado' };
    if (ent.estado === 'en_proceso') return { ya: 'en_proceso' };
    // Plata que Talo no asoció al pago: la API de devoluciones no puede moverla. Se devuelve a mano desde el panel de Talo
    // (los datos de quién la mandó están en la devolución) y después se marca con completarReembolsoManual().
    if (ent.manual) return { manual: true, monto: ent.monto, remitente: ent.remitente, transacciones: ent.transacciones };
    const res = await talo.reembolsar(ent.paymentId, { monto: ent.monto });
    await datos.actualizar('reembolso', id, (x) => { x.estado = 'en_proceso'; x.ejecutadoEn = ahora.toISOString(); x.intentos = (x.intentos || 0) + 1; x.yaPendienteEnTalo = !!res.yaPendiente; }, { redis: r, ahora });
    return { ejecutado: true };
  });
}

// Mira en Talo cómo terminó la devolución. SUCCESS → se asienta en el libro (una sola vez). FAILED → se puede reintentar.
async function conciliarReembolso(id, d) {
  const { redis: r, talo, ahora } = dep(d);
  return r.withLock(K.lockReembolso(id), 30, async () => {
    const ent = await datos.leer('reembolso', id, { redis: r });
    if (!ent) throw new datos.EntidadInexistente(id);
    if (ent.estado !== 'en_proceso') return { estado: ent.estado };
    const pago = await talo.consultarPagoCompleto(ent.paymentId);
    const ultimo = pago.refunds[pago.refunds.length - 1];
    if (!ultimo || ultimo.estado === 'PENDING') return { estado: 'en_proceso' };
    if (ultimo.estado === 'SUCCESS') {
      const monto = ent.monto != null ? ent.monto : (ultimo.monto || pago.reembolsado);
      if (!(monto > 0)) { await encolarEfecto(r, ahora, 'ef:reembolso:' + id + ':sin_monto', { tipo: 'equipo_alerta', motivo: 'reembolso_ok_sin_monto', reembolsoId: id }); return { estado: 'en_proceso' }; }
      const sol = ent.solicitudId ? await datos.leer('solicitud', ent.solicitudId, { redis: r }) : null;
      await libro.registrar({ id: 'reembolso:' + id, tipo: 'reembolso_cliente', parteId: (sol && (sol.clienteId || sol.cliente)) || 'sin-cliente', monto, refExterna: idSeguro(ent.paymentId), trabajoId: ent.solicitudId || null, nota: 'Devolución (' + ent.motivo + ') por Talo ' + ent.paymentId, por: 'sistema' }, { redis: r, ahora });
      await datos.actualizar('reembolso', id, (x) => { x.estado = 'completado'; x.completadoEn = ahora.toISOString(); }, { redis: r, ahora });
      await encolarEfecto(r, ahora, 'ef:reembolso:' + id + ':ok', { tipo: 'cliente_devolucion_hecha', solicitudId: ent.solicitudId, monto });
      return { estado: 'completado' };
    }
    await datos.actualizar('reembolso', id, (x) => { x.estado = 'fallido'; x.fallidoEn = ahora.toISOString(); }, { redis: r, ahora });
    await encolarEfecto(r, ahora, 'ef:reembolso:' + id + ':fallo:' + (ent.intentos || 0), { tipo: 'equipo_alerta', motivo: 'reembolso_fallido', reembolsoId: id });
    return { estado: 'fallido' };
  });
}

// Marca como hecha una devolución MANUAL (se devolvió desde el panel de Talo). Asienta el reembolso en el libro una sola vez.
async function completarReembolsoManual(id, o, d) {
  const { redis: r, ahora } = dep(d);
  const nota = o && o.nota ? String(o.nota).trim() : '';
  if (nota.length < 5) throw new Error('Falta una nota (referencia de la devolución hecha en Talo, mínimo 5 caracteres)');
  return r.withLock(K.lockReembolso(id), 30, async () => {
    const ent = await datos.leer('reembolso', id, { redis: r });
    if (!ent) throw new datos.EntidadInexistente(id);
    if (!ent.manual) throw new Error('Esta devolución es automática: se ejecuta con ejecutarReembolso');
    if (ent.estado === 'completado') return { estado: 'completado', ya: true };
    const sol = ent.solicitudId ? await datos.leer('solicitud', ent.solicitudId, { redis: r }) : null;
    await libro.registrar({ id: 'reembolso:' + id, tipo: 'reembolso_cliente', parteId: (sol && (sol.clienteId || sol.cliente)) || 'sin-cliente', monto: ent.monto, refExterna: idSeguro(ent.paymentId), trabajoId: ent.solicitudId || null, nota: 'Devolución manual: ' + nota, por: (o && o.por) || 'admin' }, { redis: r, ahora });
    await datos.actualizar('reembolso', id, (x) => { x.estado = 'completado'; x.completadoEn = ahora.toISOString(); x.notaManual = nota; }, { redis: r, ahora });
    await encolarEfecto(r, ahora, 'ef:reembolso:' + id + ':ok', { tipo: 'cliente_devolucion_hecha', solicitudId: ent.solicitudId, monto: ent.monto });
    return { estado: 'completado' };
  });
}

// Plata que entró a la cuenta de Talo SIN asociarse a ningún pago (payment_id vacío). Pasa, por ejemplo, cuando un cliente
// transfiere bastante más que lo pedido: Talo no la asocia y NO avisa (no hay webhook). PERO la transferencia trae a qué
// pago INTENTÓ ir (attempted_payment_id), así que acá se CONCILIA igual: se suma a lo pagado de ese pedido y sigue el camino
// de siempre (se acredita lo esperado y la diferencia queda como devolución MANUAL con los datos de quién la mandó).
// Lo que no se puede atribuir a un pedido de Hogar (sin pago intentado, o de Mudanza) se avisa al equipo, una sola vez.
// Cada transferencia se procesa una vez (se anota en un conjunto). La cuenta de Talo es compartida con Mudanza.
async function revisarSinAsociar(d, opts) {
  const { redis: r, talo, ahora } = dep(d);
  opts = opts || {};
  const desdeMs = opts.desde ? Date.parse(opts.desde) : ahora.getTime() - 24 * 3600 * 1000;
  const res = await talo.listarTransaccionesRecientes({ desde: opts.desde });
  const lista = res.transacciones || [];
  const idDe = function (t) { return idSeguro(t.id || (t.cuando + ':' + t.bruto)); };
  const sueltas = lista.filter(function (t) {
    if (!(t.tipo === 'INBOUND' && !t.pagoId && !t.clienteId && t.bruto > 0)) return false;
    const ms = Date.parse(t.cuando);
    return Number.isNaN(ms) || ms >= desdeMs;
  });
  const hechas = new Set((await r.cmd('SMEMBERS', K.sueltasHechas)) || []);
  const pendientes = sueltas.filter(function (t) { return !hechas.has(idDe(t)); });
  const out = { revisadas: lista.length, sinAsociar: sueltas.length, conciliadas: 0, nuevas: 0, hayMas: !!res.hayMas };

  const porPago = {};
  const sinPago = [];
  pendientes.forEach(function (t) { if (t.intentoPagoId) (porPago[t.intentoPagoId] = porPago[t.intentoPagoId] || []).push(t); else sinPago.push(t); });

  const marcar = async function (t) { await r.cmd('SADD', K.sueltasHechas, idDe(t)); };
  const alertar = async function (t, motivo) {
    if (await encolarEfecto(r, ahora, 'ef:sinasociar:' + idDe(t), { tipo: 'equipo_alerta', motivo, transaccionId: t.id, bruto: t.bruto, neto: t.neto, cuando: t.cuando, pagoIntentado: t.intentoPagoId || null, remitente: t.remitente || null })) out.nuevas++;
    await marcar(t);
  };

  for (const pid of Object.keys(porPago)) {
    // Todas las sueltas de ese pago (incluidas las ya procesadas): el total se recalcula completo y es idempotente.
    const todas = sueltas.filter(function (t) { return t.intentoPagoId === pid; });
    let procesado = null;
    try { procesado = await procesarPago(pid, d, { sueltas: todas }); } catch (e) { procesado = null; }
    if (procesado && !procesado.ignorado) {
      out.conciliadas += porPago[pid].length;
      for (const t of porPago[pid]) await marcar(t);
    } else {
      for (const t of porPago[pid]) await alertar(t, procesado ? 'transferencia_sin_asociar' : 'transferencia_sin_asociar_error');
    }
  }
  for (const t of sinPago) await alertar(t, 'transferencia_sin_asociar');
  return out;
}

// Devoluciones que se pasaron del plazo de 24 h (para la alerta del cron).
async function reembolsosVencidos(d) {
  const { redis: r, ahora } = dep(d);
  const out = [];
  for (const id of await datos.ids('reembolso', { redis: r })) {
    const e = await datos.leer('reembolso', id, { redis: r });
    if (e && ['solicitado', 'en_proceso', 'fallido'].includes(e.estado) && new Date(e.venceEn).getTime() < ahora.getTime()) out.push({ id, estado: e.estado, venceEn: e.venceEn, monto: e.monto, motivo: e.motivo });
  }
  return out;
}

module.exports = {
  armarExternalId, parsearExternalId, idSeguro, decidir, procesarPago, anotarAviso, procesarBuzon,
  solicitarReembolso, ejecutarReembolso, completarReembolsoManual, conciliarReembolso, reembolsosVencidos, revisarSinAsociar,
  encolarEfecto, efectosPendientes, marcarEfectoHecho, PLAZO_REEMBOLSO_MS, TOLERANCIA_PESOS,
};
