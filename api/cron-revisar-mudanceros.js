// api/cron-revisar-mudanceros.js — Triage automático de mudanceros pendientes.
//
//   #2 AUTO-APROBACIÓN: perfiles "limpios" (identidad VERDE + onboarding completo +
//      DNI + precios + datos de cobro) se aprueban solos → email de alta + términos
//      (el mismo que la aprobación manual del admin).
//   #6 ANTI-FRAUDE: perfiles con identidad en ROJO (DNI no coincide con el CUIL,
//      documento vencido, etc.) NUNCA se auto-aprueban; se reportan al admin.
//
// SEGURIDAD (importante en testing): la auto-aprobación REAL —la que le manda el
// mail al mudancero— está detrás del flag de entorno AUTO_APROBAR_ACTIVO.
//   - Sin el flag (default) → modo DRY-RUN: no toca a ningún mudancero real; solo
//     le manda al admin el resumen de a quién APROBARÍA y a quién marcó de riesgo.
//   - Con AUTO_APROBAR_ACTIVO=1 → aprueba de verdad a los limpios.
// El reporte de fraude/revisión al admin se manda en los dos modos.
//
// Corre por cron (ver vercel.json).

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
async function setJSON(k, v, ex) {
  const a = ['SET', k, JSON.stringify(v)];
  if (ex) a.push('EX', String(ex));
  return redisCall(...a);
}

// ── Reglas de triage ─────────────────────────────────────────────
// Devuelve { accion: 'skip'|'aprobar'|'fraude'|'revisar', motivos: [] }
function evaluar(p) {
  if ((p.estado || '') !== 'pendiente_revision') return { accion: 'skip', motivos: [] };

  const motivos = [];
  const nivel = (p.verificacion && p.verificacion.nivel) || (p.dniAnalisis ? 'amarillo' : 'sin_dni');

  if ((p.estadoOnboarding || '') !== 'completo') motivos.push('onboarding incompleto (pre-registrado)');
  if (!p.dniFrente || !p.dniDorso) motivos.push('faltan fotos de DNI');
  if (!p.vehiculo) motivos.push('sin vehículo declarado');

  const tienePrecios = (Array.isArray(p.serviciosActivos) && p.serviciosActivos.length) ||
    (p.precios && (p.precios.amb1 || p.precios.flete));
  if (!tienePrecios) motivos.push('sin precios cargados');

  const tieneCobro = p.metodoCobro === 'mp' ? !!p.emailMP : !!p.cbu;
  if (!tieneCobro) motivos.push('sin datos de cobro (CBU/MP)');

  // Rojo = señal de fraude de identidad → siempre a revisión manual.
  if (nivel === 'rojo') {
    const detalle = (p.verificacion && Array.isArray(p.verificacion.motivos))
      ? p.verificacion.motivos.filter((x) => x.nivel === 'rojo').map((x) => x.texto).join(' · ')
      : 'identidad en rojo';
    return { accion: 'fraude', motivos: ['⚠️ Identidad ROJA: ' + detalle, ...motivos] };
  }

  // Limpio de verdad → aprobar.
  if (motivos.length === 0 && nivel === 'verde') return { accion: 'aprobar', motivos: [] };

  // Le falta algo o identidad amarilla → revisión manual (no es fraude).
  return { accion: 'revisar', motivos: motivos.length ? motivos : ['identidad amarilla / a confirmar'] };
}

// ── Email de resumen al admin ────────────────────────────────────
async function enviarResumenAdmin({ aprobados, fraude, revisar, dryRun }) {
  const to = process.env.ADMIN_EMAIL;
  if (!to || !process.env.RESEND_API_KEY) return;
  const resend = new Resend(process.env.RESEND_API_KEY);

  const fila = (p, extra) =>
    `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${p.nombre || '—'}<br>` +
    `<span style="color:#94A3B8;font-size:11px">${p.email || ''} · ${p.zonaBase || '—'}</span></td>` +
    `<td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:12px;color:#475569">${extra || ''}</td></tr>`;

  const bloque = (titulo, color, items, render) => !items.length ? '' :
    `<h3 style="color:${color};margin:20px 0 6px;font-size:15px">${titulo} (${items.length})</h3>` +
    `<table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px">${items.map(render).join('')}</table>`;

  const html = `
    <div style="max-width:640px;margin:0 auto;font-family:Arial,sans-serif;color:#0F1923">
      <h2 style="color:#003580">Revisión automática de mudanceros</h2>
      <p style="color:#475569;font-size:13px">
        ${dryRun
          ? '🧪 <b>Modo prueba</b> (AUTO_APROBAR_ACTIVO apagado): no se aprobó a nadie automáticamente. Esto es lo que <b>aprobaría</b>.'
          : '✅ <b>Modo activo</b>: los de abajo ya fueron aprobados automáticamente (mail de alta enviado).'}
      </p>
      ${bloque(dryRun ? '✅ Aprobaría automáticamente' : '✅ Aprobados automáticamente', '#166534', aprobados, (p) => fila(p, 'Identidad verde · perfil completo'))}
      ${bloque('⚠️ Posible fraude — revisar a mano', '#B91C1C', fraude, (p) => fila(p, (p._motivos || []).join(' · ')))}
      ${bloque('📝 Faltan datos — revisar a mano', '#B45309', revisar, (p) => fila(p, (p._motivos || []).join(' · ')))}
      <p style="color:#94A3B8;font-size:11px;margin-top:24px">
        MudateYa · revisá el panel de admin para aprobar/rechazar los marcados a mano.
      </p>
    </div>`;

  await resend.emails.send({
    from: 'MudateYa <noreply@mudateya.ar>', reply_to: 'hola@mudateya.ar',
    to,
    subject: `🔎 Mudanceros: ${aprobados.length} ${dryRun ? 'para aprobar' : 'aprobados'} · ${fraude.length} riesgo · ${revisar.length} a revisar`,
    html,
  });
}

module.exports = async function handler(req, res) {
  try {
    const AUTO = process.env.AUTO_APROBAR_ACTIVO === '1' || process.env.AUTO_APROBAR_ACTIVO === 'true';
    const pendientes = (await getJSON('mudanceros:pendientes')) || [];

    const aprobados = [], fraude = [], revisar = [];
    let quedanPendientes = [...pendientes];

    for (const email of pendientes) {
      const p = await getJSON(`mudancero:perfil:${email}`);
      if (!p) { quedanPendientes = quedanPendientes.filter((e) => e !== email); continue; }

      const { accion, motivos } = evaluar(p);
      if (accion === 'skip') continue;
      p._motivos = motivos;

      if (accion === 'aprobar') {
        aprobados.push(p);
        if (AUTO) {
          // Aprobar de verdad: mismo efecto que admin-aprobar.
          p.estado = 'aprobado';
          p.terminosAceptados = false;
          p.fechaCambioEstado = new Date().toISOString();
          p.autoAprobado = new Date().toISOString();
          await setJSON(`mudancero:perfil:${email}`, p);
          quedanPendientes = quedanPendientes.filter((e) => e !== email);
          try {
            const { enviarEmailAltaExitosa } = require('./admin-aprobar');
            await enviarEmailAltaExitosa(p);
          } catch (e) { console.error('email alta auto:', e.message); }
        }
      } else if (accion === 'fraude') {
        fraude.push(p);
      } else {
        revisar.push(p);
      }
    }

    if (AUTO) await setJSON('mudanceros:pendientes', quedanPendientes);

    // Reporte al admin solo si hay algo que mostrar.
    if (aprobados.length || fraude.length || revisar.length) {
      try {
        await enviarResumenAdmin({ aprobados, fraude, revisar, dryRun: !AUTO });
      } catch (e) { console.error('resumen admin:', e.message); }
    }

    return res.status(200).json({
      ok: true, modo: AUTO ? 'activo' : 'dry-run',
      aprobados: aprobados.length, fraude: fraude.length, revisar: revisar.length,
    });
  } catch (e) {
    console.error('cron-revisar-mudanceros:', e.message);
    return res.status(200).json({ error: e.message });
  }
};
