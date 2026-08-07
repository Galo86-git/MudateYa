// api/cron-recordar-completar.js — Mudanzas que arrancaron y nadie cerró.
//
// EL PROBLEMA
//   El mudancero marca "en curso" y después no toca "completada". Para el
//   sistema eso no es un error: el pedido no está vencido ni cancelado, se
//   queda ahí. Pero el link del saldo se genera JUSTO en esa transición
//   (cambiar-estado -> 'completada' dispara avisarSaldoPendiente), así que
//   mientras nadie la cierre el cliente no tiene cómo pagar el 50% restante.
//   Plata trabajada que no se cobra, y nadie se entera.
//
// CUÁNDO PREGUNTA
//   No a una hora fija: se ancla al tiempo que el propio mudancero estimó.
//   Si cotizó 4 horas y arrancó a las 9, la primera pregunta sale 14:00
//   (estimado + 1 h de gracia). Un umbral fijo tipo "24 h" es absurdo para un
//   trabajo de 4 horas: se entera al día siguiente.
//
//   estimado + 1 h   -> primera pregunta al mudancero
//   cada 2 h         -> repregunta, hasta 3 veces (si no contesta)
//   "sigo en curso"  -> Emi llama a la tool sigo_en_curso y lo pospone 2 h
//   2x el estimado   -> aviso al EQUIPO (una sola vez)
//
// A QUIÉN
//   Al MUDANCERO, nunca al cliente. Pedirle el saldo a un cliente por un
//   trabajo que el mudancero no dio por terminado es al revés: capaz sigue en
//   curso de verdad, o pasó algo y por eso no lo cerró. Cuando él la marca
//   completada, el flujo que ya existe le manda el link al cliente solo.
//
// Corre CADA HORA (ver vercel.json): con umbrales relativos al estimado, un
// cron diario no puede preguntar "a las 4 horas".

const GRACIA_H = parseFloat(process.env.HORAS_GRACIA_COMPLETAR || '1');
const REPREGUNTA_H = parseFloat(process.env.HORAS_REPREGUNTA_COMPLETAR || '2');
const MAX_PREGUNTAS = parseInt(process.env.MAX_PREGUNTAS_COMPLETAR || '3', 10);
const HORAS_ESTIMADAS_DEFAULT = parseFloat(process.env.HORAS_ESTIMADAS_DEFAULT || '4');

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
async function setJSON(k, v, ex) {
  const a = ['SET', k, JSON.stringify(v)];
  if (ex) a.push('EX', String(ex));
  return redisCall(...a);
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Cuánto dijo que iba a tardar. Por hora es un número limpio (horasIncluidas);
// a precio cerrado hay `tiempoEstimado`, que es texto libre del mudancero
// ("3 horas", "media jornada"), así que se saca el primer número que parezca
// horas y si no se entiende se cae al default. Nunca devuelve 0.
function horasEstimadas(cot) {
  const incl = parseFloat(cot && cot.horasIncluidas);
  if (incl > 0) return incl;
  const t = String((cot && cot.tiempoEstimado) || '').toLowerCase();
  const m = t.match(/(\d+(?:[.,]\d+)?)\s*(h|hs|hora)/);
  if (m) {
    const n = parseFloat(m[1].replace(',', '.'));
    if (n > 0 && n <= 24) return n;
  }
  return HORAS_ESTIMADAS_DEFAULT;
}

async function preguntarAlMudancero(m, ruta, nOrden) {
  const cot = m.cotizacionAceptada || {};
  const tel = cot.mudanceroTel;
  if (!tel) return false;
  const nombre = (cot.mudanceroNombre || '').split(' ')[0] || 'Hola';
  const tipo = m.tipo === 'flete' ? 'el flete' : 'la mudanza';
  try {
    const { enviarPlantilla } = require('./_plantillas');
    const textoLibre = nOrden === 1
      ? `¡Hola ${nombre}! ¿Ya terminaste ${tipo} de ${ruta}?\n\n` +
        `Si sí, respondeme y la cierro — recién ahí el cliente recibe el link para pagarte el saldo. ` +
        `Si todavía estás, avisame y te pregunto más tarde.`
      : `${nombre}, ¿cómo venís con ${tipo} de ${ruta}? Si ya está, respondeme y la cierro así podés cobrar el saldo.`;
    const r = await enviarPlantilla(
      tel, 'recordatorio_completar_mudanza',
      { 1: nombre, 2: tipo, 3: ruta }, textoLibre
    );
    return !!(r && r.enviado);
  } catch (e) {
    console.warn('preguntarAlMudancero:', e.message);
    return false;
  }
}

async function avisarAlEquipo(pendientes) {
  const adminMail = process.env.ADMIN_EMAIL;
  if (!process.env.RESEND_API_KEY || !adminMail || !pendientes.length) return false;
  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const filas = pendientes.map((p) =>
      `<tr>
        <td style="padding:8px 10px;border-bottom:1px solid #E2E8F0">${esc(p.id)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #E2E8F0">${esc(p.mudancero)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #E2E8F0">${esc(p.ruta)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #E2E8F0;text-align:right">${p.horas} h / est. ${p.estimadas} h</td>
      </tr>`).join('');
    await resend.emails.send({
      from: 'MudateYa <noreply@mudateya.ar>',
      reply_to: 'hola@mudateya.ar',
      to: adminMail,
      subject: `⏳ ${pendientes.length} mudanza(s) en curso al doble de lo estimado`,
      html:
        `<div style="font-family:Arial,sans-serif;max-width:640px">
          <h2 style="color:#B45309;margin:0 0 12px">Mudanzas que arrancaron y nadie cerró</h2>
          <p style="font-size:16px;line-height:1.7">
            Estas llevan más del doble del tiempo que el mudancero estimó y siguen en curso.
            Mientras no se marquen como completadas, <strong>el cliente no tiene forma de pagar el saldo</strong>.
          </p>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr style="background:#F5F7FA">
              <th style="padding:8px 10px;text-align:left">Pedido</th>
              <th style="padding:8px 10px;text-align:left">Mudancero</th>
              <th style="padding:8px 10px;text-align:left">Ruta</th>
              <th style="padding:8px 10px;text-align:right">Lleva</th>
            </tr>
            ${filas}
          </table>
        </div>`,
    });
    return true;
  } catch (e) {
    console.warn('avisarAlEquipo:', e.message);
    return false;
  }
}

module.exports = async function handler(req, res) {
  let esVercelCron = false;
  try { esVercelCron = require('./_auth').esCronVercel(req); } catch (_) {}
  let esAdminReq = false;
  try { esAdminReq = require('./_auth').esAdmin(req); } catch (_) {}
  if (!esVercelCron && !esAdminReq) return res.status(401).json({ error: 'No autorizado' });

  // ?dry=1 → no manda nada, solo devuelve qué haría y por qué.
  const dry = String((req.query && req.query.dry) || '') === '1';

  try {
    const activas = (await getJSON('mudanzas:activas')) || [];
    const ahora = Date.now();
    let enCurso = 0, preguntados = 0;
    const paraElEquipo = [];
    const detalle = [];

    for (const id of activas) {
      const m = await getJSON(`mudanza:${id}`);
      if (!m) continue;
      if (m.estado !== 'en_curso' || !m.fechaInicio) continue;
      if (m.saldoPagado) continue;
      enCurso++;

      const cot = m.cotizacionAceptada || {};
      const ruta = `${m.desde || m.origen || ''} → ${m.hasta || m.destino || ''}`;
      const est = horasEstimadas(cot);
      const inicio = new Date(m.fechaInicio).getTime();
      const horas = Math.round(((ahora - inicio) / 3600000) * 10) / 10;

      // El mudancero pidió que lo dejen seguir: no se lo molesta hasta ahí.
      if (m.cierrePospuestoHasta && ahora < new Date(m.cierrePospuestoHasta).getTime()) continue;

      const hechas = parseInt(m.preguntasCompletar || 0, 10);
      const ultima = m.ultimaPreguntaCompletar ? new Date(m.ultimaPreguntaCompletar).getTime() : 0;
      const tocaPrimera = !hechas && horas >= est + GRACIA_H;
      const tocaRepetir = hechas > 0 && hechas < MAX_PREGUNTAS && (ahora - ultima) >= REPREGUNTA_H * 3600000;

      if (tocaPrimera || tocaRepetir) {
        detalle.push({ id, ruta, estimadas: est, lleva: horas, pregunta: hechas + 1 });
        if (dry) {
          preguntados++;
        } else if (await preguntarAlMudancero(m, ruta, hechas + 1)) {
          m.preguntasCompletar = hechas + 1;
          m.ultimaPreguntaCompletar = new Date().toISOString();
          await setJSON(`mudanza:${id}`, m, 604800);
          preguntados++;
        }
      }

      // Al doble del estimado, una sola vez, al equipo.
      if (horas >= est * 2 && !m.alertaSinCompletar) {
        paraElEquipo.push({
          id: id,
          mudancero: cot.mudanceroNombre || cot.mudanceroEmail || '—',
          ruta: ruta, horas: horas, estimadas: est,
        });
        if (!dry) {
          m.alertaSinCompletar = new Date().toISOString();
          await setJSON(`mudanza:${id}`, m, 604800);
        }
      }
    }

    if (!dry) await avisarAlEquipo(paraElEquipo);

    return res.status(200).json({
      ok: true, dry: dry,
      enCurso: enCurso,
      preguntasAMudanceros: preguntados,
      alertasAlEquipo: paraElEquipo.length,
      detalle: detalle,
      alEquipo: paraElEquipo,
    });
  } catch (e) {
    console.error('cron-recordar-completar:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
