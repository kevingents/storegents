/**
 * Mapping: winkel-naam → RES-filiaal branchId in SRS.
 *
 * Elke winkel heeft een eigen "RES" (reserverings)-filiaal in SRS waar
 * gereserveerde artikelen naartoe worden geboekt (uitgewisseld vanuit de
 * winkel-voorraad). Bron: SRS programma "Filialen" config.
 *
 * Bij toevoegen van een nieuwe winkel: voeg hier én in stores_html mapping
 * (sections/gents-portal-v6.liquid) toe.
 */

export const RESERVERING_BRANCH_MAP = {
  'GENTS Almere':     { branchId: '201', name: 'RES GENTS Almere' },
  'GENTS Amersfoort': { branchId: '202', name: 'RES GENTS Amersfoort' },
  'GENTS Arnhem':     { branchId: '203', name: 'RES GENTS Arnhem' },
  'GENTS Breda':      { branchId: '204', name: 'RES GENTS Breda' },
  'GENTS Delft':      { branchId: '205', name: 'RES GENTS Delft' },
  'GENTS Enschede':   { branchId: '208', name: 'RES GENTS Enschede' },
  'GENTS Groningen':  { branchId: '210', name: 'RES GENTS Groningen' },
  'GENTS Hilversum':  { branchId: '212', name: 'RES GENTS Hilversum' },
  'GENTS Leiden':     { branchId: '213', name: 'RES GENTS Leiden' },
  'GENTS Maastricht': { branchId: '214', name: 'RES GENTS Maastricht' },
  'GENTS Amsterdam':  { branchId: '215', name: 'RES GENTS Amsterdam' },
  'GENTS Nijmegen':   { branchId: '216', name: 'RES GENTS Nijmegen' },
  'GENTS Tilburg':    { branchId: '217', name: 'RES GENTS Tilburg' },
  'GENTS Utrecht':    { branchId: '218', name: 'RES GENTS Utrecht' },
  'GENTS Zoetermeer': { branchId: '219', name: 'RES GENTS Zoetermeer' },
  'GENTS Rotterdam':  { branchId: '220', name: 'RES GENTS Rotterdam' },
  'GENTS Zwolle':     { branchId: '222', name: 'RES GENTS Zwolle' },
  'GENTS Den Bosch':  { branchId: '223', name: 'RES GENTS Den Bosch' },
  'GENTS Antwerpen':  { branchId: '250', name: 'RES GENTS Antwerpen' }
};

/**
 * Resolve een winkelnaam naar het RES-filiaal.
 * Case-insensitive match + tolerantie voor "Gents" / "GENTS" varianten.
 */
export function getReserveringBranch(storeName) {
  const target = String(storeName || '').trim();
  if (!target) return null;
  if (RESERVERING_BRANCH_MAP[target]) return RESERVERING_BRANCH_MAP[target];
  /* Case-insensitive fallback */
  const targetLower = target.toLowerCase();
  for (const [key, value] of Object.entries(RESERVERING_BRANCH_MAP)) {
    if (key.toLowerCase() === targetLower) return value;
  }
  return null;
}

export function listReserveringBranches() {
  return Object.entries(RESERVERING_BRANCH_MAP).map(([store, info]) => ({
    store,
    branchId: info.branchId,
    resName: info.name
  }));
}
