// api/admin-uso-proveedores.js — ONE-OFF de diagnóstico, admin-only.
//
// Trae uso/costo REAL de los proveedores que exponen una API de reporting
// con las MISMAS credenciales que la app ya usa para funcionar (no hace
// falta ningún login nuevo ni token de billing separado):
//   - Twilio: Usage Records API (cuántos mensajes de WhatsApp y cuánto costaron).
//   - Mercado Pago: búsqueda de pagos (volumen procesado del período).
//
// Resend, Anthropic, Vercel y Upstash NO exponen uso/facturación con la
// misma API key que ya tenemos cargada (piden un token de management/billing
// aparte que no existe en este proyecto) — para esos, este endpoint devuelve
// el link directo al dashboard en vez de inventar un número.
//
// GET /api/admin-uso-proveedores?token=ADMIN_TOKEN&dias=30
//   dias: cuántos días hacia atrás mirar (default 30, máximo 90).

var { esAdmin } = require('./_auth');

function fechaISO(d) { return d.toISOString().slice(0, 10); }

module.exports = async function handler(req, res) {
  if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });

  var dias = Math.min(90, Math.max(1, parseInt((req.query && req.query.dias) || '30', 10) || 30));
  var hasta = new Date();
  var desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);

  var resultado = {
    periodo: { desde: fechaISO(desde), hasta: fechaISO(hasta), dias: dias },
    twilio: null,
    mercadoPago: null,
    sinApiDeUso: [
      { proveedor: 'Resend', dashboard: 'https://resend.com/emails', nota: 'Ver "Usage" en el panel — no expone uso vía API con la key transaccional que usamos.' },
      { proveedor: 'Anthropic (Claude)', dashboard: 'https://console.anthropic.com/settings/usage', nota: 'La API key de Emi no tiene alcance de admin/organización para leer uso — hace falta una Admin API Key aparte, no configurada acá.' },
      { proveedor: 'Vercel', dashboard: 'https://vercel.com/dashboard (→ tu proyecto → Usage)', nota: 'Requiere un Vercel API Token de cuenta, distinto al deploy — no está cargado en este proyecto.' },
      { proveedor: 'Upstash', dashboard: 'https://console.upstash.com', nota: 'El REST_TOKEN que usamos es de datos, no de management — el uso/costo se ve solo en su consola.' },
      { proveedor: 'Talo', dashboard: 'Consultar directo con Talo (panel propio de transferencias)', nota: 'No es una API pública documentada para uso/costo.' },
    ],
  };

  // ── TWILIO: Usage Records ──
  try {
    var sid = process.env.TWILIO_ACCOUNT_SID;
    var tok = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !tok) {
      resultado.twilio = { error: 'Faltan TWILIO_ACCOUNT_SID/AUTH_TOKEN en el entorno' };
    } else {
      var auth = 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64');
      var url = 'https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Usage/Records.json'
        + '?StartDate=' + fechaISO(desde) + '&EndDate=' + fechaISO(hasta) + '&PageSize=200';
      var r = await fetch(url, { headers: { Authorization: auth } });
      var d = await r.json();
      if (!r.ok) {
        resultado.twilio = { error: 'Twilio respondió ' + r.status, detalle: d };
      } else {
        var registros = (d.usage_records || [])
          .filter(function (u) { return parseFloat(u.count) > 0 || parseFloat(u.price) !== 0; })
          .map(function (u) {
            return { categoria: u.category, descripcion: u.description, cantidad: u.count, unidad: u.usage_unit, costo: u.price, moneda: u.price_unit };
          });
        var totalUSD = registros.reduce(function (acc, u) { return acc + (u.moneda === 'usd' ? Math.abs(parseFloat(u.costo) || 0) : 0); }, 0);
        resultado.twilio = { registros: registros, totalEstimadoUSD: Math.round(totalUSD * 100) / 100 };
      }
    }
  } catch (e) {
    resultado.twilio = { error: 'No se pudo consultar Twilio: ' + e.message };
  }

  // ── MERCADO PAGO: volumen de pagos del período (no es "costo", es el
  // monto procesado — la comisión de MP se descuenta de cada cobro y no
  // se expone como un total agregado por esta API). ──
  try {
    var mpToken = process.env.MP_ACCESS_TOKEN;
    if (!mpToken) {
      resultado.mercadoPago = { error: 'Falta MP_ACCESS_TOKEN en el entorno' };
    } else {
      var mpUrl = 'https://api.mercadopago.com/v1/payments/search'
        + '?range=date_created&begin_date=' + encodeURIComponent(desde.toISOString())
        + '&end_date=' + encodeURIComponent(hasta.toISOString())
        + '&status=approved&sort=date_created&criteria=desc&limit=200';
      var rMp = await fetch(mpUrl, { headers: { Authorization: 'Bearer ' + mpToken } });
      var dMp = await rMp.json();
      if (!rMp.ok) {
        resultado.mercadoPago = { error: 'Mercado Pago respondió ' + rMp.status, detalle: dMp };
      } else {
        var pagos = dMp.results || [];
        var totalProcesado = pagos.reduce(function (acc, p) { return acc + (parseFloat(p.transaction_amount) || 0); }, 0);
        resultado.mercadoPago = {
          cantidadPagos: pagos.length,
          totalProcesadoARS: Math.round(totalProcesado),
          nota: 'Esto es el MONTO PROCESADO (señas + saldos aprobados), no la comisión que te cobra MP — esa es un % que descuentan por fuera de esta consulta. Multiplicá por tu % de comisión de MP para estimarla.',
          totalEnLaBusqueda: dMp.paging ? dMp.paging.total : null,
        };
        if (dMp.paging && dMp.paging.total > pagos.length) {
          resultado.mercadoPago.aviso = 'Hay más de ' + pagos.length + ' pagos en el período — este total es solo de la primera página (200). Para el total exacto, sumar todas las páginas.';
        }
      }
    }
  } catch (e) {
    resultado.mercadoPago = { error: 'No se pudo consultar Mercado Pago: ' + e.message };
  }

  return res.status(200).json(resultado);
};
