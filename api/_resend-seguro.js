// Cliente de Resend que NO manda mails a direcciones sintéticas (@wa.mudateya.ar).
// Esas casillas las inventa el bot de WhatsApp para identificar pedidos de clientes sin mail:
// no existen, y mandarles provoca "Delivery Delayed"/rebotes que dañan la reputación del dominio.
// El cliente igual recibe todo por WhatsApp. Uso: const { Resend } = require('./_resend-seguro');
const { Resend: ResendOriginal } = require('resend');

const SINTETICO = /@wa\.mudateya\.ar\s*$/i;
const limpiar = (d) => {
  const s = String(d || '').trim();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim();
};

class Resend extends ResendOriginal {
  constructor(...args) {
    super(...args);
    const original = this.emails.send.bind(this.emails);
    this.emails.send = async (payload, ...resto) => {
      if (payload && payload.to != null) {
        const lista = Array.isArray(payload.to) ? payload.to : [payload.to];
        const reales = lista.filter((d) => !SINTETICO.test(limpiar(d)));
        if (reales.length === 0) return { data: null, error: null, omitido: 'destinatario sintético (@wa.mudateya.ar)' };
        if (reales.length !== lista.length) payload = { ...payload, to: Array.isArray(payload.to) ? reales : reales[0] };
      }
      return original(payload, ...resto);
    };
  }
}

module.exports = { Resend };
