// api/cotizaciones.js — Upstash Redis + PDF con pdfmake
const { Resend } = require('resend');

// ════════════════════════════════════════════════════
// REDIS
// ════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════
// GENERADOR PDF con pdfmake
// ════════════════════════════════════════════════════
async function generarPDFBase64(datos) {
  const PdfPrinter = require('pdfmake');
  const fonts = { Helvetica: { normal:'Helvetica', bold:'Helvetica-Bold', italics:'Helvetica-Oblique', bolditalics:'Helvetica-BoldOblique' } };
  const printer = new PdfPrinter(fonts);

  const WHITE='#FFFFFF', BG='#F4F6F9', NAVY='#003580', BLUE='#1A6FFF';
  const BLUE_LT='#EEF4FF', BLUE_BD='#C7D9FF', TEXT='#0F1923', TEXT2='#475569';
  const TEXT3='#94A3B8', BORDER_C='#E2E8F0', BORDER2='#CBD5E1';
  const GREEN='#16A34A', GREEN_LT='#F0FFF4', GREEN_BD='#BBF7D0';
  const AMBER='#92400E', AMBER_LT='#FFFBEB', AMBER_BD='#FCD34D';

  const nro          = datos.id || 'COT-0001';
  const fechaEmision = datos.fechaEmision || new Date().toLocaleDateString('es-AR',{day:'numeric',month:'long',year:'numeric'});
  const clienteNombre= datos.clienteNombre || '-';
  const clienteEmail = datos.clienteEmail  || '-';
  const mudNombre    = datos.mudanceroNombre || '-';
  const mudInits     = (datos.mudancero_initials||datos.mudanceroNombre||'MV').slice(0,2).toUpperCase();
  const vehiculo     = datos.vehiculo || '';
  const desde        = datos.desde || '-';
  const hasta        = datos.hasta || '-';
  const fechaMud     = datos.fecha || '-';
  const ambientes    = datos.ambientes || '-';
  const objetos      = datos.objetos || datos.servicios || '-';
  const extras       = datos.extras || '';
  const nota         = datos.nota || '';
  const precio       = parseInt(datos.precio || 0);
  const precioBase   = parseInt(datos.precioBase || precio);
  const precioKm     = parseInt(datos.precioKm || 0);
  const distanciaKm  = parseInt(datos.distanciaKm || 0);
  const tieneDesglose= precioKm > 0 && distanciaKm > 0;
  const esFlete      = datos.ambientes === 'Flete' || datos.tipo === 'flete';
  const fmt          = (n) => '$' + n.toLocaleString('es-AR');

  // Layouts compactos
  function card(fill, border) {
    return { fillColor:()=>fill, hLineColor:()=>border, vLineColor:()=>border,
      hLineWidth:()=>0.5, vLineWidth:()=>0.5,
      paddingLeft:()=>12, paddingRight:()=>12, paddingTop:()=>10, paddingBottom:()=>10 };
  }
  function pill(fill, border) {
    return { fillColor:()=>fill, hLineColor:()=>border, vLineColor:()=>border,
      hLineWidth:()=>0.4, vLineWidth:()=>0.4,
      paddingLeft:()=>6, paddingRight:()=>6, paddingTop:()=>2, paddingBottom:()=>2 };
  }
  function div() {
    return { canvas:[{type:'line',x1:0,y1:0,x2:467,y2:0,lineWidth:0.4,lineColor:BORDER_C}] };
  }
  function row(lbl, val, last) {
    return { stack:[
      { columns:[
        {text:lbl.toUpperCase(),bold:true,fontSize:7,color:TEXT3,width:120,characterSpacing:0.3},
        {text:String(val||'-'),fontSize:8.5,color:TEXT,width:'*'},
      ]},
      last ? {text:''} : {margin:[0,4,0,0],...div()},
    ], margin:[0,5,0,last?0:5] };
  }

  // Filas de detalle
  const filasDet = [
    ['Desde',desde],['Hasta',hasta],['Fecha',fechaMud],
    ['Tipo',esFlete?'Flete':'Mudanza'],['Ambientes',ambientes],
  ];
  if (objetos && objetos !== '-') filasDet.push(['Objetos',objetos]);
  if (distanciaKm > 0) filasDet.push(['Distancia',distanciaKm+' km']);
  if (extras) filasDet.push(['Servicios',extras]);
  if (nota)   filasDet.push(['Nota',nota]);

  // Sección precio
  const precioSection = tieneDesglose ? {
    table:{widths:['*'],body:[[{stack:[
      {text:'DESGLOSE DEL PRECIO',bold:true,fontSize:6.5,color:TEXT3,characterSpacing:0.6,margin:[0,0,0,6]},
      div(), {text:'',margin:[0,2,0,0]},
      row('Precio base (carga/descarga)', fmt(precioBase), false),
      row('Distancia ('+distanciaKm+' km x '+fmt(precioKm)+'/km)', fmt(precioKm*distanciaKm), false),
      {columns:[
        {text:'TOTAL',bold:true,fontSize:9,color:BLUE,width:'*'},
        {text:fmt(precio),bold:true,fontSize:16,color:BLUE,alignment:'right',width:'auto'},
      ],margin:[0,6,0,0]},
    ]}]]}, layout:card(BLUE_LT,BLUE_BD), margin:[0,0,0,6]
  } : {
    table:{widths:['*','auto'],body:[[
      {stack:[
        {text:fmt(precio),bold:true,fontSize:28,color:BLUE},
        {text:'PRECIO TOTAL',bold:true,fontSize:7,color:TEXT3,margin:[0,3,0,1]},
        {text:'Pago 100% por Mercado Pago.',fontSize:7.5,color:TEXT2},
      ]},
      {stack:[
        {table:{body:[[{text:'Mercado Pago',bold:true,fontSize:7.5,color:NAVY}]]},
          layout:pill(BLUE_LT,BLUE_BD)},
      ],alignment:'right',margin:[0,4,0,0]},
    ]]},
    layout:{fillColor:()=>BG,hLineColor:()=>BORDER2,vLineColor:()=>BORDER2,
      hLineWidth:()=>0.7,vLineWidth:()=>0.7,
      paddingLeft:()=>14,paddingRight:()=>14,paddingTop:()=>12,paddingBottom:()=>12},
    margin:[0,0,0,6]
  };

  const dd = {
    pageSize:'A4',
    pageMargins:[36,42,36,36],
    background:()=>[{canvas:[{type:'rect',x:0,y:0,w:595,h:70,color:NAVY}]}],
    defaultStyle:{font:'Helvetica',fontSize:9,color:TEXT,lineHeight:1.25},
    content:[
      // Header
      {columns:[
        {stack:[
          {columns:[
            {text:'Mudate',bold:true,fontSize:20,color:WHITE,width:'auto'},
            {text:'Ya',bold:true,fontSize:20,color:'#4ADE80',width:'auto'},
          ],columnGap:0},
          {text:'El marketplace de mudanzas de Argentina',fontSize:7.5,color:'#aac4e0',margin:[0,2,0,0]},
        ]},
        {stack:[
          {text:nro,bold:true,fontSize:12,color:WHITE,alignment:'right'},
          {text:'COTIZACION OFICIAL',bold:true,fontSize:6.5,color:'#aac4e0',alignment:'right',characterSpacing:0.5,margin:[0,2,0,2]},
          {text:fechaEmision,fontSize:7.5,color:'#aac4e0',alignment:'right'},
        ]},
      ],margin:[0,0,0,16]},

      // Badge
      {columns:[
        {table:{body:[[{text:'PRESUPUESTO OFICIAL  |  valido 24 horas',bold:true,fontSize:7,color:BLUE}]]},
          layout:pill(BLUE_LT,BLUE_BD),width:'auto'},
        {text:'',width:'*'},
      ],margin:[0,0,0,10]},

      // Cliente + Mudancero
      {columns:[
        {width:'48%',table:{widths:['*'],body:[[{stack:[
          {text:'CLIENTE',bold:true,fontSize:6.5,color:TEXT3,characterSpacing:0.7,margin:[0,0,0,6]},
          {text:clienteNombre,bold:true,fontSize:11,color:TEXT},
          {text:clienteEmail,fontSize:8,color:TEXT2,margin:[0,2,0,0]},
        ]}]]},layout:card(WHITE,BORDER_C)},
        {width:'4%',text:''},
        {width:'48%',table:{widths:['*'],body:[[{stack:[
          {text:'MUDANCERO',bold:true,fontSize:6.5,color:TEXT3,characterSpacing:0.7,margin:[0,0,0,6]},
          {columns:[
            {width:32,stack:[
              {table:{body:[[{text:mudInits,bold:true,fontSize:10,color:WHITE,alignment:'center'}]]},
                layout:{fillColor:()=>NAVY,hLineColor:()=>NAVY,vLineColor:()=>NAVY,
                  hLineWidth:()=>0,vLineWidth:()=>0,
                  paddingLeft:()=>5,paddingRight:()=>5,paddingTop:()=>6,paddingBottom:()=>6}},
            ],margin:[0,0,8,0]},
            {stack:[
              {text:mudNombre,bold:true,fontSize:11,color:TEXT},
              {table:{body:[[{text:'VERIFICADO',bold:true,fontSize:6,color:GREEN}]]},
                layout:pill(GREEN_LT,GREEN_BD),width:'auto',margin:[0,4,0,0]},
              vehiculo ? {text:vehiculo,fontSize:7.5,color:TEXT3,margin:[0,3,0,0]} : {text:''},
            ]},
          ],columnGap:0},
        ]}]]},layout:card(WHITE,BORDER_C)},
      ],columnGap:0,margin:[0,0,0,6]},

      // Detalle
      {table:{widths:['*'],body:[[{stack:[
        {text:'DETALLE DEL SERVICIO',bold:true,fontSize:6.5,color:TEXT3,characterSpacing:0.7,margin:[0,0,0,6]},
        div(), {text:'',margin:[0,2,0,0]},
        ...filasDet.map(([lbl,val],i)=>row(lbl,val,i===filasDet.length-1)),
      ]}]]},layout:card(WHITE,BORDER_C),margin:[0,0,0,6]},

      // Precio
      precioSection,

      // Proximos pasos — compacto horizontal
      {table:{widths:['*'],body:[[{stack:[
        {text:'PROXIMOS PASOS',bold:true,fontSize:6.5,color:TEXT3,characterSpacing:0.7,margin:[0,0,0,8]},
        {columns:[
          {width:'25%',stack:[
            {table:{widths:[18],body:[[{text:'1',bold:true,fontSize:9,color:BLUE,alignment:'center'}]]},
              layout:{fillColor:()=>BLUE_LT,hLineColor:()=>BLUE_BD,vLineColor:()=>BLUE_BD,
                hLineWidth:()=>0.5,vLineWidth:()=>0.5,paddingLeft:()=>3,paddingRight:()=>3,paddingTop:()=>4,paddingBottom:()=>4},
              margin:[0,0,0,4],alignment:'center'},
            {text:'Aceptar cotizacion',fontSize:7,color:TEXT2,alignment:'center'},
          ]},
          {width:'25%',stack:[
            {table:{widths:[18],body:[[{text:'2',bold:true,fontSize:9,color:BLUE,alignment:'center'}]]},
              layout:{fillColor:()=>BLUE_LT,hLineColor:()=>BLUE_BD,vLineColor:()=>BLUE_BD,
                hLineWidth:()=>0.5,vLineWidth:()=>0.5,paddingLeft:()=>3,paddingRight:()=>3,paddingTop:()=>4,paddingBottom:()=>4},
              margin:[0,0,0,4],alignment:'center'},
            {text:'Pagar con MP',fontSize:7,color:TEXT2,alignment:'center'},
          ]},
          {width:'25%',stack:[
            {table:{widths:[18],body:[[{text:'3',bold:true,fontSize:9,color:BLUE,alignment:'center'}]]},
              layout:{fillColor:()=>BLUE_LT,hLineColor:()=>BLUE_BD,vLineColor:()=>BLUE_BD,
                hLineWidth:()=>0.5,vLineWidth:()=>0.5,paddingLeft:()=>3,paddingRight:()=>3,paddingTop:()=>4,paddingBottom:()=>4},
              margin:[0,0,0,4],alignment:'center'},
            {text:'Coordinar fecha',fontSize:7,color:TEXT2,alignment:'center'},
          ]},
          {width:'25%',stack:[
            {table:{widths:[18],body:[[{text:'4',bold:true,fontSize:9,color:BLUE,alignment:'center'}]]},
              layout:{fillColor:()=>BLUE_LT,hLineColor:()=>BLUE_BD,vLineColor:()=>BLUE_BD,
                hLineWidth:()=>0.5,vLineWidth:()=>0.5,paddingLeft:()=>3,paddingRight:()=>3,paddingTop:()=>4,paddingBottom:()=>4},
              margin:[0,0,0,4],alignment:'center'},
            {text:'Mudanza lista',fontSize:7,color:TEXT2,alignment:'center'},
          ]},
        ],columnGap:6},
      ]}]]},layout:card(WHITE,BORDER_C),margin:[0,0,0,6]},

      // Garantias + Aviso — en dos columnas para ahorrar espacio
      {columns:[
        // Garantias (izq)
        {width:'60%',stack:[
          {columns:[
            {width:'25%',table:{widths:['*'],body:[[{stack:[
              {text:'Pago seguro',bold:true,fontSize:7,color:NAVY,alignment:'center',margin:[0,0,0,2]},
              {text:'Mercado Pago',fontSize:6,color:TEXT3,alignment:'center'},
            ]}]]},layout:{fillColor:()=>BLUE_LT,hLineColor:()=>BLUE_BD,vLineColor:()=>BLUE_BD,hLineWidth:()=>0.4,vLineWidth:()=>0.4,paddingLeft:()=>4,paddingRight:()=>4,paddingTop:()=>7,paddingBottom:()=>7}},
            {width:'25%',table:{widths:['*'],body:[[{stack:[
              {text:'Verificado',bold:true,fontSize:7,color:NAVY,alignment:'center',margin:[0,0,0,2]},
              {text:'ID confirmada',fontSize:6,color:TEXT3,alignment:'center'},
            ]}]]},layout:{fillColor:()=>BLUE_LT,hLineColor:()=>BLUE_BD,vLineColor:()=>BLUE_BD,hLineWidth:()=>0.4,vLineWidth:()=>0.4,paddingLeft:()=>4,paddingRight:()=>4,paddingTop:()=>7,paddingBottom:()=>7}},
            {width:'25%',table:{widths:['*'],body:[[{stack:[
              {text:'4.8 promedio',bold:true,fontSize:7,color:NAVY,alignment:'center',margin:[0,0,0,2]},
              {text:'Calificacion',fontSize:6,color:TEXT3,alignment:'center'},
            ]}]]},layout:{fillColor:()=>BLUE_LT,hLineColor:()=>BLUE_BD,vLineColor:()=>BLUE_BD,hLineWidth:()=>0.4,vLineWidth:()=>0.4,paddingLeft:()=>4,paddingRight:()=>4,paddingTop:()=>7,paddingBottom:()=>7}},
            {width:'25%',table:{widths:['*'],body:[[{stack:[
              {text:'Sin sorpresas',bold:true,fontSize:7,color:NAVY,alignment:'center',margin:[0,0,0,2]},
              {text:'Precio acordado',fontSize:6,color:TEXT3,alignment:'center'},
            ]}]]},layout:{fillColor:()=>BLUE_LT,hLineColor:()=>BLUE_BD,vLineColor:()=>BLUE_BD,hLineWidth:()=>0.4,vLineWidth:()=>0.4,paddingLeft:()=>4,paddingRight:()=>4,paddingTop:()=>7,paddingBottom:()=>7}},
          ],columnGap:3},
        ]},
        // Aviso pagos externos (der)
        {width:'38%',table:{widths:['*'],body:[[{stack:[
          {text:'AVISO IMPORTANTE',bold:true,fontSize:6.5,color:AMBER,margin:[0,0,0,3]},
          {text:'MudateYa solo garantiza pagos realizados a traves de su plataforma. Pagos externos no estan cubiertos.',fontSize:6.5,color:'#78350F',lineHeight:1.35},
        ]}]]},
        layout:{fillColor:()=>AMBER_LT,hLineColor:()=>AMBER_BD,vLineColor:()=>AMBER_BD,
          hLineWidth:()=>0.6,vLineWidth:()=>0.6,
          paddingLeft:()=>8,paddingRight:()=>8,paddingTop:()=>7,paddingBottom:()=>7}},
      ],columnGap:6,margin:[0,0,0,8]},

      // Footer
      div(),
      {margin:[0,6,0,0],columns:[
        {columns:[
          {text:'MudateYa',bold:true,fontSize:8.5,color:NAVY,width:'auto'},
          {text:'  |  mudateya.com.ar',fontSize:7.5,color:TEXT3,width:'*',margin:[0,1,0,0]},
        ]},
        {text:'Valida 24hs  |  '+nro,fontSize:7,color:TEXT3,alignment:'right',margin:[0,1,0,0]},
      ]},
    ],
  };

  return new Promise((resolve, reject) => {
    try {
      const pdfDoc = printer.createPdfKitDocument(dd);
      const chunks = [];
      pdfDoc.on('data', chunk => chunks.push(chunk));
      pdfDoc.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
      pdfDoc.on('error', reject);
      pdfDoc.end();
    } catch(e) { reject(e); }
  });
}




// ════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  // ── CORS: solo aceptar requests desde mudateya.ar ──────────────
  const allowedOrigins = [
    'https://mudateya.ar',
    'https://www.mudateya.ar',
    process.env.ALLOWED_ORIGIN || '', // para staging/dev
  ].filter(Boolean);
  const origin = req.headers.origin || '';
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    // Request sin Origin (ej: curl desde el servidor mismo, Vercel cron)
    res.setHeader('Access-Control-Allow-Origin', 'https://mudateya.ar');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Token');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  // ── RATE LIMITING por IP ─────────────────────────────────────────
  const RATE_LIMITED_ACTIONS = ['publicar', 'cotizar', 'analizar-foto', 'crear-sesion'];
  if (RATE_LIMITED_ACTIONS.includes(action)) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    const rlKey = `ratelimit:${action}:${ip}`;
    const MAX_PER_MINUTE = action === 'analizar-foto' ? 5 : 15;
    try {
      const current = await redisCall('INCR', rlKey);
      if (parseInt(current) === 1) await redisCall('EXPIRE', rlKey, '60');
      if (parseInt(current) > MAX_PER_MINUTE) {
        return res.status(429).json({ error: 'Demasiados requests. Esperá un momento.' });
      }
    } catch(rlErr) {
      console.warn('Rate limit check failed:', rlErr.message);
      // Si Redis falla el rate limit, continuar igual (no bloquear)
    }
  }

  // ── AUTH HELPERS ────────────────────────────────────────────────
  // Acciones que requieren que el email del body/query coincida con
  // el token de sesión guardado en Redis (clienteToken o mudanceroToken)
  async function verificarSesionCliente(email) {
    const token = req.headers['x-session-token'] || req.query.sessionToken;
    if (!token) return false;
    const tokenGuardado = await getJSON(`session:cliente:${email}`);
    return tokenGuardado && tokenGuardado === token;
  }
  async function verificarSesionMudancero(email) {
    const token = req.headers['x-session-token'] || req.query.sessionToken;
    if (!token) return false;
    const tokenGuardado = await getJSON(`session:mudancero:${email}`);
    return tokenGuardado && tokenGuardado === token;
  }
  // Acción pública: crear sesión al hacer login con Google (llamada desde el frontend)
  // El frontend ya validó el token con el SDK de Google — acá solo guardamos la sesión
  if (action === 'crear-sesion' && req.method === 'POST') {
    const { email, googleIdToken, rol } = req.body;
    if (!email || !googleIdToken) return res.status(400).json({ error: 'Faltan datos' });
    // Verificar el token de Google en el backend
    const verifyUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${googleIdToken}`;
    const verifyRes = await fetch(verifyUrl);
    const verifyData = await verifyRes.json();
    if (verifyData.email !== email) return res.status(401).json({ error: 'Token inválido' });
    if (verifyData.aud !== process.env.GOOGLE_CLIENT_ID) return res.status(401).json({ error: 'Token inválido' });
    // Generar token de sesión
    const sessionToken = require('crypto').randomBytes(32).toString('hex');
    const ttl = 60 * 60 * 24 * 7; // 7 días
    const prefix = rol === 'mudancero' ? 'mudancero' : 'cliente';
    await setJSON(`session:${prefix}:${email}`, sessionToken, ttl);
    return res.status(200).json({ ok: true, sessionToken, ttl });
  }

  try {

    if (action === 'publicar' && req.method === 'POST') {
      const { clienteEmail, clienteNombre, desde, hasta, ambientes, fecha, servicios, extras, zonaBase, precio_estimado, clienteWA, tipo, pisoOrigen, pisoDestino, ascOrigen, ascDestino, fotos, distanciaKm } = req.body;
      if (!clienteEmail || !desde || !hasta) return res.status(400).json({ error: 'Faltan datos' });
      const id = 'MYA-' + Date.now();
      const { modoCotizacion, mudancerosInvitados } = req.body;
      const modo = modoCotizacion || 'abierto';
      const MAX_COT = 5;
      const mudanza = { id, clienteEmail, clienteNombre, clienteWA: clienteWA||'', desde, hasta, ambientes, fecha, servicios, extras, zonaBase, precio_estimado, distanciaKm: parseInt(distanciaKm||0), tipo: tipo||'mudanza', pisoOrigen, pisoDestino, ascOrigen, ascDestino, fotos: fotos||[], estado: 'buscando', modoCotizacion: modo, maxCotizaciones: MAX_COT, mudancerosInvitados: mudancerosInvitados||[], fechaPublicacion: new Date().toISOString(), expira: new Date(Date.now() + 24*60*60*1000).toISOString(), cotizaciones: [] };
      await setJSON(`mudanza:${id}`, mudanza, 604800);
      const clienteIdx = await getJSON(`cliente:${clienteEmail}`) || [];
      if (!clienteIdx.includes(id)) clienteIdx.push(id);
      await setJSON(`cliente:${clienteEmail}`, clienteIdx, 2592000);
      const globalIdx = await getJSON('mudanzas:activas') || [];
      if (!globalIdx.includes(id)) globalIdx.push(id);
      await setJSON('mudanzas:activas', globalIdx, 604800);
      try { await notificarMudanceros(mudanza); } catch(e) { console.error(e.message); }
      try { await confirmarPublicacionCliente(mudanza); } catch(e) { console.error(e.message); }
      return res.status(200).json({ ok: true, id, mudanza });
    }

    if (action === 'cotizar' && req.method === 'POST') {
      const { mudanzaId, mudanceroEmail, mudanceroNombre, mudanceroTel, precio, precioBase, precioKm, distanciaKm, nota, tiempoEstimado } = req.body;
      if (!mudanzaId || !mudanceroEmail || !precio) return res.status(400).json({ error: 'Faltan datos' });
      const mudanza = await getJSON(`mudanza:${mudanzaId}`);
      if (!mudanza) return res.status(404).json({ error: 'Mudanza no encontrada' });
      if (mudanza.estado !== 'buscando') return res.status(400).json({ error: 'No acepta más cotizaciones' });
      if (mudanza.cotizaciones.find(c => c.mudanceroEmail === mudanceroEmail)) return res.status(400).json({ error: 'Ya cotizaste esta mudanza' });

      // Modo dirigido: solo pueden cotizar los mudanceros invitados por el cliente
      if (mudanza.modoCotizacion === 'dirigido') {
        const invitados = mudanza.mudancerosInvitados || [];
        if (!invitados.includes(mudanceroEmail)) {
          return res.status(403).json({ error: 'Esta mudanza solo acepta cotizaciones de mudanceros seleccionados por el cliente' });
        }
      }

      // Modo abierto: máximo 5 cotizaciones, después se cierra
      const maxCot = mudanza.maxCotizaciones || 5;
      if (mudanza.modoCotizacion !== 'dirigido' && mudanza.cotizaciones.length >= maxCot) {
        mudanza.estado = 'cotizaciones_completas';
        await setJSON(`mudanza:${mudanzaId}`, mudanza, 172800);
        return res.status(400).json({ error: 'Esta mudanza ya recibió las 5 cotizaciones. Llegaste tarde.' });
      }

      const cotizacion = {
        id: 'COT-' + Date.now(),
        mudanzaId, mudanceroEmail, mudanceroNombre, mudanceroTel,
        precio: parseInt(precio),
        precioBase: parseInt(precioBase||precio),
        precioKm: parseInt(precioKm||0),
        distanciaKm: parseInt(distanciaKm||0),
        nota: nota||'',
        tiempoEstimado: tiempoEstimado||'',
        fecha: new Date().toISOString(),
        estado: 'pendiente'
      };
      mudanza.cotizaciones.push(cotizacion);

      // Si con esta cotización llegamos al límite, cerramos automáticamente
      if (mudanza.modoCotizacion !== 'dirigido' && mudanza.cotizaciones.length >= maxCot) {
        mudanza.estado = 'cotizaciones_completas';
      }
      await setJSON(`mudanza:${mudanzaId}`, mudanza, 172800);
      const mudIdx = await getJSON(`mudancero:${mudanceroEmail}`) || [];
      if (!mudIdx.includes(mudanzaId)) mudIdx.push(mudanzaId);
      await setJSON(`mudancero:${mudanceroEmail}`, mudIdx, 2592000);
      try { await notificarCliente(mudanza, cotizacion); } catch(e) { console.error(e.message); }
      return res.status(200).json({ ok: true, cotizacion });
    }

    if (action === 'pdf' && req.method === 'GET') {
      const { mudanzaId, cotizacionId } = req.query;
      if (!mudanzaId || !cotizacionId) return res.status(400).json({ error: 'Faltan parámetros' });
      const mudanza = await getJSON(`mudanza:${mudanzaId}`);
      if (!mudanza) return res.status(404).json({ error: 'Mudanza no encontrada' });
      const cot = mudanza.cotizaciones.find(c => c.id === cotizacionId);
      if (!cot) return res.status(404).json({ error: 'Cotización no encontrada' });
      const pdfBase64 = await generarPDFBase64({
        id:                cot.id,
        fechaEmision:      new Date().toLocaleDateString('es-AR', { day:'numeric', month:'long', year:'numeric' }),
        clienteNombre:     mudanza.clienteNombre,
        clienteEmail:      mudanza.clienteEmail,
        mudanceroNombre:   cot.mudanceroNombre,
        mudancero_initials:(cot.mudanceroNombre||'MV').slice(0,2).toUpperCase(),
        desde:             mudanza.desde,
        hasta:             mudanza.hasta,
        fecha:             mudanza.fecha,
        ambientes:         mudanza.ambientes,
        objetos:           mudanza.servicios,
        extras:            mudanza.extras,
        precio:            cot.precio,
        precioBase:        cot.precioBase,
        precioKm:          cot.precioKm,
        distanciaKm:       cot.distanciaKm || mudanza.distanciaKm || 0,
        nota:              cot.nota,
        tiempoEstimado:    cot.tiempoEstimado,
      });
      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="presupuesto-${cot.id}.pdf"`);
      res.setHeader('Content-Length', pdfBuffer.length);
      return res.status(200).end(pdfBuffer);
    }

    if (action === 'aceptar' && req.method === 'POST') {
      const { mudanzaId, cotizacionId } = req.body;
      const mudanza = await getJSON(`mudanza:${mudanzaId}`);
      if (!mudanza) return res.status(404).json({ error: 'Mudanza no encontrada' });
      const cot = mudanza.cotizaciones.find(c => c.id === cotizacionId);
      if (!cot) return res.status(404).json({ error: 'Cotización no encontrada' });
      mudanza.estado = 'cotizacion_aceptada';
      mudanza.cotizacionAceptada = cot;
      // Agregar datos del cliente para que el mudancero pueda contactarlo
      mudanza.cotizacionAceptada.clienteNombre = mudanza.clienteNombre;
      mudanza.cotizacionAceptada.clienteEmail  = mudanza.clienteEmail;
      cot.estado = 'aceptada';
      await setJSON(`mudanza:${mudanzaId}`, mudanza, 604800);
      try { await enviarEmailAceptacion(mudanza, cot); } catch(e) { console.error('Error email:', e.message); }
      return res.status(200).json({ ok: true, mudanza, cotizacion: cot });
    }

    if (action === 'mis-mudanzas' && req.method === 'GET') {
      const { email } = req.query;
      if (!email) return res.status(400).json({ error: 'Falta email' });
      // ── Verificar sesión si viene token (soft mode hasta integrar frontend) ──
      const token = req.headers['x-session-token'] || req.query.sessionToken;
      if (token) {
        const autenticado = await verificarSesionCliente(email);
        if (!autenticado) return res.status(401).json({ error: 'Sesión inválida' });
      }
      // Sin token: continúa (modo legado — eliminar cuando el frontend esté integrado)
      try {
        const ids = await getJSON(`cliente:${email}`) || [];
        const mudanzas = [];
        for (const id of ids) {
          try { const m = await getJSON(`mudanza:${id}`); if (m) mudanzas.push(m); } catch(e) {}
        }
        return res.status(200).json({ mudanzas });
      } catch(e) { return res.status(200).json({ mudanzas: [] }); }
    }

    // Registrar pago realizado (anticipo o saldo) — llamado desde pago-exitoso
    if (action === 'registrar-pago' && req.method === 'POST') {
      const { mudanzaId, tipoPago, mpPaymentId } = req.body;
      if (!mudanzaId || !tipoPago) return res.status(400).json({ error: 'Faltan datos' });
      // ── Solo se acepta desde la API interna de Mercado Pago (webhook) ──
      // O con un secret interno para el flujo de pago-exitoso
      const internalSecret = req.headers['x-internal-secret'];
      const validSecret = process.env.INTERNAL_API_SECRET;
      if (!validSecret || internalSecret !== validSecret) {
        return res.status(403).json({ error: 'Sin autorización para registrar pagos' });
      }
      const m = await getJSON(`mudanza:${mudanzaId}`);
      if (!m) return res.status(404).json({ error: 'No encontrada' });
      // Verificar que el pago de MP existe y es válido (si viene mpPaymentId)
      if (mpPaymentId && process.env.MP_ACCESS_TOKEN) {
        try {
          const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${mpPaymentId}`, {
            headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` }
          });
          const mpData = await mpRes.json();
          if (mpData.status !== 'approved') {
            return res.status(400).json({ error: 'Pago de MP no aprobado' });
          }
          // Guardar el ID de pago de MP para auditoría
          if (tipoPago === 'anticipo') m.mpAnticipoPagoId = mpPaymentId;
          if (tipoPago === 'saldo')    m.mpSaldoPagoId = mpPaymentId;
        } catch(mpErr) {
          console.warn('No se pudo verificar pago MP:', mpErr.message);
          // Continuar igual — el webhook es la fuente de verdad
        }
      }
      if (tipoPago === 'anticipo') m.anticipoPagado = true;
      if (tipoPago === 'saldo')    m.saldoPagado = true;
      m.ultimoUpdatePago = new Date().toISOString();
      await setJSON(`mudanza:${mudanzaId}`, m, 604800);
      return res.status(200).json({ ok: true });
    }
    if (action === 'cambiar-estado' && req.method === 'POST') {
      const { mudanzaId, estado, mudanceroEmail } = req.body;
      const estadosValidos = ['en_curso', 'completada'];
      if (!mudanzaId || !estado || !estadosValidos.includes(estado)) return res.status(400).json({ error: 'Datos inválidos' });
      const m = await getJSON(`mudanza:${mudanzaId}`);
      if (!m) return res.status(404).json({ error: 'No encontrada' });
      // Verificar que este mudancero es el aceptado
      const cot = m.cotizacionAceptada;
      if (!cot || cot.mudanceroEmail !== mudanceroEmail) return res.status(403).json({ error: 'Sin permiso' });
      // Bloquear si el anticipo no fue pagado
      if (!m.anticipoPagado) return res.status(400).json({ error: 'El cliente aún no pagó el anticipo. No podés avanzar hasta que se confirme el pago.' });
      m.estado = estado;
      if (estado === 'completada') {
        m.fechaCompletada = new Date().toISOString();
        // Loguear en Google Sheets cuando se completa
        try { await logPedidoSheets(m); } catch(e) { console.warn('Sheets log error:', e.message); }
      }
      if (estado === 'en_curso') m.fechaInicio = new Date().toISOString();
      await setJSON(`mudanza:${mudanzaId}`, m, 604800);
      return res.status(200).json({ ok: true, estado });
    }
    if (action === 'eliminar' && req.method === 'POST') {
      const { mudanzaId, clienteEmail } = req.body;
      if (!mudanzaId || !clienteEmail) return res.status(400).json({ error: 'Faltan datos' });
      const m = await getJSON(`mudanza:${mudanzaId}`);
      if (!m) return res.status(404).json({ error: 'No encontrada' });
      if (m.clienteEmail !== clienteEmail) return res.status(403).json({ error: 'Sin permiso' });
      if (m.estado !== 'buscando') return res.status(400).json({ error: 'Solo se pueden eliminar mudanzas buscando cotizaciones' });
      // Marcar como eliminada
      m.estado = 'eliminada';
      await setJSON(`mudanza:${mudanzaId}`, m, 604800);
      // Sacar de la lista activa
      const activas = await getJSON('mudanzas:activas') || [];
      await setJSON('mudanzas:activas', activas.filter(id => id !== mudanzaId), 604800);
      return res.status(200).json({ ok: true });
    }
    // Modo dirigido: cliente invita a mudanceros específicos
    if (action === 'invitar-mudanceros' && req.method === 'POST') {
      const { mudanzaId, clienteEmail: cEmail, mudancerosEmails } = req.body;
      if (!mudanzaId || !cEmail || !mudancerosEmails?.length) return res.status(400).json({ error: 'Faltan datos' });
      const m = await getJSON(`mudanza:${mudanzaId}`);
      if (!m) return res.status(404).json({ error: 'Mudanza no encontrada' });
      if (m.clienteEmail !== cEmail) return res.status(403).json({ error: 'Sin permiso' });
      // Agregar los nuevos invitados (sin duplicar)
      const actuales = m.mudancerosInvitados || [];
      const nuevos = mudancerosEmails.filter(e => !actuales.includes(e));
      m.mudancerosInvitados = [...actuales, ...nuevos];
      m.modoCotizacion = 'dirigido';
      await setJSON(`mudanza:${mudanzaId}`, m, 604800);
      // Notificar a cada mudancero invitado
      for (const emailMud of nuevos) {
        try {
          const perfil = await getJSON(`mudancero:perfil:${emailMud}`);
          if (perfil) await notificarMudanceroInvitado(m, perfil);
        } catch(e) { console.warn('Error notificando mudancero:', e.message); }
      }
      return res.status(200).json({ ok: true, invitados: m.mudancerosInvitados });
    }

    // ── ADMIN: listar todos los mudanceros desde Redis ─────────────
    if (action === 'admin-mudanceros' && req.method === 'GET') {
      const adminEmail = process.env.ADMIN_EMAIL || 'jgalozaldivar@gmail.com';
      const { token } = req.query;
      if (token !== process.env.ADMIN_TOKEN && token !== 'mya-admin-2026') {
        return res.status(403).json({ error: 'Sin permiso' });
      }
      const todos = await getJSON('mudanceros:todos') || [];
      const pendientes = await getJSON('mudanceros:pendientes') || [];
      const lista = [];
      for (const email of todos) {
        try {
          const p = await getJSON(`mudancero:perfil:${email}`);
          if (!p) continue;
          lista.push({
            id: p.id, email: p.email, nombre: p.nombre, empresa: p.empresa || '',
            telefono: p.telefono, cuil: p.cuil || '', zonaBase: p.zonaBase,
            zonasExtra: p.zonasExtra || '', vehiculo: p.vehiculo,
            cantVehiculos: p.cantVehiculos || '1', equipo: p.equipo || '',
            servicios: p.servicios || '', dias: p.dias || '', horarios: p.horarios || '',
            estado: p.estado || 'pendiente',
            fechaRegistro: p.fechaRegistro || '',
            cuilVerificado: p.cuilVerificado || false,
            dniLegible: (p.dniAnalisis || {}).legible || false,
            metodoCobro: p.metodoCobro || '', cbu: p.cbu || '', emailMP: p.emailMP || '',
            extra: p.extra || '',
          });
        } catch(e) { continue; }
      }
      return res.status(200).json({ ok: true, mudanceros: lista, total: lista.length });
    }

    // ── ADMIN: aprobar o rechazar mudancero ────────────────────────
    if (action === 'admin-aprobar-mudancero' && req.method === 'POST') {
      const { token, email, nuevoEstado } = req.body;
      if (token !== process.env.ADMIN_TOKEN && token !== 'mya-admin-2026') {
        return res.status(403).json({ error: 'Sin permiso' });
      }
      if (!email || !['aprobado','rechazado','pendiente'].includes(nuevoEstado)) {
        return res.status(400).json({ error: 'Datos inválidos' });
      }
      const perfil = await getJSON(`mudancero:perfil:${email}`);
      if (!perfil) return res.status(404).json({ error: 'Mudancero no encontrado' });
      perfil.estado = nuevoEstado;
      await setJSON(`mudancero:perfil:${email}`, perfil);
      // Mover de pendientes a todos si se aprueba
      if (nuevoEstado === 'aprobado') {
        const pendientes = await getJSON('mudanceros:pendientes') || [];
        const nuevoPendientes = pendientes.filter(e => e !== email);
        await setJSON('mudanceros:pendientes', nuevoPendientes);
      }
      return res.status(200).json({ ok: true, estado: nuevoEstado });
    }

    // Catálogo público de mudanceros verificados (para modo dirigido)
    if (action === 'catalogo' && req.method === 'GET') {
      const { zona } = req.query;
      const todos = await getJSON('mudanceros:todos') || [];
      const catalogo = [];
      for (const email of todos) {
        try {
          const p = await getJSON(`mudancero:perfil:${email}`);
          if (!p || p.estado !== 'aprobado') continue;
          // Filtrar por zona si se especifica
          if (zona && p.zonaBase && !p.zonaBase.toLowerCase().includes(zona.toLowerCase()) &&
              !(p.zonasExtra||'').toLowerCase().includes(zona.toLowerCase())) continue;
          // Devolver solo datos públicos — sin datos bancarios ni fotos de DNI
          catalogo.push({
            email:              p.email,
            nombre:             p.nombre,
            empresa:            p.empresa       || '',
            zonaBase:           p.zonaBase,
            zonasExtra:         p.zonasExtra    || '',
            vehiculo:           p.vehiculo,
            servicios:          p.servicios     || '',
            calificacion:       p.calificacion  || 0,
            nroResenas:         p.nroResenas    || 0,
            trabajosCompletados: p.trabajosCompletados || 0,
            verificadoIdentidad: p.verificadoIdentidad || false,
            verificadoVehiculo:  p.verificadoVehiculo  || false,
            verificadoSeguro:    p.verificadoSeguro     || false,
            foto:               p.foto          || '',
            fotoCamion:         p.fotoCamion    || '',
            precios:            p.precios       || {},
            horarios:           p.horarios      || '',
            dias:               p.dias          || '',
            anticipacion:       p.anticipacion  || '',
            extra:              p.extra         || '',
          });
        } catch(e) {}
      }
      // Ordenar por calificación desc
      catalogo.sort((a,b) => (b.calificacion - a.calificacion) || (b.trabajosCompletados - a.trabajosCompletados));
      return res.status(200).json({ mudanceros: catalogo });
    }

    if (action === 'rechazar' && req.method === 'POST') {
      const { mudanzaId, mudanceroEmail } = req.body;
      if (!mudanzaId || !mudanceroEmail) return res.status(400).json({ error: 'Faltan datos' });
      // Guardar en lista de rechazados del mudancero para no mostrarlo más
      const rechazados = await getJSON(`rechazados:${mudanceroEmail}`) || [];
      if (!rechazados.includes(mudanzaId)) rechazados.push(mudanzaId);
      await setJSON(`rechazados:${mudanceroEmail}`, rechazados, 604800);
      return res.status(200).json({ ok: true });
    }
    if (action === 'update-wa' && req.method === 'POST') {
      const { email, clienteWA } = req.body;
      if (!email || !clienteWA) return res.status(400).json({ error: 'Faltan datos' });
      try {
        const ids = await getJSON(`cliente:${email}`) || [];
        for (const id of ids) {
          const m = await getJSON(`mudanza:${id}`);
          if (m) {
            m.clienteWA = clienteWA;
            if (m.cotizacionAceptada) m.cotizacionAceptada.clienteWA = clienteWA;
            await setJSON(`mudanza:${id}`, m, 604800);
          }
        }
        return res.status(200).json({ ok: true, updated: ids.length });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    if (action === 'por-zona' && req.method === 'GET') {
      const { email } = req.query;
      const ids = await getJSON('mudanzas:activas') || [];
      const rechazados = email ? (await getJSON(`rechazados:${email}`) || []) : [];
      const disponibles = [];
      const ahora = new Date();
      for (const id of ids) {
        const m = await getJSON(`mudanza:${id}`);
        if (!m || !['buscando','cotizaciones_completas'].includes(m.estado) || new Date(m.expira) < ahora) continue;
        if (m.estado === 'cotizaciones_completas') continue; // ya tiene 5, no mostrar más
        if (m.modoCotizacion === 'dirigido' && email && !(m.mudancerosInvitados||[]).includes(email)) continue; // modo dirigido: solo invitados
        if (email && m.cotizaciones.find(c => c.mudanceroEmail === email)) continue;
        if (rechazados.includes(id)) continue; // ocultar rechazados
        disponibles.push(m);
      }
      return res.status(200).json({ mudanzas: disponibles });
    }

    if (action === 'mis-cotizaciones' && req.method === 'GET') {
      const { email } = req.query;
      // ── Verificar sesión si viene token (soft mode hasta integrar frontend) ──
      const tokenMud = req.headers['x-session-token'] || req.query.sessionToken;
      if (email && tokenMud) {
        const autMud = await verificarSesionMudancero(email);
        if (!autMud) return res.status(401).json({ error: 'Sesión inválida' });
      }
      // Sin token: continúa (modo legado)
      if (!email) return res.status(400).json({ error: 'Falta email' });
      const ids = await getJSON(`mudancero:${email}`) || [];
      const mudanzas = [];
      for (const id of ids) {
        const m = await getJSON(`mudanza:${id}`);
        if (m) mudanzas.push({ ...m, miCotizacion: m.cotizaciones.find(c => c.mudanceroEmail === email) });
      }
      return res.status(200).json({ mudanzas });
    }

    return res.status(400).json({ error: 'Acción no reconocida' });

  } catch(e) {
    console.error('Error en cotizaciones:', e.message);
    return res.status(200).json({ mudanzas: [], error: e.message });
  }
};

// ════════════════════════════════════════════════════
// EMAILS
// ════════════════════════════════════════════════════
async function confirmarPublicacionCliente(mudanza) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  if (!process.env.RESEND_API_KEY || !mudanza.clienteEmail) return;
  const siteUrl = process.env.SITE_URL || 'https://mudateya.ar';
  const esDirigido = mudanza.modoCotizacion === 'dirigido';
  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>',
    to: mudanza.clienteEmail,
    subject: `✅ Tu mudanza está publicada — ${mudanza.desde} → ${mudanza.hasta}`,
    html: `
<div style="font-family:Inter,Arial,sans-serif;max-width:580px;margin:0 auto;background:#ffffff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
  <div style="background:#003580;padding:20px 28px">
    <span style="font-size:20px;font-weight:900;color:#ffffff;letter-spacing:1px">Mudate</span><span style="font-size:20px;font-weight:900;color:#22C36A;letter-spacing:1px">Ya</span>
  </div>
  <div style="padding:28px">
    <h2 style="margin:0 0 8px;font-size:20px;color:#0F1923">¡Tu mudanza está publicada!</h2>
    <p style="font-size:14px;color:#475569;margin:0 0 20px">Hola ${mudanza.clienteNombre || ''}${esDirigido ? ', le enviamos tu pedido directamente al mudancero.' : ', los mudanceros ya pueden verte y cotizarte.'}</p>
    <div style="background:#F4F6F9;border:1px solid #E2E8F0;border-radius:12px;padding:18px;margin-bottom:20px">
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="font-size:11px;color:#94A3B8;font-family:monospace;text-transform:uppercase;letter-spacing:.5px;padding:6px 0;width:35%;border-bottom:1px solid #E2E8F0">Desde</td><td style="font-size:14px;font-weight:600;color:#0F1923;padding:6px 0;border-bottom:1px solid #E2E8F0">${mudanza.desde}</td></tr>
        <tr><td style="font-size:11px;color:#94A3B8;font-family:monospace;text-transform:uppercase;letter-spacing:.5px;padding:6px 0;border-bottom:1px solid #E2E8F0">Hasta</td><td style="font-size:14px;font-weight:600;color:#0F1923;padding:6px 0;border-bottom:1px solid #E2E8F0">${mudanza.hasta}</td></tr>
        <tr><td style="font-size:11px;color:#94A3B8;font-family:monospace;text-transform:uppercase;letter-spacing:.5px;padding:6px 0;border-bottom:1px solid #E2E8F0">Tamaño</td><td style="font-size:14px;color:#0F1923;padding:6px 0;border-bottom:1px solid #E2E8F0">${mudanza.ambientes}</td></tr>
        <tr><td style="font-size:11px;color:#94A3B8;font-family:monospace;text-transform:uppercase;letter-spacing:.5px;padding:6px 0">Fecha</td><td style="font-size:14px;color:#0F1923;padding:6px 0">${mudanza.fecha || 'A confirmar'}</td></tr>
      </table>
    </div>
    <p style="font-size:13px;color:#475569;margin:0 0 20px">⏱ Tu pedido expira en <strong>24 horas</strong>. Te avisamos por email cuando recibas cotizaciones.</p>
    <a href="${siteUrl}/mi-mudanza" style="display:block;text-align:center;background:#1A6FFF;color:#ffffff;padding:14px 24px;border-radius:10px;text-decoration:none;font-size:15px;font-weight:700">Ver mis mudanzas →</a>
  </div>
  <div style="background:#F4F6F9;border-top:1px solid #E2E8F0;padding:14px 28px;text-align:center">
    <p style="font-size:11px;color:#94A3B8;margin:0;font-family:monospace">MudateYa · El marketplace de mudanzas de Argentina</p>
  </div>
</div>`,
  });
}

async function notificarMudanceros(mudanza) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  if (!process.env.RESEND_API_KEY) return;
  const siteUrl = process.env.SITE_URL || 'https://mudateya.ar';
  const expira = new Date(mudanza.expira).toLocaleString('es-AR', { day:'numeric', month:'long', hour:'2-digit', minute:'2-digit' });
  const esDirigido = mudanza.modoCotizacion === 'dirigido';
  const adminEmail = process.env.ADMIN_EMAIL;

  // Construir lista de destinatarios
  let destinatarios = [];

  if (esDirigido) {
    // Modo dirigido: solo los mudanceros invitados
    const invitados = mudanza.mudancerosInvitados || [];
    for (const email of invitados) {
      const perfil = await getJSON(`mudancero:perfil:${email}`);
      if (perfil && perfil.email) destinatarios.push({ email: perfil.email, nombre: perfil.nombre || '' });
    }
  } else {
    // Modo abierto: todos los mudanceros activos, filtrados por zona
    const todos = await getJSON('mudanceros:todos') || [];
    const zonaOrigen = (mudanza.zonaBase || mudanza.desde || '').toLowerCase();

    // Palabras clave de zona para matching
    const zonaKeywords = {
      'caba': ['caba','palermo','belgrano','caballito','flores','almagro','devoto','liniers','san telmo','recoleta','tribunales','microcentro','once'],
      'gba norte': ['san isidro','vicente lopez','tigre','san martin','tres de febrero','norte'],
      'gba sur': ['quilmes','lanus','avellaneda','lomas','sur','florencio varela'],
      'gba oeste': ['moron','merlo','moreno','la matanza','oeste','castelar','haedo'],
      'rosario': ['rosario','santa fe'],
      'cordoba': ['cordoba','córdoba'],
    };

    for (const emailMud of todos) {
      try {
        const perfil = await getJSON(`mudancero:perfil:${emailMud}`);
        if (!perfil || !perfil.email) continue;
        const zonaBase = (perfil.zonaBase || '').toLowerCase();
        const zonasExtra = (perfil.zonasExtra || '').toLowerCase();
        const zonasMud = zonaBase + ' ' + zonasExtra;

        // Verificar si la zona del mudancero matchea con la zona de la mudanza
        let match = false;

        // Match directo
        if (zonaOrigen.includes(zonaBase.split(',')[0]) || zonaBase.includes(zonaOrigen.split(',')[0])) {
          match = true;
        }

        // Match por keywords
        if (!match) {
          for (const [zona, keywords] of Object.entries(zonaKeywords)) {
            const origenEnZona = keywords.some(k => zonaOrigen.includes(k));
            const mudEnZona = keywords.some(k => zonasMud.includes(k)) || zonasMud.includes(zona);
            if (origenEnZona && mudEnZona) { match = true; break; }
          }
        }

        // Si no hay zona definida o no matchea, igual notificar (red pequeña al inicio)
        if (!match && todos.length <= 20) match = true;

        if (match) destinatarios.push({ email: perfil.email, nombre: perfil.nombre || '' });
      } catch(e) { continue; }
    }
  }

  // Siempre notificar al admin como fallback
  if (adminEmail && !destinatarios.find(d => d.email === adminEmail)) {
    destinatarios.push({ email: adminEmail, nombre: 'Admin' });
  }

  if (!destinatarios.length) return;

  // Enviar email a cada destinatario
  for (const dest of destinatarios) {
    try {
      await resend.emails.send({
        from: 'MudateYa <noreply@mudateya.ar>',
        to: dest.email,
        subject: esDirigido
          ? `⭐ Un cliente te eligió — ${mudanza.desde} → ${mudanza.hasta}`
          : `🔥 Nueva mudanza en tu zona — ${mudanza.desde} → ${mudanza.hasta}`,
        html: `
<div style="font-family:Inter,Arial,sans-serif;max-width:580px;margin:0 auto;background:#ffffff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
  <div style="background:#003580;padding:20px 28px;display:flex;align-items:center">
    <span style="font-size:20px;font-weight:900;color:#ffffff;letter-spacing:1px">Mudate</span><span style="font-size:20px;font-weight:900;color:#22C36A;letter-spacing:1px">Ya</span>
    ${esDirigido ? '<span style="margin-left:10px;background:#22C36A;color:#003580;font-size:11px;font-weight:700;padding:3px 8px;border-radius:4px">TE ELIGIERON</span>' : '<span style="margin-left:10px;background:#EF4444;color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:4px">SOLO 5 LUGARES</span>'}
  </div>
  <div style="padding:28px">
    <h2 style="margin:0 0 6px;font-size:18px;color:#0F1923">${esDirigido ? 'Un cliente te eligió directamente' : '🔥 Nueva mudanza en tu zona'}</h2>
    <p style="font-size:13px;color:#475569;margin:0 0 20px">${esDirigido ? 'Este cliente revisó tu perfil y te invitó a cotizar.' : 'Solo los <strong>primeros 5 mudanceros</strong> en cotizar acceden a este pedido. ¡Apurate!'}</p>
    <div style="background:#F4F6F9;border:1px solid #E2E8F0;border-radius:12px;padding:18px;margin-bottom:20px">
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="font-size:11px;color:#94A3B8;font-family:monospace;text-transform:uppercase;letter-spacing:.5px;padding:6px 0;width:35%;border-bottom:1px solid #E2E8F0">Desde</td><td style="font-size:14px;font-weight:600;color:#0F1923;padding:6px 0;border-bottom:1px solid #E2E8F0">${mudanza.desde}</td></tr>
        <tr><td style="font-size:11px;color:#94A3B8;font-family:monospace;text-transform:uppercase;letter-spacing:.5px;padding:6px 0;border-bottom:1px solid #E2E8F0">Hasta</td><td style="font-size:14px;font-weight:600;color:#0F1923;padding:6px 0;border-bottom:1px solid #E2E8F0">${mudanza.hasta}</td></tr>
        <tr><td style="font-size:11px;color:#94A3B8;font-family:monospace;text-transform:uppercase;letter-spacing:.5px;padding:6px 0;border-bottom:1px solid #E2E8F0">Tamaño</td><td style="font-size:14px;color:#0F1923;padding:6px 0;border-bottom:1px solid #E2E8F0">${mudanza.ambientes}</td></tr>
        <tr><td style="font-size:11px;color:#94A3B8;font-family:monospace;text-transform:uppercase;letter-spacing:.5px;padding:6px 0;border-bottom:1px solid #E2E8F0">Fecha</td><td style="font-size:14px;color:#0F1923;padding:6px 0;border-bottom:1px solid #E2E8F0">${mudanza.fecha || 'A confirmar'}</td></tr>
        <tr><td style="font-size:11px;color:#94A3B8;font-family:monospace;text-transform:uppercase;letter-spacing:.5px;padding:6px 0;border-bottom:1px solid #E2E8F0">Estimado</td><td style="font-size:16px;font-weight:700;color:#1A6FFF;padding:6px 0;border-bottom:1px solid #E2E8F0">$${parseInt(mudanza.precio_estimado||0).toLocaleString('es-AR')}</td></tr>
        <tr><td style="font-size:11px;color:#94A3B8;font-family:monospace;text-transform:uppercase;letter-spacing:.5px;padding:6px 0">Expira</td><td style="font-size:13px;color:#F59E0B;font-weight:600;padding:6px 0">${expira}</td></tr>
      </table>
    </div>
    <a href="${siteUrl}/mi-cuenta" style="display:block;text-align:center;background:#1A6FFF;color:#ffffff;padding:14px 24px;border-radius:10px;text-decoration:none;font-size:15px;font-weight:700;letter-spacing:-.2px">${esDirigido ? 'Ver el pedido →' : '⚡ Cotizar ahora →'}</a>
    ${!esDirigido ? '<p style="font-size:12px;color:#EF4444;text-align:center;margin-top:10px;font-weight:600">Solo quedan 5 lugares · Primero en cotizar, primero en ganar</p>' : ''}
  </div>
  <div style="background:#F4F6F9;border-top:1px solid #E2E8F0;padding:14px 28px;text-align:center">
    <p style="font-size:11px;color:#94A3B8;margin:0;font-family:monospace">MudateYa · mudateya.ar</p>
  </div>
</div>`,
      });
    } catch(e) { console.error('Error notificando a ' + dest.email + ':', e.message); }
  }
}

async function notificarCliente(mudanza, cotizacion) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  if (!process.env.RESEND_API_KEY) return;

  // Generar PDF con los datos de la cotización
  let attachments = [];
  try {
    const pdfBase64 = await generarPDFBase64({
      id:                cotizacion.id,
      fechaEmision:      new Date().toLocaleDateString('es-AR', { day:'numeric', month:'long', year:'numeric' }),
      clienteNombre:     mudanza.clienteNombre,
      clienteEmail:      mudanza.clienteEmail,
      mudanceroNombre:   cotizacion.mudanceroNombre,
      mudancero_initials:(cotizacion.mudanceroNombre||'MV').slice(0,2).toUpperCase(),
      desde:             mudanza.desde,
      hasta:             mudanza.hasta,
      fecha:             mudanza.fecha,
      ambientes:         mudanza.ambientes,
      objetos:           mudanza.servicios,
      extras:            mudanza.extras,
      precio:            cotizacion.precio,
      nota:              cotizacion.nota,
    });
    attachments = [{ filename: `cotizacion-${cotizacion.id}.pdf`, content: pdfBase64 }];
  } catch(e) {
    console.error('Error generando PDF cotización:', e.message);
  }

  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>',
    to: mudanza.clienteEmail,
    subject: `💰 Cotización de ${cotizacion.mudanceroNombre} — $${cotizacion.precio.toLocaleString('es-AR')}`,
    html: `<div style="font-family:Inter,Arial,sans-serif;max-width:580px;background:#ffffff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
  <div style="background:#003580;padding:18px 28px">
    <span style="font-size:20px;font-weight:900;color:#ffffff;letter-spacing:1px">Mudate</span><span style="font-size:20px;font-weight:900;color:#22C36A;letter-spacing:1px">Ya</span>
  </div>
      <div style="background:#003580;padding:18px 28px"><h2 style="margin:0;color:#ffffff;font-size:17px">💰 Nueva cotización recibida</h2></div>
      <div style="padding:22px">
        <p style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px"><strong style="color:#0F1923">${cotizacion.mudanceroNombre}</strong> cotizó tu mudanza <strong>${mudanza.desde} → ${mudanza.hasta}</strong></p>
        <div style="background:#F4F6F9;border:1px solid #E2E8F0;border-radius:10px;padding:14px 18px;margin:14px 0">
          <div style="font-size:1.8rem;color:#22C36A;font-weight:700">$${cotizacion.precio.toLocaleString('es-AR')}</div>
          ${cotizacion.tiempoEstimado ? `<div style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-size:12px;margin-top:4px">⏱ ${cotizacion.tiempoEstimado}</div>` : ''}
          ${cotizacion.nota ? `<div style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-size:12px;margin-top:8px;font-style:italic">"${cotizacion.nota}"</div>` : ''}
        </div>
        <p style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-size:13px">Adjuntamos el detalle completo en PDF.</p>
        <a href="https://mudateya.vercel.app/mi-mudanza" style="display:inline-block;background:#1A6FFF;color:#ffffff;padding:13px 24px;border-radius:10px;text-decoration:none;font-weight:700">Ver todas las cotizaciones →</a>
      </div>
    </div>`,
    attachments,
  });
}

async function enviarEmailAceptacion(mudanza, cot) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  if (!process.env.RESEND_API_KEY) return;

  const siteUrl = process.env.SITE_URL || 'https://mudateya.vercel.app';
  const precioFmt = '$' + parseInt(cot.precio).toLocaleString('es-AR');

  // ── 1. Generar link de pago MP ───────────────────
  let linkPago = `${siteUrl}/mi-mudanza`; // fallback
  try {
    const { MercadoPagoConfig, Preference } = require('mercadopago');
    const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
    const preference = new Preference(client);
    const result = await preference.create({ body: {
      items: [{
        id:          `${mudanza.id}-${cot.id}`,
        title:       `MudateYa — Mudanza con ${cot.mudanceroNombre}`,
        description: `${mudanza.desde} → ${mudanza.hasta} · ${mudanza.ambientes}`,
        quantity:    1,
        unit_price:  Number(cot.precio),
        currency_id: 'ARS',
      }],
      back_urls: {
        success: `${siteUrl}/pago-exitoso?mudanzaId=${mudanza.id}&cotizacionId=${cot.id}&monto=${cot.precio}&mudancero=${encodeURIComponent(cot.mudanceroNombre)}`,
        failure: `${siteUrl}/mi-mudanza?pago=error`,
        pending: `${siteUrl}/mi-mudanza?pago=pendiente`,
      },
      auto_return:          'approved',
      statement_descriptor: 'MUDATEYA',
      external_reference:   `${mudanza.id}-${cot.id}`,
      notification_url:     `${siteUrl}/api/webhook-mp`,
      metadata:             { mudanzaId: mudanza.id, cotizacionId: cot.id },
    }});
    linkPago = result.init_point || result.initPoint || linkPago;
  } catch(e) {
    console.error('Error generando link MP:', e.message);
  }

  // ── 2. Generar PDF ───────────────────────────────
  let attachments = [];
  try {
    const pdfBase64 = await generarPDFBase64({
      id:                mudanza.id,
      fechaEmision:      new Date().toLocaleDateString('es-AR', { day:'numeric', month:'long', year:'numeric' }),
      clienteNombre:     mudanza.clienteNombre,
      clienteEmail:      mudanza.clienteEmail,
      mudanceroNombre:   cot.mudanceroNombre,
      mudancero_initials:(cot.mudanceroNombre||'MV').slice(0,2).toUpperCase(),
      desde:             mudanza.desde,
      hasta:             mudanza.hasta,
      fecha:             mudanza.fecha,
      ambientes:         mudanza.ambientes,
      objetos:           mudanza.servicios,
      extras:            mudanza.extras,
      precio:            cot.precio,
      nota:              cot.nota,
    });
    attachments = [{ filename: `cotizacion-${mudanza.id}.pdf`, content: pdfBase64 }];
  } catch(e) {
    console.error('Error generando PDF:', e.message);
  }

  // ── 3. Email al CLIENTE con botón de pago ────────
  if (mudanza.clienteEmail) {
    await resend.emails.send({
      from: 'MudateYa <noreply@mudateya.ar>',
      to: mudanza.clienteEmail,
      subject: `✅ Aceptaste la cotización — Pagá ahora con Mercado Pago`,
      html: `<div style="font-family:Inter,Arial,sans-serif;max-width:580px;background:#ffffff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
  <div style="background:#003580;padding:18px 28px">
    <span style="font-size:20px;font-weight:900;color:#ffffff;letter-spacing:1px">Mudate</span><span style="font-size:20px;font-weight:900;color:#22C36A;letter-spacing:1px">Ya</span>
  </div>
        <div style="background:#003580;padding:18px 28px">
          <h2 style="margin:0;color:#ffffff;font-size:17px">✅ ¡Cotización aceptada!</h2>
        </div>
        <div style="padding:22px">
          <p style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px;line-height:1.7">Hola <strong style="color:#0F1923">${mudanza.clienteNombre}</strong>,</p>
          <p style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px;line-height:1.7">
            Aceptaste la cotización de <strong style="color:#0F1923">${cot.mudanceroNombre}</strong>.
            Para confirmar la mudanza, completá el pago.
          </p>

          <!-- Resumen -->
          <div style="background:#F4F6F9;border:1px solid #E2E8F0;border-radius:10px;padding:14px 18px;margin:14px 0">
            <table style="width:100%">
              <tr><td style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:5px 0;width:35%">Mudancero</td><td><strong>${cot.mudanceroNombre}</strong></td></tr>
              <tr><td style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:5px 0">Teléfono</td><td>${cot.mudanceroTel || '—'}</td></tr>
              <tr><td style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:5px 0">Ruta</td><td>${mudanza.desde} → ${mudanza.hasta}</td></tr>
              <tr><td style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:5px 0">Fecha</td><td>${mudanza.fecha}</td></tr>
              <tr><td style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:5px 0">Ambientes</td><td>${mudanza.ambientes}</td></tr>
              ${cot.nota ? `<tr><td style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:5px 0">Nota</td><td style="font-style:italic">${cot.nota}</td></tr>` : ''}
            </table>
          </div>

          <!-- Precio + botón de pago -->
          <div style="background:#EEF4FF;border:2px solid #1A6FFF;border-radius:12px;padding:20px;margin:20px 0;text-align:center">
            <div style="font-size:13px;color:#475569;margin-bottom:6px;text-transform:uppercase;letter-spacing:1px">Total a pagar</div>
            <div style="font-size:2.5rem;font-weight:700;color:#1A6FFF;margin-bottom:16px">${precioFmt}</div>
            <a href="${linkPago}"
               style="display:inline-block;background:#009EE3;color:white;padding:14px 36px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px;letter-spacing:.3px">
              💳 Pagar con Mercado Pago
            </a>
            <p style="color:#94A3B8;font-size:11px;margin-top:12px;margin-bottom:0">
              🔒 Pago 100% seguro · MudateYa retiene el monto hasta confirmar el servicio
            </p>
          </div>

          <p style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-size:13px">
            También podés acceder desde
            <a href="${siteUrl}/mi-mudanza" style="color:#22C36A">tu panel de mudanzas</a>.
          </p>
          <div style="background:#FFF8E6;border:1px solid #F59E0B;border-left:4px solid #F59E0B;border-radius:8px;padding:12px 14px;margin:16px 0">
            <p style="color:#92400E;font-size:12px;margin:0;line-height:1.6">
              <strong>⚠ Importante:</strong> MudateYa garantiza y protege exclusivamente los pagos realizados a través de su plataforma. Cualquier pago acordado fuera de la plataforma (efectivo, transferencia directa u otro medio) queda fuera de las garantías de MudateYa. Ante conflictos por pagos externos, MudateYa no podrá intervenir ni compensar. Para tu protección, pagá siempre a través de MudateYa.
            </p>
          </div>
          <p style="color:#94A3B8;font-size:11px">
            Adjuntamos el comprobante de cotización en PDF para tus registros.
          </p>
        </div>
      </div>`,
      attachments,
    });
  }

  // ── 4. Email al MUDANCERO ────────────────────────
  if (cot.mudanceroEmail) {
    await resend.emails.send({
      from: 'MudateYa <noreply@mudateya.ar>',
      to: cot.mudanceroEmail,
      subject: `🎉 ¡Aceptaron tu cotización! — ${mudanza.desde} → ${mudanza.hasta}`,
      html: `<div style="font-family:Inter,Arial,sans-serif;max-width:580px;background:#ffffff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
  <div style="background:#003580;padding:18px 28px">
    <span style="font-size:20px;font-weight:900;color:#ffffff;letter-spacing:1px">Mudate</span><span style="font-size:20px;font-weight:900;color:#22C36A;letter-spacing:1px">Ya</span>
  </div>
        <div style="background:#003580;padding:18px 28px">
          <h2 style="margin:0;color:#ffffff;font-size:17px">🎉 ¡Te eligieron!</h2>
        </div>
        <div style="padding:22px">
          <p style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px;line-height:1.7">
            <strong style="color:#0F1923">${mudanza.clienteNombre}</strong> aceptó tu cotización.
            Te avisaremos cuando confirme el pago.
          </p>
          <div style="background:#F4F6F9;border:1px solid #E2E8F0;border-radius:10px;padding:14px 18px;margin:14px 0">
            <table style="width:100%">
              <tr><td style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:5px 0;width:35%">Ruta</td><td>${mudanza.desde} → ${mudanza.hasta}</td></tr>
              <tr><td style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:5px 0">Fecha</td><td>${mudanza.fecha}</td></tr>
              <tr><td style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:5px 0">Tamaño</td><td>${mudanza.ambientes}</td></tr>
              <tr><td style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:5px 0">Precio acordado</td><td style="color:#22C36A;font-weight:700">${precioFmt}</td></tr>
            </table>
          </div>
          <div style="background:#EEF4FF;border:1px solid #E2E8F0;border-radius:10px;padding:14px 18px;margin-bottom:14px">
            <p style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-size:13px;margin:0">
              💡 <strong style="color:#0F1923">¿Cuándo recibís el pago?</strong><br>
              MudateYa procesa las liquidaciones cada <strong style="color:#22C36A">15 días hábiles</strong>
              una vez confirmada la mudanza.
            </p>
          </div>
          <a href="${siteUrl}/mi-cuenta" style="display:inline-block;background:#1A6FFF;color:#ffffff;padding:13px 24px;border-radius:10px;text-decoration:none;font-weight:700">
            Ver en mi panel →
          </a>
        </div>
      </div>`,
      attachments,
    });
  }
}

// ════════════════════════════════════════════════════
// EMAIL — MUDANCERO INVITADO (modo dirigido)
// ════════════════════════════════════════════════════
async function notificarMudanceroInvitado(mudanza, perfil) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  if (!process.env.RESEND_API_KEY || !perfil.email) return;
  const siteUrl = process.env.SITE_URL || 'https://mudateya.vercel.app';
  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>',
    to:   perfil.email,
    subject: `⭐ Te eligieron — ${mudanza.desde} → ${mudanza.hasta}`,
    html: `<div style="font-family:Inter,Arial,sans-serif;max-width:580px;background:#ffffff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
  <div style="background:#003580;padding:18px 28px">
    <span style="font-size:20px;font-weight:900;color:#ffffff;letter-spacing:1px">Mudate</span><span style="font-size:20px;font-weight:900;color:#22C36A;letter-spacing:1px">Ya</span>
  </div>
      <div style="background:#22C36A;padding:18px 22px">
        <h2 style="margin:0;color:#041A0E">⭐ ¡Un cliente te eligió!</h2>
      </div>
      <div style="padding:22px">
        <p style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px;line-height:1.7">
          Hola <strong style="color:#0F1923">${perfil.nombre}</strong>,<br>
          <strong style="color:#0F1923">${mudanza.clienteNombre || 'Un cliente'}</strong> revisó tu perfil y te invitó a cotizar su mudanza.
        </p>
        <div style="background:#F4F6F9;border:1px solid #E2E8F0;border-radius:10px;padding:14px 18px;margin:14px 0">
          <table style="width:100%">
            <tr><td style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:5px 0;width:35%">De</td><td><strong>${mudanza.desde}</strong></td></tr>
            <tr><td style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:5px 0">A</td><td><strong>${mudanza.hasta}</strong></td></tr>
            <tr><td style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:5px 0">Tamaño</td><td>${mudanza.ambientes || '—'}</td></tr>
            <tr><td style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:5px 0">Fecha</td><td>${mudanza.fecha || '—'}</td></tr>
            ${mudanza.precio_estimado ? `<tr><td style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:5px 0">Estimado cliente</td><td style="color:#22C36A;font-weight:700">$${parseInt(mudanza.precio_estimado).toLocaleString('es-AR')}</td></tr>` : ''}
          </table>
        </div>
        <div style="background:#EEF4FF;border:1px solid #C7D9FF;border-radius:10px;padding:12px 16px;margin-bottom:16px">
          <p style="color:#94A3B8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-size:13px;margin:0">
            💡 Esta es una solicitud <strong style="color:#0F1923">directa</strong> — el cliente te eligió a vos específicamente entre los mudanceros disponibles.
          </p>
        </div>
        <a href="${siteUrl}/mi-cuenta" style="display:inline-block;background:#1A6FFF;color:#ffffff;padding:13px 24px;border-radius:10px;text-decoration:none;font-weight:700">
          Enviar cotización →
        </a>
      </div>
    </div>`,
  });
}

// ════════════════════════════════════════════════════
// GOOGLE SHEETS — LOG DE MUDANZAS COMPLETADAS
// ════════════════════════════════════════════════════
async function logPedidoSheets(mudanza) {
  const webhookUrl = process.env.GOOGLE_SHEETS_PEDIDOS_URL;
  if (!webhookUrl) return;

  const cot = mudanza.cotizacionAceptada || {};
  const esFlete = mudanza.tipo === 'flete' || mudanza.ambientes === 'Flete';
  const feePct = esFlete ? 0.20 : 0.15;
  const precio = parseInt(cot.precio || 0);
  const fee = Math.round(precio * feePct);
  const neto = precio - fee;

  const fmt = (n) => n ? '$' + parseInt(n).toLocaleString('es-AR') : '—';
  const fmtFecha = (iso) => iso ? new Date(iso).toLocaleString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires'
  }) : '—';

  const row = {
    ID:                mudanza.id,
    'Fecha publicación': fmtFecha(mudanza.fechaPublicacion),
    'Fecha completada':  fmtFecha(mudanza.fechaCompletada),
    Tipo:              (mudanza.tipo || 'mudanza').toUpperCase(),
    Desde:             mudanza.desde,
    Hasta:             mudanza.hasta,
    Ambientes:         mudanza.ambientes || '—',
    Objeto:            mudanza.servicios || '—',
    Cliente:           mudanza.clienteNombre || '—',
    'Email cliente':   mudanza.clienteEmail || '—',
    'Celular cliente': mudanza.clienteWA || '—',
    Mudancero:         cot.mudanceroNombre || '—',
    'Email mudancero': cot.mudanceroEmail || '—',
    'Tel mudancero':   cot.mudanceroTel || '—',
    'Precio total':    fmt(precio),
    'Fee MudateYa':    fmt(fee),
    'Neto mudancero':  fmt(neto),
    '% Fee':           esFlete ? '20%' : '15%',
    'Anticipo pagado': mudanza.anticipoPagado ? 'SI' : 'NO',
    'Saldo pagado':    mudanza.saldoPagado    ? 'SI' : 'NO',
    Estado:            'COMPLETADA',
  };

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(row),
  });
}

