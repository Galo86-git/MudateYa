// api/admin-ver-conversacion.js
//
// SOLO LECTURA — diagnóstico para investigar respuestas raras de Emi o
// posibles confusiones de identidad. Lee tal cual la conversación de
// WhatsApp que Emi tiene guardada en Redis (últimos 20 mensajes, mismo
// historial que ella usa para responder) y, si es mudancero, resuelve
// también su perfil (nombre/email) por el índice de teléfono.
//
// GET ?telefono=NUMERO&token=ADMIN_TOKEN[&rol=mud|ase|inmo|cliente]
//   telefono: cualquier formato (con o sin +54/9, espacios, guiones) — se
//             matchea por los últimos 8 dígitos, igual que el resto del
//             sistema (mudanceros:tel8-idx, ver whatsapp.js).
//   rol: default 'mud'. Define el prefijo de la clave de conversación
//        (wa:conv:mud:/ase:/inmo:/ sin prefijo para cliente) — exactamente
//        el mismo armado que generarRespuesta() en whatsapp.js.
//
// No hay forma de listar "todas las conversaciones de hoy": Redis no guarda
// timestamp por mensaje ni un índice por fecha. Este endpoint busca UNA
// conversación puntual a partir de un teléfono.

async function redisCall(method, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  const r = await fetch(`${url}/${[method, ...args].map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}
async function getJSON(key) {
  const v = await redisCall('GET', key);
  if (!v) return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}
function clave8(tel) {
  return String(tel || '').replace(/\D/g, '').slice(-8);
}

const PREFIJOS_ROL = { mud: 'mud:', ase: 'ase:', inmo: 'inmo:', cliente: '' };
const IDX_ROL = { mud: 'mudanceros:tel8-idx', ase: 'asesorescanal:tel8-idx', inmo: 'inmocontacto:tel8-idx' };

module.exports = async function handler(req, res) {
  if (!require('./_auth').esAdmin(req)) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const telRaw = (req.query && req.query.telefono) || '';
  let rol = (req.query && req.query.rol) || 'mud';
  if (!Object.prototype.hasOwnProperty.call(PREFIJOS_ROL, rol)) rol = 'mud';

  const digitos = String(telRaw).replace(/\D/g, '');
  if (digitos.length < 8) {
    return res.status(400).json({ error: 'Pasá un teléfono válido en ?telefono=' });
  }
  const t8 = clave8(digitos);
  const ult10 = digitos.slice(-10);

  try {
    // ── Identidad: mismo índice tel8 que usa el bot para reconocer quién escribe ──
    let identidad = null;
    if (rol === 'mud') {
      const email = await redisCall('HGET', IDX_ROL.mud, t8);
      if (email) identidad = await getJSON(`mudancero:perfil:${email}`);
    } else if (IDX_ROL[rol]) {
      const val = await redisCall('HGET', IDX_ROL[rol], t8);
      if (val) identidad = { indice: val };
    }

    // ── Candidatos de waId, en el formato real que arma Twilio para AR (+549…) ──
    let candidatos = [];
    if (ult10.length === 10) candidatos.push(`+549${ult10}`, `+54${ult10}`);
    candidatos.push(`+${digitos}`, digitos);
    candidatos = candidatos.filter((v, i) => candidatos.indexOf(v) === i);

    const prefijo = PREFIJOS_ROL[rol];
    let conversacion = null;
    for (const cand of candidatos) {
      const key = `wa:conv:${prefijo}${cand}`;
      const conv = await getJSON(key);
      if (conv && conv.messages && conv.messages.length) {
        conversacion = { waId: cand, key, mensajes: conv.messages };
        break;
      }
    }

    return res.status(200).json({
      ok: true,
      telefonoBuscado: telRaw,
      ultimos8Digitos: t8,
      identidad,
      candidatosProbados: candidatos.map((c) => `wa:conv:${prefijo}${c}`),
      conversacion,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
