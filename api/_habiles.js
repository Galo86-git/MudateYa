// api/_habiles.js
//
// Cálculo de vencimientos en HORAS HÁBILES para Argentina.
// Vercel ignora los archivos de /api que empiezan con "_": no se deploya como función.
//
// DEFINICIÓN QUE IMPLEMENTA
//   El reloj de las 24hs corre ÚNICAMENTE durante días hábiles.
//   Sábados, domingos y feriados no suman tiempo: el reloj se pausa.
//
//   Publicado miércoles 15:00            → vence jueves 15:00
//   Publicado viernes 15:00              → vence lunes 15:00
//   Publicado viernes 15:00 + lunes feriado → vence martes 15:00
//   Publicado sábado 10:00               → el reloj arranca el lunes 00:00
//                                          y vence el martes 00:00
//
//   Se cuentan las 24hs del día hábil completo, no un horario comercial
//   de 9 a 18. Contar solo horario de oficina haría que un pedido del
//   viernes venciera recién el miércoles, que es demasiado.
//
// ZONA HORARIA
//   Vercel corre en UTC. Argentina es UTC-3 todo el año (no tiene horario
//   de verano desde 2009). Todo el cálculo se hace en hora argentina para
//   que el corte de día no se desplace 3 horas.
//
// ── MANTENIMIENTO ANUAL ─────────────────────────────────────────────
//   Los feriados trasladables y los puentes turísticos los fija el Poder
//   Ejecutivo por decreto cada año (ley 27.399). HAY QUE ACTUALIZAR ESTA
//   TABLA TODOS LOS AÑOS, idealmente en diciembre cuando Jefatura de
//   Gabinete publica el calendario del año siguiente.
//   Fuente: https://www.argentina.gob.ar/jefatura/feriados-nacionales-2026
//
//   Si el año no está en la tabla, el cálculo sigue funcionando pero solo
//   descuenta fines de semana (y deja un warning en los logs). Es a
//   propósito: preferimos un vencimiento un poco corto antes que romper
//   la publicación de un pedido.

var OFFSET_AR_MIN = -180; // UTC-3

// Feriados nacionales + días no laborables con fines turísticos.
// Formato 'YYYY-MM-DD'.
var FERIADOS = {
  2026: [
    '2026-01-01', // Año Nuevo
    '2026-02-16', // Carnaval
    '2026-02-17', // Carnaval
    '2026-03-23', // No laborable con fines turísticos (puente)
    '2026-03-24', // Día de la Memoria
    '2026-04-02', // Malvinas
    '2026-04-03', // Viernes Santo
    '2026-05-01', // Día del Trabajador
    '2026-05-25', // Revolución de Mayo
    '2026-06-15', // Güemes (trasladado desde el 17)
    '2026-06-20', // Belgrano (cae sábado)
    '2026-07-09', // Independencia
    '2026-07-10', // No laborable con fines turísticos (puente)
    '2026-08-17', // San Martín
    '2026-10-12', // Diversidad Cultural
    '2026-11-23', // Soberanía Nacional (trasladado desde el 20)
    '2026-12-07', // No laborable con fines turísticos (puente)
    '2026-12-08', // Inmaculada Concepción
    '2026-12-25'  // Navidad
  ],
  // 2027: solo los inamovibles y los de fecha calculable. Los trasladables
  // y los puentes se agregan cuando salga el decreto.
  2027: [
    '2027-01-01', // Año Nuevo
    '2027-02-08', // Carnaval
    '2027-02-09', // Carnaval
    '2027-03-24', // Día de la Memoria
    '2027-03-26', // Viernes Santo
    '2027-04-02', // Malvinas
    '2027-05-01', // Día del Trabajador
    '2027-05-25', // Revolución de Mayo
    '2027-06-20', // Belgrano
    '2027-07-09', // Independencia
    '2027-12-08', // Inmaculada Concepción
    '2027-12-25'  // Navidad
  ]
};

var _avisado = {}; // para no spamear los logs con el mismo año

// Convierte un Date (UTC) a los componentes de fecha/hora en Argentina.
function aHoraAR(fecha) {
  return new Date(fecha.getTime() + OFFSET_AR_MIN * 60 * 1000);
}

// Devuelve 'YYYY-MM-DD' de un Date ya desplazado a hora argentina.
function claveDia(fechaAR) {
  var y = fechaAR.getUTCFullYear();
  var m = String(fechaAR.getUTCMonth() + 1).padStart(2, '0');
  var d = String(fechaAR.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function esFeriado(fechaAR) {
  var anio = fechaAR.getUTCFullYear();
  var lista = FERIADOS[anio];
  if (!lista) {
    if (!_avisado[anio]) {
      console.warn('[habiles] sin tabla de feriados para ' + anio +
                   ' — solo se descuentan fines de semana. Actualizar api/_habiles.js');
      _avisado[anio] = true;
    }
    return false;
  }
  return lista.indexOf(claveDia(fechaAR)) !== -1;
}

function esFinDeSemana(fechaAR) {
  var d = fechaAR.getUTCDay(); // 0 domingo, 6 sábado
  return d === 0 || d === 6;
}

// true si ese día suma tiempo al reloj.
function esDiaHabil(fechaAR) {
  return !esFinDeSemana(fechaAR) && !esFeriado(fechaAR);
}

// Núcleo: suma `horas` de tiempo hábil a partir de `desde` (Date en UTC).
// Devuelve un Date en UTC.
function sumarHorasHabiles(desde, horas) {
  var MIN_MS = 60 * 1000;
  var DIA_MS = 24 * 60 * MIN_MS;
  var restanMin = Math.round(horas * 60);
  var cursor = new Date(desde.getTime());

  // Guarda de seguridad: no más de 60 días de búsqueda.
  var limite = new Date(desde.getTime() + 60 * DIA_MS);

  while (restanMin > 0 && cursor < limite) {
    var cursorAR = aHoraAR(cursor);

    if (!esDiaHabil(cursorAR)) {
      // Saltar al comienzo del día siguiente (00:00 hora argentina).
      var finDeDiaAR = Date.UTC(
        cursorAR.getUTCFullYear(), cursorAR.getUTCMonth(), cursorAR.getUTCDate() + 1, 0, 0, 0, 0
      );
      cursor = new Date(finDeDiaAR - OFFSET_AR_MIN * MIN_MS);
      continue;
    }

    // Minutos hábiles que quedan en este día (hasta las 24:00 hora AR).
    var finDiaAR = Date.UTC(
      cursorAR.getUTCFullYear(), cursorAR.getUTCMonth(), cursorAR.getUTCDate() + 1, 0, 0, 0, 0
    );
    var finDiaUTC = finDiaAR - OFFSET_AR_MIN * MIN_MS;
    var disponibles = Math.round((finDiaUTC - cursor.getTime()) / MIN_MS);

    if (disponibles >= restanMin) {
      return new Date(cursor.getTime() + restanMin * MIN_MS);
    }
    restanMin -= disponibles;
    cursor = new Date(finDiaUTC);
  }

  // Si algo salió mal, devolver el fallback de 24hs corridas.
  console.error('[habiles] no se pudo calcular el vencimiento, se usa fallback corrido');
  return new Date(desde.getTime() + horas * 60 * MIN_MS);
}

// Helper de conveniencia: ISO string del vencimiento a N horas hábiles de ahora.
function vencimientoHabilISO(horas, desde) {
  var base = desde ? new Date(desde) : new Date();
  return sumarHorasHabiles(base, horas).toISOString();
}

module.exports = {
  sumarHorasHabiles: sumarHorasHabiles,
  vencimientoHabilISO: vencimientoHabilISO,
  esDiaHabil: esDiaHabil,
  esFeriado: esFeriado,
  aHoraAR: aHoraAR,
  FERIADOS: FERIADOS
};
