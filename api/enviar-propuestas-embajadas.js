// api/enviar-propuestas-embajadas.js
//
// Campaña MYA Mobility a embajadas — dos listas con pitch distinto:
//   LISTA_A: embajadas ARGENTINAS en el exterior (staff argentino, mail solo
//            en español). Pitch: relocation para personal que vuelve/se
//            traslada A la Argentina (sin "adaptación cultural": son
//            argentinos, no extranjeros adaptándose al país).
//   LISTA_B: embajadas EXTRANJERAS en la Argentina (staff del país de origen,
//            mail en español + inglés). Pitch directo: les mudamos a su
//            personal diplomático hacia la Argentina.
// Fuente de contactos: sitio de Cancillería argentina (representaciones en
// el exterior) + directorio de representaciones extranjeras acreditadas,
// relevado 2026-08-07/08. 169 destinatarios (86 Lista A + 83 Lista B) — el
// resto de países no tenía email institucional publicado.
//
// CADENCIA: cada 3 meses, el 1er día hábil del mes, 9am ART — 100% automático,
// no requiere ninguna acción manual. Como Vercel no soporta "cada 3 meses"
// directo, el cron corre TODOS los días hábiles a las 9am (vercel.json:
// "0 12 * * 1-5", 12 UTC = 9 AR) y el handler decide si corresponde mandar:
//   - Si NUNCA se mandó (clave Redis de abajo vacía) → manda hoy mismo, sin
//     esperar a que caiga el 1er hábil del mes. Cubre el primer envío
//     (2026-08-08, no es 1er hábil de agosto, pero es el arranque del ciclo).
//   - Si ya se mandó antes → solo vuelve a mandar cuando HOY es el 1er hábil
//     del mes Y ya pasaron >=3 meses desde el último envío exitoso.
// Mismo patrón de "corre seguido, decide internamente" que
// cron-recordar-comisiones-asesores.js.
//
// GET  ?token=ADMIN_TOKEN              → preview: cuenta destinatarios, no manda nada.
// POST ?token=ADMIN_TOKEN {apply:true} → fuerza el envío ahora, salteando el chequeo de fecha (uso manual excepcional).

var { esAdmin, esCronVercel } = require('./_auth');
var { esDiaHabil, aHoraAR } = require('./_habiles');
var { linkBaja } = require('./_baja');

var CLAVE_ULTIMO_ENVIO = 'propuestas-embajadas:ultimo-envio';

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
async function getJSON(k) { var v = await redisCall('get', [k]); if (!v) return null; try { return JSON.parse(v); } catch (e) { return null; } }
async function setJSON(k, v) { return redisCall('set', [k, JSON.stringify(v)]); }
function chunk(arr, size) { var out = []; for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; }
function esc(s) { return String(s || '').replace(/[<>&"]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]; }); }

// ¿Es `fechaAR` el 1er día hábil del mes en el que cae?
function esPrimerHabilDelMes(fechaAR) {
  if (!esDiaHabil(fechaAR)) return false;
  var anio = fechaAR.getUTCFullYear(), mes = fechaAR.getUTCMonth();
  for (var dia = 1; dia < fechaAR.getUTCDate(); dia++) {
    var d = new Date(Date.UTC(anio, mes, dia, 12, 0, 0));
    if (esDiaHabil(d)) return false;
  }
  return true;
}
function mesesDesde(fechaISO, hoyAR) {
  var f = aHoraAR(new Date(fechaISO));
  var meses = (hoyAR.getUTCFullYear() - f.getUTCFullYear()) * 12 + (hoyAR.getUTCMonth() - f.getUTCMonth());
  if (hoyAR.getUTCDate() < f.getUTCDate()) meses--;
  return meses;
}

// ── Nombres de país: correcciones puntuales sobre los datos crudos ──
var NOMBRE_FIX = {
  'Trinidad Y Tobago': 'Trinidad y Tobago',
  'República De Corea': 'República de Corea',
  'Checa, República': 'República Checa',
  'Dominicana, República': 'República Dominicana',
  'Liga de Los Estados Árabes': 'Liga de los Estados Árabes',
};
function nombrePais(p) { return NOMBRE_FIX[p] || p; }

// "de {país}" / "en {país}" con artículo correcto donde hace falta.
var DE_OVERRIDE = {
  'Estados Unidos': 'de los Estados Unidos',
  'Reino Unido': 'del Reino Unido',
  'Países Bajos': 'de los Países Bajos',
  'República Dominicana': 'de la República Dominicana',
  'República Checa': 'de la República Checa',
  'Unión Europea': 'de la Unión Europea',
  'Soberana Orden de Malta': 'de la Soberana Orden de Malta',
  'Liga de los Estados Árabes': 'de la Liga de los Estados Árabes',
};
var EN_OVERRIDE = {
  'Estados Unidos': 'en los Estados Unidos',
  'Reino Unido': 'en el Reino Unido',
  'Países Bajos': 'en los Países Bajos',
  'República Dominicana': 'en la República Dominicana',
  'República Checa': 'en la República Checa',
};
function dePais(p) { return DE_OVERRIDE[p] || ('de ' + p); }
function enPais(p) { return EN_OVERRIDE[p] || ('en ' + p); }

// Nombre en inglés (solo Lista B, para el bloque EN del mail).
var EN_NOMBRE = {
  'Angola': 'Angola', 'Arabia Saudita': 'Saudi Arabia', 'Argelia': 'Algeria', 'Armenia': 'Armenia',
  'Australia': 'Australia', 'Austria': 'Austria', 'Azerbaiyán': 'Azerbaijan', 'Belarús': 'Belarus',
  'Bélgica': 'Belgium', 'Bolivia': 'Bolivia', 'Brasil': 'Brazil', 'Bulgaria': 'Bulgaria', 'Canadá': 'Canada',
  'Chequia': 'the Czech Republic', 'Chile': 'Chile', 'China': 'China', 'Colombia': 'Colombia', 'Congo': 'Congo',
  'Corea del Sur': 'South Korea', 'Costa Rica': 'Costa Rica', 'Croacia': 'Croatia', 'Cuba': 'Cuba',
  'Dinamarca': 'Denmark', 'República Dominicana': 'the Dominican Republic', 'Ecuador': 'Ecuador',
  'Egipto': 'Egypt', 'El Salvador': 'El Salvador', 'Emiratos Árabes': 'the United Arab Emirates',
  'Eslovaquia': 'Slovakia', 'Eslovenia': 'Slovenia', 'España': 'Spain', 'Filipinas': 'the Philippines',
  'Finlandia': 'Finland', 'Francia': 'France', 'Georgia': 'Georgia', 'Grecia': 'Greece',
  'Guatemala': 'Guatemala', 'Haití': 'Haiti', 'Honduras': 'Honduras', 'Hungría': 'Hungary', 'India': 'India',
  'Indonesia': 'Indonesia', 'Irán': 'Iran', 'Irlanda': 'Ireland', 'Israel': 'Israel', 'Italia': 'Italy',
  'Japón': 'Japan', 'Kuwait': 'Kuwait', 'Líbano': 'Lebanon', 'Libia': 'Libya',
  'Liga de los Estados Árabes': 'the League of Arab States', 'Malasia': 'Malaysia', 'Marruecos': 'Morocco',
  'México': 'Mexico', 'Montenegro': 'Montenegro', 'Nicaragua': 'Nicaragua', 'Noruega': 'Norway',
  'Nueva Zelanda': 'New Zealand', 'Países Bajos': 'the Netherlands', 'Pakistán': 'Pakistan',
  'Palestina': 'Palestine', 'Panamá': 'Panama', 'Paraguay': 'Paraguay', 'Perú': 'Peru', 'Polonia': 'Poland',
  'Portugal': 'Portugal', 'Qatar': 'Qatar', 'Rumania': 'Romania', 'Rusia': 'Russia', 'Serbia': 'Serbia',
  'Siria': 'Syria', 'Soberana Orden de Malta': 'the Sovereign Order of Malta', 'Sudáfrica': 'South Africa',
  'Suecia': 'Sweden', 'Suiza': 'Switzerland', 'Tailandia': 'Thailand', 'Túnez': 'Tunisia',
  'Türkiye': 'Türkiye', 'Ucrania': 'Ukraine', 'Unión Europea': 'the European Union', 'Uruguay': 'Uruguay',
  'Venezuela': 'Venezuela', 'Vietnam': 'Vietnam',
};

// ── Lista A: embajadas ARGENTINAS en el exterior (86) ──
var LISTA_A = [
  { pais: 'Canadá', email: 'ecana@cancilleria.gob.ar' }, { pais: 'Estados Unidos', email: 'eeeuu@mrecic.gov.ar' },
  { pais: 'México', email: 'emexi@mrecic.gov.ar' }, { pais: 'Costa Rica', email: 'erica@mrecic.gov.ar' },
  { pais: 'Cuba', email: 'ecuba@mrecic.gov.ar' }, { pais: 'República Dominicana', email: 'edomi@mrecic.gov.ar' },
  { pais: 'El Salvador', email: 'esalv@mrecic.gov.ar' }, { pais: 'Guatemala', email: 'eguat@mrecic.gov.ar' },
  { pais: 'Haití', email: 'ehait@mrecic.gov.ar' }, { pais: 'Honduras', email: 'ehond@cancilleria.gob.ar' },
  { pais: 'Jamaica', email: 'ejama@mrecic.gov.ar' }, { pais: 'Nicaragua', email: 'enica@mrecic.gov.ar' },
  { pais: 'Panamá', email: 'epnma@mrecic.gov.ar' }, { pais: 'Trinidad Y Tobago', email: 'etrin@mrecic.gov.ar' },
  { pais: 'Bolivia', email: 'ebolv@mrecic.gov.ar' }, { pais: 'Brasil', email: 'ebras@mrecic.gob.ar' },
  { pais: 'Colombia', email: 'ecolo@cancilleria.gov.ar' }, { pais: 'Chile', email: 'ehile@mrecic.gov.ar' },
  { pais: 'Ecuador', email: 'eecua@mrecic.gov.ar' }, { pais: 'Paraguay', email: 'contacto_epara@mrecic.gov.ar' },
  { pais: 'Perú', email: 'eperu@mrecic.gov.ar' }, { pais: 'Uruguay', email: 'eurug@mrecic.gov.ar' },
  { pais: 'Alemania', email: 'ealem@cancilleria.gob.ar' }, { pais: 'Austria', email: 'etria@mrecic.gov.ar' },
  { pais: 'Bélgica', email: 'ebelg@cancilleria.gob.ar' }, { pais: 'Dinamarca', email: 'edina@mrecic.gob.ar' },
  { pais: 'España', email: 'eespa@mrecic.gov.ar' }, { pais: 'Finlandia', email: 'embajada_efinl@cancilleria.gob.ar' },
  { pais: 'Francia', email: 'efran@mrecic.gov.ar' }, { pais: 'Grecia', email: 'egrec@mrecic.gov.ar' },
  { pais: 'Irlanda', email: 'eirla@mrecic.gov.ar' }, { pais: 'Italia', email: 'eital@mrecic.gov.ar' },
  { pais: 'Noruega', email: 'enoru@mrecic.gov.ar' }, { pais: 'Países Bajos', email: 'epbaj@mrecic.gov.ar' },
  { pais: 'Portugal', email: 'eport@mrecic.gov.ar' }, { pais: 'Reino Unido', email: 'eruni@mrecic.gov.ar' },
  { pais: 'Santa Sede', email: 'essed@mrecic.gov.ar' }, { pais: 'Suecia', email: 'esuec@mrecic.gov.ar' },
  { pais: 'Suiza', email: 'esuiz@mrecic.gov.ar' }, { pais: 'Türkiye', email: 'eturq@mrecic.gov.ar' },
  { pais: 'Bulgaria', email: 'ebulg@mrecic.gov.ar' }, { pais: 'Checa, República', email: 'eches@mrecic.gov.ar' },
  { pais: 'Hungría', email: 'eungr@mrecic.gov.ar' }, { pais: 'Polonia', email: 'epolo@mrecic.gov.ar' },
  { pais: 'Rumania', email: 'eruma@cancilleria.gob.ar' }, { pais: 'Rusia', email: 'efrus@cancilleria.gob.ar' },
  { pais: 'Ucrania', email: 'eucra@mrecic.gov.ar' }, { pais: 'Serbia', email: 'eserb@mrecic.gov.ar' },
  { pais: 'Siria', email: 'easir@mrecic.gov.ar' }, { pais: 'Arabia Saudita', email: 'earab@mrecic.gov.ar' },
  { pais: 'Argelia', email: 'earge@cancilleria.gob.ar' }, { pais: 'Egipto', email: 'eegip@cancilleria.gob.ar' },
  { pais: 'Emiratos Árabes', email: 'eearb@mrecic.gov.ar' }, { pais: 'Libia', email: 'elbia@mrecic.gov.ar' },
  { pais: 'Israel', email: 'eisra@mrecic.gov.ar' }, { pais: 'Kuwait', email: 'ekuwa@mrecic.gov.ar' },
  { pais: 'Líbano', email: 'elbno@mrecic.gov.ar' }, { pais: 'Marruecos', email: 'emarr@cancilleria.gob.ar' },
  { pais: 'Túnez', email: 'etune@mrecic.gov.ar' }, { pais: 'Kenya', email: 'ekeny@cancilleria.gob.ar' },
  { pais: 'Nigeria', email: 'enige@mrecic.gov.ar' }, { pais: 'Sudáfrica', email: 'esafr@mrecic.gov.ar' },
  { pais: 'República De Corea', email: 'ecore@mrecic.gov.ar' }, { pais: 'China', email: 'echin@mrecic.gov.ar' },
  { pais: 'Filipinas', email: 'efili@mrecic.gov.ar' }, { pais: 'India', email: 'eindi@mrecic.gov.ar' },
  { pais: 'Indonesia', email: 'eisia@mrecic.gov.ar' }, { pais: 'Japón', email: 'ejapo@mrecic.gov.ar' },
  { pais: 'Malasia', email: 'emsia@mrecic.gov.ar' }, { pais: 'Pakistán', email: 'epaki@mrecic.gov.ar' },
  { pais: 'Tailandia', email: 'etail@mrecic.gov.ar' }, { pais: 'Vietnam', email: 'eviet@mrecic.gov.ar' },
  { pais: 'Australia', email: 'eaust@mrecic.gov.ar' }, { pais: 'Nueva Zelandia', email: 'enzel@mrecic.gov.ar' },
  { pais: 'Barbados', email: 'ebarb@mrecic.gov.ar' }, { pais: 'Guyana', email: 'eguya@mrecic.gov.ar' },
  { pais: 'Surinam', email: 'esuri@mrecic.gov.ar' }, { pais: 'Azerbaiyán', email: 'eazer@mrecic.gov.ar' },
  { pais: 'Qatar', email: 'eqatr@mrecic.gov.ar' }, { pais: 'Etiopía', email: 'eetio@mrecic.gob.ar' },
  { pais: 'Mozambique', email: 'emoza@mrecic.gov.ar' }, { pais: 'Senegal', email: 'secon_esene@mrecic.gov.ar' },
  { pais: 'Angola', email: 'eango@mrecic.gov.ar' }, { pais: 'Bangladesh', email: 'ebang@cancilleria.gov.ar' },
  { pais: 'Singapur', email: 'esing@mrecic.gov.ar' }, { pais: 'Armenia', email: 'earme@mrecic.gov.ar' },
];

// ── Lista B: embajadas EXTRANJERAS en la Argentina (83) ──
var LISTA_B = [
  { pais: 'Angola', email: 'embaixada.argentina@mirex.gov.ao' }, { pais: 'Arabia Saudita', email: 'embasaudita@fibertel.com.ar' },
  { pais: 'Argelia', email: 'embajadaargelia02@gmail.com' }, { pais: 'Armenia', email: 'armargentineembassy@mfa.am' },
  { pais: 'Australia', email: 'consular.buenosaires@dfat.gov.au.' }, { pais: 'Austria', email: 'buenos-aires-ob@bmeia.gv.at' },
  { pais: 'Azerbaiyán', email: 'buenosaires@mission.mfa.gov.az' }, { pais: 'Belarús', email: 'argentina@mfa.gov.by' },
  { pais: 'Bélgica', email: 'buenosaires@diplobel.fed.be' }, { pais: 'Bolivia', email: 'mesadeentrada@embajadadebolivia.com.ar' },
  { pais: 'Brasil', email: 'brasemb.buenosaires@itamaraty.gov.br' }, { pais: 'Bulgaria', email: 'embassy.buenosaires@mfa.bg' },
  { pais: 'Canadá', email: 'bairs-webmail@international.gc.ca' }, { pais: 'Chequia', email: 'buenosaires@embassy.mzv.gov.cz' },
  { pais: 'Chile', email: 'echile.argentina@minrel.gob.cl' }, { pais: 'China', email: 'info@embajadachina.net.ar' },
  { pais: 'Colombia', email: 'eargentina@cancilleria.gov.co' }, { pais: 'Congo', email: 'rdcbuenos@hotmail.com' },
  { pais: 'Corea del Sur', email: 'argentina@mofa.go.kr' }, { pais: 'Costa Rica', email: 'embcr-ar@rree.go.cr' },
  { pais: 'Croacia', email: 'croemb.ar@mvep.hr' }, { pais: 'Cuba', email: 'secretaria@ar.embacuba.cu' },
  { pais: 'Dinamarca', email: 'bueamb@um.dk' }, { pais: 'Dominicana, República', email: 'embajada@embajadadominicana.com.ar' },
  { pais: 'Ecuador', email: 'eecuargentina@cancilleria.gob.ec' }, { pais: 'Egipto', email: 'emb.egipto@gmail.com' },
  { pais: 'El Salvador', email: 'embajadaargentina@rree.gob.sv' }, { pais: 'Emiratos Árabes', email: 'buenosairesemb.sec@mofa.gov.ae' },
  { pais: 'Eslovaquia', email: 'emb.buenosaires@mzv.sk' }, { pais: 'Eslovenia', email: 'sloembassy.buenosaires@gov.si' },
  { pais: 'España', email: 'emb.buenosaires@maec.es' }, { pais: 'Filipinas', email: 'buenosaires.pe@dfa.gov.ph' },
  { pais: 'Finlandia', email: 'sanomat.bue@gov.fi' }, { pais: 'Francia', email: 'ambafr.argentine@gmail.com' },
  { pais: 'Georgia', email: 'buenosaires.emb@mfa.gov.ge' }, { pais: 'Grecia', email: 'gremb.bay@mfa.gr' },
  { pais: 'Guatemala', email: 'embargentina@minex.gob.gt' }, { pais: 'Haití', email: 'amb.argentine@diplomatie.ht' },
  { pais: 'Honduras', email: 'emb.hondurasar@gmail.com' }, { pais: 'Hungría', email: 'mission.bue@mfa.gov.hu' },
  { pais: 'India', email: 'frontdesk.buenos@mea.gov.in' }, { pais: 'Indonesia', email: 'emindo@indonesianembassy.org.ar' },
  { pais: 'Irán', email: 'iranemb.bue@mfa.gov.ir' }, { pais: 'Irlanda', email: 'buenosairesembassy@dfa.ie' },
  { pais: 'Israel', email: 'info@buenosaires.mfa.gov.il' }, { pais: 'Italia', email: 'ambasciata.buenosaires@esteri.it' },
  { pais: 'Japón', email: 'taishikan@bn.mofa.go.jp' }, { pais: 'Kuwait', email: 'info@embajadadekuwait.com.ar' },
  { pais: 'Líbano', email: 'ellibanoar@gmail.com' }, { pais: 'Libia', email: 'embajada@embajadadelibia.com.ar' },
  { pais: 'Liga de Los Estados Árabes', email: 'ligarabeargentina@yahoo.com.ar' }, { pais: 'Malasia', email: 'mwbuenosaires@kln.gov.my' },
  { pais: 'Marruecos', email: 'ambassade.buenosaires@maec.gov.ma' }, { pais: 'México', email: 'embajadaarg@sre.gob.mx' },
  { pais: 'Montenegro', email: 'argentina@mfa.gov.me' }, { pais: 'Nicaragua', email: 'embanicbuenosaires@gmail.com' },
  { pais: 'Noruega', email: 'emb.buenosaires@mfa.no' }, { pais: 'Nueva Zelanda', email: 'embajadanzba@gmail.com' },
  { pais: 'Países Bajos', email: 'bue@minbuza.nl' }, { pais: 'Pakistán', email: 'pakistan2130@gmail.com' },
  { pais: 'Palestina', email: 'emb.palestina.arg@gmail.com' }, { pais: 'Panamá', email: 'embpanamaargentina@mire.gob.pa' },
  { pais: 'Paraguay', email: 'secretaria@paraguay.int.ar' }, { pais: 'Perú', email: 'contacto@embajadadelperu.int.ar' },
  { pais: 'Polonia', email: 'secretaria.buenosaires@msz.gov.pl' }, { pais: 'Portugal', email: 'buenosaires@mne.pt' },
  { pais: 'Qatar', email: 'buenosaires@mofa.gov.qa' }, { pais: 'Rumania', email: 'buenosaires@mae.ro' },
  { pais: 'Rusia', email: 'argentina@mid.ru' }, { pais: 'Serbia', email: 'srb.emb.argentina@mfa.rs' },
  { pais: 'Siria', email: 'embajadasiriabs@gmail.com' }, { pais: 'Soberana Orden de Malta', email: 'argentinaembassy@orderofmalta.int' },
  { pais: 'Sudáfrica', email: 'embajador.argentina@dirco.gov.za' }, { pais: 'Suecia', email: 'ambassaden.buenos-aires@gov.se' },
  { pais: 'Suiza', email: 'buenosaires@eda.admin.ch' }, { pais: 'Tailandia', email: 'thaiembassy.bua@mfa.go.th' },
  { pais: 'Túnez', email: 'embajadatunez.ar@gmail.com' }, { pais: 'Türkiye', email: 'embajada.buenosaires@mfa.gov.tr' },
  { pais: 'Ucrania', email: 'emb_ar@mfa.gov.ua' }, { pais: 'Unión Europea', email: 'delegation-argentina@eeas.europa.eu' },
  { pais: 'Uruguay', email: 'uruargentina@mrree.gub.uy' }, { pais: 'Venezuela', email: 'despacho.argentina@mppre.gob.ve' },
  { pais: 'Vietnam', email: 'atn.sqvn@gmail.com' },
];

var HEADER =
  '<div style="background:#003580;padding:28px 36px">' +
  '<span style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#fff;letter-spacing:.2px">Mudate<span style="color:#8FB4E8">Ya</span></span>' +
  '<span style="font-family:Arial,sans-serif;font-size:12px;color:#B8CCEA;margin-left:10px;letter-spacing:.4px;text-transform:uppercase">Mobility</span>' +
  '</div>';
function CTA_FOOTER(linkB) {
  return '<div style="text-align:center;padding:8px 40px 34px">' +
    '<a href="mailto:contacto@mudateya.ar" style="display:inline-block;background:#003580;color:#fff;padding:14px 34px;border-radius:6px;text-decoration:none;font-family:Arial,sans-serif;font-weight:700;font-size:14px;letter-spacing:.2px">contacto@mudateya.ar</a>' +
    '<div style="font-family:Arial,sans-serif;font-size:12px;color:#94A3B8;margin-top:12px">mudateya.ar/mya-mobility</div>' +
    '</div>' +
    '<div style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:18px 40px;text-align:center">' +
    '<p style="font-family:Arial,sans-serif;font-size:10.5px;color:#94A3B8;margin:0">MudateYa Mobility · mudateya.ar · Buenos Aires, Argentina · ' +
    '<a href="' + linkB + '" style="color:#94A3B8">darse de baja</a></p>' +
    '</div>';
}
function P(t) { return '<p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#334155;margin:0 0 14px">' + t + '</p>'; }

function mailListaA(dest) {
  var pais = nombrePais(dest.pais);
  var linkB = linkBaja(dest.email, 'propuestas-embajadas');
  var html =
    '<div style="font-family:Georgia,\'Times New Roman\',serif;max-width:640px;margin:0 auto;background:#ffffff">' +
    HEADER +
    '<div style="padding:36px 40px 8px">' +
    '<p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#0F1923;margin:0 0 14px">Estimados señores,</p>' +
    P('Nos dirigimos a la Embajada Argentina ' + esc(enPais(pais)) + ' para presentar <strong>MudateYa Mobility</strong>, la línea de relocation corporativo de MudateYa, empresa establecida en el mercado argentino de mudanzas y relocation.') +
    P('Ofrecemos un servicio integral para el traslado de personal diplomático y sus familias hacia la Argentina — vivienda, mudanza y escolaridad — coordinado por un único responsable de punta a punta.') +
    P('Quedamos a disposición para coordinar una reunión o resolver cualquier consulta.') +
    '</div>' +
    CTA_FOOTER(linkB) +
    '</div>';
  return {
    from: 'MudateYa Mobility <contacto@mudateya.ar>',
    to: dest.email,
    subject: 'MudateYa Mobility — Relocation integral para personal diplomático que se traslada a Argentina',
    html: html,
    headers: { 'List-Unsubscribe': '<mailto:hola@mudateya.ar?subject=BAJA>, <' + linkB + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}

function mailListaB(dest) {
  var pais = nombrePais(dest.pais);
  var paisEn = EN_NOMBRE[pais] || pais;
  var linkB = linkBaja(dest.email, 'propuestas-embajadas');
  var html =
    '<div style="font-family:Georgia,\'Times New Roman\',serif;max-width:640px;margin:0 auto;background:#ffffff">' +
    HEADER +
    '<div style="padding:36px 40px 8px">' +
    '<p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#0F1923;margin:0 0 14px">Estimados señores,</p>' +
    P('Nos dirigimos a la Embajada ' + esc(dePais(pais)) + ' en la República Argentina para presentar <strong>MudateYa Mobility</strong>, la línea de relocation corporativo de MudateYa, empresa establecida en el mercado argentino de mudanzas y relocation.') +
    P('Ofrecemos un servicio integral para el traslado de personal diplomático y sus familias — vivienda, mudanza, escolaridad y adaptación cultural — coordinado por un único responsable de punta a punta.') +
    P('Quedamos a disposición para coordinar una reunión o resolver cualquier consulta.') +
    '<div style="border-top:1px solid #E2E8F0;margin:0 0 28px"></div>' +
    '<p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#0F1923;margin:0 0 14px">Dear Sir or Madam,</p>' +
    '<p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#334155;margin:0 0 14px">We are writing to the Embassy of ' + esc(paisEn) + ' in the Argentine Republic to introduce <strong>MudateYa Mobility</strong>, the corporate relocation division of MudateYa, an established provider in the Argentine moving and relocation market.</p>' +
    '<p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#334155;margin:0 0 14px">We offer a comprehensive relocation service for diplomatic staff and their families — housing, moving logistics, schooling and cultural adaptation — coordinated by a single point of contact from start to finish.</p>' +
    '<p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#334155;margin:0 0 28px">We remain available to arrange a meeting or answer any questions.</p>' +
    '</div>' +
    CTA_FOOTER(linkB) +
    '</div>';
  return {
    from: 'MudateYa Mobility <contacto@mudateya.ar>',
    to: dest.email,
    subject: 'MudateYa Mobility — Relocation integral para su personal diplomático en Argentina',
    html: html,
    headers: { 'List-Unsubscribe': '<mailto:hola@mudateya.ar?subject=BAJA>, <' + linkB + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}

module.exports = async function handler(req, res) {
  var esVercelCron = false;
  try { esVercelCron = esCronVercel(req); } catch (e) {}
  var admin = false;
  try { admin = esAdmin(req); } catch (e) {}
  if (!esVercelCron && !admin) return res.status(401).json({ error: 'No autorizado' });
  if (!process.env.RESEND_API_KEY) return res.status(200).json({ error: 'sin RESEND_API_KEY' });

  var hoyAR = aHoraAR(new Date());
  var ultimoEnvio = await getJSON(CLAVE_ULTIMO_ENVIO);

  var apply = false, motivo = '';
  if (esVercelCron) {
    if (!ultimoEnvio) { apply = true; motivo = 'cron-primer-envio'; }
    else if (esPrimerHabilDelMes(hoyAR) && mesesDesde(ultimoEnvio, hoyAR) >= 3) { apply = true; motivo = 'cron-trimestral'; }
  } else if (admin && req.method === 'POST' && req.body && req.body.apply === true) {
    apply = true; motivo = 'manual';
  }

  var total = LISTA_A.length + LISTA_B.length;
  if (!apply) {
    return res.status(200).json({
      ok: true, modo: 'preview', totalListaA: LISTA_A.length, totalListaB: LISTA_B.length, total: total,
      ultimoEnvio: ultimoEnvio,
      nota: 'POST con {"apply":true} y token admin para mandarlo ahora. El cron automático solo dispara el 1er día hábil del mes, cada 3 meses desde el último envío.',
    });
  }

  var { Resend } = require('resend');
  var resend = new Resend(process.env.RESEND_API_KEY);
  var suprimidos = (await redisCall('smembers', ['baja:emails'])) || [];
  var suprSet = {}; suprimidos.forEach(function (e) { suprSet[String(e).toLowerCase()] = 1; });

  var payloads = []
    .concat(LISTA_A.filter(function (d) { return !suprSet[d.email]; }).map(mailListaA))
    .concat(LISTA_B.filter(function (d) { return !suprSet[d.email]; }).map(mailListaB));

  var resumen = { enviados: 0, errores: 0, fallidos: [], suprimidos: suprimidos.length };
  var hayBatch = !!(resend.batch && typeof resend.batch.send === 'function');
  var grupos = chunk(payloads, 100);
  for (var g = 0; g < grupos.length; g++) {
    var unoAUno = !hayBatch;
    if (hayBatch) {
      try {
        var rb = await resend.batch.send(grupos[g]);
        if (rb && rb.error) throw new Error(typeof rb.error === 'string' ? rb.error : JSON.stringify(rb.error));
        resumen.enviados += grupos[g].length;
      } catch (eb) {
        resumen.fallidos.push({ lote: g, modo: 'batch', error: eb.message });
        unoAUno = true;
      }
    }
    if (unoAUno) {
      for (var q = 0; q < grupos[g].length; q++) {
        var p = grupos[g][q];
        try {
          var r1 = await resend.emails.send(p);
          if (r1 && r1.error) throw new Error(typeof r1.error === 'string' ? r1.error : JSON.stringify(r1.error));
          resumen.enviados++;
        } catch (e2) { resumen.errores++; resumen.fallidos.push({ email: p.to, error: e2.message }); }
        await new Promise(function (ok) { setTimeout(ok, 130); });
      }
    }
  }

  await setJSON(CLAVE_ULTIMO_ENVIO, new Date().toISOString());
  return res.status(200).json({ ok: true, aplicado: true, motivo: motivo, batchDisponible: hayBatch, total: total, ...resumen });
};
