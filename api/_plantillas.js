// api/_plantillas.js — Envío de plantillas de WhatsApp resolviendo el ContentSid
// AUTOMÁTICAMENTE por nombre (sin env vars manuales).
//
// El registro nombre→{sid,status} lo mantiene cron-plantillas (3x/día, consulta
// Twilio). enviarPlantilla() usa la plantilla apenas Meta la aprueba; mientras
// tanto (o si no existe) cae al texto libre (que solo llega dentro de la ventana 24h).
//
// Vercel ignora los archivos de /api que empiezan con "_".

const { enviarWhatsApp, enviarWhatsAppTexto } = require('./_whatsapp');

async function redisGet(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/GET/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
  const d = await r.json();
  return d.result || null;
}

// Devuelve { sid, status } de una plantilla por nombre (del registro cacheado).
async function resolver(nombre) {
  try {
    const raw = await redisGet('plantillas:registro');
    const reg = raw ? JSON.parse(raw) : null;
    return (reg && reg[nombre]) || null;
  } catch (e) { return null; }
}

// Envía una plantilla si está APROBADA; si no (pendiente/rechazada/inexistente),
// manda `textoLibre` como texto libre (llega solo dentro de la ventana 24h).
//   to         teléfono destino
//   nombre     friendly_name de la plantilla (ej 'recordatorio_pago_pendiente')
//   variables  objeto {1: '...', 2: '...'} para la plantilla
//   textoLibre string de fallback (opcional pero recomendado)
//   mediaUrl   adjunto para el fallback de texto libre (opcional)
async function enviarPlantilla(to, nombre, variables, textoLibre, mediaUrl) {
  try {
    const p = await resolver(nombre);
    if (p && p.status === 'approved' && p.sid) {
      await enviarWhatsApp(to, p.sid, variables || {});
      return { enviado: true, via: 'plantilla', sid: p.sid };
    }
  } catch (e) { console.warn('enviarPlantilla plantilla:', e.message); }
  if (textoLibre) {
    try {
      await enviarWhatsAppTexto(to, textoLibre, mediaUrl);
      return { enviado: true, via: 'texto_libre' };
    } catch (e) { return { enviado: false, motivo: e.message }; }
  }
  return { enviado: false, motivo: 'plantilla no aprobada y sin texto libre' };
}

module.exports = { resolver, enviarPlantilla };
