// api/validar-cuil.js
// Valida CUIL argentino consultando CuitOnline (scraping del HTML)
// TangoFactura y la API oficial de AFIP/ARCA no tienen acceso público gratuito
// CuitOnline usa datos del padrón público de ARCA — misma fuente, sin API key

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { cuil } = req.query;
  if (!cuil) return res.status(400).json({ error: 'Falta el CUIL' });

  const cuilLimpio = cuil.replace(/[-\s]/g, '');

  // ── 1. VALIDAR FORMATO ────────────────────────────────────────
  if (!/^\d{11}$/.test(cuilLimpio)) {
    return res.status(200).json({
      valido: false,
      error:  'El CUIL/CUIT debe tener 11 dígitos (ej: 20-12345678-9 o 30-12345678-9)'
    });
  }

  // ── 2. VALIDAR DÍGITO VERIFICADOR ────────────────────────────
  if (!validarDV(cuilLimpio)) {
    return res.status(200).json({
      valido: false,
      error:  'El CUIL/CUIT tiene un dígito verificador incorrecto. Revisá que lo hayas ingresado bien.'
    });
  }

  // ── 3. CONSULTAR CUITONLINE ──────────────────────────────────
  try {
    const response = await fetch(
      `https://www.cuitonline.com/search.php?q=${cuilLimpio}`,
      {
        headers: {
          // Simular un browser para evitar bloqueos
          'User-Agent': 'Mozilla/5.0 (compatible; MudateYa/1.0)',
          'Accept':     'text/html,application/xhtml+xml',
          'Accept-Language': 'es-AR,es;q=0.9',
        },
        signal: AbortSignal.timeout(6000),
      }
    );

    if (!response.ok) {
      return res.status(200).json({
        valido:      null,
        advertencia: true,
        error:       'No se pudo consultar el padrón en este momento. Podés continuar igual.'
      });
    }

    const html = await response.text();

    // ── 4. PARSEAR EL HTML ──────────────────────────────────────
    // CuitOnline devuelve algo como:
    // <strong>ZALDIVAR JUAN GALO</strong>
    // • CUIT: 20-32507679-9
    // Persona Física (masculino)

    // Verificar si no encontró resultados
    if (html.includes('No se encontraron resultados') || html.includes('0 personas encontradas')) {
      return res.status(200).json({
        valido: false,
        error:  'CUIL/CUIT no encontrado en el padrón de ARCA. Verificá que sea correcto.'
      });
    }

    // Extraer el nombre — aparece en un tag <strong> o como texto destacado
    const nombreMatch = html.match(/class="nombre[^"]*"[^>]*>([^<]+)</) ||
                        html.match(/<strong>([A-ZÁÉÍÓÚÑ\s]+)<\/strong>/) ||
                        html.match(/CUIT:\s*[\d\-]+[^<]*<[^>]+>\s*([A-ZÁÉÍÓÚÑ\s,]+)</i);

    // Extraer el CUIL con formato oficial
    const cuitMatch = html.match(/CUIT:\s*([\d\-]+)/i);

    // Extraer tipo de persona
    const tipoMatch = html.match(/Persona\s+(Física|Jurídica)/i);

    if (!nombreMatch && !cuitMatch) {
      // Página cargó pero no encontró el CUIL
      return res.status(200).json({
        valido: false,
        error:  'CUIL/CUIT no encontrado en el padrón de ARCA.'
      });
    }

    // Normalizar nombre — puede venir como "APELLIDO NOMBRE" o "APELLIDO, NOMBRE"
    const nombreRaw   = (nombreMatch ? nombreMatch[1] : '').trim();
    const partes      = nombreRaw.includes(',')
      ? nombreRaw.split(',').map(s => s.trim())
      : nombreRaw.split(' ');

    const apellido = partes[0] || '';
    const nombres  = partes.slice(1).join(' ') || '';

    return res.status(200).json({
      valido:      true,
      cuil:        cuilLimpio,
      nombre:      nombres,
      apellido:    apellido,
      nombreCompleto: nombreRaw,
      tipoClave:   tipoMatch ? tipoMatch[1] : 'Física',
      fuente:      'ARCA via CuitOnline',
    });

  } catch(e) {
    console.warn('Error consultando CuitOnline:', e.message);
    // Timeout u otro error — no bloqueamos el formulario
    return res.status(200).json({
      valido:      null,
      advertencia: true,
      error:       'El padrón no está disponible ahora. Podés continuar igual, verificamos manualmente.'
    });
  }
};

// ── VALIDAR DÍGITO VERIFICADOR DEL CUIL (algoritmo oficial ARCA) ─
function validarDV(cuil) {
  if (cuil.length !== 11) return false;
  const digits = cuil.split('').map(Number);
  const serie  = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma   = digits.slice(0, 10).reduce((acc, d, i) => acc + d * serie[i], 0);
  const resto  = suma % 11;
  const dv     = resto === 0 ? 0 : resto === 1 ? 9 : 11 - resto;
  return dv === digits[10];
}
