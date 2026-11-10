// api/_hogar-emi-catalogo.js
//
// TODO lo que Emi le dice a un cliente de MYA Hogar sale de ESTE catálogo. No hay texto generado por un modelo de
// lenguaje que llegue al cliente: por eso "Emi no inventa nada" es una garantía y no una promesa.
//
// Reglas de contenido (decididas con el dueño del proyecto):
//   - Emi NUNCA pide documentos por el chat, promete trabajos, da consejos técnicos/fiscales/legales ni habla de precios
//     de los trabajos. Solo es asertiva sobre el pedido.
//   - Los únicos montos que aparecen son los de MYA (contacto directo y gestión), y vienen de la configuración de precios
//     (datos.precios()), nunca escritos acá.
//   - No se repite texto libre del cliente (salvo valores ya validados: rubro/zona/urgencia/modo y la dirección saneada).
//
// Cada mensaje es una función (vars) → texto. `render(id, vars)` es la ÚNICA forma de armar una salida.
// Si se cambia un texto, hay que correr tests/hogar-emi.test.js (revisa que ningún mensaje viole las reglas).

const RUBROS = { plomeria: 'Plomería', gas: 'Gas', electricidad: 'Electricidad', cerrajeria: 'Cerrajería', aire: 'Aire acondicionado' };
const ZONAS = { san_isidro: 'San Isidro', vicente_lopez: 'Vicente López' };
const URGENCIAS = { urgente: 'Hoy / urgente', semana: 'Esta semana', sin_apuro: 'Sin apuro' };
const MODOS = { directo: 'Contactos directos', abierto: 'Gestión de MYA' };
const FRANJAS = { manana: 'Mañana (7 a 12)', tarde: 'Tarde (12 a 19)', cualquiera: 'Cualquier horario (7 a 19)' };
const MAX_FOTOS = 6;

const pesos = (n) => '$' + Number(n || 0).toLocaleString('es-AR');
const lista = (items) => items.map((x, i) => (i + 1) + ') ' + x).join('\n');

const CATALOGO = {
  bienvenida: () => '¡Hola! Soy Emi, de MudateYa. Te ayudo a conseguir profesionales para tu hogar en San Isidro y Vicente López: plomería, gas, electricidad, cerrajería y aire acondicionado.\n\nYo solo gestiono el pedido: no doy consejos técnicos, no manejo precios de los trabajos y no puedo asegurar disponibilidad.',
  pedir_rubro: () => '¿Qué necesitás? Respondé con el número:\n' + lista(Object.values(RUBROS)),
  rubro_ambiguo: (v) => 'Puede ser más de un rubro. ¿Cuál necesitás primero? Respondé con el número:\n' + lista(v.opciones.map((k) => RUBROS[k])) + '\n\nDespués podés hacer otro pedido para el otro.',
  pedir_zona: () => '¿En qué zona es? Respondé con el número o el nombre de la localidad:\n1) San Isidro (Martínez, Acassuso, Beccar, Boulogne, Villa Adelina)\n2) Vicente López (Olivos, La Lucila, Florida, Munro, Villa Martelli, Carapachay)',
  zona_fuera: () => 'Por ahora solo trabajamos en San Isidro y Vicente López, así que no puedo gestionar este pedido. Gracias por escribir.',
  pedir_descripcion: () => 'Contame con tus palabras qué pasa. También podés mandar hasta ' + MAX_FOTOS + ' fotos; no muestres tu dirección ni datos personales en ellas.',
  pedir_urgencia: () => '¿Qué tan urgente es? Respondé con el número:\n' + lista(Object.values(URGENCIAS)),
  pedir_direccion: () => '¿Cuál es la dirección exacta (calle y número)? Los profesionales ven solo una zona aproximada hasta que el pedido se paga; la dirección exacta se les da recién ahí.',
  direccion_invalida: () => 'Necesito calle y número (por ejemplo: Libertador 1234). ¿Me la pasás?',
  pedir_modo: (v) => 'Hay dos formas de seguir. Respondé con el número:\n' +
    '1) Contactos directos: ves los profesionales de tu zona y elegís los que quieras. Cuesta ' + pesos(v.precios.contactoDirecto) + ' por cada contacto, se paga una sola vez, y el acuerdo lo hacés vos con cada uno. MYA no garantiza el trabajo.\n' +
    '2) Gestión de MYA: yo busco quién tome tu pedido y coordino. La gestión cuesta ' + pesos(v.precios.gestionAbierto) + ' y se paga cuando un profesional acepta.',
  resumen: (v) => 'Revisemos tu pedido:\n• Rubro: ' + RUBROS[v.d.rubro] + '\n• Zona: ' + ZONAS[v.d.zona] + '\n• Urgencia: ' + URGENCIAS[v.d.urgencia] + '\n• Modo: ' + MODOS[v.d.modo] + '\n• Dirección: ' + v.d.direccion + (v.d.agenda ? '\n• Día y horario: ' + v.d.agenda.txt + ' · ' + FRANJAS[v.d.agenda.franja] : '') + '\n• Fotos: ' + (v.d.fotos || []).length + '\n\n¿Está todo bien? Respondé con el número:\n1) Sí, confirmar\n2) Empezar de nuevo',
  pedir_agenda_dia: () => '¿Qué día te queda bien para que vaya el profesional? Escribilo así: "hoy", "mañana", "jueves" o "15/11" (hasta 14 días desde hoy).',
  agenda_dia_invalido: () => 'No pude entender ese día, o ya pasó. Escribilo así: "hoy", "mañana", "jueves" o "15/11" (hasta 14 días desde hoy).',
  agenda_hoy_cerrado: () => 'Hoy ya no quedan horarios (los profesionales atienden de 7 a 19). ¿Para qué otro día?',
  pedir_agenda_franja: (v) => '¿En qué horario? (' + v.dia + ') Respondé con el número:\n' + lista(Object.values(FRANJAS)),
  agenda_franja_pasada: () => 'Esa franja ya pasó para hoy. Elegí otra.',
  // PLACEHOLDER hasta conectar profesionales y cobro: no promete nada.
  fin_datos_completos: (v) => 'Listo, registré tu pedido (n° ' + v.codigo + '). Por ahora quedó registrado y no puedo asegurarte plazos ni disponibilidad.\n\nSi necesitás otro rubro, escribime "menu" y hacemos otro pedido.',
  foto_ok: (v) => 'Recibí tu foto (' + v.n + '/' + MAX_FOTOS + ').',
  foto_limite: () => 'Ya tengo el máximo de fotos (' + MAX_FOTOS + ').',
  foto_no_guardada: () => 'No pude guardar esa foto. ¿Probás mandarla de nuevo?',
  foto_fuera_de_paso: () => 'Las fotos las recibo cuando te pregunto qué pasa.',
  emergencia: () => '⚠️ Por lo que contás puede ser una emergencia. Salí del lugar y llamá al 911 (o a Bomberos, 100). No sigo con el pedido por ahora. Cuando estés a salvo, escribime de nuevo.',
  sin_precios: () => 'Los precios los acuerdan directamente con cada profesional; yo no los manejo ni puedo estimarlos.',
  sin_asesoramiento: () => 'No puedo dar consejos técnicos, legales ni fiscales. Solo gestiono tu pedido.',
  sin_promesas: () => 'No puedo asegurar disponibilidad, plazos ni resultados.',
  no_documentos: () => 'Por seguridad, no pidas ni mandes documentos ni datos personales por acá.',
  fuera_de_alcance: () => 'Eso no lo puedo resolver por acá: solo gestiono pedidos de plomería, gas, electricidad, cerrajería y aire acondicionado.',
  no_entendi: () => 'No te entendí.',
  ayuda_trabado: () => 'Si preferís, escribí "persona" para que te responda el equipo, o "menu" para empezar de nuevo.',
  reinicio: () => 'Listo, empezamos de nuevo.',
  baja_ok: () => 'Listo, no te escribo más. Si necesitás algo, escribime cuando quieras.',
  humano_pedir_email: () => 'Para que alguien del equipo te responda, ¿me pasás tu email?',
  humano_email_invalido: () => 'Ese email no parece válido. ¿Me lo pasás de nuevo?',
  humano_ok: () => 'Listo, le pasé tu consulta al equipo. Te van a responder por email.',
  error_generico: () => 'Tuve un problema técnico. Probá de nuevo en un momento.',
};

function render(id, vars) {
  const f = CATALOGO[id];
  if (!f) throw new Error('Mensaje inexistente en el catálogo: ' + id);
  return f(vars || {});
}

// Une varios mensajes del catálogo en una sola respuesta. partes: [[id, vars], ...] o ids sueltos.
function armar(partes) {
  return partes.map((p) => (Array.isArray(p) ? render(p[0], p[1]) : render(p))).join('\n\n');
}

// Cualquier texto con estas características NO puede salir de Emi Hogar (guarda de salida, falla cerrado).
// Los montos de MYA solo se permiten en el mensaje del modo (pedir_modo), que los trae de la configuración.
const PROHIBIDO = [
  { re: /https?:\/\/|www\./i, motivo: 'url' },
  { re: /\b\d[\d .-]{7,}\d\b/, motivo: 'numero_largo' },            // teléfonos/documentos (los códigos de pedido llevan prefijo y son cortos)
  { re: /[\w.+-]+@[\w-]+\.[\w.]+/, motivo: 'email' },
  // Promesas en positivo. "MYA no garantiza el trabajo" (negación) es un mensaje legítimo del catálogo.
  { re: /(?<!no )(te |lo |les )?(garantiz[oa]|garantizamos|garantizado)|te aseguro|aseguramos|prometo|prometemos|sin falta|seguro que (viene|llega)|va a llegar|llega(rá)? hoy/i, motivo: 'promesa' },
  { re: /\b(dni|cuil|cuit|cbu|contraseña|clave)\b/i, motivo: 'pide_documento' },
];

// Devuelve { ok: true } o { ok: false, motivo }. `id` permite el monto solo en el mensaje del modo.
function verificarSalida(texto, id) {
  if (typeof texto !== 'string' || !texto.trim()) return { ok: false, motivo: 'vacio' };
  if (texto.length > 1500) return { ok: false, motivo: 'largo' };
  for (const p of PROHIBIDO) if (p.re.test(texto)) return { ok: false, motivo: p.motivo };
  if (id !== 'pedir_modo' && id !== 'resumen' && /\$\s?\d/.test(texto)) return { ok: false, motivo: 'monto_fuera_de_lugar' };
  return { ok: true };
}

module.exports = { CATALOGO, RUBROS, ZONAS, URGENCIAS, MODOS, FRANJAS, MAX_FOTOS, render, armar, verificarSalida, PROHIBIDO };
