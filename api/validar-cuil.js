// api/validar-cuil.js
// Consulta AFIP via TangoFactura para validar si un CUIL existe
// Llamado desde el frontend (onblur del campo CUIL) para feedback inmediato

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { cuil } = req.query;
  if (!cuil) return res.status(400).json({ error: 'Falta el CUIL' });

  const cuilLimpio = cuil.replace(/[-\s]/g, '');

  if (!/^\d{11}$/.test(cuilLimpio)) {
    return res.status(200).json({
      valido: false,
      error:  'El CUIL debe tener 11 dígitos (sin guiones: 20123456789)'
    });
  }

  // Validar dígito verificador del CUIL
  if (!validarDigitoVerificador(cuilLimpio)) {
    return res.status(200).json({
      valido: false,
      error:  'El CUIL ingresado tiene un dígito verificador incorrecto'
    });
  }

  try {
    const response = await fetch(
      `https://afip.tangofactura.com/Rest/GetContribuyenteFull?cuit=${cuilLimpio}`,
      {
        headers: { 'Accept': 'application/json' },
        // Timeout de 5 segundos para no bloquear el formulario
        signal: AbortSignal.timeout(5000),
      }
    );

    if (!response.ok) {
      // AFIP o TangoFactura caído — devolvemos advertencia, no error bloqueante
      return res.status(200).json({
        valido:     null,
        advertencia: true,
        error:      'AFIP no disponible en este momento. Podés continuar igual.'
      });
    }

    const data = await response.json();

    if (data.errorGetData || !data.Contribuyente) {
      return res.status(200).json({
        valido: false,
        error:  'CUIL no encontrado en AFIP. Verificá que sea correcto.'
      });
    }

    const c = data.Contribuyente;

    return res.status(200).json({
      valido:      true,
      cuil:        cuilLimpio,
      nombre:      c.nombre       || '',
      apellido:    c.apellido     || '',
      razonSocial: c.razonSocial  || '',
      estadoClave: c.estadoClave  || '', // ACTIVO / INACTIVO
      tipoClave:   c.tipoClave    || '', // CUIL / CUIT
    });

  } catch(e) {
    // Timeout u otro error de red
    console.warn('Error consultando AFIP:', e.message);
    return res.status(200).json({
      valido:      null,
      advertencia: true,
      error:       'AFIP no disponible temporalmente. Podés continuar igual.'
    });
  }
};

// ── VALIDAR DÍGITO VERIFICADOR DEL CUIL ─────────────────────────
// Algoritmo oficial de AFIP
function validarDigitoVerificador(cuil) {
  if (cuil.length !== 11) return false;
  const digits = cuil.split('').map(Number);
  const serie  = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma   = digits.slice(0, 10).reduce((acc, d, i) => acc + d * serie[i], 0);
  const resto  = suma % 11;
  const dv     = resto === 0 ? 0 : resto === 1 ? 9 : 11 - resto;
  return dv === digits[10];
}
