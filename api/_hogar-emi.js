// api/_hogar-emi.js
//
// Emi para MYA Hogar, en MODO ESTRICTO. Se enchufa en api/whatsapp.js detrás de la bandera HOGAR_EMI_ACTIVO=1
// (apagado por defecto) y NO toca el flujo de Mudanza: si el mensaje no es de Hogar, devuelve null y el flujo de
// siempre sigue igual.
//
// Cómo garantiza "Emi no inventa nada":
//   1. Todo lo que dice sale del catálogo (api/_hogar-emi-catalogo.js). No hay texto generado por un modelo.
//   2. Lo que escribe el cliente se interpreta con REGLAS (palabras clave y opciones numeradas), no con un modelo. Si
//      no se entiende, se repite la pregunta. No se hace eco de texto libre, salvo la dirección ya saneada.
//   3. Guarda de salida que FALLA CERRADO: si una respuesta tuviera una URL, un teléfono, un email, una promesa o un
//      monto fuera de lugar, no sale; se manda un mensaje genérico y se avisa al equipo.
//   4. Emergencias (olor a gas, chispas, humo...): mensaje fijo de seguridad y se corta el pedido.
//   5. Temas prohibidos (precios de trabajos, consejos técnicos/legales/fiscales, promesas, documentos): cada uno con
//      su respuesta fija; no avanzan el pedido.
//
// Estado de la conversación: hogar:conv:{waId} (vence a los 2 días sin actividad). Baja y consentimiento: hogar:optout:* y
// hogar:consent:* (permanentes, con fecha). Al confirmar se crea la solicitud (estado 'datos_completos') y el cliente.
//
// Todo se inyecta (redis, ahora, precios, descargarMedia, guardarFoto) para probarlo sin red.
//
// Vercel ignora los archivos de /api que empiezan con "_".

const crypto = require('crypto');
const { cliente } = require('./_redis');
const datos = require('./_hogar-datos');
const pagos = require('./_hogar-pagos');
const cat = require('./_hogar-emi-catalogo');

const VIGENCIA_ACTIVA_MS = 6 * 60 * 60 * 1000;   // una conversación sin actividad por más de 6 h se da por terminada
const TTL_CONV_SEG = 2 * 24 * 3600;
const ORDEN = ['rubro', 'zona', 'descripcion', 'urgencia', 'direccion', 'modo'];

// ───────────────────────── Interpretación (reglas, sin modelo) ─────────────────────────

function normalizar(s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

const RUBRO_RE = {
  plomeria: [/plomer/, /caneria/, /canilla/, /grifo/, /perdida de agua/, /pierde agua/, /destap/, /cloaca/, /inodoro/, /cisterna/, /pileta/, /bacha/],
  gas: [/gasista/, /\bgas\b/, /calefon/, /estufa/, /garrafa/, /termotanque/],
  electricidad: [/electric/, /\bluz\b/, /tomacorriente/, /enchufe/, /\btermica\b/, /disyuntor/, /tablero/, /\bcable/],
  cerrajeria: [/cerraj/, /cerradura/, /\bllave/, /me quede afuera/, /puerta (trabada|bloqueada)/],
  aire: [/aire acondicionado/, /\bsplit\b/, /\baire\b/],
};
// Para decidir si un mensaje "arranca" Hogar (más estricto: sin palabras que también se usan en una mudanza).
const RUBRO_FUERTE = [/plomer/, /gasista/, /electricist/, /cerrajer/, /aire acondicionado/, /\bsplit\b/, /perdida de agua/, /pierde agua/, /destap/, /canilla/, /tomacorriente/, /\btermica\b/, /me quede afuera/, /mya hogar/];
const MUDANZA_RE = /(mudanza|mudar|mudarme|mudarnos|flete|embalaje|camion|traslado)/;

const LOCALIDADES = {
  san_isidro: ['san isidro', 'martinez', 'acassuso', 'beccar', 'boulogne', 'villa adelina'],
  vicente_lopez: ['vicente lopez', 'vte lopez', 'vicente', 'olivos', 'la lucila', 'florida oeste', 'florida', 'munro', 'villa martelli', 'carapachay'],
};
const FUERA_DE_ZONA = ['caba', 'capital federal', 'palermo', 'belgrano', 'recoleta', 'nunez', 'caballito', 'tigre', 'san fernando', 'pilar', 'san martin', 'tres de febrero', 'moron', 'lanus', 'quilmes', 'la plata', 'escobar', 'nordelta', 'general pacheco', 'don torcuato', 'san miguel', 'jose c paz', 'malvinas', 'villa ballester', 'ramos mejia'];

const EMERGENCIA_RE = [/olor a gas/, /huele a gas/, /(perdida|fuga|escape) de gas/, /pierde gas/, /gas en (toda|el)/, /chispa/, /\bhumo\b/, /incendi/, /\bfuego\b/, /electrocut/, /me dio (la )?(corriente|descarga)/, /descarga electrica/, /cortocircuit/, /monoxido/, /explosi/, /se prendio fuego/, /sale humo/];

const TEMAS = [
  ['no_documentos', /(\bdni\b|documento|\bcuil\b|\bcuit\b|pasaporte|tarjeta de credito|\bcbu\b|contrasena|clave (de|del)|numero de tarjeta)/],
  ['sin_promesas', /(garantiz|me aseguras|me aseguran|promet|vienen hoy|llegan hoy|cuanto tardan|en cuanto tiempo|cuando vienen|seguro (que )?vienen|seguro (que )?llegan|me garantizan)/],
  ['sin_asesoramiento', /(factura|garantia|abogado|denuncia|demanda|impuesto|\biva\b|monotributo|\bley\b|contrato|defensa del consumidor|seguro de|responsabl|como (lo )?(arreglo|reparo|soluciono|hago)|puedo (arreglar|repararlo)|tutorial|paso a paso|que (hago|debo hacer) mientras)/],
  ['sin_precios', /(cuanto (cuesta|sale|cobra|cobran|vale|me sale|me va a salir)|precio|presupuesto|tarifa|\bcosto|es caro|esta caro|\bcaro\b|barato)/],
  ['fuera_de_alcance', /(ignora|olvida (tus|las|todo)|instrucciones|prompt|system|eres un|sos un|chatgpt|openai|anthropic|claude|modelo de lenguaje|actua como|role ?play|jailbreak|que (clima|hora)|chiste|poema|receta)/],
];

const CONTROL = {
  reinicio: /^(menu|reiniciar|reinicio|empezar de nuevo|volver a empezar|cancelar|empezar)$/,
  baja: /(^baja$|^stop$|no me escriban mas|no quiero recibir|dejar de recibir|desuscrib|no me escribas mas)/,
  humano: /(\bhumano\b|persona real|hablar con (alguien|una persona|un humano)|operador|\bagente\b|^persona$)/,
};

function opcion(norm, max) {
  const m = /^\s*(\d)\s*[).,:-]?\s*$/.exec(norm);
  if (m) { const n = Number(m[1]); return n >= 1 && n <= max ? n : null; }
  const palabras = { uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5 };
  return palabras[norm] && palabras[norm] <= max ? palabras[norm] : null;
}

function detectarRubros(norm) {
  return Object.keys(RUBRO_RE).filter((k) => RUBRO_RE[k].some((re) => re.test(norm)));
}

function detectarZona(norm) {
  if (FUERA_DE_ZONA.some((f) => new RegExp('(^|\\W)' + f + '(\\W|$)').test(norm))) return 'fuera';
  for (const k of Object.keys(LOCALIDADES)) if (LOCALIDADES[k].some((l) => new RegExp('(^|\\W)' + l + '(\\W|$)').test(norm))) return k;
  return null;
}

function detectarUrgencia(norm) {
  if (/(urgente|hoy|ahora|ya mismo|cuanto antes|lo antes posible)/.test(norm)) return 'urgente';
  if (/(esta semana|en la semana|estos dias)/.test(norm)) return 'semana';
  if (/(sin apuro|cuando puedan|no corre prisa|no es urgente|tranqui)/.test(norm)) return 'sin_apuro';
  return null;
}

function detectarModo(norm) {
  if (/(contacto|directo|elegir|elijo|quiero ver)/.test(norm)) return 'directo';
  if (/(gestion|coordin|busquen|ustedes|que lo gestione)/.test(norm)) return 'abierto';
  return null;
}

function esMensajeHogar(norm) {
  if (EMERGENCIA_RE.some((re) => re.test(norm))) return true; // una emergencia siempre se atiende, venga de donde venga
  return !MUDANZA_RE.test(norm) && RUBRO_FUERTE.some((re) => re.test(norm));
}

// Saca emails y números largos (teléfonos, documentos) de un texto libre antes de guardarlo.
function limpiarTexto(t, max) {
  return String(t == null ? '' : t)
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[dato oculto]')
    .replace(/\+?\d[\d ()-]{6,}\d/g, '[dato oculto]')
    .replace(/\s+/g, ' ').trim().slice(0, max || 600);
}

// Dirección saneada para mostrar de vuelta: letras, números y puntuación simple; sin teléfonos ni emails.
function limpiarDireccion(t) {
  const s = limpiarTexto(t, 120).replace(/\[dato oculto\]/g, '').replace(/[^\p{L}\d .,#°ºª/-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return s;
}
function direccionValida(s) { return s.length >= 5 && /\p{L}/u.test(s) && /\d{1,5}/.test(s); }
function emailValido(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || '').trim()) && String(e).length <= 120; }

const faltante = (dat) => ORDEN.find((p) => !dat[p]) || null;

// ───────────────────────── Estado ─────────────────────────

const K = {
  conv: (wk) => 'hogar:conv:' + wk,
  optout: (wk) => 'hogar:optout:' + wk,
  consent: (wk) => 'hogar:consent:' + wk,
};
const idWa = (waId) => 'wa' + crypto.createHash('sha1').update(String(waId)).digest('hex').slice(0, 20);

async function estaDeBaja(r, wk) { return !!(await r.getJSON(K.optout(wk))); }

// ───────────────────────── Preguntas de cada paso ─────────────────────────

function preguntaDe(paso, conv, precios) {
  switch (paso) {
    case 'rubro': return [['pedir_rubro']];
    case 'rubro_ambiguo': return [['rubro_ambiguo', { opciones: conv.ambiguos || Object.keys(cat.RUBROS) }]];
    case 'zona': return [['pedir_zona']];
    case 'descripcion': return [['pedir_descripcion']];
    case 'urgencia': return [['pedir_urgencia']];
    case 'direccion': return [['pedir_direccion']];
    case 'modo': return [['pedir_modo', { precios }]];
    case 'confirmar': return [['resumen', { d: conv.datos }]];
    case 'humano_email': return [['humano_pedir_email']];
    default: return [['pedir_rubro']];
  }
}

// ───────────────────────── Salida segura ─────────────────────────

// partes: [[id, vars], ...]. Cada una se verifica; si alguna no pasa, no sale nada de lo previsto.
async function salidaSegura(r, ahora, partes, contexto) {
  const textos = [];
  for (const p of partes) {
    const id = Array.isArray(p) ? p[0] : p;
    const vars = Array.isArray(p) ? p[1] : undefined;
    const t = cat.render(id, vars);
    const v = cat.verificarSalida(t, id);
    if (!v.ok) {
      try { await pagos.encolarEfecto(r, ahora, 'ef:hogaremi:bloqueo:' + ahora.getTime() + ':' + id, { tipo: 'equipo_alerta', motivo: 'hogar_emi_salida_bloqueada', mensaje: id, razon: v.motivo, contexto: contexto || null }); } catch (e) { /* el aviso es secundario */ }
      return { texto: cat.render('error_generico'), bloqueada: true };
    }
    textos.push(t);
  }
  return { texto: textos.join('\n\n'), bloqueada: false };
}

// ───────────────────────── Manejo del mensaje ─────────────────────────

// e: { waId, texto, imagenes: [{url, tipo}], ubicacion }
// d: { redis, ahora, precios, descargarMedia(url) → base64, guardarFoto(base64, clave) → pathname|null }
// Devuelve { respuesta, paso } o null si el mensaje no es de Hogar (el flujo normal de Emi sigue).
async function manejar(e, d) {
  d = d || {};
  const r = d.redis || cliente();
  const ahora = d.ahora || new Date();
  const waId = String(e.waId || '');
  if (!waId) return null;
  const wk = idWa(waId);
  const texto = String(e.texto || '');
  const norm = normalizar(texto);
  const imagenes = e.imagenes || [];

  let conv = await r.getJSON(K.conv(wk));
  const activa = !!conv && conv.paso && conv.paso !== 'completo' && (ahora.getTime() - (conv.ultimo || 0)) < VIGENCIA_ACTIVA_MS;
  if (!activa && !esMensajeHogar(norm)) return null;          // no es Hogar: sigue el flujo de Mudanza

  try {
    return await procesar({ r, ahora, d, wk, waId, texto, norm, imagenes, ubicacion: e.ubicacion || null, conv, activa });
  } catch (err) {
    console.error('Emi Hogar:', err && err.message);
    return { respuesta: cat.render('error_generico'), paso: 'error' };
  }
}

async function procesar(c) {
  const { r, ahora, d, wk, waId, norm } = c;
  const precios = d.precios || await datos.precios({ redis: r }).catch(() => require('./_hogar-reglas').PRECIOS_DEFAULT);
  let conv = c.activa ? c.conv : null;
  const nuevaConv = !conv;
  if (nuevaConv) conv = { paso: 'rubro', datos: { fotos: [] }, noEntendi: 0, log: [], inicio: ahora.toISOString() };
  conv.datos = conv.datos || { fotos: [] };
  conv.datos.fotos = conv.datos.fotos || [];

  // Consentimiento: queda registrado el primer contacto (el cliente nos escribió él: contacto iniciado por el cliente).
  if (await estaDeBaja(r, wk) && nuevaConv) { try { await r.cmd('DEL', K.optout(wk)); } catch (e) { /* si no se puede borrar, sigue de baja */ } }
  try { await r.setJSON(K.consent(wk), { cuando: ahora.toISOString(), version: 'inbound-1', origen: 'cliente_inicio' }, { permanente: true, nx: true }); } catch (e) { /* secundario */ }

  const salir = async (partes, extra) => {
    const s = await salidaSegura(r, ahora, partes, { paso: conv.paso, wk });
    conv.ultimo = ahora.getTime();
    conv.log = (conv.log || []).concat([{ t: ahora.toISOString(), in: c.texto.slice(0, 300), out: partes.map((p) => (Array.isArray(p) ? p[0] : p)), paso: conv.paso }]).slice(-20);
    if (extra && extra.borrar) await r.cmd('DEL', K.conv(wk));
    else await r.setJSON(K.conv(wk), conv, { ttlSeg: TTL_CONV_SEG });
    return { respuesta: s.texto, paso: conv.paso, bloqueada: s.bloqueada };
  };
  const preguntar = (prefijo) => (prefijo || []).concat(preguntaDe(conv.paso, conv, precios));
  const reasignarPaso = () => { const f = faltante(conv.datos); conv.paso = f || 'confirmar'; conv.noEntendi = 0; };

  // 1) EMERGENCIA: mensaje fijo y se corta el pedido.
  if (EMERGENCIA_RE.some((re) => re.test(norm))) {
    conv.paso = 'emergencia';
    return salir(['emergencia'], { borrar: true });
  }

  // 2) CONTROLES
  if (CONTROL.baja.test(norm)) {
    await r.setJSON(K.optout(wk), { cuando: ahora.toISOString() }, { permanente: true });
    return salir(['baja_ok'], { borrar: true });
  }
  if (CONTROL.reinicio.test(norm)) {
    conv = { paso: 'rubro', datos: { fotos: [] }, noEntendi: 0, log: conv.log || [], inicio: ahora.toISOString() };
    return salir(['reinicio'].concat(preguntaDe('rubro', conv, precios)));
  }
  if (conv.paso === 'humano_email') {
    const mail = c.texto.trim();
    if (!emailValido(mail)) return salir(['humano_email_invalido']);
    await pagos.encolarEfecto(r, ahora, 'ef:hogaremi:humano:' + wk + ':' + ahora.getTime(), { tipo: 'equipo_alerta', motivo: 'hogar_cliente_pide_humano', email: mail, pasoAnterior: conv.pasoAnterior || null, datos: { rubro: conv.datos.rubro || null, zona: conv.datos.zona || null } });
    conv.paso = conv.pasoAnterior || 'rubro';
    return salir(['humano_ok'], { borrar: true });
  }
  if (CONTROL.humano.test(norm)) {
    conv.pasoAnterior = conv.paso;
    conv.paso = 'humano_email';
    return salir(['humano_pedir_email']);
  }

  // 3) PRIMER MENSAJE: se aprovecha lo que ya dijo (rubro, zona, urgencia, descripción).
  let bienvenida = false;
  if (nuevaConv) {
    bienvenida = true;
    const rs = detectarRubros(norm);
    if (rs.length === 1) conv.datos.rubro = rs[0]; else if (rs.length > 1) conv.ambiguos = rs;
    const z = detectarZona(norm);
    if (z === 'fuera') return salir(['bienvenida', 'zona_fuera'], { borrar: true });
    if (z) conv.datos.zona = z;
    const u = detectarUrgencia(norm); if (u) conv.datos.urgencia = u;
    const desc = limpiarTexto(c.texto, 600);
    if (desc.length >= 40) conv.datos.descripcion = desc;
    const f = faltante(conv.datos);
    conv.paso = (!conv.datos.rubro && conv.ambiguos) ? 'rubro_ambiguo' : (f || 'confirmar');
  } else if (!norm && (c.imagenes || []).length && !c.ubicacion) {
    // Mensaje con solo fotos: se guardan y se repite la pregunta (no cuenta como "no te entendí").
  } else {
    // 4) TEMAS PROHIBIDOS (salvo cuando el cliente está describiendo el problema con sus palabras)
    const esOpcionPlana = /^\s*\d\s*[).,:-]?\s*$/.test(norm);
    if (!esOpcionPlana && conv.paso !== 'descripcion' && conv.paso !== 'direccion') {
      for (const [id, re] of TEMAS) {
        if (re.test(norm)) return salir(preguntar([id]));
      }
    }
    // 5) AVANCE DEL PASO ACTUAL
    const resultado = avanzar(conv, c, precios);
    if (resultado && resultado.fin) return salir(resultado.partes, { borrar: true });
    if (resultado && resultado.confirmar) return confirmarPedido(c, conv, precios, salir);
    if (resultado && resultado.partes) return salir(resultado.partes);
  }

  // Fotos (en cualquier paso activo, hasta el máximo)
  const avisosFoto = await procesarFotos(c, conv, wk);

  if (bienvenida) {
    return salir(['bienvenida'].concat(avisosFoto, preguntaDe(conv.paso, conv, precios)));
  }
  return salir(avisosFoto.concat(preguntaDe(conv.paso, conv, precios)));
}

// Interpreta la respuesta para el paso actual. Devuelve null si avanzó bien (el llamador pregunta lo que sigue),
// o { partes } con lo que hay que decir si no se entendió / hay que repetir, { fin } o { confirmar }.
function avanzar(conv, c, precios) {
  const { norm } = c;
  const noEntendio = () => {
    conv.noEntendi = (conv.noEntendi || 0) + 1;
    return { partes: ['no_entendi'].concat(conv.noEntendi >= 3 ? ['ayuda_trabado'] : [], preguntaDe(conv.paso, conv, precios)) };
  };
  const ok = () => { const f = faltante(conv.datos); conv.paso = f || 'confirmar'; conv.noEntendi = 0; return null; };

  switch (conv.paso) {
    case 'rubro':
    case 'rubro_ambiguo': {
      const lista = conv.paso === 'rubro_ambiguo' ? (conv.ambiguos || []) : Object.keys(cat.RUBROS);
      const n = opcion(norm, lista.length);
      if (n) { conv.datos.rubro = lista[n - 1]; conv.ambiguos = null; return ok(); }
      const rs = detectarRubros(norm);
      if (rs.length === 1) { conv.datos.rubro = rs[0]; conv.ambiguos = null; return ok(); }
      if (rs.length > 1) { conv.ambiguos = rs; conv.paso = 'rubro_ambiguo'; conv.noEntendi = 0; return { partes: preguntaDe('rubro_ambiguo', conv) }; }
      return noEntendio();
    }
    case 'zona': {
      const n = opcion(norm, 2);
      if (n) { conv.datos.zona = n === 1 ? 'san_isidro' : 'vicente_lopez'; return ok(); }
      const z = detectarZona(norm);
      if (z === 'fuera') return { fin: true, partes: ['zona_fuera'] };
      if (z) { conv.datos.zona = z; return ok(); }
      return noEntendio();
    }
    case 'descripcion': {
      const t = limpiarTexto(c.texto, 600);
      if (t.length >= 10) { conv.datos.descripcion = t; return ok(); }
      if ((c.imagenes || []).length) return null; // mandó solo fotos: se las guarda y se le vuelve a preguntar
      return noEntendio();
    }
    case 'urgencia': {
      const n = opcion(norm, 3);
      const u = n ? ['urgente', 'semana', 'sin_apuro'][n - 1] : detectarUrgencia(norm);
      if (u) { conv.datos.urgencia = u; return ok(); }
      return noEntendio();
    }
    case 'direccion': {
      if (c.ubicacion) { conv.datos.direccion = 'Ubicación compartida'; conv.datos.ubicacion = { lat: c.ubicacion.lat, lng: c.ubicacion.lng }; return ok(); }
      const dir = limpiarDireccion(c.texto);
      if (direccionValida(dir)) { conv.datos.direccion = dir; return ok(); }
      conv.noEntendi = (conv.noEntendi || 0) + 1;
      return { partes: ['direccion_invalida'] };
    }
    case 'modo': {
      const n = opcion(norm, 2);
      const m = n ? (n === 1 ? 'directo' : 'abierto') : detectarModo(norm);
      if (m) { conv.datos.modo = m; return ok(); }
      return noEntendio();
    }
    case 'confirmar': {
      const n = opcion(norm, 2);
      if (n === 1 || /^(si|sii|ok|dale|confirmo|confirmar|listo|correcto)$/.test(norm)) return { confirmar: true };
      if (n === 2 || /^(no|empezar de nuevo|corregir)$/.test(norm)) {
        conv.datos = { fotos: conv.datos.fotos || [] }; conv.paso = 'rubro'; conv.noEntendi = 0;
        return { partes: ['reinicio'].concat(preguntaDe('rubro', conv)) };
      }
      return noEntendio();
    }
    default:
      return noEntendio();
  }
}

async function procesarFotos(c, conv, wk) {
  const avisos = [];
  const { d } = c;
  for (const img of c.imagenes || []) {
    if ((conv.datos.fotos || []).length >= cat.MAX_FOTOS) { avisos.push('foto_limite'); break; }
    let path = null;
    try {
      const b64 = d.descargarMedia ? await d.descargarMedia(img.url) : null;
      const guardar = d.guardarFoto || require('./_hogar-media').guardarFotoPrivada;
      path = b64 ? await guardar(b64, wk) : null;
    } catch (e) { path = null; }
    if (path) { conv.datos.fotos.push(path); avisos.push(['foto_ok', { n: conv.datos.fotos.length }]); }
    else avisos.push('foto_no_guardada');
  }
  return avisos;
}

async function confirmarPedido(c, conv, precios, salir) {
  const { r, ahora, wk, waId } = c;
  const clienteId = wk;
  try { await datos.crear('cliente', clienteId, { wa: waId, origen: 'emi_hogar' }, { redis: r, ahora }); }
  catch (e) { if (!(e instanceof datos.EntidadExistente)) throw e; }
  const id = 'hg' + ahora.getTime().toString(36) + crypto.randomBytes(2).toString('hex');
  const letras = Array.from(crypto.randomBytes(5)).map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[b % 24]).join('');
  const codigo = 'HG-' + letras + String(crypto.randomBytes(1)[0] % 100).padStart(2, '0');
  const dat = conv.datos;
  await datos.crear('solicitud', id, {
    origen: 'emi_hogar', estado: 'datos_completos', codigo, modo: dat.modo, clienteId,
    rubro: dat.rubro, zona: dat.zona, descripcion: dat.descripcion, urgencia: dat.urgencia, direccion: dat.direccion,
    ubicacion: dat.ubicacion || null, fotos: dat.fotos || [], preciosAlCrear: { contactoDirecto: precios.contactoDirecto, gestionAbierto: precios.gestionAbierto },
  }, { redis: r, ahora });
  conv.paso = 'completo'; conv.solicitudId = id;
  return salir([['fin_datos_completos', { codigo }]]);
}

module.exports = {
  manejar, normalizar, esMensajeHogar, detectarRubros, detectarZona, detectarUrgencia, detectarModo,
  limpiarTexto, limpiarDireccion, direccionValida, emailValido, opcion, idWa,
  EMERGENCIA_RE, TEMAS, VIGENCIA_ACTIVA_MS,
};
