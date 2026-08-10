// api/_coldwell-oficinas.js
// Oficinas de Coldwell Banker Argentina en AMBA (CABA + GBA Norte + GBA Sur)
// + Córdoba — 28 direcciones únicas ("Seniority" y "Seniority +", que
// comparten el mismo mail, cuentan una sola vez acá). Sacadas a mano de
// coldwellbanker.com.ar/oficina (listado público completo, sin API).
//
// No hay ninguna en Rosario — la única de "Santa Fe" en el directorio es la
// ciudad de Santa Fe capital, no Rosario.
//
// Nota: "Coldwell Banker Río de la Plata" (Vicente López) usa
// contacto@coldwellbanker.com.ar, el mismo mail de contacto general de la
// empresa (no un buzón exclusivo de esa sucursal) — se incluye igual porque
// es una dirección real y activa, pero es distinto al resto.
module.exports = [
  // CABA
  {n:'Coldwell Banker Seniority', e:'seniority@coldwellbanker.com.ar', zona:'CABA'},
  {n:'Coldwell Banker Ser', e:'ser@coldwellbanker.com.ar', zona:'CABA'},
  {n:'Coldwell Banker SpaceBa', e:'spaceba@coldwellbanker.com.ar', zona:'CABA'},
  {n:'Coldwell Banker Ápice', e:'carolina.fernandez@coldwellbanker.com.ar', zona:'CABA'},
  {n:'Coldwell Banker Wings', e:'wings@coldwellbanker.com.ar', zona:'CABA'},
  {n:'Coldwell Banker Database', e:'database@coldwellbanker.com.ar', zona:'CABA'},
  {n:'Coldwell Banker Niceto Real Estate', e:'info.niceto@coldwellbanker.com.ar', zona:'CABA'},
  {n:'Coldwell Banker Desiderio Group', e:'desideriogroup@coldwellbanker.com.ar', zona:'CABA'},
  {n:'Coldwell Banker Goyena', e:'info.goyena@coldwellbanker.com.ar', zona:'CABA'},
  {n:'Coldwell Banker Haka Real Estate', e:'info.haka@coldwellbanker.com.ar', zona:'CABA'},
  {n:'Coldwell Banker Horizon Group', e:'info.horizon@coldwellbanker.com.ar', zona:'CABA'},
  {n:'Coldwell Banker Grupo Elite Bienes Raices', e:'info.grupoelite@coldwellbanker.com.ar', zona:'CABA'},
  {n:'Coldwell Banker Destino', e:'destino@coldwellbanker.com.ar', zona:'CABA'},
  {n:'Coldwell Banker Beyker', e:'info.beyker@coldwellbanker.com.ar', zona:'CABA'},
  {n:'Coldwell Banker Lion Team', e:'info.lionteam@coldwellbanker.com.ar', zona:'CABA'},
  {n:'Coldwell Banker Nova', e:'info.cbnova@coldwellbanker.com.ar', zona:'CABA'},
  {n:'Coldwell Banker Notable', e:'info.notable@coldwellbanker.com.ar', zona:'CABA'},
  {n:'Coldwell Banker Livello', e:'recepcion.livello@coldwellbanker.com.ar', zona:'CABA'},
  // GBA Norte
  {n:'Coldwell Banker Quality Real Estate', e:'quality@coldwellbanker.com.ar', zona:'GBA Norte'},
  {n:'Coldwell Banker Acqua', e:'acqua@coldwellbanker.com.ar', zona:'GBA Norte'},
  {n:'Coldwell Banker North Team', e:'north.team@coldwellbanker.com.ar', zona:'GBA Norte'},
  {n:'Coldwell Banker Tig Real Estate', e:'tig@coldwellbanker.com.ar', zona:'GBA Norte'},
  {n:'Coldwell Banker Puerto Norte Group', e:'puertonortegroup@coldwellbanker.com.ar', zona:'GBA Norte'},
  {n:'Coldwell Banker Río de la Plata', e:'contacto@coldwellbanker.com.ar', zona:'GBA Norte'},
  {n:'Coldwell Banker Lion Team Norte', e:'info.lionteamnorte@coldwellbanker.com.ar', zona:'GBA Norte'},
  // GBA Sur
  {n:'Coldwell Banker Boutique', e:'infoboutique@coldwellbanker.com.ar', zona:'GBA Sur'},
  {n:'Coldwell Banker Golden Team', e:'gestion.goldenteam@coldwellbanker.com.ar', zona:'GBA Sur'},
  // Córdoba
  {n:'Coldwell Banker Activo', e:'activo@coldwellbanker.com.ar', zona:'Córdoba'}
];
