// api/_talo.js — Cliente de la API de Talo (transferencias bancarias)
//
// Vercel ignora los archivos de /api que empiezan con "_": no se deploya como función.
//
// QUÉ RESUELVE
//   Talo emite un CVU/alias ÚNICO por pago. Como cada CVU corresponde a una sola
//   operación, cuando entra plata ahí no hay ambigüedad posible sobre a qué
//   mudanza corresponde. Eso es lo que permite confirmar automáticamente y
//   dejar de revisar el extracto a mano.
//
// VARIABLES DE ENTORNO
//   TALO_USER_ID        ID de la cuenta Talo               (obligatoria)
//   TALO_CLIENT_ID      credencial del dashboard           (obligatoria)
//   TALO_CLIENT_SECRET  credencial del dashboard           (obligatoria)
//   TALO_MODO           'sandbox' | 'produccion'  (default: sandbox)
//
//   Arranca en sandbox A PROPÓSITO. Para cobrar de verdad hay que poner
//   TALO_MODO=produccion explícitamente. Nadie mueve plata real por olvido.
//
// NOTA SOBRE MONTOS
//   La documentación de Talo se contradice: en un lugar dice centavos y en otro
//   pesos. Los ejemplos (price.amount 30000 → faucet 30000) indican PESOS y así
//   está implementado. CONFIRMAR EN SANDBOX antes de pasar a producción: si
//   estuviera en centavos, se cobraría 100 veces menos.

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

function esProduccion() {
  return String(process.env.TALO_MODO || '').toLowerCase() === 'produccion';
}

function apiBase() {
  return esProduccion() ? 'https://api.talo.com.ar' : 'https://sandbox-api.talo.com.ar';
}

function taloConfigurado() {
  return !!(process.env.TALO_USER_ID && process.env.TALO_CLIENT_ID && process.env.TALO_CLIENT_SECRET);
}

// ── Token de acceso ───────────────────────────────────────────────
// Es temporal. Se cachea en Redis con TTL conservador (50 min) y se
// renueva solo. Si una llamada devuelve 401 se fuerza la renovación.
const CLAVE_TOKEN = 'talo:token';

async function pedirTokenNuevo() {
  const r = await fetch(`${apiBase()}/users/${encodeURIComponent(process.env.TALO_USER_ID)}/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     process.env.TALO_CLIENT_ID,
      client_secret: process.env.TALO_CLIENT_SECRET
    })
  });
  const d = await r.json().catch(() => ({}));
  const token = d && d.data && d.data.token;
  if (!r.ok || !token) {
    throw new Error('Talo: no se pudo obtener token (' + r.status + ')');
  }
  try { await redisCall('SET', CLAVE_TOKEN, token, 'EX', '3000'); } catch (e) { /* cache opcional */ }
  return token;
}

async function getToken(forzar) {
  if (!forzar) {
    try {
      const cache = await redisCall('GET', CLAVE_TOKEN);
      if (cache) return cache;
    } catch (e) { /* sigue sin cache */ }
  }
  return pedirTokenNuevo();
}

// Llamada autenticada con reintento único ante 401 (token vencido).
async function fetchAuth(path, opciones, reintento) {
  const token = await getToken(!!reintento);
  const r = await fetch(apiBase() + path, Object.assign({}, opciones, {
    headers: Object.assign({ Authorization: 'Bearer ' + token }, (opciones || {}).headers || {})
  }));
  if (r.status === 401 && !reintento) return fetchAuth(path, opciones, true);
  return r;
}

// ── Crear pago ────────────────────────────────────────────────────
// Devuelve { paymentId, cvu, alias, expira, paymentUrl }.
// El CVU vence a los ~5 días; por eso el pago se crea cuando el cliente
// va a pagar, no cuando se acepta la cotización.
async function crearPago(opts) {
  const body = {
    user_id: process.env.TALO_USER_ID,
    price: { amount: Number(opts.monto), currency: 'ARS' },
    payment_options: ['transfer'],
    external_id: opts.externalId,
    webhook_url: opts.webhookUrl,
    motive: opts.motivo || 'MudateYa'
  };
  if (opts.redirectUrl) body.redirect_url = opts.redirectUrl;
  if (opts.cliente) {
    body.client_data = {};
    if (opts.cliente.nombre)   body.client_data.first_name = opts.cliente.nombre;
    if (opts.cliente.apellido) body.client_data.last_name  = opts.cliente.apellido;
    if (opts.cliente.email)    body.client_data.email      = opts.cliente.email;
  }

  // Este endpoint es público: el user_id del body identifica al comercio.
  const r = await fetch(`${apiBase()}/payments/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const d = await r.json().catch(() => ({}));
  const data = d && d.data;
  if (!r.ok || !data || !data.id) {
    throw new Error('Talo: no se pudo crear el pago (' + r.status + ')');
  }
  const q = (data.quotes && data.quotes[0]) || {};
  return {
    paymentId:  data.id,
    // La doc usa `cvu` al crear y `address` al consultar. Se contemplan ambos.
    cvu:        q.cvu || q.address || '',
    alias:      q.alias || '',
    expira:     data.expiration_timestamp || '',
    paymentUrl: data.payment_url || '',
    estado:     data.payment_status || 'PENDING'
  };
}

// ── Consultar pago ────────────────────────────────────────────────
// SIEMPRE se consulta antes de dar un pago por bueno. El webhook de Talo
// todavía no viene firmado (la firma HMAC figura como "pronto" en su doc),
// así que su payload no se puede tratar como fuente de verdad: cualquiera
// que conozca la URL podría postear un aviso falso. La verdad es lo que
// devuelve este GET autenticado.
async function consultarPago(paymentId) {
  const r = await fetchAuth('/payments/' + encodeURIComponent(paymentId), { method: 'GET' });
  const d = await r.json().catch(() => ({}));
  const data = d && d.data;
  if (!r.ok || !data) throw new Error('Talo: no se pudo consultar el pago (' + r.status + ')');

  const q = (data.quotes && data.quotes[0]) || {};
  const tf = data.transaction_fields || {};
  return {
    paymentId:   data.id || paymentId,
    estado:      data.payment_status || '',
    externalId:  data.external_id || '',
    montoPedido: Number((data.price && data.price.amount) || 0),
    montoPagado: Number(tf.amount || tf.amountReadable || 0),
    acreditado:  Number(tf.credited_amount || 0),
    cvu:         q.address || q.cvu || '',
    alias:       q.alias || '',
    expira:      data.expiration_timestamp || (data.user_info || {}).expiration_timestamp || ''
  };
}

module.exports = {
  taloConfigurado: taloConfigurado,
  esProduccion:    esProduccion,
  apiBase:         apiBase,
  crearPago:       crearPago,
  consultarPago:   consultarPago
};
