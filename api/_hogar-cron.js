// api/_hogar-cron.js
//
// El "proceso por minuto" de MYA Hogar (lo dispara api/cron-hogar.js). Es lo que hace que los cobros pasen solos:
//   1. vacía el buzón de avisos de Talo (pagos que Talo avisó y no se alcanzaron a procesar al instante);
//   2. cada 2 minutos revisa las transferencias que Talo NO asoció a ningún pago y las concilia
//      (Talo no avisa de esas: solo se detectan mirando las transacciones de la cuenta);
//   3. sigue las devoluciones que están en proceso en Talo y las asienta cuando terminan;
//   4. cada 10 minutos avisa las devoluciones que pasaron el plazo de 24 h;
//   5. ejecuta los avisos pendientes (buzón de efectos): los del equipo salen en UN solo mail agrupado; los de clientes
//      y proveedores esperan a que exista el canal (Emi/WhatsApp) y quedan pendientes, sin perderse.
// Cada tarea corre aislada: si una falla, las otras siguen y el error queda en el resultado.
// Un bloqueo evita que dos ciclos corran a la vez. Cada ciclo deja un "latido" (hogar:cron:latido, vence en 1 h): si el
// proceso deja de correr, cron-healthcheck lo detecta y avisa.
//
// Todo se inyecta (redis, talo, ahora, enviarEquipo, manejadores) para probarlo sin esperar ni mandar mails.
//
// Vercel ignora los archivos de /api que empiezan con "_".

const { cliente, LockOcupado } = require('./_redis');
const datos = require('./_hogar-datos');
const pagos = require('./_hogar-pagos');
const { fechaAR } = require('./_hogar-reglas');

const K = { latido: 'hogar:cron:latido', lock: 'hogar:lock:cron-ciclo' };
const LATIDO_TTL_SEG = 3600;
const LATIDO_MAX_MIN = 5;           // más que esto sin latido = el proceso no está corriendo
const pesos = (n) => '$' + Number(n || 0).toLocaleString('es-AR');
const dep = (d) => ({ redis: (d && d.redis) || cliente(), ahora: (d && d.ahora) || new Date() });

// Texto de una línea para el mail al equipo.
function describirEfecto(e) {
  const quien = (r) => (r ? [r.titular, r.cuit ? 'CUIT ' + r.cuit : '', r.cbu ? 'CBU ' + r.cbu : ''].filter(Boolean).join(' · ') : 'sin datos');
  if (e.tipo === 'equipo_reembolso_pendiente') {
    return 'Devolver ' + pesos(e.monto) + ' (' + e.motivo + '), plazo hasta ' + e.venceEn + ' — ' +
      (e.manual ? 'MANUAL desde el panel de Talo, a: ' + quien(e.remitente) : 'se ejecuta desde el admin (Talo la devuelve)');
  }
  if (e.tipo === 'equipo_alerta') {
    switch (e.motivo) {
      case 'pago_sin_pedido': return 'Entró un pago de ' + pesos(e.pagado) + ' (Talo ' + e.paymentId + ') que no corresponde a ningún pedido de Hogar (' + e.externalId + ').';
      case 'transferencia_sin_asociar':
      case 'transferencia_sin_asociar_error':
        return 'Transferencia de ' + pesos(e.bruto) + ' que Talo no asoció a ningún pago y no se pudo conciliar sola' + (e.pagoIntentado ? ' (iba al pago ' + e.pagoIntentado + ', que no es de Hogar o falló)' : ' (no indica a qué pago iba)') + ' — de: ' + quien(e.remitente) + '.';
      case 'reembolso_monto_cambio': return 'Una devolución cambió de monto (' + pesos(e.antes) + ' → ' + pesos(e.ahora) + '): revisar a mano (' + e.reembolsoId + ').';
      case 'reembolso_fallido': return 'Talo rechazó una devolución (' + e.reembolsoId + '). Se puede reintentar.';
      case 'reembolso_ok_sin_monto': return 'Talo confirmó una devolución pero no se pudo leer el monto (' + e.reembolsoId + '): revisar el libro.';
      case 'reembolso_vencido': return 'DEVOLUCIÓN VENCIDA (más de 24 h): ' + e.reembolsoId + ' · ' + pesos(e.monto) + ' · ' + e.motivoReembolso + ' · estado ' + e.estado + '.';
      default: return String(e.motivo || 'aviso');
    }
  }
  return String(e.tipo);
}

// Ejecuta los avisos pendientes. opts: { enviarEquipo(asunto, resumen, datos) → Promise<boolean>, manejadores: { tipo: async (efecto) → true }, max }
async function ejecutarEfectos(d, opts) {
  opts = opts || {};
  const { ahora } = dep(d);
  const pendientes = await pagos.efectosPendientes(d, opts.max || 50);
  const res = { hechos: 0, pendientes: 0, sinCanal: 0, atrasadosSinCanal: 0, mailEnviado: false };

  const equipo = pendientes.filter((e) => String(e.tipo).indexOf('equipo_') === 0);
  const otros = pendientes.filter((e) => String(e.tipo).indexOf('equipo_') !== 0);

  if (equipo.length) {
    const lote = equipo.slice(0, 15);
    const datosMail = {};
    lote.forEach((e, i) => { datosMail[String(i + 1)] = describirEfecto(e); });
    const enviar = opts.enviarEquipo || (d && d.enviarEquipo) || require('./_alerta-equipo').alertarEquipo;
    const ok = await enviar('Hogar: ' + lote.length + (lote.length === 1 ? ' aviso' : ' avisos') + ' para revisar',
      'El sistema de cobros de MYA Hogar tiene ' + (equipo.length === 1 ? 'un aviso' : equipo.length + ' avisos') + ' que necesitan que alguien los mire.', datosMail);
    if (ok) { for (const e of lote) await pagos.marcarEfectoHecho(d, e.id); res.hechos += lote.length; res.mailEnviado = true; }
    res.pendientes += equipo.length - (ok ? lote.length : 0);
  }

  for (const e of otros) {
    const mh = opts.manejadores || (d && d.manejadores);
    const h = mh && mh[e.tipo];
    if (h) {
      try { if (await h(e)) { await pagos.marcarEfectoHecho(d, e.id); res.hechos++; continue; } } catch (err) { /* queda pendiente y se reintenta */ }
      res.pendientes++;
    } else {
      // Todavía no existe el canal (Emi/WhatsApp): el aviso espera, no se pierde.
      res.sinCanal++; res.pendientes++;
      if (ahora.getTime() - new Date(e.creado).getTime() > 30 * 60 * 1000) res.atrasadosSinCanal++;
    }
  }
  return res;
}

async function ciclo(d, opts) {
  opts = opts || {};
  const { redis, ahora } = dep(d);
  const t0 = Date.now();
  const res = { errores: [] };
  const tarea = async (nombre, fn) => { try { res[nombre] = await fn(); } catch (e) { res.errores.push(nombre + ': ' + e.message); } };

  await tarea('buzon', () => pagos.procesarBuzon(d, 20));
  if (opts.forzar || ahora.getUTCMinutes() % 2 === 0) await tarea('sinAsociar', () => pagos.revisarSinAsociar(d));
  await tarea('reembolsos', () => pagos.conciliarReembolsosEnProceso(d));
  if (opts.forzar || ahora.getUTCMinutes() % 10 === 0) await tarea('vencidos', () => pagos.alertarReembolsosVencidos(d, fechaAR(ahora)));
  await tarea('efectos', () => ejecutarEfectos(d, opts));

  res.ms = Date.now() - t0;
  res.ok = res.errores.length === 0;
  try { await redis.setJSON(K.latido, { ts: ahora.getTime(), cuando: ahora.toISOString(), ok: res.ok, errores: res.errores.slice(0, 5), ms: res.ms }, { ttlSeg: LATIDO_TTL_SEG }); }
  catch (e) { res.errores.push('latido: ' + e.message); }
  return res;
}

// Un ciclo a la vez: si el anterior sigue corriendo, este se saltea.
async function cicloConLock(d, opts) {
  const { redis } = dep(d);
  try { return await redis.withLock(K.lock, 55, () => ciclo(d, opts), { esperaMs: 0 }); }
  catch (e) { if (e instanceof LockOcupado) return { omitido: 'ya hay un ciclo corriendo' }; throw e; }
}

// ¿El proceso por minuto está corriendo? (lo mira cron-healthcheck)
async function estadoLatido(d) {
  const { redis, ahora } = dep(d);
  const l = await redis.getJSON(K.latido);
  if (!l) return { ultimo: null, minutos: null, ok: false };
  const minutos = Math.round((ahora.getTime() - l.ts) / 60000 * 10) / 10;
  return { ultimo: l.cuando, minutos, ok: minutos <= LATIDO_MAX_MIN && l.ok !== false, ultimoOk: l.ok, errores: l.errores };
}

async function resumenEstado(d) {
  const { redis } = dep(d);
  const [efectos, buzon, latido] = await Promise.all([redis.cmd('ZCARD', 'hogar:outbox:pend'), redis.cmd('ZCARD', 'hogar:inbox:talo'), estadoLatido(d)]);
  return { latido, avisosPendientes: Number(efectos) || 0, avisosDeTaloEnBuzon: Number(buzon) || 0 };
}

module.exports = { ciclo, cicloConLock, ejecutarEfectos, describirEfecto, estadoLatido, resumenEstado, LATIDO_MAX_MIN, K };
