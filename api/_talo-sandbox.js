// api/_talo-sandbox.js
//
// Cliente de Talo EXCLUSIVO del sandbox, para la consola de pruebas (admin-seguridad.html).
// La URL del sandbox está fija en este archivo: aunque TALO_MODO diga "produccion", acá nunca se toca
// la API real ni se mueve plata de verdad. Es independiente de api/_talo.js (que usa Mudanza), así que
// no puede alterarlo ni compartir su token.
//
// Credenciales (en este orden):
//   1. TALO_SANDBOX_USER_ID / TALO_SANDBOX_CLIENT_ID / TALO_SANDBOX_CLIENT_SECRET  (si existen)
//   2. TALO_USER_ID / TALO_CLIENT_ID / TALO_CLIENT_SECRET — SOLO si TALO_MODO no es "produccion"
//      (en ese caso son credenciales de sandbox).
// Si TALO_MODO es "produccion" y no hay credenciales TALO_SANDBOX_*, la consola avisa qué falta.
//
// Expone la misma interfaz que usa api/_hogar-pagos.js (consultarPagoCompleto, reembolsar) para poder
// inyectarlo como `talo`, más crearPago y faucet (simula una transferencia entrante).
//
// Vercel ignora los archivos de /api que empiezan con "_".

const { parsearPagoCompleto } = require('./_talo');

const BASE = 'https://sandbox-api.talo.com.ar'; // fija a propósito
const TIMEOUT_MS = 25000; // el sandbox puede tardar (arranque en frío, token): mejor esperar que cortar

function credenciales(env) {
  env = env || process.env;
  if (env.TALO_SANDBOX_USER_ID && env.TALO_SANDBOX_CLIENT_ID && env.TALO_SANDBOX_CLIENT_SECRET) {
    return { userId: env.TALO_SANDBOX_USER_ID, clientId: env.TALO_SANDBOX_CLIENT_ID, clientSecret: env.TALO_SANDBOX_CLIENT_SECRET, fuente: 'TALO_SANDBOX_*' };
  }
  const prod = String(env.TALO_MODO || '').toLowerCase() === 'produccion';
  if (!prod && env.TALO_USER_ID && env.TALO_CLIENT_ID && env.TALO_CLIENT_SECRET) {
    return { userId: env.TALO_USER_ID, clientId: env.TALO_CLIENT_ID, clientSecret: env.TALO_CLIENT_SECRET, fuente: 'TALO_* (TALO_MODO no es produccion)' };
  }
  return null;
}

function crearTaloSandbox(env) {
  const cred = credenciales(env);
  let tokenCache = null; // { token, hasta }

  function configurado() { return !!cred; }
  function exigir() { if (!cred) throw new Error('Faltan credenciales de sandbox de Talo (TALO_SANDBOX_USER_ID / TALO_SANDBOX_CLIENT_ID / TALO_SANDBOX_CLIENT_SECRET).'); }

  async function token(forzar) {
    exigir();
    if (!forzar && tokenCache && tokenCache.hasta > Date.now()) return tokenCache.token;
    const r = await fetch(BASE + '/users/' + encodeURIComponent(cred.userId) + '/tokens', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: cred.clientId, client_secret: cred.clientSecret }), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const d = await r.json().catch(() => ({}));
    const t = d && d.data && d.data.token;
    if (!r.ok || !t) throw new Error('Talo sandbox: no se pudo obtener token (' + r.status + ')');
    tokenCache = { token: t, hasta: Date.now() + 45 * 60 * 1000 };
    return t;
  }

  async function auth(path, opciones, reintento) {
    const t = await token(!!reintento);
    const r = await fetch(BASE + path, Object.assign({ signal: AbortSignal.timeout(TIMEOUT_MS) }, opciones, { headers: Object.assign({ Authorization: 'Bearer ' + t }, (opciones || {}).headers || {}) }));
    if (r.status === 401 && !reintento) return auth(path, opciones, true);
    return r;
  }

  async function crearPago(o) {
    exigir();
    const body = { user_id: cred.userId, price: { amount: Number(o.monto), currency: 'ARS' }, payment_options: ['transfer'], external_id: o.externalId, motive: o.motivo || 'MudateYa Hogar (prueba)' };
    if (o.webhookUrl) body.webhook_url = o.webhookUrl;
    const r = await fetch(BASE + '/payments/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const d = await r.json().catch(() => ({}));
    const data = d && d.data;
    if (!r.ok || !data || !data.id) throw new Error('Talo sandbox: no se pudo crear el pago (' + r.status + ' ' + ((d && d.message) || '') + ')');
    return parsearPagoCompleto(data, data.id);
  }

  async function consultarPagoCompleto(paymentId) {
    const r = await auth('/payments/' + encodeURIComponent(paymentId), { method: 'GET' });
    const d = await r.json().catch(() => ({}));
    const data = d && d.data;
    if (!r.ok || !data) throw new Error('Talo sandbox: no se pudo consultar el pago (' + r.status + ')');
    return parsearPagoCompleto(data, paymentId);
  }

  async function reembolsar(paymentId, o) {
    const monto = o && o.monto;
    const body = monto == null ? { refund_type: 'FULL' } : { refund_type: 'PARTIAL', amount: String(monto), currency: 'ARS' };
    const r = await auth('/payments/' + encodeURIComponent(paymentId) + '/refunds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (r.status === 409 && d && d.message === 'refund.already.pending') return { ok: true, yaPendiente: true };
    if (!r.ok) throw new Error('Talo sandbox: no se pudo pedir el reembolso (' + r.status + ' ' + ((d && d.message) || '') + ')');
    return { ok: true, yaPendiente: false };
  }

  // Simula que un cliente transfirió `monto` al CVU. Solo existe en el sandbox.
  async function faucet(cvu, monto) {
    const r = await auth('/cvu/' + encodeURIComponent(cvu) + '/faucet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: Number(monto) }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Talo sandbox: el simulador de transferencias falló (' + r.status + ' ' + ((d && d.message) || '') + ')');
    return true;
  }

  return { configurado, fuente: cred ? cred.fuente : null, base: BASE, token, crearPago, consultarPagoCompleto, reembolsar, faucet };
}

module.exports = { crearTaloSandbox, credenciales, BASE };
