// api/enviar-invitacion-mudanceros.js
// ── ONE-OFF (solo admin) ──
// Invita a empresas de mudanza/fletes de AMBA, Córdoba y Rosario (encontradas
// por prospección web, no son clientes actuales) a sumarse como mudanceros
// verificados en MudateYa. Mail genérico desde hola@mudateya.ar, CTA a
// /mudanceros.
//
// DEDUP contra mudanceros que YA están en la plataforma (para no invitar a
// alguien que ya se registró): antes de mandar, chequea en Redis
//   1) si existe mudancero:perfil:{email}  (dedup por mail)
//   2) si el teléfono matchea mudanceros:tel8-idx (dedup por WhatsApp/tel,
//      últimos 8 dígitos — mismo índice que usa el bot de WhatsApp)
// Si cualquiera de los dos matchea, se saltea (no se manda).
//
// IDEMPOTENCIA propia de esta campaña: guarda los emails ya invitados en
// Redis (clave invitacion-mudanceros:enviados). Si se corre de nuevo, no
// duplica.
//
// SEGURIDAD: admin con ?token=ADMIN_TOKEN, o Vercel Cron (header Authorization
// Bearer CRON_SECRET — mismo mecanismo que enviar-propuesta-remax.js).
//   GET ?token=…              → DRY: cuenta pendientes/enviados/ya-mudanceros, NO envía nada.
//   GET ?token=…&test=x@y.com → envía UNA muestra a esa dirección (no marca, no chequea dedup).
//   GET ?token=…&apply=1      → ENVÍA a los pendientes (una sola corrida).
//   SIN cron de Vercel a propósito (se sacó de vercel.json el 2026-08-10 al sumar la tanda
//   de 105 prospectos AMBA) — así no se manda nada solo al deployar; el envío es siempre manual
//   vía ?apply=1. Si en algún momento se quiere volver a automatizar, agregar de nuevo la entrada
//   { "path": "/api/enviar-invitacion-mudanceros", "schedule": "..." } en vercel.json (idempotente,
//   no reenvía a quien ya se le mandó).

const { Resend } = require('resend');
const { esAdmin, esCronVercel } = require('./_auth');
const { linkBaja } = require('./_baja');

async function redisCall(method, args) {
  var url = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  var r = await fetch(url + '/' + method + '/' + args.map(encodeURIComponent).join('/'), {
    headers: { Authorization: 'Bearer ' + token }
  });
  var data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}
async function getJSON(k) { var v = await redisCall('get', [k]); if (!v) return null; try { return JSON.parse(v); } catch(e) { return null; } }
async function setJSON(k, v) { return redisCall('set', [k, JSON.stringify(v)]); }

function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim()); }
function esc(s) { return String(s || '').replace(/[<>&"]/g, function(c){ return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]; }); }
function chunk(arr, size) { var out = []; for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; }

// Saca todas las secuencias numéricas "tipo teléfono" de un string libre
// (puede traer varios números separados por "/", prefijos, "WhatsApp", etc.)
// y devuelve los últimos 8 dígitos de cada una — mismo criterio que
// mudanceros:tel8-idx.
function telefonosCandidatos(raw) {
  var out = [];
  var matches = String(raw || '').match(/\d[\d\s().-]{5,}\d/g) || [];
  matches.forEach(function(m) {
    var digits = m.replace(/\D/g, '');
    if (digits.length >= 8) out.push(digits.slice(-8));
  });
  return out;
}

var CLAVE_ENVIADOS = 'invitacion-mudanceros:enviados';

// ── Prospectos: empresas de mudanza/fletes en AMBA, Córdoba y Rosario ──
// Encontrados por búsqueda web (sitio propio de cada empresa), NO son
// mudanceros ya registrados en MudateYa — eso se chequea aparte en caliente
// contra Redis (ver yaEsMudancero). Solo incluye los que tienen email
// confirmado en su propia web (se descartaron ~49 que solo tenían
// teléfono/WhatsApp — esos van por otro canal, no por este script).
// Quedaron afuera por dato dudoso (revisar a mano si se quiere sumar):
//   - Cassandra Moving (cassandramooving@gmail.com, posible typo vs. dominio)
//   - Flete Master Rosario (email visto solo en snippet de búsqueda, no confirmado en el sitio)
var PROSPECTOS = [
  // AMBA
  { n: 'Vía MG', region: 'AMBA', e: 'viamg2015@gmail.com', tel: '11 6622-6123' },
  { n: 'Fletes Balvanera', region: 'AMBA', e: 'info@fletesbalvanera.com.ar', tel: '11 6860-3466' },
  { n: 'Fletes Ya', region: 'AMBA', e: 'contacto@fletesya.com.ar', tel: '+54 11 3221-0924' },
  { n: 'Fletes Baires', region: 'AMBA', e: 'hola@fletesbaires.com', tel: '(+5411) 4146-6082' },
  { n: 'Retroflet', region: 'AMBA', e: 'reservas@retroflet.com.ar', tel: '11 5639-0253 / 11 2040-1113' },
  { n: 'Transportes Vintage', region: 'AMBA', e: 'transportesvintage@gmail.com', tel: '11 5095-3053' },
  { n: 'Fletes y Mudanzas Nelson', region: 'AMBA', e: 'info@fletesymudanzasnelson.com.ar', tel: '011 4931-9102 / 11 6300-8580' },
  { n: 'Mudanzas Capital', region: 'AMBA', e: 'info@mudanzascapital.com.ar', tel: '011 4931-8570' },
  { n: 'Logística Almagro', region: 'AMBA', e: 'info@almagrologistica.com.ar', tel: '11 2176-4640' },
  { n: 'Mudanzas Norte', region: 'AMBA', e: 'contacto@mudanzasnorte.com.ar', tel: '11 4030-1055' },
  { n: 'Transporte SC', region: 'AMBA', e: 'info@transporte-sc.com.ar', tel: '11 6095-1997' },
  { n: 'Mudanzas Independencia', region: 'AMBA', e: 'info@mudanzasindependencia.com.ar', tel: '4931-8570 / 11-4055-3982' },
  { n: 'Transportes Argentinos', region: 'AMBA', e: 'info@transportesargentinos.com.ar', tel: '011 5263-0443' },
  // Córdoba
  { n: 'Mudanzas Nueva Córdoba', region: 'Córdoba', e: 'mudanzasnuevacordoba@gmail.com', tel: '+54 9 351 811-7933' },
  { n: 'Fu Fletes', region: 'Córdoba', e: 'fletesfu@hotmail.com', tel: '(0351) 471-7271 / +54 9 351 619-6876' },
  { n: 'CordobaFletes.com.ar', region: 'Córdoba', e: 'die60cr@gmail.com', tel: '0351 15-385-0577' },
  { n: 'Fletes Cor Mudanzas', region: 'Córdoba', e: 'info@fletescor.com', tel: '+54 9 351 340-4918' },
  { n: 'Grupo Fletes Córdoba', region: 'Córdoba', e: 'fletescordoba.ar@gmail.com', tel: '+54 9 351 818-7650' },
  { n: 'Cor-Flet', region: 'Córdoba', e: 'cor-flet@hotmail.com', tel: '351 274-1711' },
  { n: 'Mudanzas Acuario', region: 'Córdoba', e: 'mudanzasacuario@hotmail.com', tel: '(0351) 695-0035 / (0351) 15-612-9602' },
  // Rosario
  { n: 'Mudanzas Ya Rosario', region: 'Rosario', e: 'info@mudanzasyarosario.com.ar', tel: '+54 341 5103104 / +54 341 3342392' },
  { n: 'Bannelli Mudanzas', region: 'Rosario', e: 'mudanzasbannelli@hotmail.com', tel: '(0341) 154 68-1298 / 454-6657' },
  { n: 'Mudanzas América', region: 'Rosario', e: 'info@mudanzasamerica.com.ar', tel: '(0341) 156 585 606 / 156 847 739' },
  { n: 'Fletes Rosario', region: 'Rosario', e: 'miguelpulidook@gmail.com', tel: '341-209-3808' },
  { n: 'Fletes E&M', region: 'Rosario', e: 'fleteseymrosario@gmail.com', tel: '(0341) 155954223 / 156894869' },
  { n: 'Fletes Zona Norte', region: 'Rosario', e: 'info@fletes-zonanorte.com.ar', tel: '4793-1436 / 15-6802-8251' },
  { n: 'Mudanzas España', region: 'Rosario', e: 'contacto@mudanzasrosario.online', tel: '(0341) 482-3815 / 552-2322' },
  // ── AMBA — barrida exhaustiva 2026-08-10 (92 nuevos, dedupeados contra los de arriba) ──
  { n: 'Mudanzas Palmo', region: 'AMBA', e: 'contacto@palmomudanzas.com', tel: '11-6629-2391', zona: 'Palermo y Chacarita' },
  { n: 'Fletes André', region: 'AMBA', e: 'contacto@fletesandre.com.ar', tel: '11-6935-6292', zona: '' },
  { n: 'Fletes y Mudanzas Pedro', region: 'AMBA', e: 'mudanzasencapitalfederal@gmail.com', tel: '011 3874-5405', zona: 'Palermo' },
  { n: 'Empresa de Mudanzas La Fuerza', region: 'AMBA', e: 'mudanzapablodiaz@gmail.com', tel: '11 6751-4176', zona: 'Palermo y Belgrano' },
  { n: 'Fletes.net.ar', region: 'AMBA', e: 'info@fletes.net.ar', tel: '11 7080-0313', zona: '' },
  { n: 'Abel Flet Transportes', region: 'AMBA', e: 'info@abeltransportes.com.ar', tel: '11-4757-1274', zona: '' },
  { n: 'Fletes y Mudanzas El Milenio', region: 'AMBA', e: 'cargaselmilenio@hotmail.com', tel: '', zona: 'Monserrat' },
  { n: 'Fletes Independencia', region: 'AMBA', e: 'mudanzascapitalfederal@gmail.com', tel: '4931-7208', zona: 'Boedo y Almagro' },
  { n: 'Miniflete', region: 'AMBA', e: 'info@miniflete.com.ar', tel: '+54 9 11 6962 0764', zona: 'Saavedra y Belgrano' },
  { n: 'Mudanzas Los Castillos', region: 'AMBA', e: 'mudanzasloscastillos@gmail.com', tel: '11 3139-4320', zona: 'Belgrano y Nuñez' },
  { n: 'Rapiflet', region: 'AMBA', e: 'info@rapiflet.com', tel: '', zona: 'Villa Crespo y Villa del Parque' },
  { n: 'Mudanzas y Fletes 2001', region: 'AMBA', e: 'fletesymudanzas2001@yahoo.com.ar', tel: '011 4304-1393', zona: 'San Telmo y Barracas' },
  { n: 'Minifletes.net', region: 'AMBA', e: 'info@minifletes.net', tel: '11-2774-2927', zona: '' },
  { n: 'Fletes CABA (fletescaba.com.ar)', region: 'AMBA', e: 'info@fletescaba.com.ar', tel: '+54 9 11 4991-9813', zona: '' },
  { n: 'Palermo Express', region: 'AMBA', e: 'administracion@palermoexpress.com.ar', tel: '+5491133912022', zona: 'Palermo' },
  { n: 'Fletes y Mudanzas Ricardo', region: 'AMBA', e: 'consultas@fletesymudanzasricardo.com', tel: '011 15 4940 5668', zona: 'Caballito' },
  { n: 'Caballito Mudanzas', region: 'AMBA', e: 'mudanzascaballito@gmail.com', tel: '011 15 35967724', zona: 'Caballito' },
  { n: 'Fletes - Transportes y Mudanzas Perales', region: 'AMBA', e: 'transporteperales617@gmail.com', tel: '011 4166-6033', zona: 'Flores' },
  { n: 'Fletes y Mudanzas CABA (Home Mover)', region: 'AMBA', e: 'sebtrincheri@gmail.com', tel: '+54 11 3065-6869', zona: 'Flores' },
  { n: 'Fletes Zona Norte', region: 'AMBA', e: 'info@fletes-zonanorte.com.ar', tel: '15-6802-8251', zona: 'San Isidro' },
  { n: 'Mudanzas Sanchez', region: 'AMBA', e: 'consultas@mudanzas-sanchez.com', tel: '11-2354-7155', zona: 'San Isidro' },
  { n: 'AlmaFlet', region: 'AMBA', e: 'info@almaflet.com.ar', tel: '+54 9 11 3936-4929', zona: 'Vicente López' },
  { n: 'Fletes y Mudanzas Julio', region: 'AMBA', e: 'fletesjulio@hotmail.com', tel: '011 15-3547-8407', zona: 'Escobar' },
  { n: 'Fletes Olivos', region: 'AMBA', e: 'info@fletesolivos.com.ar', tel: '011-4797-1073', zona: 'Olivos y Vicente López' },
  { n: 'Mudanzas Martinz Hnos S.A.', region: 'AMBA', e: 'martinzmudanzas@gmail.com', tel: '11 4078-2767', zona: 'Martínez y Olivos' },
  { n: 'Armenia Mudanzas', region: 'AMBA', e: 'info@mudanzasarmenia.com.ar', tel: '4756-6669', zona: 'Munro y Vicente López' },
  { n: 'Fletes Fleche', region: 'AMBA', e: 'fletesfleche@gmail.com', tel: '4459-8960', zona: 'Hurlingham' },
  { n: 'Hurling-Fleet (Fletes Me)', region: 'AMBA', e: 'fletesme@hotmail.com', tel: '15-5932-4391', zona: 'Hurlingham' },
  { n: 'Minifletes Franco', region: 'AMBA', e: 'transportefranco@live.com.ar', tel: '15-3927-6294', zona: 'San Miguel y Bella Vista' },
  { n: 'Mudarte', region: 'AMBA', e: 'consultas@mudarte.com.ar', tel: '11 3200-2023', zona: 'Olivos y Vicente López' },
  { n: 'Fletes San Isidro (fletes-sanisidro.com.ar)', region: 'AMBA', e: 'zonanortefletes@gmail.com', tel: '+54 911 6802-8251', zona: 'San Isidro y Olivos' },
  { n: 'Transporte San Isidro (fletesanisidro.com.ar)', region: 'AMBA', e: 'fletesanisidro@gmail.com', tel: '2153-0674', zona: 'San Isidro y Victoria' },
  { n: 'Full Express Mensajería y Minifletes', region: 'AMBA', e: 'fullexpress.pilar@gmail.com', tel: '+54 9 11 5185-3339', zona: 'Pilar' },
  { n: 'Boxes Pilar (Guardamuebles y Fletes)', region: 'AMBA', e: 'guardaboxespilar@hotmail.com', tel: '02304-424775', zona: 'Pilar' },
  { n: 'Logística Integral Ariel', region: 'AMBA', e: 'logistica.oscariz17@gmail.com', tel: '11 2216-0942', zona: 'Pilar' },
  { n: 'La Mudanza', region: 'AMBA', e: 'lamudanzamudanzas@gmail.com', tel: '11-2553-5500', zona: 'Pilar y Del Viso' },
  { n: 'Fletes San Fernando', region: 'AMBA', e: 'fletessanfernandook@hotmail.com', tel: '11 4528-7983', zona: 'San Fernando' },
  { n: 'Transgrama S.A.', region: 'AMBA', e: 'transgramasa@live.com.ar', tel: '011 4651-3919', zona: 'San Justo' },
  { n: 'Mudanzas Loza', region: 'AMBA', e: 'transporte.loza22@gmail.com', tel: '(11) 2738-9589', zona: 'Tres de Febrero y San Martín' },
  { n: 'Cassandra Moving', region: 'AMBA', e: 'cassandramooving@gmail.com', tel: '11-4162-4460', zona: '' },
  { n: 'Fletes de Morón', region: 'AMBA', e: 'fletesdemoron@gmail.com', tel: '', zona: 'Morón' },
  { n: 'Transporte Sena', region: 'AMBA', e: 'transportesena.ok@gmail.com', tel: '+54 9 11 5935-4309', zona: 'Ituzaingó' },
  { n: 'Fletes y Mudanzas Moreno', region: 'AMBA', e: 'edubarreto_125_@hotmail.com', tel: '', zona: 'Moreno' },
  { n: 'Fletes Andrés', region: 'AMBA', e: 'fletesandres@hotmail.com.ar', tel: '11-3274-2154', zona: 'General Rodríguez' },
  { n: 'Tesei Fletes', region: 'AMBA', e: 'tesei_fletes@hotmail.com', tel: '4459-0694', zona: 'Villa Tesei' },
  { n: 'Fletes fletes (Merlo)', region: 'AMBA', e: 'mg.v2008@hotmail.com', tel: '+54 9 11 6758-1496', zona: 'Merlo' },
  { n: 'Mini Fletes Fernando', region: 'AMBA', e: 'miniflete.fernando@gmail.com', tel: '', zona: '' },
  { n: 'Mini Fletes Ramos Mejía', region: 'AMBA', e: 'alejobrandsen1009@gmail.com', tel: '+54 9 11 6105-7718', zona: 'Ramos Mejía y San Justo' },
  { n: 'Fletes Constitución', region: 'AMBA', e: 'fletes@fletesconstitucion.com.ar', tel: '7700-0027', zona: 'Constitución' },
  { n: 'Mudanzas Atenas', region: 'AMBA', e: 'info@mudanzasatenas.com.ar', tel: '011 4942-4899', zona: 'Caballito y Belgrano' },
  { n: 'PedidosFletes.com', region: 'AMBA', e: 'hola@pedidosfletes.com', tel: '7530-7197', zona: '' },
  { n: 'Fletes Pablo (Villa Devoto)', region: 'AMBA', e: 'dominguez_logistica@hotmail.com', tel: '+54 11 5029-6214', zona: 'Villa Devoto' },
  { n: 'Fletes Whitys', region: 'AMBA', e: 'fleteswhitys@gmail.com', tel: '+54 11-2341-1735', zona: '' },
  { n: 'Verga Hnos SRL', region: 'AMBA', e: 'contacto@vergahnos.com.ar', tel: '(011) 4862-6866', zona: 'Almagro' },
  { n: 'TuSenvios', region: 'AMBA', e: 'tusenviosok@hotmail.com', tel: '15-5990-3718', zona: 'Abasto y Almagro' },
  { n: 'Mudanzas Gaston', region: 'AMBA', e: 'info@mudanzasgaston.com.ar', tel: '+54 9 11 5141-8195', zona: '' },
  { n: 'Abad Mudanzas SRL', region: 'AMBA', e: 'info@abadmudanzas.com.ar', tel: '(011) 4854-0470', zona: '' },
  { n: 'Mudanzas Balvanera (independiente)', region: 'AMBA', e: 'mudanzasbalvanera@gmail.com', tel: '11 3366-0318', zona: 'Balvanera' },
  { n: 'Transporte Almagro', region: 'AMBA', e: 'info@transportealmagro.com.ar', tel: '011 4982-8128', zona: 'Almagro' },
  { n: 'Art Fletes al Instante', region: 'AMBA', e: 'consultas@artfletes.com', tel: '(011) 4574-0604', zona: 'Villa Pueyrredón' },
  { n: 'Transporte Nikita', region: 'AMBA', e: 'camionesxhora@gmail.com', tel: '011 4583-6492', zona: 'Agronomía y Villa General Mitre' },
  { n: 'Fletes Falcón', region: 'AMBA', e: 'martinez00gladis@gmail.com', tel: '+54 9 11 3227-1399', zona: 'Lomas de Zamora' },
  { n: 'Fletes y Mudanzas Lucio', region: 'AMBA', e: 'fletesymudanzaslucio@gmail.com', tel: '+54 11 3848-4293', zona: 'Avellaneda y Quilmes' },
  { n: 'Fletes Zona Sur', region: 'AMBA', e: 'fletesymudanzaszonasur@gmail.com', tel: '', zona: 'Lanús' },
  { n: 'Fletes Galassi (Transporte HyL)', region: 'AMBA', e: 'galassihyl@hotmail.com', tel: '', zona: 'Lomas de Zamora' },
  { n: 'Fletes y Mudanzas Rodo', region: 'AMBA', e: 'fletesrodo@gmail.com', tel: '+54 9 11 6988-3339', zona: 'Berazategui' },
  { n: 'Transporte Nesci', region: 'AMBA', e: 'transportenesci@hotmail.com', tel: '11-6639-2699', zona: 'Ezeiza' },
  { n: 'Fletes Pico', region: 'AMBA', e: 'rosylombar_do@hotmail.com', tel: '+54 11 5943-7974', zona: 'Adrogué' },
  { n: 'Fletes Sur (Burzaco)', region: 'AMBA', e: 'info@fletessur.com', tel: '+54 9 11 3045-0618', zona: 'Burzaco y Almirante Brown' },
  { n: 'El Poco a Poco', region: 'AMBA', e: 'consultas@elpocoapoco.com.ar', tel: '(011) 4242-4182', zona: 'Banfield' },
  { n: 'Adrogué Antonio Mudanzas', region: 'AMBA', e: 'mudanzasantonio2013@gmail.com', tel: '(011) 4294-9780', zona: 'Adrogué' },
  { n: 'Mudanzas Integrales (Fletes y Mudanzas del Sur)', region: 'AMBA', e: 'fletesymudanzasdelsur@gmail.com', tel: '(011) 15-2362-5334', zona: 'Almirante Brown' },
  { n: 'Agencia de Fletes Quilmes', region: 'AMBA', e: 'fletesquilmes@gmail.com', tel: '+54 11 4257-6622', zona: 'Quilmes' },
  { n: 'Transpato Mudanzas', region: 'AMBA', e: 'alejandroriscino@yahoo.com.ar', tel: '', zona: 'Adrogué y Almirante Brown' },
  { n: 'Mudadora Fletes Argentina', region: 'AMBA', e: 'fletesargentinaok@gmail.com', tel: '0221 618-7887', zona: 'La Plata y alrededores' },
  { n: 'Fletes Capital', region: 'AMBA', e: 'info@fletes-capital.com.ar', tel: '011 3874-5405', zona: '' },
  { n: 'FleteBA', region: 'AMBA', e: 'contacto@fleteba.com', tel: '+54 9 11 3341 4606', zona: '' },
  { n: 'Movar Group', region: 'AMBA', e: 'moving@movargroup.com', tel: '+54 11 2008-3420', zona: 'San Isidro' },
  { n: 'Logistica Torito', region: 'AMBA', e: 'logisticatorito@gmail.com', tel: '+54 11 5693-2292', zona: 'Quilmes Oeste' },
  { n: 'Fletex', region: 'AMBA', e: 'fletexarg@gmail.com', tel: '+54 9 11 6028-2620', zona: '' },
  { n: 'Fletes Pachy', region: 'AMBA', e: 'fletespachy@gmail.com', tel: '11 3042-7778', zona: '' },
  { n: 'Fletes Ariel', region: 'AMBA', e: 'mudanzasariel2025@gmail.com', tel: '11 2005-2968', zona: '' },
  { n: 'BeraExpress', region: 'AMBA', e: 'clientes@beraexpress.com', tel: '11 6062-6490', zona: 'Berazategui y Ranelagh' },
  { n: 'Rapiflete', region: 'AMBA', e: 'info@rapiflete.ar', tel: '115 327-1226', zona: '' },
  { n: 'Fletes Benjamin', region: 'AMBA', e: 'fletesbenjamin@hotmail.com.ar', tel: '+54 9 11 5657-0330', zona: '' },
  { n: 'Gaona Fletes', region: 'AMBA', e: 'fletes@gaonafletes.com.ar', tel: '4005-4149', zona: '' },
  { n: 'Nahuel Flet', region: 'AMBA', e: 'info@nahuelflet.com.ar', tel: '011 4864-8417', zona: '' },
  { n: 'TuFlete', region: 'AMBA', e: 'contacto@tuflete.com.ar', tel: '+54 9 11 6689-2228', zona: 'Villa Lugano' },
  { n: '24 Baires', region: 'AMBA', e: 'mudanzasencaba@gmail.com', tel: '+54 9 11 2540-1208', zona: '' },
  { n: 'Medrano Flet', region: 'AMBA', e: 'leyvarafael_01@hotmail.com', tel: '4958-4036', zona: '' },
  { n: 'Fletes Kairos', region: 'AMBA', e: 'contacto@mudanzaskairos.com', tel: '+54 9 11 2474-4416', zona: '' },
  { n: 'Durand Logistica', region: 'AMBA', e: 'info@durandlogistica.com.ar', tel: '11 7228-8238', zona: '' },
  // ── AMBA — segunda tanda 2026-08-10 (65 nuevos, dedupeados contra los de arriba) ──
  { n: 'PF Soluciones Logísticas', region: 'AMBA', e: 'paflores1979paf@gmail.com', tel: '', zona: 'Virrey del Pino, La Matanza' },
  { n: 'Fletes Martin', region: 'AMBA', e: 'fletesalejandro@gmail.com', tel: '', zona: 'Gregorio de Laferrere' },
  { n: 'Agencia 7 de Agosto (Mudanzas al Paraguay)', region: 'AMBA', e: 'agencia7deagosto@hotmail.com', tel: '', zona: 'Isidro Casanova y San Justo' },
  { n: 'Fletes El Padri', region: 'AMBA', e: 'fletesmudanzaselpadri@outlook.es', tel: '', zona: 'El Palomar' },
  { n: 'Transportes Hermida', region: 'AMBA', e: 'info@transporteshermida.com', tel: '', zona: 'José León Suárez y San Martín' },
  { n: 'Stock Logística', region: 'AMBA', e: 'gerenciacomercial@stocklogistica.com', tel: '', zona: 'Villa Ballester' },
  { n: 'Mini Fletes Baumann', region: 'AMBA', e: 'mauro_casal79@hotmail.com', tel: '', zona: 'Villa Ballester' },
  { n: 'Transporte FBM SRL', region: 'AMBA', e: 'info@transportefbm.com.ar', tel: '', zona: 'Loma Hermosa' },
  { n: 'Transportes Molina SRL', region: 'AMBA', e: 'info@transportesmolinasrl.com', tel: '', zona: 'Loma Hermosa' },
  { n: 'Flete Bosch', region: 'AMBA', e: 'fletebosch@gmail.com', tel: '', zona: 'Villa Bosch y Villa Urquiza' },
  { n: 'Fletes Mitrexpress', region: 'AMBA', e: 'contacto@mitrexpress.com.ar', tel: '', zona: 'Caseros y Tres de Febrero' },
  { n: 'Minifletes.net.ar (Caseros)', region: 'AMBA', e: 'info@minifletes.net.ar', tel: '', zona: 'Caseros' },
  { n: 'Fletes y MiniFletes Javier', region: 'AMBA', e: 'minifletesjavier@gmail.com', tel: '', zona: 'Villa Sarmiento y Ramos Mejía' },
  { n: 'Logística Smiraglia', region: 'AMBA', e: 'info@logisticasmiraglia.com.ar', tel: '', zona: 'Villa Bosch' },
  { n: 'Transporte Los 3 Ases', region: 'AMBA', e: 'administracion@transportelos3ases.com', tel: '', zona: 'Caseros' },
  { n: 'Fletes Caseros', region: 'AMBA', e: 'fletescaseros@gmail.com', tel: '', zona: 'Caseros' },
  { n: 'Canning Mudanzas', region: 'AMBA', e: 'info@canningmudanzas.com.ar', tel: '', zona: 'Canning' },
  { n: 'Fast Fletes', region: 'AMBA', e: 'fastfletesbs@gmail.com', tel: '', zona: 'Florencio Varela' },
  { n: 'Hora Flet', region: 'AMBA', e: 'horafletsrl@gmail.com', tel: '', zona: 'Boedo' },
  { n: 'Mms Logistica', region: 'AMBA', e: 'consultas@mmslogistica.com.ar', tel: '', zona: 'Barracas' },
  { n: 'Canning Mudanzas', region: 'AMBA', e: 'canningmudanzas@yahoo.com.ar', tel: '', zona: 'Villa Devoto y Floresta' },
  { n: 'Transporte RCT', region: 'AMBA', e: 'info@transporterct.com.ar', tel: '', zona: 'Boedo' },
  { n: 'Guardamuebles GL', region: 'AMBA', e: 'guardamueblegl@gmail.com', tel: '', zona: 'Bajo Flores' },
  { n: 'Bairestrans', region: 'AMBA', e: 'bairestrans@gmail.com', tel: '', zona: 'Munro y Vicente López' },
  { n: 'Pretiflet', region: 'AMBA', e: 'pretiflet@gmail.com', tel: '', zona: 'San Martín' },
  { n: 'Transporte Romano SRL', region: 'AMBA', e: 'transporteromanosrl@gmail.com', tel: '', zona: 'San Martín' },
  { n: 'Transporte Panisa', region: 'AMBA', e: 'contacto@transpanisa.com', tel: '', zona: 'Boulogne' },
  { n: 'Transporte Gioia e Hijos SRL', region: 'AMBA', e: 'contacto@transportegioia.com', tel: '', zona: 'Lanús' },
  { n: 'Oeste Cargas', region: 'AMBA', e: 'oestecargas@hotmail.com.ar', tel: '', zona: 'Morón' },
  { n: 'Servicios D-Leo', region: 'AMBA', e: 'leo_daguerre@hotmail.com', tel: '', zona: 'Moreno' },
  { n: 'OR Mudanzas Internacional', region: 'AMBA', e: 'oscar.embalajes@gmail.com', tel: '', zona: 'José C. Paz' },
  { n: 'Mudanzas Aguilar Hnos', region: 'AMBA', e: 'willyaguilar7@hotmail.com', tel: '', zona: 'Belgrano' },
  { n: 'Marmail Logística', region: 'AMBA', e: 'marmaillogistica@gmail.com', tel: '', zona: 'Belgrano' },
  { n: 'Mendez Mudanzas', region: 'AMBA', e: 'info@mendezmudanzas.com.ar', tel: '', zona: 'Belgrano' },
  { n: 'Transportadores Unidos SRL', region: 'AMBA', e: 'jlcamenforte@hotmail.com', tel: '', zona: 'Villa Urquiza y Munro' },
  { n: 'Córdoba Hnos', region: 'AMBA', e: 'cordobaa405@gmail.com', tel: '', zona: 'Palermo' },
  { n: 'Mudanzas N&D', region: 'AMBA', e: 'nydmudanzas@gmail.com', tel: '', zona: 'Villa Crespo y Palermo' },
  { n: 'Logística Enlace', region: 'AMBA', e: 'consultas@logisticaenlace.com', tel: '', zona: 'Villa Crespo y Palermo' },
  { n: 'Av. Santa Fe Mudanzas', region: 'AMBA', e: 'velezarcangelvictor@gmail.com', tel: '', zona: 'Villa Crespo' },
  { n: 'Mercovan Argentina Mudanzas Internacionales', region: 'AMBA', e: 'mercovan@mercovan.com.ar', tel: '', zona: 'Villa Crespo' },
  { n: 'Transporte Provincias Unidas', region: 'AMBA', e: 'cotizaciones@tpusrl.com', tel: '', zona: 'San Justo' },
  { n: 'La Guarda', region: 'AMBA', e: 'info@la-guarda.com.ar', tel: '', zona: 'Balvanera y Constitución' },
  { n: 'Elishar', region: 'AMBA', e: 'info@elishar.com.ar', tel: '', zona: '' },
  { n: 'Akari Mudanzas', region: 'AMBA', e: 'akaritransportes@gmail.com', tel: '', zona: 'San José, CABA' },
  { n: 'Universal Cargo Argentina', region: 'AMBA', e: 'info@universalcargo.com.ar', tel: '', zona: '' },
  { n: 'Mi Mudanza', region: 'AMBA', e: 'info@mimudanza.com.ar', tel: '', zona: '' },
  { n: 'Fletes Buenos Aires', region: 'AMBA', e: 'info@fletesbuenosaires.com.ar', tel: '', zona: '' },
  { n: 'Mudanzas y Transportes MC', region: 'AMBA', e: 'mudanzasytransportesmc@yahoo.com', tel: '', zona: 'San Isidro y Constitución' },
  { n: 'Buenos Aires Guarda (BAG)', region: 'AMBA', e: 'informers@buenosairesguarda.com.ar', tel: '', zona: '' },
  { n: 'ONE Storage', region: 'AMBA', e: 'info@onestorage.com.ar', tel: '', zona: 'Pilar' },
  { n: 'Teloguardo', region: 'AMBA', e: 'info@teloguardo.com.ar', tel: '', zona: 'Balvanera' },
  { n: 'Unibox', region: 'AMBA', e: 'info@unibox.com.ar', tel: '', zona: 'Munro y Beccar' },
  { n: 'U-Store', region: 'AMBA', e: 'guardalo@u-store.com.ar', tel: '', zona: '' },
  { n: 'Espacio Bauleras', region: 'AMBA', e: 'info@espaciobauleras.com.ar', tel: '', zona: 'Boedo y Balvanera' },
  { n: 'Más Espacio', region: 'AMBA', e: 'info@masespacio.com.ar', tel: '', zona: 'Palermo y Barracas' },
  { n: 'La Baulera', region: 'AMBA', e: 'info@labaulera.com.ar', tel: '', zona: '' },
  { n: 'Neygi Moving & Relocation', region: 'AMBA', e: 'info@neygimoving.com', tel: '', zona: '' },
  { n: 'Premium Mudanzas', region: 'AMBA', e: 'info@premiummudanzas.com', tel: '', zona: 'Munro' },
  { n: 'Hub Argentina', region: 'AMBA', e: 'info@hubargentina.com.ar', tel: '', zona: '' },
  { n: 'Guardaloya', region: 'AMBA', e: 'info@guardaloya.com.ar', tel: '', zona: 'Olivos' },
  { n: 'Labs Relocation Services', region: 'AMBA', e: 'info@relocation.com.ar', tel: '', zona: '' },
  { n: 'Lift Van International', region: 'AMBA', e: 'sales@liftvan.com', tel: '', zona: 'Don Torcuato' },
  { n: 'Transportes Mitre', region: 'AMBA', e: 'contacto@transportesmitre.com', tel: '', zona: 'Villa Lugano' },
  { n: 'Mudanzas Urquiza', region: 'AMBA', e: 'mudanzasurquiza@gmail.com', tel: '', zona: 'Olivos' },
  { n: 'El Neutral', region: 'AMBA', e: 'info@mudanzaselneutral.com.ar', tel: '', zona: 'Paternal' },
  // ── Mendoza — barrida 2026-08-10 (solo con email confirmado en su propia web) ──
  { n: 'Fletes Mendoza', region: 'Mendoza', e: 'contacto@fletesmendoza.com.ar', tel: '261 609-0153', zona: 'Mendoza Capital y Gran Mendoza' },
  { n: 'Mudanzas Mendoza (MDS)', region: 'Mendoza', e: 'mdsfletes@hotmail.com', tel: '0261 472-4985', zona: 'Las Heras y Gran Mendoza' },
  { n: 'Mudanzas Stocco e Hijos', region: 'Mendoza', e: 'mudanzas-stocco@hotmail.com', tel: '0261 425-3344', zona: 'Mendoza Capital' }
];

var REGION_TEXTO = {
  'AMBA': 'Buenos Aires y alrededores',
  'Córdoba': 'Córdoba',
  'Rosario': 'Rosario',
  'Mendoza': 'Mendoza y Gran Mendoza'
};

function emailInvitacion(o) {
  var nm = esc(o.n || 'equipo');
  var linkB = linkBaja(o.e, 'invitacion-mudanceros');
  var zona = esc((o.zona && o.zona.trim()) || REGION_TEXTO[o.region] || o.region || 'tu zona');
  return {
    subject: o.n + ': sumate a MudateYa como mudancero verificado',
    html:
      '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">' +
        '<div style="background:#003580;padding:22px 28px;text-align:center">' +
          '<span style="font-family:Arial Black,Arial,sans-serif;font-size:28px;font-weight:900;letter-spacing:2px;color:#fff">MUDATE</span>' +
          '<span style="font-family:Arial Black,Arial,sans-serif;font-size:28px;font-weight:900;letter-spacing:2px;color:#22C36A">YA</span>' +
        '</div>' +
        '<div style="padding:28px">' +
          '<h2 style="margin:0 0 12px;color:#0F1923;font-size:20px">Hola, equipo de ' + nm + ' 👋</h2>' +
          '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">Te escribimos desde <strong>MudateYa</strong>, un marketplace argentino que conecta a mudanceros y fleteros verificados con clientes que están por mudarse.</p>' +
          '<p style="color:#0F1923;font-size:14px;line-height:1.7;margin:0 0 18px;background:#F5F7FA;border-radius:10px;padding:12px 16px"><strong>Hoy nos están pidiendo mudanzas en ' + zona + ' y necesitamos cubrir esa zona con mudanceros verificados</strong> — por eso pensamos en ustedes.</p>' +
          '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px">Publicás tu perfil, recibís pedidos reales de tu zona y cotizás cuando te conviene — sin obligación de aceptar todos.</p>' +
          '<div style="background:#F5F7FA;border-radius:12px;padding:14px 20px;margin-bottom:18px;text-align:center">' +
            '<span style="display:inline-block;margin:4px 8px;font-size:12px;font-weight:700;color:#003580;background:#E5ECF6;padding:6px 12px;border-radius:999px">Sin costo de alta</span>' +
            '<span style="display:inline-block;margin:4px 8px;font-size:12px;font-weight:700;color:#003580;background:#E5ECF6;padding:6px 12px;border-radius:999px">Pedidos reales de tu zona</span>' +
            '<span style="display:inline-block;margin:4px 8px;font-size:12px;font-weight:700;color:#003580;background:#E5ECF6;padding:6px 12px;border-radius:999px">Vos elegís qué cotizar</span>' +
          '</div>' +
          '<div style="text-align:center;margin:20px 0">' +
            '<a href="https://mudateya.ar/mudanceros" style="display:inline-block;background:#22C36A;color:#fff;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none">Sumarme como mudancero →</a>' +
          '</div>' +
          '<p style="color:#475569;font-size:14px;line-height:1.7;margin:0">Si tenés dudas, respondé este mail y te contamos más.</p>' +
          '<p style="color:#94A3B8;font-size:11px;text-align:center;margin:22px 0 0;border-top:1px solid #E2E8F0;padding-top:16px">Recibís este correo porque tu empresa figura como mudancero/fletero en tu zona. <a href="' + linkB + '" style="color:#94A3B8;text-decoration:underline">Darte de baja</a>.<br>MudateYa · hola@mudateya.ar · mudateya.ar</p>' +
        '</div>' +
      '</div>'
  };
}

function payloadDe(o) {
  var m = emailInvitacion(o);
  var link = linkBaja(o.e, 'invitacion-mudanceros');
  return {
    from: 'MudateYa <hola@mudateya.ar>', to: o.e, subject: m.subject, html: m.html,
    headers: {
      'List-Unsubscribe': '<' + link + '>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    }
  };
}

// true si ya es mudancero registrado en MudateYa (por email o por teléfono)
async function yaEsMudancero(o) {
  var perfil = await redisCall('get', ['mudancero:perfil:' + o.e.toLowerCase()]);
  if (perfil) return true;
  var tels = telefonosCandidatos(o.tel);
  for (var i = 0; i < tels.length; i++) {
    var match = await redisCall('hget', ['mudanceros:tel8-idx', tels[i]]);
    if (match) return true;
  }
  return false;
}

module.exports = async function handler(req, res) {
  var esVercelCron = esCronVercel(req);
  // En previews (no producción) el cron no debe enviar nada.
  if (esVercelCron && process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    return res.status(200).json({ ok: true, skipped: true, reason: 'no-production-env' });
  }
  if (!esVercelCron && !esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
  if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY no configurado' });

  var resend = new Resend(process.env.RESEND_API_KEY);
  var testTo = req.query && req.query.test ? String(req.query.test).trim() : '';
  var apply  = esVercelCron || (req.query && req.query.apply === '1');

  try {
    // ── TEST: una muestra (no marca, no chequea dedup) ──
    if (testTo) {
      if (!validEmail(testTo)) return res.status(400).json({ error: 'Email de test inválido' });
      var rt = await resend.emails.send(payloadDe({ n: 'Vía MG', e: testTo, tel: '' }));
      if (rt && rt.error) return res.status(502).json({ error: rt.error });
      return res.status(200).json({ ok: true, test: true, enviadoA: testTo });
    }

    // ── Ya invitados en esta campaña ──
    var enviados = (await getJSON(CLAVE_ENVIADOS)) || [];
    var enviadosSet = {}; enviados.forEach(function(e){ enviadosSet[String(e).toLowerCase()] = 1; });
    var suprimidos = (await redisCall('smembers', ['baja:emails'])) || [];
    var suprSet = {}; suprimidos.forEach(function(e){ suprSet[String(e).toLowerCase()] = 1; });

    // ── Filtrar: no repetidos de esta campaña, no suprimidos, y no ya-mudanceros ──
    var candidatos = PROSPECTOS.filter(function(o){
      var k = o.e.toLowerCase();
      return !enviadosSet[k] && !suprSet[k];
    });
    var pendientes = [];
    var yaMudanceros = [];
    for (var c = 0; c < candidatos.length; c++) {
      var o = candidatos[c];
      if (await yaEsMudancero(o)) yaMudanceros.push(o.n + ' <' + o.e + '>');
      else pendientes.push(o);
    }

    // ── DRY (sin apply): informa, no envía ──
    if (!apply) {
      return res.status(200).json({
        ok: true, dry: true,
        totalProspectos: PROSPECTOS.length,
        yaInvitados: enviados.length,
        suprimidos: suprimidos.length,
        yaMudanceros: yaMudanceros.length,
        yaMudancerosMuestra: yaMudanceros.slice(0, 8),
        pendientes: pendientes.length,
        muestra: pendientes.slice(0, 8).map(function(o){ return o.n + ' <' + o.e + '>'; })
      });
    }

    // ── APPLY: enviar. Preferimos batch (rápido); si no está disponible o falla,
    //    caemos a envío uno por uno para no perder el lote. ──
    var resumen = { enviados: 0, errores: 0, fallidos: [], omitidosYaMudanceros: yaMudanceros.length };
    async function _marcar(email){ enviados.push(email); await setJSON(CLAVE_ENVIADOS, enviados); }
    async function _enviarUno(o){
      var r1 = await resend.emails.send(payloadDe(o));
      if (r1 && r1.error) throw new Error(typeof r1.error === 'string' ? r1.error : JSON.stringify(r1.error));
    }
    var hayBatch = !!(resend.batch && typeof resend.batch.send === 'function');
    var grupos = chunk(pendientes, 100);
    for (var g = 0; g < grupos.length; g++) {
      var unoAUno = !hayBatch;
      if (hayBatch) {
        try {
          var rb = await resend.batch.send(grupos[g].map(payloadDe));
          if (rb && rb.error) throw new Error(typeof rb.error === 'string' ? rb.error : JSON.stringify(rb.error));
          for (var b = 0; b < grupos[g].length; b++) { await _marcar(grupos[g][b].e); resumen.enviados++; }
        } catch (eb) {
          resumen.fallidos.push({ lote: g, modo: 'batch', error: eb.message });
          unoAUno = true; // reintentamos el lote uno por uno
        }
      }
      if (unoAUno) {
        for (var q = 0; q < grupos[g].length; q++) {
          var o = grupos[g][q];
          try { await _enviarUno(o); await _marcar(o.e); resumen.enviados++; }
          catch (e2) { resumen.errores++; resumen.fallidos.push({ email: o.e, error: e2.message }); }
          await new Promise(function(ok){ setTimeout(ok, 130); });
        }
      }
    }
    return res.status(200).json({ ok: true, aplicado: true, batchDisponible: hayBatch, ...resumen });
  } catch (e) {
    console.error('Error en enviar-invitacion-mudanceros:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
