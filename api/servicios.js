// api/servicios.js — Motor de Servicios de MudateYa (Forma A: MYA cobra y retiene)
// Lo usan DOS frontends:
//   • servicios.html  -> tu panel interno (requiere token de admin)
//   • cobrar.html     -> la web del contratista (requiere su CÓDIGO propio)

const { MercadoPagoConfig, Preference } = require('mercadopago');

// ════════════════ REDIS (igual que cotizaciones.js)
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
async function getJSON(key) { const v = await redisCall('GET', key); return v ? JSON.parse(v) : null; }
async function setJSON(key, value, exSeconds) {
  const str = JSON.stringify(value);
  if (exSeconds) await redisCall('SET', key, str, 'EX', String(exSeconds));
  else await redisCall('SET', key, str);
}

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'mya-admin-2026';
const ESTADOS = ['link_generado', 'pagado_cliente', 'pagado_contratista'];

function genCodigo() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return 'MYA-' + s;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const adminToken = req.headers['x-admin-token'] || (req.body && req.body.token) || (req.query && req.query.token);
  const isAdmin = adminToken === ADMIN_TOKEN;

  try {
    if (req.method === 'GET') {
      if (!isAdmin) return res.status(401).json({ error: 'No autorizado' });
      const sIdx = await getJSON('servicios:index') || [];
      const servicios = [];
      for (let i = 0; i < sIdx.length; i++) {
        try { const s = await getJSON(`servicio:${sIdx[i]}`); if (s) servicios.push(s); } catch (e) {}
      }
      const cIdx = await getJSON('contratistas:index') || [];
      const contratistas = [];
      for (let i = 0; i < cIdx.length; i++) {
        try { const c = await getJSON(`contratista:${cIdx[i]}`); if (c) contratistas.push(c); } catch (e) {}
      }
      return res.status(200).json({ servicios, contratistas });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
    const action = (req.body && req.body.action) || 'crear';

    if (action === 'validar_contratista') {
      const cod = String(req.body.codigo || '').trim().toUpperCase();
      const c = await getJSON(`contratista:${cod}`);
      if (!c || !c.activo) return res.status(401).json({ error: 'Código inválido o inactivo' });
      return res.status(200).json({ ok: true, nombre: c.nombre });
    }

    if (action === 'crear_contratista') {
      if (!isAdmin) return res.status(401).json({ error: 'No autorizado' });
      const { nombre, contacto } = req.body;
      if (!nombre) return res.status(400).json({ error: 'Falta el nombre' });
      let cod = genCodigo(), tries = 0;
      while (await getJSON(`contratista:${cod}`) && tries < 6) { cod = genCodigo(); tries++; }
      const c = { id: 'ct-' + Date.now().toString(36), codigo: cod, nombre, contacto: contacto || '', activo: true, creado: new Date().toISOString() };
      await setJSON(`contratista:${cod}`, c);
      const idx = await getJSON('contratistas:index') || [];
      idx.unshift(cod);
      await setJSON('contratistas:index', idx);
      return res.status(200).json({ contratista: c });
    }

    if (action === 'toggle_contratista') {
      if (!isAdmin) return res.status(401).json({ error: 'No autorizado' });
      const cod = String(req.body.codigo || '').trim().toUpperCase();
      const c = await getJSON(`contratista:${cod}`);
      if (!c) return res.status(404).json({ error: 'Contratista no encontrado' });
      c.activo = !c.activo;
      await setJSON(`contratista:${cod}`, c);
      return res.status(200).json({ contratista: c });
    }

    if (action === 'actualizar') {
      if (!isAdmin) return res.status(401).json({ error: 'No autorizado' });
      const { id, estado, monto_contratista } = req.body;
      const s = await getJSON(`servicio:${id}`);
      if (!s) return res.status(404).json({ error: 'Servicio no encontrado' });
      if (estado) { if (ESTADOS.indexOf(estado) === -1) return res.status(400).json({ error: 'Estado inválido' }); s.estado = estado; }
      if (monto_contratista !== undefined && monto_contratista !== '') {
        s.monto_contratista = Math.round(Number(monto_contratista));
        s.margen = s.monto - s.monto_contratista;
      }
      s.actualizado = new Date().toISOString();
      await setJSON(`servicio:${id}`, s);
      return res.status(200).json({ servicio: s });
    }

    if (action === 'crear') {
      let contratistaNombre = '', contratistaCodigo = '', contratistaContacto = '', origen = 'panel';
      if (isAdmin) {
        contratistaNombre = req.body.contratista || '';
        contratistaContacto = req.body.contratista_contacto || '';
      } else {
        const cod = String(req.body.codigo || '').trim().toUpperCase();
        const c = await getJSON(`contratista:${cod}`);
        if (!c || !c.activo) return res.status(401).json({ error: 'Código inválido o inactivo' });
        contratistaNombre = c.nombre; contratistaCodigo = c.codigo; origen = 'contratista';
      }

      if (!process.env.MP_ACCESS_TOKEN) return res.status(500).json({ error: 'Configuración de pago incompleta' });
      const { concepto, categoria, cliente, monto } = req.body;
      if (!concepto || !monto || Number(monto) <= 0) return res.status(400).json({ error: 'Falta concepto o monto válido' });

      const id = 'srv-' + Date.now().toString(36);
      const montoNum = Math.round(Number(monto));
      const montoContr = (isAdmin && req.body.monto_contratista) ? Math.round(Number(req.body.monto_contratista)) : null;
      const margen = (montoContr != null) ? (montoNum - montoContr) : null;

      const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
      const preference = new Preference(client);
      const siteUrl = process.env.SITE_URL || 'https://mudateya.vercel.app';

      const result = await preference.create({ body: {
        items: [{
          id: id,
          title: `MudateYa Servicios · ${concepto}`,
          description: contratistaNombre ? `Prestador: ${contratistaNombre}` : 'Servicio MudateYa',
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
        metadata: { tipo: 'servicio', servicioId: id, concepto, categoria: categoria || '', contratista: contratistaNombre, contratistaCodigo },
      }});

      const servicio = {
        id, concepto, categoria: categoria || '',
        contratista: contratistaNombre, contratista_codigo: contratistaCodigo, contratista_contacto: contratistaContacto,
        cliente: cliente || '',
        monto: montoNum, monto_contratista: montoContr, margen,
        origen, estado: 'link_generado',
        preference_id: result.id,
        init_point: result.init_point || result.initPoint,
        creado: new Date().toISOString(), actualizado: new Date().toISOString(),
      };
      await setJSON(`servicio:${id}`, servicio);
      const idx = await getJSON('servicios:index') || [];
      idx.unshift(id);
      await setJSON('servicios:index', idx);

      return res.status(200).json({ servicio });
    }

    return res.status(400).json({ error: 'Acción desconocida' });

  } catch (error) {
    console.error('Error en servicios:', error);
    return res.status(500).json({ error: 'Error en el servidor', detalle: error.message });
  }
};
