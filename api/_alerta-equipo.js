// api/_alerta-equipo.js — Mail de alerta al equipo (ADMIN_EMAIL) cuando algo del
// flujo de plata/avisos falla en silencio. Fail-soft: nunca tira, nunca rompe
// el flujo que lo llama. Vercel ignora los archivos de /api que empiezan con "_".

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

// datos: objeto plano { clave: valor } que se muestra como tabla.
async function alertarEquipo(asunto, resumen, datos) {
  try {
    const adminMail = process.env.ADMIN_EMAIL;
    if (!process.env.RESEND_API_KEY || !adminMail) {
      console.error('[alerta-equipo] falta RESEND_API_KEY o ADMIN_EMAIL:', asunto);
      return false;
    }
    const { Resend } = require('resend');
    const filas = Object.keys(datos || {}).map(function (k) {
      return '<tr><td style="padding:4px 12px 4px 0;color:#64748B">' + esc(k) + '</td><td style="padding:4px 0"><b>' + esc(datos[k]) + '</b></td></tr>';
    }).join('');
    await new Resend(process.env.RESEND_API_KEY).emails.send({
      from: 'MudateYa <noreply@mudateya.ar>',
      reply_to: 'hola@mudateya.ar',
      to: adminMail,
      subject: '⚠️ ' + asunto,
      html: '<p>' + esc(resumen) + '</p><table style="font-size:14px">' + filas + '</table>',
    });
    return true;
  } catch (e) {
    console.error('[alerta-equipo] no se pudo enviar:', e && e.message);
    return false;
  }
}

module.exports = { alertarEquipo };
