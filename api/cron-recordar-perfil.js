// api/cron-recordar-perfil.js — Recordatorio SEMANAL consolidado a mudanceros.
// Reemplaza a los recordatorios sueltos de DNI y cobro: en UN solo mail le decimos
// al mudancero TODO lo que le falta para activarse (DNI, cobro, precios, foto del
// vehículo, TyC). Y "revive a los muertos": a los aprobados que hace mucho no
// aparecen les manda un mail de reactivación ("hay pedidos en tu zona").
//
// Idempotencia:
//   - Perfil incompleto: se manda 1 vez por "estado de faltantes". Si completa algo
//     pero le sigue faltando otra cosa, el set cambia y se le vuelve a avisar. Igual
//     hay un piso de 21 días entre mails para no ser pesado.
//   - Reactivación: máximo 1 cada 45 días.
//
// Seguridad: solo Vercel Cron (x-vercel-cron) o admin con token.
// Corre por cron (ver vercel.json). Canal: email (siempre) + WhatsApp opcional
// (plantilla onboarding_mudancero) si ONBOARDING_WA_ACTIVO=1.

const { Resend } = require('resend');

async function redisCall(method, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/${[method, ...args].map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d = await r.json();
  return d.result;
}
async function getJSON(k) { const v = await redisCall('GET', k); return v ? JSON.parse(v) : null; }
async function setJSON(k, v) { await redisCall('SET', k, JSON.stringify(v)); }

function diasDesde(iso) {
  if (!iso) return 99999;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return 99999;
  return Math.floor((Date.now() - t) / 86400000);
}
function ultimaSenal(p) {
  const ts = [p.ultimaActividad, p.ultimaActualizacion, p.fechaRegistro]
    .filter(Boolean).map((f) => new Date(f).getTime()).filter((t) => !isNaN(t));
  return ts.length ? Math.max(...ts) : 0;
}
const numOf = (v) => parseInt(String(v || '').replace(/[^0-9]/g, '')) || 0;
function tienePrecios(p) {
  const pack = (pk) => pk && (numOf(pk.amb1) || numOf(pk.amb2) || numOf(pk.amb3) || numOf(pk.amb4));
  if (pack(p.preciosEsencial) || pack(p.preciosIntegral) || pack(p.preciosLlave) || numOf(p.precioFleteNuevo)) return true;
  if (p.precios && (numOf(p.precios.amb1) || numOf(p.precios.amb2) || numOf(p.precios.amb3) || numOf(p.precios.amb4) || numOf(p.precios.flete))) return true;
  return false;
}

// Qué le falta al perfil (lista de {k, txt}).
function faltantes(p) {
  const falta = [];
  if (!p.dniFrente || !p.dniDorso) {
    const cual = (!p.dniFrente && !p.dniDorso) ? 'las dos fotos del DNI'
      : (!p.dniFrente ? 'el frente del DNI' : 'el dorso del DNI');
    falta.push({ k: 'dni', txt: 'Subir ' + cual });
  }
  const cobroOk = p.metodoCobro === 'mp' ? !!p.emailMP : !!p.cbu;
  if (!cobroOk) falta.push({ k: 'cobro', txt: 'Cargar tus datos de cobro (CBU/Alias o Mercado Pago)' });
  if (!tienePrecios(p)) falta.push({ k: 'precios', txt: 'Cargar tus precios' });
  if (p.tipoCobro !== 'fijo' && p.tipoCobro !== 'porHora') falta.push({ k: 'tipoCobro', txt: 'Elegir cómo cobrás (precio fijo o por hora)' });
  const tieneFotoVeh = !!(p.fotoCamion || (Array.isArray(p.fotosVehiculo) && p.fotosVehiculo.length));
  if (!tieneFotoVeh) falta.push({ k: 'vehiculo', txt: 'Subir una foto de tu vehículo' });
  if (p.estado === 'aprobado' && p.terminosAceptados !== true) {
    falta.push({ k: 'tyc', txt: 'Aceptar los Términos y Condiciones' });
  }
  return falta;
}

// ── Emails ────────────────────────────────────────────────────────
function shell(inner) {
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0">
    <div style="background:#003580;padding:26px 32px"><div style="font-family:'Arial Black',Arial,sans-serif;font-size:26px;color:#fff;letter-spacing:1px">Mudate<span style="color:#22C36A">Ya</span></div></div>
    <div style="background:#22C36A;padding:4px"></div>
    <div style="padding:30px 32px">${inner}</div>
    <div style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:16px 32px;text-align:center"><p style="font-size:11px;color:#94A3B8;font-family:monospace;margin:0">MudateYa · <a href="https://mudateya.ar" style="color:#94A3B8">mudateya.ar</a></p></div>
  </div>`;
}
function emailIncompleto(p, falta) {
  const nombre = (p.nombre || 'Mudancero').split(' ')[0];
  const items = falta.map((f) => `<li style="margin:8px 0;font-size:14px;color:#0F1923">${f.txt}</li>`).join('');
  return shell(
    `<div style="font-size:38px;text-align:center;margin-bottom:12px">🚚</div>
     <h2 style="font-size:21px;color:#003580;margin:0 0 8px;text-align:center">¡Hola ${nombre}! Te falta poco para recibir pedidos</h2>
     <p style="font-size:14px;color:#475569;text-align:center;margin:0 0 22px;line-height:1.6">Tu perfil está casi listo. Para empezar a recibir pedidos en tu zona, completá esto:</p>
     <div style="background:#F0F5FF;border:1px solid #C7D9FF;border-radius:12px;padding:18px 22px;margin-bottom:24px">
       <ul style="margin:0;padding-left:20px">${items}</ul>
     </div>
     <a href="https://mudateya.ar/mi-cuenta" style="display:block;background:#22C36A;color:#fff;text-align:center;padding:14px 24px;border-radius:10px;text-decoration:none;font-size:15px;font-weight:700">Completar mi perfil →</a>
     <p style="font-size:12px;color:#94A3B8;text-align:center;margin:14px 0 0">Te toma un par de minutos. Si ya lo hiciste, ignorá este mail.</p>`
  );
}
function emailReactivar(p) {
  const nombre = (p.nombre || 'Mudancero').split(' ')[0];
  const zona = p.zonaBase ? ` en ${p.zonaBase}` : '';
  return shell(
    `<div style="font-size:38px;text-align:center;margin-bottom:12px">👋</div>
     <h2 style="font-size:21px;color:#003580;margin:0 0 8px;text-align:center">${nombre}, ¡hace rato no te vemos!</h2>
     <p style="font-size:14px;color:#475569;text-align:center;margin:0 0 22px;line-height:1.6">Están entrando pedidos de mudanzas y fletes${zona}. Si seguís activo, entrá y revisá los que podés cotizar — es plata que se están llevando otros.</p>
     <a href="https://mudateya.ar/mi-cuenta" style="display:block;background:#22C36A;color:#fff;text-align:center;padding:14px 24px;border-radius:10px;text-decoration:none;font-size:15px;font-weight:700">Ver pedidos disponibles →</a>
     <p style="font-size:12px;color:#94A3B8;text-align:center;margin:14px 0 0">¿No querés recibir más estos avisos? Respondé este mail con "BAJA".</p>`
  );
}

async function nudgeWhatsApp(p, falta) {
  if (!(process.env.ONBOARDING_WA_ACTIVO === '1' || process.env.ONBOARDING_WA_ACTIVO === 'true')) return;
  if (!p.telefono) return;
  const nombre = (p.nombre || 'Hola').split(' ')[0];
  const lista = falta.map((f) => f.txt.replace(/^Subir |^Cargar |^Aceptar /, '').toLowerCase()).join(', ');
  const frase = `todavía te falta: ${lista}`;
  try {
    const { enviarPlantilla } = require('./_plantillas');
    const textoLibre = `¡Hola ${nombre}! Soy Emi de MudateYa. Para activar tu cuenta ${frase}. Completalo acá: https://mudateya.ar/mi-cuenta 🚚`;
    await enviarPlantilla(p.telefono, 'onboarding_mudancero', { 1: nombre, 2: frase }, textoLibre);
  } catch (e) { console.warn('nudgeWhatsApp perfil:', e.message); }
}

module.exports = async function handler(req, res) {
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    return res.status(200).json({ ok: true, skipped: 'no-prod' });
  }
  const esVercelCron = req.headers['x-vercel-cron'] === '1';
  let esAdminReq = false;
  try { esAdminReq = require('./_auth').esAdmin(req); } catch (_) {}
  if (!esVercelCron && !esAdminReq) return res.status(401).json({ error: 'No autorizado' });
  if (!process.env.RESEND_API_KEY) return res.status(200).json({ error: 'sin RESEND_API_KEY' });

  const DIAS_DORMIDO = 45;   // aprobado sin señales de vida → reactivar
  const PISO_INCOMPLETO = 21; // días mínimos entre recordatorios de perfil
  const PISO_REACTIVAR = 45;  // días mínimos entre reactivaciones
  const MAX = 120;

  const resend = new Resend(process.env.RESEND_API_KEY);
  const out = { revisados: 0, incompletos: 0, reactivados: 0, fallidos: 0 };

  try {
    const todos = (await getJSON('mudanceros:todos')) || [];
    for (const email of todos) {
      if (out.incompletos + out.reactivados >= MAX) break;
      const p = await getJSON(`mudancero:perfil:${email}`);
      if (!p || !p.email || p.estado === 'rechazado') continue;
      out.revisados++;

      const falta = faltantes(p);

      // 1) Perfil incompleto → recordatorio consolidado (todo lo que falta).
      if (falta.length) {
        const hash = falta.map((f) => f.k).sort().join(',');
        const prev = p.recordatorioPerfil || {};
        const cambioSet = prev.hash !== hash;
        const pasoPiso = diasDesde(prev.enviadoEn) >= PISO_INCOMPLETO;
        if (cambioSet || pasoPiso) {
          try {
            await resend.emails.send({
              from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
              to: p.email,
              subject: `Te falta poco para recibir pedidos en MudateYa (${falta.length} paso${falta.length > 1 ? 's' : ''})`,
              html: emailIncompleto(p, falta),
            });
            await nudgeWhatsApp(p, falta);
            p.recordatorioPerfil = { enviadoEn: new Date().toISOString(), hash };
            await setJSON(`mudancero:perfil:${email}`, p);
            out.incompletos++;
          } catch (e) { out.fallidos++; console.warn('incompleto', email, e.message); }
        }
        continue; // si le falta algo, no lo tratamos como "dormido"
      }

      // 2) Perfil completo pero DORMIDO (aprobado, sin señales hace mucho) → reactivar.
      if (p.estado === 'aprobado') {
        const dias = diasDesde(new Date(ultimaSenal(p)).toISOString());
        const ultReact = p.reactivacionMudancero && p.reactivacionMudancero.enviadoEn;
        if (dias > DIAS_DORMIDO && diasDesde(ultReact) >= PISO_REACTIVAR) {
          try {
            await resend.emails.send({
              from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
              to: p.email,
              subject: `${(p.nombre || '').split(' ')[0] || 'Hola'}, hace rato no te vemos — hay pedidos en tu zona`,
              html: emailReactivar(p),
            });
            p.reactivacionMudancero = { enviadoEn: new Date().toISOString(), diasInactivo: dias };
            await setJSON(`mudancero:perfil:${email}`, p);
            out.reactivados++;
          } catch (e) { out.fallidos++; console.warn('reactivar', email, e.message); }
        }
      }
    }

    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    console.error('cron-recordar-perfil:', e.message);
    return res.status(200).json({ error: e.message, ...out });
  }
};
