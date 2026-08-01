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

// enviarWhatsAppTexto: manda un mensaje de TEXTO LIBRE (sin plantilla).
// OJO: WhatsApp solo entrega texto libre dentro de la VENTANA DE 24hs desde el
// último mensaje del usuario. Fuera de esa ventana hay que usar una plantilla
// aprobada (enviarWhatsApp). Sirve perfecto para responder/avisar en una charla
// activa (ej: avisarle al cliente que llegó una cotización mientras conversa).
async function enviarWhatsAppTexto(to, body, mediaUrl) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_WHATSAPP_FROM;
  if (!sid || !token || !from) {
    throw new Error('Twilio no configurado (faltan variables de entorno TWILIO_*)');
  }
  var tel = String(to || '').replace(/[^\d+]/g, '');
  if (!tel) throw new Error('Teléfono de destino inválido');
  if (tel[0] !== '+') tel = '+' + tel;

  const params = {
    To:   'whatsapp:' + tel,
    From: from,
    Body: String(body || '').slice(0, 1500),
  };
  // Adjunto opcional (PDF, imagen, etc.). Twilio lo BAJA de esta URL, así que
  // tiene que ser pública y HTTPS (ej: el endpoint /api/cotizaciones?action=pdf).
  if (mediaUrl) params.MediaUrl = mediaUrl;
  const body2 = new URLSearchParams(params);

  const r = await fetch(
    'https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json',
    {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(sid + ':' + token).toString('base64'),
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: body2.toString(),
    }
  );

  const data = await r.json();
  if (!r.ok) throw new Error('Twilio error: ' + (data.message || r.status));
  return { ok: true, sid: data.sid, status: data.status };
}

// avisarSenaConfirmada: cuando se acredita la SEÑA (anticipo) de una mudanza que
// vino por WhatsApp, avisa por WhatsApp al CLIENTE ("seña confirmada, reservada")
// y al MUDANCERO elegido ("ganaste el pedido, coordiná"). Toma todo del objeto
// mudanza (no necesita Redis). Fail-soft: cada envío en su try. Se llama desde
// los webhooks de pago (MP y Talo). OJO ventana 24h para texto libre.
async function avisarSenaConfirmada(mudanza) {
  if (!mudanza) return;
  const cot   = mudanza.cotizacionAceptada || {};
  const desde = mudanza.desde || mudanza.origen || '';
  const hasta = mudanza.hasta || mudanza.destino || '';
  const fecha = mudanza.fecha || '';
  const tipo  = mudanza.tipo || 'mudanza';
  const mud   = cot.mudanceroNombre || 'el mudancero';

  // 1) Cliente (solo si el pedido vino por WhatsApp).
  if (mudanza.canal === 'whatsapp' && mudanza.clienteWA) {
    try {
      await enviarWhatsAppTexto(
        mudanza.clienteWA,
        `✅ ¡Seña confirmada! Tu ${tipo} quedó reservada con ${mud} 🎉\n` +
        `${desde} → ${hasta}${fecha ? ' · ' + fecha : ''}\n` +
        (cot.mudanceroTel ? `Coordinás con ${mud}: ${cot.mudanceroTel}\n` : '') +
        `El 50% restante lo pagás al completar la mudanza. ¡Cualquier cosa escribime por acá!`
      );
    } catch (e) { console.warn('avisarSenaConfirmada cliente:', e.message); }
  }

  // 2) Mudancero elegido (por su teléfono de la cotización).
  if (cot.mudanceroTel) {
    try {
      await enviarWhatsAppTexto(
        cot.mudanceroTel,
        `🎉 ¡Ganaste un pedido en MudateYa! El cliente pagó la seña.\n` +
        `${tipo}: ${desde} → ${hasta}${fecha ? ' · ' + fecha : ''}\n` +
        (mudanza.clienteNombre ? `Cliente: ${mudanza.clienteNombre}` : 'Cliente') +
        (mudanza.clienteWA ? ` (${mudanza.clienteWA})` : '') + '\n' +
        `Escribile para coordinar los detalles. ¡Éxitos! 🚚`
      );
    } catch (e) { console.warn('avisarSenaConfirmada mudancero:', e.message); }
  }
}

// avisarMudanzaIniciada: le avisa al cliente (por WhatsApp) que la mudanza arrancó.
async function avisarMudanzaIniciada(mudanza) {
  if (!mudanza || mudanza.canal !== 'whatsapp' || !mudanza.clienteWA) return;
  const cot   = mudanza.cotizacionAceptada || {};
  const desde = mudanza.desde || mudanza.origen || '';
  const hasta = mudanza.hasta || mudanza.destino || '';
  try {
    await enviarWhatsAppTexto(
      mudanza.clienteWA,
      `🚚 ¡Tu ${mudanza.tipo || 'mudanza'} arrancó! ${cot.mudanceroNombre || 'El mudancero'} ya está en marcha.\n` +
      `${desde} → ${hasta}\n` +
      `Cualquier cosa, escribime por acá. ¡Que salga todo bien! 🙌`
    );
  } catch (e) { console.warn('avisarMudanzaIniciada:', e.message); }
}

// avisarSaldoPendiente: al completarse la mudanza, le avisa al cliente que pague
// el SALDO (50% restante) con el link de MP y/o los datos de transferencia.
async function avisarSaldoPendiente(mudanza, saldo, linkMP, transferencia) {
  if (!mudanza || mudanza.canal !== 'whatsapp' || !mudanza.clienteWA) return;
  const montoFmt = '$' + Number(saldo || 0).toLocaleString('es-AR');
  let msg =
    `✅ ¡Tu ${mudanza.tipo || 'mudanza'} se completó! 🎉\n` +
    `Queda el saldo final (50%): ${montoFmt}.\n`;
  if (linkMP) msg += `\n💳 Mercado Pago:\n${linkMP}\n`;
  if (transferencia && (transferencia.cbu || transferencia.alias)) {
    msg += `\n🏦 O por transferencia:\n` +
      (transferencia.alias ? `Alias: ${transferencia.alias}\n` : '') +
      (transferencia.cbu ? `CBU: ${transferencia.cbu}\n` : '') +
      (transferencia.titular ? `Titular: ${transferencia.titular}\n` : '');
  }
  msg += `\n¡Gracias por elegir MudateYa! 🙌`;
  try { await enviarWhatsAppTexto(mudanza.clienteWA, msg); }
  catch (e) { console.warn('avisarSaldoPendiente:', e.message); }
}

module.exports = { enviarWhatsApp, enviarWhatsAppTexto, avisarSenaConfirmada, avisarMudanzaIniciada, avisarSaldoPendiente };
