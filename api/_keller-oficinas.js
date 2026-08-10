// api/_keller-oficinas.js
// Market Centers de Keller Williams Argentina en AMBA (CABA + GBA + La Plata)
// + Córdoba, con email publicado — 10. Sacados a mano de
// kwargentina.com/centros-de-negocios (no tiene API pública como RE/MAX).
//
// Quedan afuera de la lista:
//  - KW Mendoza, KW Salta: fuera de zona (AMBA + Córdoba solamente).
//  - KW Cápital: sin dirección publicada, no se pudo confirmar la zona.
//  - KW ON, KW Punta Chica, KW Leloir: están en zona (AMBA) pero la página
//    no publica ningún email para ellos (KW ON y Punta Chica tienen
//    teléfono, Leloir ni eso) — no se inventa una dirección de contacto.
//
// A diferencia de RE/MAX (oficinas chicas, 1 a 1), acá cada Market Center
// nuclea a muchos asesores — el mail va dirigido a la conducción del centro,
// no a un asesor individual.
module.exports = [
  {n:'KW Norte', e:'kwnorte@kwargentina.com', zona:'Tigre'},
  {n:'KW Pilar', e:'kwpilar@kwargentina.com', zona:'Pilar'},
  {n:'KW San Isidro', e:'kwsanisidro@kwargentina.com', zona:'Martínez'},
  {n:'KW Centro', e:'kwcentro@kwargentina.com', zona:'Devoto, CABA'},
  {n:'KW Suma', e:'kwsuma@kwargentina.com', zona:'La Plata'},
  {n:'KW Conecta', e:'kwconecta@kwargentina.com', zona:'Pilar'},
  {n:'KW City', e:'kwcity@kwargentina.com', zona:'CABA'},
  {n:'KW Nexo', e:'kwnexo@kwargentina.com', zona:'Vicente López'},
  {n:'KW Delta', e:'info.delta@kwargentina.com', zona:'Escobar'},
  {n:'KW Córdoba', e:'kwcordoba@kwargentina.com', zona:'Córdoba'}
];
