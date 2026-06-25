// api/servicios.js — Servicios externos por MudateYa (Forma A: MYA cobra y retiene)
// El link de pago usa MP_ACCESS_TOKEN (tu cuenta), así que la plata cae en MYA.
// Después marcás manualmente cuándo le pagaste al contratista.
//
// Acciones (POST):
//   { action:'crear', ...datos }              -> crea preferencia + guarda el trabajo
//   { action:'estado', id, estado }           -> actualiza el estado del trabajo
// GET  -> lista todos los trabajos
//
// Protegido con token de admin (header x-admin-token o body.token).

const { MercadoPagoConfig, Preference } = require('mercadopago');

// ════════════════════════════════════════════════════ REDIS (igual que cotizaciones.js)
async function redisCall(method, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  const response = await fetch(`${url}/${[method, ...args].map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}
async function getJSON(key) {
  const val = await redisCall('GET', key);
  if (!val) return null;
  return JSON.parse(val);
}
async function setJSON(key, value, exSeconds) {
  const str = JSON.stringify(value);
  if (exSeconds) await redisCall('SET', key, str, 'EX', String(exSeconds));
  else await redisCall('SET', key, str);
}

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'mya-admin-2026';
const ESTADOS = ['link_generado', 'pagado_cliente', 'pagado_contratista'];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── auth admin ──
  const token = req.headers['x-admin-token'] || (req.body && req.body.token) || (req.query && req.query.token);
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });

  try {
    // ── LISTAR ──
    if (req.method === 'GET') {
      const idx = await getJSON('servicios:index') || [];
      const items = [];
      for (let i = 0; i < idx.length; i++) {
        try { const s = await getJSON(`servicio:${idx[i]}`); if (s) items.push(s); } catch (e) {}
      }
      return res.status(200).json({ servicios: items });
    }

    if (req.method === 'POST') {
      const action = (req.body && req.body.action) || 'crear';

      // ── ACTUALIZAR ESTADO ──
      if (action === 'estado') {
        const { id, estado } = req.body;
        if (!id || ESTADOS.indexOf(estado) === -1) return res.status(400).json({ error: 'Datos inválidos' });
        const s = await getJSON(`servicio:${id}`);
        if (!s) return res.status(404).json({ error: 'Servicio no encontrado' });
        s.estado = estado;
        s.actualizado = new Date().toISOString();
        await setJSON(`servicio:${id}`, s);
        return res.status(200).json({ servicio: s });
      }

      // ── CREAR LINK ──
      if (!process.env.MP_ACCESS_TOKEN) return res.status(500).json({ error: 'Configuración de pago incompleta' });
      const {
        concepto, categoria, contratista, contratista_contacto,
        cliente, cliente_contacto, monto, monto_contratista
      } = req.body;
      if (!concepto || !monto || Number(monto) <= 0) return res.status(400).json({ error: 'Falta concepto o monto válido' });

      const id = 'srv-' + Date.now().toString(36);
      const montoNum = Math.round(Number(monto));
      const montoContr = monto_contratista ? Math.round(Number(monto_contratista)) : null;
      const margen = (montoContr != null) ? (montoNum - montoContr) : null;

      const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
      const preference = new Preference(client);
      const siteUrl = process.env.SITE_URL || 'https://mudateya.vercel.app';

      const result = await preference.create({ body: {
        items: [{
          id: id,
          title: `MudateYa Servicios · ${concepto}`,
          description: contratista ? `Prestador: ${contratista}` : 'Servicio MudateYa',
          quantity: 1,
          unit_price: montoNum,
          currency_id: 'ARS',
        }],
        back_urls: {
          success: `${siteUrl}/?pago_servicio=ok`,
          failure: `${siteUrl}/?pago_servicio=error`,
          pending: `${siteUrl}/?pago_servicio=pendiente`,
        },
        auto_return: 'approved',
        statement_descriptor: 'MUDATEYA',
        external_reference: `servicio-${id}`,
        metadata: { tipo: 'servicio', servicioId: id, concepto, categoria: categoria || '', contratista: contratista || '' },
      }});

      const servicio = {
        id,
        concepto,
        categoria: categoria || '',
        contratista: contratista || '',
        contratista_contacto: contratista_contacto || '',
        cliente: cliente || '',
        cliente_contacto: cliente_contacto || '',
        monto: montoNum,
        monto_contratista: montoContr,
        margen,
        estado: 'link_generado',
        preference_id: result.id,
        init_point: result.init_point || result.initPoint,
        creado: new Date().toISOString(),
        actualizado: new Date().toISOString(),
      };
      await setJSON(`servicio:${id}`, servicio);
      const idx = await getJSON('servicios:index') || [];
      idx.unshift(id);
      await setJSON('servicios:index', idx);

      return res.status(200).json({ servicio });
    }

    return res.status(405).json({ error: 'Método no permitido' });

  } catch (error) {
    console.error('Error en servicios:', error);
    return res.status(500).json({ error: 'Error en el servidor', detalle: error.message });
  }
};
