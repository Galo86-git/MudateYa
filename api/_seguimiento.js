// api/_seguimiento.js
// Motor genérico de seguimiento escalonado (touch 2, 3, 4, 5, …) para las
// campañas "en frío" a redes de franquicia y mudanceros. Un solo lugar para
// la cadencia y para el cruce contra altas reales — lo usan
// cron-seguimiento-remax.js, -c21.js, -keller.js, -coldwell.js y
// -mudanceros.js. Vercel ignora los archivos de /api que empiezan con "_":
// esto no se deploya como función propia.
//
// CADENCIA (pedida por Galo 2026-08-11):
//   touch 1 → 2: 7 días   (touch 1 = la propuesta original, ya mandada aparte)
//   touch 2 → 3: 7 días
//   touch 3 → 4, 4 → 5, …: 10 días — sigue indefinidamente, no hay último touch.
//
// ESTADO EN REDIS (una clave por campaña, ej. "remax-seguimiento:estado"):
//   { "<email-en-minúscula>": { touch: 2, fecha: "2026-08-18" } }
//   "touch"  = último toque mandado a ese contacto.
//   "fecha"  = cuándo se mandó ese último toque (YYYY-MM-DD, día ART).
//   "convertido: true" = se cruzó contra la base real y ya está de alta —
//   se lo saca de circulación para siempre, ningún cron futuro le vuelve a
//   preguntar nada (evita pegarle a la base real todos los días de más).
//
// SIEMBRA (primera corrida, `leerEstado`): si esta campaña ya venía
// mandando toques "a mano" antes de este cron (caso REMAX y CENTURY 21, que
// ya tenían enviar-propuesta-*.js y recordatorio-*.js), no hay que perder
// esa historia — se arranca el estado a partir de esas listas viejas
// (`opts.semilla`), así el cron nuevo sigue la cadencia en vez de repetir
// un toque que ya salió.
//
// CRUCE CONTRA ALTA: cada candidato que ya cumplió el plazo pasa por
// `estaConvertido` (función que le pasa el caller, distinta por red — cada
// una registra sus altas en un lugar distinto de Redis). Es la llamada más
// cara (red), por eso se hace SOLO para los que ya vencieron el plazo, no
// para todo el universo en cada corrida.

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

// ── Fecha (solo el día) en horario de Argentina. Sin esto, "días desde el
//    último toque" se corre según a qué hora UTC le toque correr al cron. ──
function hoyART() {
  var f = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return f.toISOString().slice(0, 10);
}
function diasEntre(desdeYMD, hastaYMD) {
  return Math.round((Date.parse(hastaYMD + 'T00:00:00Z') - Date.parse(desdeYMD + 'T00:00:00Z')) / 86400000);
}
// Días de espera DESPUÉS de `touchActual` para que corresponda el próximo.
function intervaloPara(touchActual) {
  return touchActual >= 3 ? 10 : 7;
}

// ── Arma el estado la primera vez que corre esta campaña, a partir de las
//    listas viejas (semilla). Corridas siguientes: lee el estado tal cual. ──
async function leerEstado(clave, semilla) {
  var estado = await getJSON(clave);
  if (estado) return estado;

  estado = {};
  var hoy = hoyART();
  (semilla.touch1 || []).forEach(function (email) {
    estado[String(email).toLowerCase()] = { touch: 1, fecha: semilla.fechaTouch1 || hoy };
  });
  (semilla.touch2 || []).forEach(function (email) {
    // Ya recibieron el touch 2 (para REMAX/C21 salió a destiempo respecto de
    // esta cadencia nueva) — igual arrancamos el reloj del touch 3 desde
    // fechaTouch2 si se conoce, para no atrasar de más el seguimiento.
    estado[String(email).toLowerCase()] = { touch: 2, fecha: semilla.fechaTouch2 || hoy };
  });
  await setJSON(clave, estado);
  return estado;
}

// ── Candidatos a los que hoy les toca el próximo mail. ──
// opts:
//   clave           clave de Redis para el estado de esta campaña
//   universo        array de candidatos, cada uno con al menos { e: email }
//   semilla         { touch1: [emails], touch2: [emails], fechaTouch1, fechaTouch2 }
//   estaConvertido  async (candidato) => bool — ya se dio de alta de verdad
//   maxTouch        tope de touch (default: sin tope — sigue cada 10 días)
async function elegiblesHoy(opts) {
  var clave = opts.clave;
  var universo = opts.universo;
  var estaConvertido = opts.estaConvertido;
  var maxTouch = opts.maxTouch === undefined ? Infinity : opts.maxTouch;

  var estado = await leerEstado(clave, opts.semilla || {});
  var suprimidos = (await redisCall('smembers', ['baja:emails'])) || [];
  var suprSet = {}; suprimidos.forEach(function (e) { suprSet[String(e).toLowerCase()] = 1; });

  var hoy = hoyART();
  var elegibles = [];
  var cambios = false;

  for (var i = 0; i < universo.length; i++) {
    var cand = universo[i];
    var k = String(cand.e).toLowerCase();
    if (suprSet[k]) continue;

    var st = estado[k];
    if (!st) continue;            // nunca recibió el touch 1 — no es candidato de seguimiento
    if (st.convertido) continue;  // ya se dio de alta, no se le vuelve a tocar
    if (st.touch >= maxTouch) continue;

    var faltan = intervaloPara(st.touch) - diasEntre(st.fecha, hoy);
    if (faltan > 0) continue; // todavía no le toca

    // ── Cruce contra la base real, solo para los que ya vencieron el plazo. ──
    var yaAlta = false;
    try { yaAlta = await estaConvertido(cand); }
    catch (e) { console.warn('estaConvertido falló para ' + cand.e + ':', e.message); }

    if (yaAlta) {
      estado[k] = { touch: st.touch, fecha: st.fecha, convertido: true };
      cambios = true;
      continue;
    }

    elegibles.push({ candidato: cand, touchActual: st.touch, proximoTouch: st.touch + 1 });
  }

  if (cambios) await setJSON(clave, estado);
  return { elegibles: elegibles, estado: estado };
}

async function marcarEnviado(clave, estado, email, proximoTouch) {
  estado[String(email).toLowerCase()] = { touch: proximoTouch, fecha: hoyART() };
  await setJSON(clave, estado);
}

module.exports = {
  elegiblesHoy: elegiblesHoy,
  marcarEnviado: marcarEnviado,
  hoyART: hoyART,
  redisCall: redisCall,
  getJSON: getJSON,
  setJSON: setJSON
};
