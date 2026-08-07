// api/transferencias.js — Transferencia bancaria como medio de pago
//
// Habilita transferencia para ANTICIPO y SALDO FINAL, en paralelo a Mercado Pago.
//
// FLUJO
//   1. El cliente elige "Transferencia" en el modal de pago.
//   2. GET  ?action=datos      → devuelve CBU/alias/titular + monto + código de referencia.
//   3. POST accion=declarar    → el cliente avisa que transfirió (queda PENDIENTE).
//   4. Vos verificás en el banco que la plata llegó.
//   5. POST accion=confirmar   → se marca el pago y se dispara todo el flujo normal.
//
// POR QUÉ LA CONFIRMACIÓN NO ES AUTOMÁTICA
//   Nadie le avisa al sistema que entró una transferencia. Declarar no es pagar:
//   la única fuente de verdad es tu extracto bancario. Confirmar automáticamente
//   con lo que dice el cliente sería regalar mudanzas. Si más adelante contratás
//   un servicio de conciliación (CVUs únicos por operación), la confirmación se
//   automatiza llamando a `confirmar` desde ese webhook.
//
// POR QUÉ SE DELEGA EN registrar-pago
//   Marcar el pago implica setear anticipoPagado/saldoPagado, guardar la fecha
//   que dispara el conteo de 15 días hábiles para liquidarle al mudancero, mandar
//   los emails y cerrar la mudanza. Esa lógica ya existe y está probada en
//   cotizaciones.js. Duplicarla acá sería tener dos verdades sobre la misma plata.
//
// VARIABLES DE ENTORNO NECESARIAS
//   TRANSFER_CBU         CBU o CVU de la cuenta que recibe
//   TRANSFER_ALIAS       alias de esa cuenta
//   TRANSFER_TITULAR     titular tal como figura en el banco
//   TRANSFER_CUIT        (opcional) CUIT del titular
//   INTERNAL_API_SECRET  ya existente, se usa para confirmar el pago
//
// Si faltan CBU y alias, los endpoints públicos devuelven 503 y el frontend
// no ofrece la opción. Nunca se muestran datos bancarios a medias.

const { esAdmin } = require('./_auth');
const { Resend } = require('resend');
const crypto = require('crypto');
const talo = require('./_talo');

async function redisCall(method, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  const r = await fetch(`${url}/${[method, ...args].map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}
async function getJSON(k) { const v = await redisCall('GET', k); return v ? JSON.parse(v) : null; }
async function setJSON(k, v, ex) {
  const s = JSON.stringify(v);
  if (ex) await redisCall('SET', k, s, 'EX', String(ex));
  else await redisCall('SET', k, s);
}

const TTL = 60 * 60 * 24 * 180; // 180 días

function datosBancarios() {
  return {
    cbu:     process.env.TRANSFER_CBU     || '',
    alias:   process.env.TRANSFER_ALIAS   || '',
    titular: process.env.TRANSFER_TITULAR || 'MudateYa',
    cuit:    process.env.TRANSFER_CUIT    || ''
  };
}
function bancoConfigurado() {
  const d = datosBancarios();
  return !!(d.cbu && d.alias);
}

// Monto que el sistema espera para este tramo. Sirve para contrastar contra lo
// que declara el cliente: si no coinciden, el admin lo ve marcado y decide.
function montoEsperado(m, tipoPago) {
  const cot = m.cotizacionAceptada || {};
  // OJO CON EL ORDEN: cotizacionAceptada.precio primero.
  //
  // montoTotal se escribe UNA sola vez, cuando se acepta la cotización, y no
  // se vuelve a tocar. Cuando el mudancero propone un ajuste y el cliente lo
  // acepta, lo que se actualiza es cotizacionAceptada.precio; montoTotal queda
  // con el precio viejo. Si se lee montoTotal primero, después de un ajuste se
  // le cobra al cliente el importe anterior.
  //
  // Es el mismo criterio que usa el frontend para calcular el saldo.
  const total = parseInt(cot.precio || m.montoTotal || 0) || 0;
  if (!total) return null;
  if (tipoPago === 'anticipo') return Math.round(total * 0.5);
  if (tipoPago === 'saldo') {
    const ant = parseInt(m.anticipoMonto || Math.round(total * 0.5)) || 0;
    return Math.max(total - ant, 0);
  }
  return null;
}

// Aviso cuando una transferencia entra por MENOS de lo esperado (Talo UNDERPAID):
// no se acredita, pero NO puede quedar en silencio. Avisa al equipo (email) y al
// cliente (WhatsApp) para completar la diferencia o resolverlo a mano.
async function avisarTransferenciaInsuficiente(m, tipoPago, pago) {
  const esperado = montoEsperado(m, tipoPago);
  const pagado = Number((pago && (pago.montoPagado || pago.montoPedido)) || 0);
  const falta = esperado != null ? Math.max(0, esperado - pagado) : null;
  const label = tipoPago === 'anticipo' ? 'la seña' : 'el saldo';
  const fmt = (n) => '$' + Number(n || 0).toLocaleString('es-AR');

  // 1) Equipo (email).
  try {
    if (process.env.RESEND_API_KEY && process.env.ADMIN_EMAIL) {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
        to: process.env.ADMIN_EMAIL,
        subject: `⚠️ Transferencia INSUFICIENTE — ${m.id} (${tipoPago})`,
        html:
          `<p>Entró una transferencia por <b>menos</b> de lo esperado (NO se acreditó).</p>` +
          `<p>Mudanza: <b>${m.id}</b> · ${tipoPago}<br>` +
          `Esperado: ${fmt(esperado)} · Pagado: ${fmt(pagado)} · Falta: ${falta != null ? fmt(falta) : '—'}<br>` +
          `Cliente: ${m.clienteNombre || ''} ${m.clienteWA || m.clienteEmail || ''}<br>` +
          `Talo paymentId: ${(pago && pago.paymentId) || '—'}</p>` +
          `<p>Resolver a mano: acreditar, pedir la diferencia, o devolver.</p>`,
      });
    }
  } catch (e) { console.warn('[underpaid] email admin:', e.message); }

  // 2) Cliente por WhatsApp → plantilla transferencia_diferencia (o texto libre).
  if (m.clienteWA) {
    const nomCli = (m.clienteNombre || '').split(' ')[0] || 'Hola';
    const faltaNum = falta != null ? Number(falta).toLocaleString('es-AR') : '0';
    const texto =
      `⚠️ Recibimos tu transferencia para ${label}, pero fue por un monto menor al indicado` +
      (falta != null ? ` (faltarían ${fmt(falta)})` : '') + `.\n` +
      `Para que quede acreditada, transferí la diferencia al MISMO alias/CBU que te pasé, o escribime y lo resolvemos juntos. 🙏`;
    try {
      const { enviarPlantilla } = require('./_plantillas');
      await enviarPlantilla(m.clienteWA, 'transferencia_diferencia', { 1: nomCli, 2: label, 3: faltaNum }, texto);
    } catch (e) { console.warn('[underpaid] WhatsApp cliente:', e.message); }
  }
}

// Código corto para poner en el concepto de la transferencia y cruzarlo contra
// el extracto bancario.
//
// Se usa un hash y no los últimos dígitos del ID: los IDs son 'MYA-'+Date.now(),
// así que recortar los últimos 6 dígitos hace que el código se repita cada
// ~16 minutos. Dos pedidos distintos con la misma referencia es exactamente
// lo que no querés cuando estás conciliando plata.
//
// SHA-1 truncado a 6 caracteres base36 en mayúsculas: ~2.100 millones de
// combinaciones, suficiente y legible para tipear en el homebanking.
function codigoReferencia(mudanzaId, tipoPago) {
  const h = crypto.createHash('sha1')
    .update(String(mudanzaId || '') + '|' + String(tipoPago || ''))
    .digest('hex');
  const n = parseInt(h.slice(0, 12), 16);
  const s = n.toString(36).toUpperCase().slice(-6).padStart(6, '0');
  return 'MYA-' + s;
}

// El external_id viaja a Talo y vuelve en el webhook: es lo que permite saber
// a que mudanza y a que tramo corresponde la plata que entro.
function armarExternalId(mudanzaId, tipoPago) {
  return String(mudanzaId) + '__' + String(tipoPago);
}
function leerExternalId(ext) {
  const p = String(ext || '').split('__');
  if (p.length !== 2) return null;
  if (['anticipo', 'saldo'].indexOf(p[1]) === -1) return null;
  return { mudanzaId: p[0], tipoPago: p[1] };
}

// Marca el pago reutilizando registrar-pago, que es donde vive toda la logica
// de plata (estados, fecha de liquidacion a 15 dias habiles, emails).
async function marcarPagado(mudanzaId, tipoPago) {
  if (!process.env.INTERNAL_API_SECRET) throw new Error('falta INTERNAL_API_SECRET');
  const base = process.env.SITE_URL || 'https://mudateya.ar';
  const r = await fetch(`${base}/api/cotizaciones?action=registrar-pago`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_API_SECRET },
    body: JSON.stringify({ mudanzaId: mudanzaId, tipoPago: tipoPago, metodoPago: 'transferencia' })
  });
  const d = await r.json().catch(function () { return {}; });
  if (!r.ok) throw new Error((d && d.error) || 'registrar-pago fallo');
  return true;
}

function fmtPesos(n) {
  return '$' + Number(n || 0).toLocaleString('es-AR');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = (req.query && req.query.action) || '';

  try {
    // ════════════════════════════════════════════════════════════
    // GET ?action=disponible — ¿se puede pagar por transferencia?
    // ════════════════════════════════════════════════════════════
    // Lo consulta el frontend al cargar para decidir si dibuja el botón.
    // Sin esto se le ofrecía transferencia a todo el mundo y al tocar el
    // botón aparecía un error, que es peor que no ofrecerla.
    if (req.method === 'GET' && action === 'disponible') {
      return res.status(200).json({
        disponible: bancoConfigurado() || talo.taloConfigurado(),
        automatico: talo.taloConfigurado()
      });
    }

    // ════════════════════════════════════════════════════════════
    // GET ?action=estado-pago — ¿ya se acreditó este tramo? (público)
    // ════════════════════════════════════════════════════════════
    // Lo consulta la pantalla del cliente cada pocos segundos después de
    // avisar que transfirió. Con CVU único la acreditación llega sola en
    // segundos, pero sin esto el cliente veía su mudanza como pendiente y
    // tenía que refrescar a mano para enterarse.
    //
    // Devuelve lo mínimo indispensable: no expone datos de la mudanza.
    if (req.method === 'GET' && action === 'estado-pago') {
      const q = req.query || {};
      if (!q.mudanzaId || ['anticipo', 'saldo'].indexOf(q.tipoPago) === -1) {
        return res.status(400).json({ error: 'Datos inválidos' });
      }
      const m = await getJSON(`mudanza:${q.mudanzaId}`);
      if (!m) return res.status(404).json({ error: 'Mudanza no encontrada' });
      return res.status(200).json({
        ok: true,
        pagado: q.tipoPago === 'anticipo' ? !!m.anticipoPagado : !!m.saldoPagado
      });
    }

    // ════════════════════════════════════════════════════════════
    // GET ?action=datos — datos bancarios para pagar (público)
    // ════════════════════════════════════════════════════════════
    if (req.method === 'GET' && action === 'datos') {
      if (!bancoConfigurado() && !talo.taloConfigurado()) {
        return res.status(503).json({ error: 'Transferencia no disponible por el momento' });
      }
      const mudanzaId = (req.query || {}).mudanzaId;
      const tipoPago  = (req.query || {}).tipoPago;
      if (!mudanzaId || ['anticipo', 'saldo'].indexOf(tipoPago) === -1) {
        return res.status(400).json({ error: 'Datos inválidos' });
      }
      const m = await getJSON(`mudanza:${mudanzaId}`);
      if (!m) return res.status(404).json({ error: 'Mudanza no encontrada' });

      if (tipoPago === 'anticipo' && m.anticipoPagado) {
        return res.status(409).json({ error: 'El anticipo ya está pago' });
      }
      if (tipoPago === 'saldo' && m.saldoPagado) {
        return res.status(409).json({ error: 'El saldo ya está pago' });
      }
      if (tipoPago === 'saldo' && !m.anticipoPagado) {
        return res.status(409).json({ error: 'Primero hay que pagar el anticipo' });
      }

      const monto = montoEsperado(m, tipoPago);

      // ── Camino Talo: CVU unico por operacion, confirmacion automatica ──
      if (talo.taloConfigurado() && monto > 0) {
        try {
          const clave = `talo:pago:${mudanzaId}:${tipoPago}`;
          let pago = null;

          // Reutilizar el pago anterior si sigue vigente: evita generar un CVU
          // nuevo cada vez que el cliente abre el modal.
          const previoId = await redisCall('GET', clave);
          if (previoId) {
            try {
              const p = await talo.consultarPago(previoId);
              const vigente = p.estado === 'PENDING' &&
                              (!p.expira || new Date(p.expira).getTime() > Date.now() + 60000) &&
                              Number(p.montoPedido) === Number(monto);
              if (vigente) pago = { paymentId: p.paymentId, cvu: p.cvu, alias: p.alias, expira: p.expira, paymentUrl: p.paymentUrl };
            } catch (e) { /* si no se puede consultar, se crea uno nuevo */ }
          }

          if (!pago) {
            const base = process.env.SITE_URL || 'https://mudateya.ar';
            pago = await talo.crearPago({
              monto: monto,
              externalId: armarExternalId(mudanzaId, tipoPago),
              webhookUrl: `${base}/api/transferencias?action=webhook`,
              motivo: `MudateYa ${m.id} - ${tipoPago === 'anticipo' ? 'Anticipo' : 'Saldo final'}`,
              cliente: { nombre: m.clienteNombre || '', email: m.clienteEmail || '' }
            });
            await redisCall('SET', clave, pago.paymentId, 'EX', String(60 * 60 * 24 * 7));
          }

          return res.status(200).json({
            ok: true,
            automatico: true,
            banco: { cbu: pago.cvu, alias: pago.alias, titular: datosBancarios().titular, cuit: datosBancarios().cuit },
            checkoutUrl: pago.paymentUrl || '', // link/QR de Talo con el monto YA cargado (no se puede tipear mal)
            monto: monto,
            expira: pago.expira,
            referencia: codigoReferencia(mudanzaId, tipoPago)
          });
        } catch (e) {
          // Si Talo falla, se cae al CBU fijo en vez de dejar al cliente sin
          // poder pagar. Se avisa en los logs para poder revisarlo.
          console.error('[transferencias] Talo no disponible, se usa CBU fijo:', e.message);
        }
      }

      if (!bancoConfigurado()) {
        return res.status(503).json({ error: 'Transferencia no disponible por el momento' });
      }
      return res.status(200).json({
        ok: true,
        automatico: false,
        banco: datosBancarios(),
        monto: monto,
        referencia: codigoReferencia(mudanzaId, tipoPago)
      });
    }

    // ════════════════════════════════════════════════════════════
    // POST ?action=webhook — notificación de Talo (público)
    // ════════════════════════════════════════════════════════════
    //
    // Talo todavía no firma sus webhooks (la firma HMAC figura como "pronto"
    // en su documentación). Por eso el payload NO se trata como fuente de
    // verdad: cualquiera que descubra esta URL podría postear un aviso falso.
    // Lo único que se toma del payload es el paymentId; todo lo demás se
    // verifica consultando la API de Talo con nuestro token.
    //
    // Se responde 200 incluso ante errores de negocio, para que Talo no
    // reintente en loop. Los problemas quedan en los logs.
    if (req.method === 'POST' && action === 'webhook') {
      const payload = req.body || {};
      const paymentId = payload.paymentId;
      if (!paymentId) return res.status(200).json({ ok: true, ignorado: 'sin paymentId' });
      if (!talo.taloConfigurado()) {
        console.error('[webhook] llegó una notificación de Talo pero no está configurado');
        return res.status(200).json({ ok: true });
      }

      let pago;
      try {
        pago = await talo.consultarPago(paymentId);
      } catch (e) {
        // Acá sí conviene devolver 500: si no pudimos verificar, queremos
        // que Talo reintente más tarde.
        console.error('[webhook] no se pudo verificar el pago:', e.message);
        return res.status(500).json({ error: 'No se pudo verificar' });
      }

      const ref = leerExternalId(pago.externalId);
      if (!ref) {
        console.error('[webhook] external_id no reconocido:', pago.externalId);
        return res.status(200).json({ ok: true, ignorado: 'external_id inválido' });
      }

      const m = await getJSON(`mudanza:${ref.mudanzaId}`);
      if (!m) {
        console.error('[webhook] mudanza inexistente:', ref.mudanzaId);
        return res.status(200).json({ ok: true, ignorado: 'mudanza inexistente' });
      }

      // UNDERPAID no se acredita: si transfirieron de menos, la mudanza no está
      // paga. EXPIRED y PENDING tampoco. OVERPAID sí (más abajo). PERO un
      // UNDERPAID no puede quedar MUDO: llegó plata real de menos y el cliente
      // cree que pagó. Se avisa al equipo y al cliente para completarlo/resolverlo.
      if (pago.estado !== 'SUCCESS' && pago.estado !== 'OVERPAID') {
        if (pago.estado === 'UNDERPAID') {
          try { await avisarTransferenciaInsuficiente(m, ref.tipoPago, pago); }
          catch (e) { console.warn('[webhook] aviso underpaid:', e.message); }
        }
        console.warn('[webhook] pago ' + paymentId + ' en estado ' + pago.estado + ', no se acredita');
        return res.status(200).json({ ok: true, estado: pago.estado });
      }

      // Idempotencia: Talo puede reenviar la misma notificación varias veces.
      const yaPago = (ref.tipoPago === 'anticipo' && m.anticipoPagado) ||
                     (ref.tipoPago === 'saldo' && m.saldoPagado);
      if (yaPago) return res.status(200).json({ ok: true, yaRegistrado: true });

      // Control de monto: el estado de Talo ya compara contra el precio que
      // le pedimos, pero se vuelve a contrastar contra lo que espera el
      // sistema por si el precio cambió después de crear el pago.
      const esperado = montoEsperado(m, ref.tipoPago);
      const pagado = Number(pago.montoPagado || pago.montoPedido || 0);
      if (esperado != null && pagado > 0 && pagado + 1 < esperado) {
        console.error('[webhook] monto insuficiente: pagó ' + pagado + ', esperado ' + esperado);
        return res.status(200).json({ ok: true, ignorado: 'monto insuficiente' });
      }

      try {
        await marcarPagado(ref.mudanzaId, ref.tipoPago);
      } catch (e) {
        console.error('[webhook] registrar-pago falló:', e.message);
        return res.status(500).json({ error: 'No se pudo registrar' });
      }

      // Dejar constancia para conciliar después.
      try {
        const m2 = await getJSON(`mudanza:${ref.mudanzaId}`);
        if (m2) {
          if (ref.tipoPago === 'anticipo') { m2.metodoPagoAnticipo = 'transferencia'; m2.taloPagoAnticipo = paymentId; }
          if (ref.tipoPago === 'saldo')    { m2.metodoPagoSaldo    = 'transferencia'; m2.taloPagoSaldo    = paymentId; }
          await setJSON(`mudanza:${ref.mudanzaId}`, m2);
        }
        // Si el cliente ya habia declarado, se ACTUALIZA ese registro en vez de
        // crear otro. Sin esto quedaban dos filas por el mismo cobro: la que
        // dejo el cliente y la que crea el webhook.
        const idxPrev = await getJSON('transferencias:pendientes') || [];
        let idExistente = null;
        for (let i = 0; i < idxPrev.length; i++) {
          const p = await getJSON(`transferencia:${idxPrev[i]}`);
          if (p && p.estado === 'pendiente' &&
              p.mudanzaId === ref.mudanzaId && p.tipoPago === ref.tipoPago) {
            idExistente = p.id; break;
          }
        }

        const reg = {
          id: idExistente || ('TRANS-' + Date.now()),
          mudanzaId: ref.mudanzaId,
          tipoPago: ref.tipoPago,
          estado: 'confirmada',
          origen: 'talo',
          taloPaymentId: paymentId,
          clienteEmail: m.clienteEmail || '',
          clienteNombre: m.clienteNombre || '',
          montoEsperado: esperado,
          montoDeclarado: pagado || esperado,
          coincide: pago.estado === 'SUCCESS',
          referencia: codigoReferencia(ref.mudanzaId, ref.tipoPago),
          fechaDeclarada: new Date().toISOString(),
          fechaResolucion: new Date().toISOString()
        };
        await setJSON(`transferencia:${reg.id}`, reg, TTL);
        if (!idExistente) {
          const idx = await getJSON('transferencias:pendientes') || [];
          idx.push(reg.id);
          await setJSON('transferencias:pendientes', idx, TTL);
        }
      } catch (e) { console.warn('[webhook] registro:', e.message); }

      // Cerrar el círculo por WhatsApp: al acreditar la SEÑA, avisar al cliente
      // (reservada) y al mudancero elegido (ganó el pedido). Idempotente por el
      // guard `yaPago` de arriba: solo corre la primera vez que se acredita.
      if (ref.tipoPago === 'anticipo') {
        try {
          const mFinal = await getJSON(`mudanza:${ref.mudanzaId}`);
          const { avisarSenaConfirmada } = require('./_whatsapp');
          await avisarSenaConfirmada(mFinal);
        } catch (e) { console.warn('[webhook] aviso WhatsApp seña:', e.message); }
      } else if (ref.tipoPago === 'saldo') {
        try {
          const mFinal = await getJSON(`mudanza:${ref.mudanzaId}`);
          const { avisarMudanzaPagadaCompleta } = require('./_whatsapp');
          await avisarMudanzaPagadaCompleta(mFinal);
        } catch (e) { console.warn('[webhook] aviso WhatsApp saldo:', e.message); }
      }

      // Si pagó de más, avisar: hay que devolver la diferencia.
      if (pago.estado === 'OVERPAID') {
        try {
          const resend = new Resend(process.env.RESEND_API_KEY);
          if (process.env.ADMIN_EMAIL && process.env.RESEND_API_KEY) {
            await resend.emails.send({
              from: 'MudateYa <noreply@mudateya.ar>',
              reply_to: 'hola@mudateya.ar',
              to: process.env.ADMIN_EMAIL,
              subject: `⚠️ Transferencia con monto de más · ${ref.mudanzaId}`,
              html: `<p>El pago se acreditó igual, pero entró más plata de la pedida.</p>
                     <p>Esperado: ${fmtPesos(esperado)} · Recibido: ${fmtPesos(pagado)}</p>
                     <p>Pedido ${ref.mudanzaId} · Talo ${paymentId}</p>
                     <p>Hay que devolver la diferencia.</p>`
            });
          }
        } catch (e) { console.warn('[webhook] aviso overpaid:', e.message); }
      }

      return res.status(200).json({ ok: true, registrado: true });
    }

    // ════════════════════════════════════════════════════════════
    // POST accion=declarar — el cliente avisa que transfirió
    // ════════════════════════════════════════════════════════════
    if (req.method === 'POST' && (req.body || {}).accion === 'declarar') {
      if (!bancoConfigurado() && !talo.taloConfigurado()) {
        return res.status(503).json({ error: 'Transferencia no disponible por el momento' });
      }
      const b = req.body || {};
      const mudanzaId = b.mudanzaId;
      const tipoPago  = b.tipoPago;
      if (!mudanzaId || ['anticipo', 'saldo'].indexOf(tipoPago) === -1) {
        return res.status(400).json({ error: 'Datos inválidos' });
      }
      const m = await getJSON(`mudanza:${mudanzaId}`);
      if (!m) return res.status(404).json({ error: 'Mudanza no encontrada' });
      if (tipoPago === 'anticipo' && m.anticipoPagado) {
        return res.status(409).json({ error: 'El anticipo ya está pago' });
      }
      if (tipoPago === 'saldo' && m.saldoPagado) {
        return res.status(409).json({ error: 'El saldo ya está pago' });
      }

      // Una declaración pendiente por tramo: evita que el cliente toque
      // el botón cinco veces y te llene el panel de duplicados.
      const idx = await getJSON('transferencias:pendientes') || [];
      for (let i = 0; i < idx.length; i++) {
        const prev = await getJSON(`transferencia:${idx[i]}`);
        if (prev && prev.estado === 'pendiente' &&
            prev.mudanzaId === mudanzaId && prev.tipoPago === tipoPago) {
          return res.status(200).json({ ok: true, id: prev.id, referencia: prev.referencia, yaDeclarada: true });
        }
      }

      const esperado  = montoEsperado(m, tipoPago);
      const declarado = parseInt(String(b.montoDeclarado || '').replace(/\D/g, '')) || esperado;
      const id = 'TRANS-' + Date.now();

      const t = {
        id,
        mudanzaId,
        tipoPago,
        estado: 'pendiente',
        clienteEmail:    m.clienteEmail || '',
        clienteNombre:   m.clienteNombre || '',
        mudanceroNombre: (m.cotizacionAceptada || {}).mudanceroNombre || '',
        montoEsperado:   esperado,
        montoDeclarado:  declarado,
        // Si no coinciden, el panel lo marca. No se bloquea: puede haber un
        // ajuste de precio legítimo o una diferencia de redondeo.
        coincide:        esperado != null ? (declarado === esperado) : null,
        referencia:      codigoReferencia(mudanzaId, tipoPago),
        comprobanteUrl:  b.comprobanteUrl || '',
        nota:            String(b.nota || '').slice(0, 300),
        fechaDeclarada:  new Date().toISOString()
      };

      await setJSON(`transferencia:${id}`, t, TTL);
      idx.push(id);
      await setJSON('transferencias:pendientes', idx, TTL);

      // Aviso al admin: sin esto la transferencia espera a que alguien
      // se acuerde de mirar el panel.
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        const admin = process.env.ADMIN_EMAIL;
        if (admin && process.env.RESEND_API_KEY) {
          const dif = t.coincide === false
            ? `<p style="color:#B45309"><strong>Ojo:</strong> declaró ${fmtPesos(declarado)} y el sistema esperaba ${fmtPesos(esperado)}.</p>`
            : '';
          await resend.emails.send({
            from: 'MudateYa <noreply@mudateya.ar>',
            reply_to: 'hola@mudateya.ar',
            to: admin,
            subject: `💸 Transferencia declarada · ${m.id} · ${fmtPesos(declarado)}`,
            html: `<div style="font-family:Arial,sans-serif;max-width:520px">
              <h2 style="color:#003580;margin:0 0 12px">Transferencia por confirmar</h2>
              <p><strong>${t.clienteNombre || t.clienteEmail}</strong> declaró haber transferido
              <strong>${fmtPesos(declarado)}</strong> (${tipoPago === 'anticipo' ? 'anticipo' : 'saldo final'}).</p>
              ${dif}
              <p style="font-size:13px;color:#475569">Pedido ${m.id} · Referencia <code>${t.referencia}</code></p>
              <p style="font-size:13px;color:#475569">Verificá en el banco antes de confirmar.</p>
              <a href="${process.env.SITE_URL || 'https://mudateya.ar'}/admin"
                 style="display:inline-block;background:#003580;color:#fff;text-decoration:none;
                        padding:10px 20px;border-radius:8px;font-weight:700">Ir al panel</a>
            </div>`
          });
        }
      } catch (e) { console.warn('[transferencias] aviso admin:', e.message); }

      return res.status(200).json({ ok: true, id, referencia: t.referencia });
    }

    // ════════════════════════════════════════════════════════════
    // A partir de acá, todo requiere admin
    // ════════════════════════════════════════════════════════════

    // GET sin action — listado que consume el panel
    if (req.method === 'GET') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      const ids = await getJSON('transferencias:pendientes') || [];
      const todas = [];
      for (let i = 0; i < ids.length; i++) {
        const t = await getJSON(`transferencia:${ids[i]}`);
        if (t) todas.push(t);
      }
      todas.sort(function (a, b) {
        return String(b.fechaDeclarada || '').localeCompare(String(a.fechaDeclarada || ''));
      });
      return res.status(200).json({ transferencias: todas, bancoConfigurado: bancoConfigurado() });
    }

    // POST accion=borrar-permanente — hard delete de UNA declaración de
    // transferencia. Pensado para limpiar datos de prueba: borra la key y la
    // saca de transferencias:pendientes (que pese al nombre guarda TODOS los
    // ids alguna vez creados, no solo los pendientes — así lee el listado de
    // arriba). No toca la mudanza asociada, eso lo maneja
    // admin-borrar-permanente en cotizaciones.js por separado. IRREVERSIBLE.
    if (req.method === 'POST' && (req.body || {}).accion === 'borrar-permanente') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      const idBorrar = (req.body || {}).id;
      if (!idBorrar) return res.status(400).json({ error: 'Falta id' });
      await redisCall('DEL', `transferencia:${idBorrar}`);
      const idxBorrar = (await getJSON('transferencias:pendientes')) || [];
      await setJSON('transferencias:pendientes', idxBorrar.filter((x) => x !== idBorrar), TTL);
      return res.status(200).json({ ok: true, borrado: idBorrar });
    }

    // POST accion=confirmar | rechazar
    if (req.method === 'POST') {
      if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
      const b = req.body || {};
      const id = b.id;
      const accion = b.accion;
      if (!id || ['confirmar', 'rechazar'].indexOf(accion) === -1) {
        return res.status(400).json({ error: 'Datos inválidos' });
      }

      const t = await getJSON(`transferencia:${id}`);
      if (!t) return res.status(404).json({ error: 'Transferencia no encontrada' });
      if (t.estado !== 'pendiente') {
        return res.status(409).json({ error: `Esta transferencia ya está ${t.estado}` });
      }

      if (accion === 'rechazar') {
        t.estado = 'rechazada';
        t.fechaResolucion = new Date().toISOString();
        await setJSON(`transferencia:${id}`, t, TTL);
        return res.status(200).json({ ok: true, estado: 'rechazada' });
      }

      // ── Confirmar: delegar en registrar-pago ──────────────────
      if (!process.env.INTERNAL_API_SECRET) {
        console.error('[transferencias] falta INTERNAL_API_SECRET');
        return res.status(500).json({ error: 'Servidor sin configurar' });
      }
      const base = process.env.SITE_URL || 'https://mudateya.ar';
      let r, d;
      try {
        r = await fetch(`${base}/api/cotizaciones?action=registrar-pago`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-secret': process.env.INTERNAL_API_SECRET
          },
          body: JSON.stringify({
            mudanzaId:  t.mudanzaId,
            tipoPago:   t.tipoPago,
            metodoPago: 'transferencia'
          })
        });
        d = await r.json().catch(function () { return {}; });
      } catch (e) {
        console.error('[transferencias] registrar-pago:', e.message);
        return res.status(502).json({ error: 'No se pudo registrar el pago' });
      }
      if (!r.ok) {
        return res.status(502).json({ error: (d && d.error) || 'No se pudo registrar el pago' });
      }

      t.estado = 'confirmada';
      t.fechaResolucion = new Date().toISOString();
      await setJSON(`transferencia:${id}`, t, TTL);

      // Dejar marcado en la mudanza cómo se pagó: sirve para conciliar
      // después y para saber qué operaciones no pasaron por Mercado Pago.
      try {
        const m = await getJSON(`mudanza:${t.mudanzaId}`);
        if (m) {
          if (t.tipoPago === 'anticipo') m.metodoPagoAnticipo = 'transferencia';
          if (t.tipoPago === 'saldo')    m.metodoPagoSaldo    = 'transferencia';
          await setJSON(`mudanza:${t.mudanzaId}`, m);
        }
      } catch (e) { console.warn('[transferencias] marcar método:', e.message); }

      return res.status(200).json({ ok: true, estado: 'confirmada' });
    }

    return res.status(405).json({ error: 'Método no permitido' });

  } catch (e) {
    console.error('[transferencias]', e);
    return res.status(500).json({ error: 'Error interno' });
  }
};
