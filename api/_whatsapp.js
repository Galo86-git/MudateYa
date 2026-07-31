// api/_whatsapp.js
// Envío de WhatsApp por Twilio (pago por uso). Vercel ignora los archivos de
// /api que empiezan con "_": no se deploya como función.
//
// VARIABLES DE ENTORNO (se cargan en Vercel → Settings → Environment Variables):
//   TWILIO_ACCOUNT_SID     SID de la cuenta (empieza con "AC...")
//   TWILIO_AUTH_TOKEN      token secreto de la cuenta
//   TWILIO_WHATSAPP_FROM   número de WhatsApp aprobado, formato "whatsapp:+549..."
//
// enviarWhatsApp: manda un mensaje de PLANTILLA aprobada (así se inicia la charla
// con una empresa; la ida y vuelta posterior dentro de 24h es gratis).
//   to          teléfono destino en formato internacional, ej "+5491122334455"
//   contentSid  ID de la plantilla aprobada en Twilio (empieza con "HX...")
//   variables   objeto con las variables de la plantilla, ej { "1":"Palermo", "2":"hoy" }
//
// Devuelve { ok, sid, status } o lanza un error con el detalle de Twilio.

async function enviarWhatsApp(to, contentSid, variables) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_WHATSAPP_FROM;
  if (!sid || !token || !from) {
    throw new Error('Twilio no configurado (faltan variables de entorno TWILIO_*)');
  }

  // Normalizar el teléfono a formato "whatsapp:+<solo dígitos>"
  var tel = String(to || '').replace(/[^\d+]/g, '');
  if (!tel) throw new Error('Teléfono de destino inválido');
  if (tel[0] !== '+') tel = '+' + tel;

  const body = new URLSearchParams({
    To:               'whatsapp:' + tel,
    From:             from,
    ContentSid:       contentSid,
    ContentVariables: JSON.stringify(variables || {}),
  });

  const r = await fetch(
    'https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json',
    {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(sid + ':' + token).toString('base64'),
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    }
  );

  const data = await r.json();
  if (!r.ok) throw new Error('Twilio error: ' + (data.message || r.status));
  return { ok: true, sid: data.sid, status: data.status };
}

module.exports = { enviarWhatsApp };
