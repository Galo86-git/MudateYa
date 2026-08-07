// api/match-mudanceros.js
// #4 — Rankea qué mudanceros son los MEJORES para un pedido, para el barrido.
//
// Dos etapas:
//   1) Reglas (rápido, gratis): filtra aprobados, puntúa por cobertura de zona,
//      calce de vehículo/servicios y disponibilidad de días. Se queda con el top.
//   2) IA (Claude): reordena y EXPLICA el top ~12 con un motivo por cada uno,
//      para que el barrido priorice a quién le conviene mandarle el pedido.
//
// Devuelve hasta N (default 5, "hasta 5 presupuestos") con score + motivo.
//
// ── USO ──────────────────────────────────────────────────────────────────────
//   POST /api/match-mudanceros
//   { "pedidoId": "abc123", "n": 5 }              // toma el pedido de Redis
//     ó
//   { "pedido": { tipo, origen, destino, detalles, fecha }, "n": 5 }
//   → { ranking: [ { email, nombre, empresa, telefono, score, motivo, señales[] } ], total }
// ─────────────────────────────────────────────────────────────────────────────

const { cors, limitarPorIP } = require('./_seguridad');
const { esAdmin } = require('./_auth');
const { claudeJSON, getJSON, redisPipeline, MODEL_LIGHT } = require('./_ia');

// ── Normalización de zona (mismo criterio que buscar-mudanceros.js) ──────────
function norm(str) {
  return (str || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
const STOP = ['de', 'del', 'la', 'las', 'los', 'el', 'en', 'y', 'av', 'ave', 'avenida',
  'calle', 'blvd', 'ruta', 'provincia', 'ciudad', 'argentina', 'ar'];
function palabrasZona(direccion) {
  return norm(direccion).split(/[\s,]+/).filter((p) => p.length > 2 && !STOP.includes(p));
}
// ── AMBA como UNA sola zona ─────────────────────────────────────────────────
// Definición del negocio (2026-08-06): AMBA = Capital Federal + Provincia de
// Buenos Aires. Resuelve un agujero real del matching por tokens: "CABA",
// "Capital Federal" y "Ciudad Autónoma de Buenos Aires" son EL MISMO lugar y no
// comparten ni una palabra entre sí, así que nunca matcheaban entre ellas — lo
// tapaba el cruce por substring del final de coincideZona(), que a su vez mete
// falsos positivos. Con esto el caso frecuente se resuelve de forma explícita.
//
// OJO con lo que NO está acá a propósito:
//   - "capital" a secas: matchearía "Córdoba Capital".
//   - "zona norte/sur/oeste": las usa también gente del interior.
// Ambas eran justo el tipo de coincidencia boba que trajo el problema.
const FRASES_AMBA = ['capital federal', 'ciudad autonoma', 'buenos aires',
  'bs as', 'bsas', 'conurbano', 'gran buenos aires'];
const SIGLAS_AMBA = ['caba', 'amba', 'gba'];
function esAMBA(texto) {
  const t = norm(texto);
  if (FRASES_AMBA.some((f) => t.includes(f))) return true;
  // Comparación EXACTA de token para las siglas: si no, "cabildo" pasaría por "caba".
  return palabrasZona(t).some((p) => SIGLAS_AMBA.includes(p));
}

// ── La Plata vs Mar del Plata: dos ciudades reales y distintas (~400km) que
// comparten la palabra "Plata" ─────────────────────────────────────────────
// Sin este chequeo explícito, un pedido a "La Plata" matcheaba con un
// mudancero en "Mar del Plata" (y viceversa) solo por esa palabra suelta —
// mismo tipo de agujero que resolvió esAMBA arriba, mismo criterio de
// solución: reconocer la frase completa en vez de confiar en la palabra sola.
// "plata" se excluye del matching genérico por palabra suelta más abajo en
// coincideZona(); si de verdad es la misma ciudad, matchea acá.
function esLaPlataCiudad(texto) {
  const t = norm(texto);
  if (t.includes('mar del plata')) return false; // "mar del plata" contiene "plata" pero NO es "La Plata"
  return /(^|\s)la plata(\s|$)/.test(t);
}
function esMarDelPlataCiudad(texto) {
  return norm(texto).includes('mar del plata');
}

// Frases que un mudancero pone en zonasExtra para decir "cubro cualquier
// lugar" — sin esto, "toda argentina" quedaba reducida a la palabra "toda"
// (STOP descarta "argentina"), así que nunca matcheaba con ningún pedido real.
// Confirmado con un caso real: un mudancero con "Toda Argentina" en su perfil
// nunca fue notificado de pedidos fuera de su zona base.
const COMODINES_ZONA = ['toda argentina', 'todo el pais', 'toda la argentina', 'nacional', 'todo el territorio', 'todas las zonas'];
function esComodinNacional(cobertura) {
  const c = norm(cobertura);
  return COMODINES_ZONA.some((k) => c.includes(k));
}
// opts.ignorarComodines = true → NO se aplica el atajo de "toda Argentina".
// Se usa al NOTIFICAR un pedido (mail/push/WhatsApp): el comodín está pensado
// para que un mudancero aparezca en BÚSQUEDAS de cualquier zona, no para que
// le entren pedidos de todo el país. Sin esto, alguien de Córdoba con "toda
// Argentina" en zonasExtra recibía una mudanza de Guise a Cabildo (caso real,
// 2026-08-06). Para búsqueda/ranking se sigue llamando sin opts, igual que antes.
// ── Alcance por GEOLOCALIZACIÓN (criterio principal para notificar) ─────────
// El matching por texto siempre va a fallar en los bordes: "CABA" y "Ciudad
// Autónoma" no comparten palabras, y "Córdoba Capital" se parece de más a
// cualquier cosa. La distancia real no tiene ese problema: si el origen del
// pedido está a 700 km de la base del mudancero, no es su pedido y punto.
//
// Devuelve true / false / null. **null = no se pudo decidir** (falta la key de
// Google, no geocodificó, el perfil no tiene zona): ahí el llamador cae al
// matching por texto de coincideZona(). A propósito falla ABIERTO — es peor
// dejar a un mudancero sin enterarse de un pedido de su zona por un problema
// de geocoding que mandarle uno de más.
//
// RADIO_NOTIFICACION_KM (env, default 100) — 100 km cubre AMBA entera con aire
// (CABA→La Plata son ~55, CABA→Luján ~70) y deja afuera cualquier otra
// provincia. Se sube o baja sin tocar código.
const RADIO_KM = parseInt(process.env.RADIO_NOTIFICACION_KM || '100', 10);

async function redisSet(key, valor) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(`${url}/SET/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(valor))}`,
      { headers: { Authorization: `Bearer ${token}` } });
  } catch (_) {}
}

// Coordenadas de un texto de zona/dirección, cacheadas en Redis por texto
// normalizado. Las zonas se repiten muchísimo entre mudanceros ("CABA", "zona
// norte"), así que en la práctica se le pega a Google una vez por zona, no una
// vez por mudancero. Cachea también el fallo, para no reintentar en cada barrido.
async function coordsDeTexto(texto) {
  const t = norm(texto);
  if (!t) return null;
  const key = `geo:zona:${t}`;
  try {
    const cache = await getJSON(key);
    if (cache) return cache.lat ? cache : null;
  } catch (_) {}
  try {
    const { geocodificar } = require('./_geo');
    const g = await geocodificar(`${texto}, Argentina`);
    const coords = g && g.ok ? { lat: g.lat, lng: g.lng } : null;
    await redisSet(key, coords || { fallo: true });
    return coords;
  } catch (e) {
    console.warn('coordsDeTexto:', e.message);
    return null;
  }
}

// ¿La base del mudancero está dentro del radio del ORIGEN del pedido?
async function cubreGeo(perfil, textoOrigenPedido, coordsPedido) {
  try {
    const cp = (coordsPedido && coordsPedido.lat) ? coordsPedido : await coordsDeTexto(textoOrigenPedido);
    if (!cp) return null;
    const cm = await coordsDeTexto(`${(perfil && perfil.zonaBase) || ''}`);
    if (!cm) return null;
    const { haversineKm } = require('./_geo');
    const km = haversineKm(cp, cm);
    if (!km && km !== 0) return null;
    return km <= RADIO_KM;
  } catch (e) {
    console.warn('cubreGeo:', e.message);
    return null;
  }
}

function coincideZona(cobertura, palabras, opts) {
  if (!(opts && opts.ignorarComodines) && esComodinNacional(cobertura)) return true;
  // AMBA cuenta como UNA zona: si el pedido y la cobertura caen los dos ahí, es
  // la misma zona aunque no compartan ninguna palabra ("CABA" vs "Ciudad
  // Autónoma de Buenos Aires"). Pide el texto CRUDO del pedido porque `palabras`
  // ya viene tokenizado y las frases de dos palabras no sobreviven al split.
  if (opts && opts.textoPedido && esAMBA(opts.textoPedido) && esAMBA(cobertura)) return true;
  const cob = norm(cobertura);

  // La Plata / Mar del Plata: mismo criterio que AMBA arriba, ver comentario
  // de esLaPlataCiudad/esMarDelPlataCiudad. Se resuelve ANTES del matching
  // genérico para que "plata" (ambigua entre las dos) nunca sea la única
  // razón por la que matchean o dejan de matchear.
  if (opts && opts.textoPedido) {
    if (esLaPlataCiudad(opts.textoPedido) && esLaPlataCiudad(cob)) return true;
    if (esMarDelPlataCiudad(opts.textoPedido) && esMarDelPlataCiudad(cob)) return true;
  }
  const esAmbigua = (w) => w === 'plata';

  // OJO: acá antes había un chequeo de substring crudo (palabra del pedido
  // contra el string entero de cobertura sin tokenizar) — es justo el que
  // hacía que "san" (de "San Isidro") matcheara "Santa Fe"/"Santiago" por
  // ser prefijo. Se saca: el resto de los chequeos (match exacto de token +
  // fallback por substring con longitud mínima) cubren los casos legítimos
  // sin ese agujero.
  const cobPal = palabrasZona(cob);
  // Coincidencia EXACTA de palabra completa primero — elimina falsos
  // positivos de substring parcial (ej. "san" de "San Isidro" ya no matchea
  // "Santa Fe"/"Santiago" solo porque esas palabras EMPIEZAN con "san").
  if (cobPal.some((p) => !esAmbigua(p) && palabras.includes(p))) return true;
  // Fallback por substring: solo para palabras largas (6+ letras) en AMBOS
  // lados — sigue reconociendo nombres compuestos/abreviaturas largas, pero
  // ya no alcanza con una palabra corta suelta para matchear.
  return cobPal.some((p) => !esAmbigua(p) && p.length >= 6 &&
    palabras.some((b) => !esAmbigua(b) && b.length >= 6 && (b.includes(p) || p.includes(b))));
}

// ── Score por reglas (0..100) ────────────────────────────────────────────────
function scoreReglas(perfil, palabras, pedido) {
  let score = 0;
  const señales = [];

  const cobertura = `${perfil.zonaBase || ''} ${perfil.zonasExtra || ''}`;
  const textoPedidoZona = `${pedido.origen || ''} ${pedido.destino || ''}`;
  if (coincideZona(cobertura, palabras, { textoPedido: textoPedidoZona })) { score += 45; señales.push('cubre la zona'); }

  // Días disponibles (si el perfil los declara y el pedido tiene fecha, es un plus blando)
  if (perfil.dias) { score += 8; }

  // Servicios que pide el pedido (embalaje/desarme) presentes en el perfil.
  const det = norm(pedido.detalles || '');
  const serv = norm(perfil.servicios || '');
  if (det.includes('embalaje') && serv.includes('embalaje')) { score += 10; señales.push('hace embalaje'); }
  if ((det.includes('desarme') || det.includes('armado')) && (serv.includes('desarme') || serv.includes('armado'))) {
    score += 8; señales.push('desarme/armado');
  }

  // Tiene lista de precios cargada → perfil más completo/activo.
  const precios = perfil.precios || {};
  if (precios.amb1 || precios.amb2 || precios.flete) { score += 12; señales.push('precios cargados'); }

  // Tiene vehículo declarado.
  if (perfil.vehiculo) { score += 10; señales.push('vehículo: ' + perfil.vehiculo); }

  // Verificación / documentación (si el alta la guarda).
  if (perfil.dniVerificado || perfil.verificado) { score += 7; señales.push('verificado'); }

  return { score: Math.min(100, score), señales };
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ranking'],
  properties: {
    ranking: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['email', 'score', 'motivo'],
        properties: {
          email:  { type: 'string' },
          score:  { type: 'integer' },   // 0..100, calce con ESTE pedido
          motivo: { type: 'string' },    // 1 línea de por qué (o por qué no)
        },
      },
    },
  },
};

const SYSTEM = `Sos el motor de matching de MudateYa (mudanzas/fletes AR). Recibís un pedido y una lista de mudanceros candidatos (ya prefiltrados por reglas), y los REORDENÁS por qué tan bien calzan con ESE pedido.

Priorizá: cobertura real de la zona (origen y destino), vehículo acorde al volumen, servicios que el pedido necesita (embalaje/desarme), y perfil completo/activo. Penalizá zona lejana o vehículo insuficiente.

Devolvé el ranking con un score 0-100 por mudancero (calce con este pedido puntual) y un motivo de UNA línea. No inventes datos que no estén en el candidato. Devolvé TODOS los candidatos que recibas, ordenados de mejor a peor.`;

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (await limitarPorIP(req, 'match-mudanceros', 15)) {
    return res.status(429).json({ error: 'Demasiadas solicitudes. Esperá un momento.' });
  }
  // Expone teléfonos/datos de mudanceros → solo admin (o master token para el barrido).
  if (!esAdmin(req)) return res.status(403).json({ error: 'No autorizado' });

  try {
    let { pedido, pedidoId, n } = req.body || {};
    const N = Math.min(Math.max(parseInt(n, 10) || 5, 1), 10);

    if (!pedido && pedidoId) {
      try { pedido = await getJSON(`mudanza:${pedidoId}`); } catch (_) {}
    }
    if (!pedido || typeof pedido !== 'object') {
      return res.status(400).json({ error: 'Falta el pedido (mandá "pedido" o un "pedidoId" válido)' });
    }

    // Cargar todos los mudanceros (lista de emails → perfiles por lotes con pipeline).
    const emails = (await getJSON('mudanceros:todos')) || [];
    if (!emails.length) {
      return res.status(200).json({ ranking: [], total: 0, nota: 'No hay mudanceros cargados todavía' });
    }

    const perfiles = [];
    for (let off = 0; off < emails.length; off += 100) {
      const lote = emails.slice(off, off + 100);
      const vals = await redisPipeline(lote.map((e) => ['GET', `mudancero:perfil:${e}`]));
      vals.forEach((v) => { if (v) { try { perfiles.push(JSON.parse(v)); } catch (_) {} } });
    }

    // Solo aprobados.
    const aprobados = perfiles.filter((p) => p && (p.estado === 'aprobado'));

    // Score por reglas y prefiltro (top 12 para la etapa de IA).
    const palabras = palabrasZona(`${pedido.origen || ''} ${pedido.destino || ''}`);
    const puntuados = aprobados
      .map((p) => {
        const { score, señales } = scoreReglas(p, palabras, pedido);
        return {
          email: p.email, nombre: p.nombre || '', empresa: p.empresa || '', telefono: p.telefono || '',
          zonaBase: p.zonaBase || '', zonasExtra: p.zonasExtra || '', vehiculo: p.vehiculo || '',
          servicios: p.servicios || '', dias: p.dias || '', scoreReglas: score, señales,
        };
      })
      .sort((a, b) => b.scoreReglas - a.scoreReglas);

    const candidatos = puntuados.slice(0, 12);

    // Si no hay candidatos, devolvemos vacío (sin cobertura).
    if (!candidatos.length) {
      return res.status(200).json({ ranking: [], total: 0, sinCobertura: true });
    }

    // Etapa IA: reordenar y explicar. Le pasamos lo mínimo necesario.
    let reordenado;
    try {
      const payload = {
        pedido: { tipo: pedido.tipo, origen: pedido.origen, destino: pedido.destino, fecha: pedido.fecha, detalles: pedido.detalles },
        candidatos: candidatos.map((c) => ({
          email: c.email, zonaBase: c.zonaBase, zonasExtra: c.zonasExtra,
          vehiculo: c.vehiculo, servicios: c.servicios, dias: c.dias,
        })),
      };
      const out = await claudeJSON({
        model: MODEL_LIGHT,
        system: SYSTEM,
        content: `PEDIDO Y CANDIDATOS:\n${JSON.stringify(payload).slice(0, 3500)}\n\nReordená y explicá.`,
        schema: SCHEMA,
        maxTokens: 1200,
      });
      reordenado = out.ranking || [];
    } catch (e) {
      console.warn('match-mudanceros: IA falló, uso solo reglas:', e.message);
      reordenado = null;
    }

    // Fusionar la salida de IA con los datos completos del candidato.
    let ranking;
    if (reordenado && reordenado.length) {
      const byEmail = new Map(candidatos.map((c) => [c.email, c]));
      ranking = reordenado
        .map((r) => {
          const c = byEmail.get(r.email);
          if (!c) return null;
          return {
            email: c.email, nombre: c.nombre, empresa: c.empresa, telefono: c.telefono,
            score: typeof r.score === 'number' ? r.score : c.scoreReglas,
            motivo: r.motivo || '', señales: c.señales,
          };
        })
        .filter(Boolean);
    } else {
      // Fallback: solo reglas.
      ranking = candidatos.map((c) => ({
        email: c.email, nombre: c.nombre, empresa: c.empresa, telefono: c.telefono,
        score: c.scoreReglas, motivo: c.señales.join(', ') || 'candidato de la zona', señales: c.señales,
      }));
    }

    ranking.sort((a, b) => b.score - a.score);
    return res.status(200).json({ ranking: ranking.slice(0, N), total: ranking.length });
  } catch (error) {
    console.error('Error en match-mudanceros:', error.message);
    return res.status(500).json({ error: error.message });
  }
};

// Se exportan también los helpers de zona (además del handler) para que
// cotizaciones.js los reuse en el barrido del bot, en vez de duplicar la
// lógica de matching por zona en dos archivos.
module.exports.coincideZona = coincideZona;
module.exports.palabrasZona = palabrasZona;
module.exports.norm = norm;
module.exports.cubreGeo = cubreGeo;
module.exports.esAMBA = esAMBA;
