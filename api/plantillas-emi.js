// api/plantillas-emi.js
// Actualiza las plantillas de WhatsApp desde el servidor (usa las credenciales
// de Twilio que ya están en Vercel — nunca salen de ahí). Admin-only.
//
//   GET  /api/plantillas-emi            -> PREVIEW (dry-run): lee las 6 existentes,
//                                          reporta estructura/variables y si el body
//                                          Emi encaja. Lista las 5 nuevas a crear. NO toca nada.
//   POST /api/plantillas-emi  {apply:true}
//                                       -> APLICA: actualiza las 6 a voz Emi (crea versión
//                                          nueva + borra vieja + manda a revisión) SOLO si las
//                                          variables calzan, y crea las 5 nuevas.
//
// Las plantillas Content de Twilio son inmutables: por eso se recrea y reenvía a Meta.

var { esAdmin } = require('./_auth');

const BASE = 'https://content.twilio.com/v1/Content';

function auth() {
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok) return null;
  return 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64');
}
async function tw(method, url, body, AUTH) {
  const r = await fetch(url, {
    method, headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let d; try { d = t ? JSON.parse(t) : {}; } catch { d = { raw: t }; }
  return { ok: r.ok, status: r.status, d };
}
function findBodyType(types) {
  for (const k of Object.keys(types || {})) if (types[k] && typeof types[k].body === 'string') return k;
  return null;
}
function varsIn(body) {
  return [...new Set((String(body).match(/\{\{\s*\d+\s*\}\}/g) || []).map((s) => s.replace(/\D/g, '')))];
}

// ── Las 6 existentes: SOLO cambia el body a voz Emi (se preservan botones/variables) ──
const ACTUALIZAR = [
  { name: 'nuevo_pedido_mudancero', sid: 'HX5f39381013f9e1880d6f69afc7fe3b79', category: 'UTILITY',
    body: 'Hola {{1}}, tenés un pedido nuevo para cotizar en MudateYa.\n\nMudanza: {{2}} → {{3}}\nFecha: {{4}}\n\nRespondé este WhatsApp con tu presupuesto para participar. El pedido queda abierto 24 hs.' },
  { name: 'recordatorio_pedido_incompleto', sid: 'HX2ebc4cb3b32221059b9d013a212bbbda', category: 'MARKETING',
    body: 'Hola {{1}}, quedó a medias tu pedido de mudanza en MudateYa. ¿Lo retomamos? Respondé este mensaje y en un minuto te consigo los presupuestos.' },
  { name: 'mudancero_elegido', sid: 'HX4b32834b2e7a07da7b5ac52dc8bdc853', category: 'UTILITY',
    body: '¡Te eligieron, {{1}}! 🙌 El cliente reservó tu presupuesto y pagó la seña.\n\nMudanza: {{2}} → {{3}}\nFecha: {{4}}\nContacto: {{5}} — {{6}}\n\nCoordiná directo con el cliente. ¡Éxitos!' },
  { name: 'pago_confirmado_cliente', sid: 'HX5e31109f51010ea07751dd13e98258d2', category: 'UTILITY',
    body: '¡Listo, {{1}}! Recibimos tu seña ✅\nTu mudancero {{2}} quedó confirmado para el {{3}}. Te va a escribir para coordinar los detalles.' },
  { name: 'link_pago_sena', sid: 'HX93c65be02436ce3f138bee796768cd02', category: 'UTILITY',
    body: '¡Buenísimo, {{1}}! Reservaste con {{2}} por {{3}}.\nPara confirmar, pagá la seña de {{4}} desde el botón de abajo (o por transferencia si preferís, pedímela). El resto lo abonás al terminar. Pago protegido.' },
  { name: 'presupuestos_cliente', sid: 'HXa307fb50a1ae96e0eb4535792ee40ea3', category: 'UTILITY',
    body: '¡Hola {{1}}! Ya tenemos presupuestos para tu mudanza ({{2}} → {{3}}).\nTe los paso acá abajo para que elijas el que más te convenga. Cada presupuesto vale 7 días.' },
  // Meta la reclasificó sola de UTILITY a MARKETING apenas se creó (mismo
  // problema que ya tuvo nuevo_pedido_mudancero) -- sospecha: "antes de que
  // se los lleve otro mudancero" suena a apuro/venta. Texto más neutro/
  // informativo acá, recreada para que Meta la vuelva a evaluar como UTILITY.
  { name: 'recordatorio_pedido_sin_cotizar', sid: 'HX4257153b4001300b86b15413fc851e78', category: 'UTILITY',
    body: 'Hola {{1}}, tenés {{2}} pedido(s) sin cotizar en MudateYa. Entrá a tu cuenta para verlos y mandar tu presupuesto.' },
];

// ── Las 5 nuevas: se crean con estructura completa (body + botón de pago si aplica) ──
const CREAR = [
  { name: 'mudanza_completada_saldo', category: 'UTILITY',
    types: { 'twilio/call-to-action': {
      body: '¡Hola {{1}}! Tu {{2}} ({{3}} → {{4}}) se completó ✅\n\nQueda el saldo final: ${{5}}. Pagalo desde el botón para cerrar el trabajo. ¡Gracias por elegir MudateYa!',
      actions: [{ type: 'URL', title: 'Pagar saldo', url: 'https://mudateya.ar/pagar/{{6}}' }],
    } },
    variables: { '1': 'Juan', '2': 'mudanza', '3': 'Palermo', '4': 'Tigre', '5': '25.000', '6': 'MYA-123' } },
  { name: 'mudanza_iniciada', category: 'UTILITY',
    types: { 'twilio/text': { body: '¡Hola {{1}}! Tu {{2}} ({{3}} → {{4}}) ya arrancó 🚚\n\n{{5}} está en camino. Cualquier cosa, respondé este mensaje.' } },
    variables: { '1': 'Juan', '2': 'mudanza', '3': 'Palermo', '4': 'Tigre', '5': 'Cristian' } },
  { name: 'invitacion_calificar', category: 'UTILITY',
    types: { 'twilio/text': { body: '¡Hola {{1}}! Esperamos que tu {{2}} con {{3}} haya salido genial.\n\n¿Nos dejás una calificación del 1 al 5? Respondé este mensaje con las estrellas (y un comentario si querés). ¡Gracias!' } },
    variables: { '1': 'Juan', '2': 'mudanza', '3': 'Cristian' } },
  { name: 'ajuste_precio_propuesto', category: 'UTILITY',
    types: { 'twilio/text': { body: 'Hola {{1}}, {{2}} propuso ajustar el precio de tu {{3}} a ${{4}}.\n\nMotivo: {{5}}\n\nRespondé este mensaje para aceptarlo o rechazarlo. Si rechazás, se cancela y te devolvemos la seña.' } },
    variables: { '1': 'Juan', '2': 'Cristian', '3': 'mudanza', '4': '120.000', '5': 'piso sin ascensor' } },
  { name: 'transferencia_diferencia', category: 'UTILITY',
    types: { 'twilio/text': { body: 'Hola {{1}}, recibimos tu transferencia para {{2}}, pero fue por un monto menor al indicado (faltan ${{3}}).\n\nTransferí la diferencia al mismo alias/CVU, o respondé este mensaje y lo resolvemos juntos. 🙏' } },
    variables: { '1': 'Juan', '2': 'la seña', '3': '5.000' } },
  { name: 'recordatorio_pago_pendiente', category: 'UTILITY',
    types: { 'twilio/call-to-action': {
      body: '¡Hola {{1}}! Reservaste {{2}} con {{3}}, pero todavía queda pendiente el pago de {{4}}.\n\nPagalo desde el botón para confirmar. ¡Te esperamos!',
      actions: [{ type: 'URL', title: 'Pagar ahora', url: 'https://mudateya.ar/pagar/{{5}}' }],
    } },
    variables: { '1': 'Juan', '2': 'tu mudanza', '3': 'Cristian', '4': 'la seña ($25.000)', '5': 'MYA-123' } },

  // ── Tanda de automatizaciones (nurturing, cierre, onboarding) ──
  { name: 'presupuestos_esperando', category: 'UTILITY',
    types: { 'twilio/text': { body: '¡Hola {{1}}! Tenés {{2}} presupuesto(s) para {{3}} desde {{4}} esperando que elijas.\n\n¿Te ayudo a decidir? Respondé este mensaje y lo vemos juntos. 😊' } },
    variables: { '1': 'Juan', '2': '3', '3': 'tu mudanza', '4': '$80.000' } },
  { name: 'pedido_vencido_con_presupuestos', category: 'MARKETING',
    types: { 'twilio/text': { body: '¡Hola {{1}}! Recibiste {{2}} presupuesto(s) para {{3}}, pero venció el plazo para elegir. ¿Querés que lo reactivemos? Respondé este mensaje y seguimos. 🚚' } },
    variables: { '1': 'Juan', '2': '3', '3': 'tu mudanza' } },
  { name: 'pedido_vencido_sin_presupuestos', category: 'MARKETING',
    types: { 'twilio/text': { body: '¡Hola {{1}}! No llegamos a conseguirte un mudancero para {{2}} a tiempo. ¿Reintentamos con un poco más de anticipación? Respondé este mensaje y lo republicamos. 🙌' } },
    variables: { '1': 'Juan', '2': 'tu mudanza' } },
  { name: 'onboarding_mudancero', category: 'MARKETING',
    types: { 'twilio/call-to-action': {
      body: '¡Hola {{1}}! Soy Emi de MudateYa. {{2}}.\n\nCompletá tu perfil (vehículo, precios, fotos y datos de cobro) desde el botón y empezá a recibir pedidos. 🚚',
      actions: [{ type: 'URL', title: 'Completar mi perfil', url: 'https://mudateya.ar/mi-cuenta' }],
    } },
    variables: { '1': 'Cristian', '2': 'te falta un pasito para activar tu cuenta' } },

  // Confirmación al cliente apenas publica el pedido por la WEB (no existía
  // ninguna plantilla para esto — las demás cubren etapas posteriores). Al
  // ser la PRIMERA plantilla que le llega, además "abre" la conversación de
  // WhatsApp con él, así los avisos siguientes (presupuestos, pagos) le
  // pueden llegar dentro de la ventana de 24hs sin fricción.
  { name: 'pedido_recibido_cliente', category: 'UTILITY',
    types: { 'twilio/text': { body: '¡Hola {{1}}! Recibimos tu pedido de {{2}} ({{3}} → {{4}}) en MudateYa.\n\nYa estamos consiguiéndote presupuestos de mudanceros/fleteros verificados — te aviso por acá apenas lleguen. 🚚' } },
    variables: { '1': 'Juan', '2': 'mudanza', '3': 'Palermo', '4': 'Tigre' } },

  // Confirmación al cliente cuando ACEPTA el ajuste de precio propuesto por el
  // mudancero (hoy solo mandaba email — ver ajuste_precio_propuesto arriba,
  // que es la propuesta; esta es la confirmación posterior).
  { name: 'ajuste_aceptado_cliente', category: 'UTILITY',
    types: { 'twilio/text': { body: '¡Hola {{1}}! Confirmamos el nuevo precio de tu {{2}} con {{3}}: ${{4}}.\n\nTe queda un saldo de ${{5}} a pagar cuando se complete el trabajo. ¡Gracias!' } },
    variables: { '1': 'Juan', '2': 'mudanza', '3': 'Cristian', '4': '150.000', '5': '30.000' } },

  // Confirmación al cliente cuando se cancela la mudanza (por rechazo de un
  // ajuste de precio) + estado del reintegro de la seña. Hoy solo mandaba email.
  { name: 'mudanza_cancelada_cliente', category: 'UTILITY',
    types: { 'twilio/text': { body: '¡Hola {{1}}! Cancelamos tu {{2}} con {{3}} como solicitaste.\n\n{{4}}\n\n¿Necesitás una nueva mudanza? Entrá a mudateya.ar cuando quieras.' } },
    variables: { '1': 'Juan', '2': 'mudanza', '3': 'Cristian', '4': 'Procesamos el reintegro de $25.000. Vas a verlo acreditado en 5 a 10 días hábiles.' } },

  // Cuando un mudancero cotiza pidiendo un relevamiento/visita presencial para
  // dar el precio final. Le sugerimos al cliente mandar fotos por acá como
  // alternativa, para no perder el pedido por la fricción de coordinar una visita.
  { name: 'sugerencia_fotos_relevamiento', category: 'UTILITY',
    types: { 'twilio/text': { body: '¡Hola {{1}}! {{2}} te cotizó tu {{3}}, pero pidió visitarte para confirmar el precio final.\n\nSi querés evitarte la visita, respondeme por acá con fotos de lo que hay que mudar o contame más detalles por escrito — se los paso al mudancero para que ajuste el precio sin necesidad de ir. 📷' } },
    variables: { '1': 'Juan', '2': 'Cristian', '3': 'mudanza' } },

  // Aviso al MUDANCERO cuando el cliente le manda fotos o más detalle en vez
  // de la visita que pidió (contraparte de sugerencia_fotos_relevamiento).
  { name: 'fotos_relevamiento_mudancero', category: 'UTILITY',
    types: { 'twilio/text': { body: '¡Hola {{1}}! El cliente del pedido {{2}} ({{3}} → {{4}}) te mandó {{5}} en vez de la visita — entrá a tu cuenta para verlo y ajustar el precio si hace falta.' } },
    variables: { '1': 'Cristian', '2': 'MYA-123', '3': 'Palermo', '4': 'Tigre', '5': 'fotos' } },

  // Aviso al mudancero NO elegido cuando el cliente acepta otra propuesta.
  // Antes solo mandaba email (notificarMudancerosNoElegidos en cotizaciones.js)
  // — mismo texto, ahora también por WhatsApp.
  { name: 'mudancero_no_elegido', category: 'UTILITY',
    types: { 'twilio/text': { body: 'Hola {{1}}, el cliente ya eligió otra propuesta para el pedido {{2}}. Este pedido pasó a tu sección Expirados. ¡Gracias por cotizar, seguí atento que vienen más! 🚚' } },
    variables: { '1': 'Cristian', '2': 'Palermo → Tigre' } },

];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://mudateya.ar');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });

  const AUTH = auth();
  if (!AUTH) return res.status(200).json({ error: 'Faltan TWILIO_ACCOUNT_SID / AUTH_TOKEN en Vercel' });

  const apply = req.method === 'POST' && req.body && req.body.apply === true;
  const reporte = { modo: apply ? 'aplicar' : 'preview', actualizar: [], crear: [] };

  // Idempotencia: nombres ya existentes en la cuenta (para no duplicar al re-correr).
  const existentes = new Set();
  try {
    const all = await tw('GET', 'https://content.twilio.com/v1/ContentAndApprovals?PageSize=100', null, AUTH);
    ((all.d && all.d.contents) || []).forEach((c) => existentes.add(c.friendly_name));
  } catch (_) {}

  // ── ACTUALIZAR las 6 ──
  for (const t of ACTUALIZAR) {
    const got = await tw('GET', `${BASE}/${t.sid}`, null, AUTH);
    if (!got.ok) {
      // El SID viejo ya no existe: si el nombre ya está en la cuenta, se actualizó antes.
      reporte.actualizar.push({ name: t.name, accion: existentes.has(t.name) ? 'ya_actualizada' : 'SID_viejo_no_existe' });
      continue;
    }
    const orig = got.d;
    const typeKey = findBodyType(orig.types);
    const origVars = Object.keys(orig.variables || {});
    const need = varsIn(t.body);
    const faltan = need.filter((n) => !origVars.includes(n));
    const item = { name: t.name, typeKey, variablesOriginales: origVars, variablesNuevas: need };
    if (faltan.length) {
      item.accion = 'SALTEADA'; item.motivo = `el body nuevo usa {{${faltan.join('}}, {{')}}} que la original no tiene — revisar mapeo`;
      reporte.actualizar.push(item); continue;
    }
    if (!apply) { item.accion = 'se_actualizaria'; reporte.actualizar.push(item); continue; }
    // Crear versión nueva preservando estructura, cambiando solo el body.
    const newTypes = JSON.parse(JSON.stringify(orig.types));
    newTypes[typeKey].body = t.body;
    const created = await tw('POST', BASE, { friendly_name: t.name, language: orig.language || 'es', variables: orig.variables || {}, types: newTypes }, AUTH);
    if (!created.ok) { item.accion = 'ERROR_crear'; item.detalle = created.d; reporte.actualizar.push(item); continue; }
    item.nuevoSid = created.d.sid;
    await tw('DELETE', `${BASE}/${t.sid}`, null, AUTH);
    const appr = await tw('POST', `${BASE}/${created.d.sid}/ApprovalRequests/whatsapp`, { name: t.name, category: t.category }, AUTH);
    item.accion = appr.ok ? 'actualizada_y_enviada' : 'creada_pero_no_enviada';
    if (!appr.ok) item.aprobacion = appr.d;
    reporte.actualizar.push(item);
  }

  // ── CREAR las 5 nuevas ──
  for (const t of CREAR) {
    const item = { name: t.name };
    if (existentes.has(t.name)) { item.accion = 'ya_existe'; reporte.crear.push(item); continue; }
    if (!apply) { item.accion = 'se_crearia'; reporte.crear.push(item); continue; }
    const created = await tw('POST', BASE, { friendly_name: t.name, language: 'es', variables: t.variables, types: t.types }, AUTH);
    if (!created.ok) { item.accion = 'ERROR_crear'; item.detalle = created.d; reporte.crear.push(item); continue; }
    item.sid = created.d.sid;
    const appr = await tw('POST', `${BASE}/${created.d.sid}/ApprovalRequests/whatsapp`, { name: t.name, category: t.category }, AUTH);
    item.accion = appr.ok ? 'creada_y_enviada' : 'creada_pero_no_enviada';
    if (!appr.ok) item.aprobacion = appr.d;
    reporte.crear.push(item);
  }

  return res.status(200).json(reporte);
};

// ── Reutilizable por el cron (cron-plantillas.js): crea las plantillas del array
// CREAR que todavía no existan en la cuenta y las manda a aprobación de Meta.
// Idempotente: las que ya existen se saltean. Así las plantillas nuevas se crean
// solas, sin tener que tocar el botón del admin.
async function crearFaltantes() {
  const AUTH = auth();
  if (!AUTH) return { error: 'sin credenciales Twilio', creadas: [] };
  const existentes = new Set();
  try {
    const all = await tw('GET', 'https://content.twilio.com/v1/ContentAndApprovals?PageSize=100', null, AUTH);
    ((all.d && all.d.contents) || []).forEach((c) => existentes.add(c.friendly_name));
  } catch (_) {}
  const creadas = [];
  for (const t of CREAR) {
    if (existentes.has(t.name)) continue;
    const created = await tw('POST', BASE, { friendly_name: t.name, language: 'es', variables: t.variables, types: t.types }, AUTH);
    if (!created.ok) { creadas.push({ name: t.name, accion: 'ERROR_crear', detalle: created.d }); continue; }
    const appr = await tw('POST', `${BASE}/${created.d.sid}/ApprovalRequests/whatsapp`, { name: t.name, category: t.category }, AUTH);
    creadas.push({ name: t.name, sid: created.d.sid, accion: appr.ok ? 'creada_y_enviada' : 'creada_pero_no_enviada' });
  }
  return { creadas };
}
module.exports.crearFaltantes = crearFaltantes;

// ── Reutilizable por el cron: aplica cambios de texto del array ACTUALIZAR sobre
// las plantillas que YA existen, cuando el body en código difiere del que está
// vivo en Twilio. Busca el SID ACTUAL por nombre (no el hardcodeado en el array,
// que queda viejo apenas se actualiza una vez) — así funciona bien en corridas
// sucesivas. Solo aplica si las variables ({{1}}, {{2}}...) calzan (misma
// salvaguarda que el flujo manual); si no calzan, se saltea para revisar a mano.
// Idempotente: si el body ya está al día, no hace nada.
async function actualizarCambiadas() {
  const AUTH = auth();
  if (!AUTH) return { error: 'sin credenciales Twilio', actualizadas: [] };
  const porNombre = new Map();
  try {
    const all = await tw('GET', 'https://content.twilio.com/v1/ContentAndApprovals?PageSize=100', null, AUTH);
    ((all.d && all.d.contents) || []).forEach((c) => porNombre.set(c.friendly_name, c.sid));
  } catch (_) {}

  const actualizadas = [];
  for (const t of ACTUALIZAR) {
    const sidActual = porNombre.get(t.name);
    if (!sidActual) continue; // no existe todavía (raro para este array; se salta)

    const got = await tw('GET', `${BASE}/${sidActual}`, null, AUTH);
    if (!got.ok) continue;
    const orig = got.d;
    const typeKey = findBodyType(orig.types);
    if (!typeKey || orig.types[typeKey].body === t.body) continue; // ya está al día

    const origVars = Object.keys(orig.variables || {});
    const need = varsIn(t.body);
    const faltan = need.filter((n) => !origVars.includes(n));
    if (faltan.length) {
      actualizadas.push({ name: t.name, accion: 'SALTEADA', motivo: `usa {{${faltan.join('}}, {{')}}} que la plantilla no tiene` });
      continue;
    }

    const newTypes = JSON.parse(JSON.stringify(orig.types));
    newTypes[typeKey].body = t.body;
    const created = await tw('POST', BASE, { friendly_name: t.name, language: orig.language || 'es', variables: orig.variables || {}, types: newTypes }, AUTH);
    if (!created.ok) { actualizadas.push({ name: t.name, accion: 'ERROR_crear', detalle: created.d }); continue; }
    await tw('DELETE', `${BASE}/${sidActual}`, null, AUTH);
    const appr = await tw('POST', `${BASE}/${created.d.sid}/ApprovalRequests/whatsapp`, { name: t.name, category: t.category }, AUTH);
    actualizadas.push({ name: t.name, sid: created.d.sid, accion: appr.ok ? 'actualizada_y_enviada' : 'creada_pero_no_enviada' });
  }
  return { actualizadas };
}
module.exports.actualizarCambiadas = actualizarCambiadas;
