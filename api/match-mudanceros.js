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
function coincideZona(cobertura, palabras) {
  if (esComodinNacional(cobertura)) return true;
  const cob = norm(cobertura);
  if (palabras.some((p) => cob.includes(p))) return true;
  const cobPal = palabrasZona(cob);
  return cobPal.some((p) => palabras.some((b) => b.includes(p) || p.includes(b)));
}

// ── Score por reglas (0..100) ────────────────────────────────────────────────
function scoreReglas(perfil, palabras, pedido) {
  let score = 0;
  const señales = [];

  const cobertura = `${perfil.zonaBase || ''} ${perfil.zonasExtra || ''}`;
  if (coincideZona(cobertura, palabras)) { score += 45; señales.push('cubre la zona'); }

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
