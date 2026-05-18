/**
 * GENTS winkel coördinaten voor route-berekening + maps.
 *
 * Bron: handmatig samengesteld uit openbare adres-data van gents.nl.
 * Update indien een winkel verhuist.
 */

export const GENTS_STORE_LOCATIONS = {
  /* HQ + magazijn */
  'GENTS Magazijn': { lat: 52.3009, lng: 4.9526, address: 'Lemelerbergweg 15, 1101 AJ Amsterdam', city: 'Amsterdam' },
  'GENTS Magazijn (Uitlevertafel)': { lat: 52.3009, lng: 4.9526, address: 'Lemelerbergweg 15, 1101 AJ Amsterdam', city: 'Amsterdam' },
  'GENTS Showroom': { lat: 52.3009, lng: 4.9526, address: 'Lemelerbergweg 15, 1101 AJ Amsterdam', city: 'Amsterdam' },
  'Amsterdam HQ': { lat: 52.3009, lng: 4.9526, address: 'Lemelerbergweg 15, 1101 AJ Amsterdam', city: 'Amsterdam' },

  /* Fysieke winkels */
  'GENTS Almere': { lat: 52.3702, lng: 5.2148, address: 'Almere', city: 'Almere' },
  'GENTS Amersfoort': { lat: 52.1561, lng: 5.3878, address: 'Amersfoort', city: 'Amersfoort' },
  'GENTS Amsterdam': { lat: 52.3676, lng: 4.9041, address: 'Amsterdam', city: 'Amsterdam' },
  'GENTS Antwerpen': { lat: 51.2194, lng: 4.4025, address: 'Antwerpen', city: 'Antwerpen' },
  'GENTS Arnhem': { lat: 51.9851, lng: 5.8987, address: 'Arnhem', city: 'Arnhem' },
  'GENTS Breda': { lat: 51.5719, lng: 4.7683, address: 'Breda', city: 'Breda' },
  'GENTS Delft': { lat: 52.0116, lng: 4.3571, address: 'Delft', city: 'Delft' },
  'GENTS Den Bosch': { lat: 51.6978, lng: 5.3037, address: 'Den Bosch', city: 'Den Bosch' },
  'GENTS Enschede': { lat: 52.2215, lng: 6.8937, address: 'Enschede', city: 'Enschede' },
  'GENTS Groningen': { lat: 53.2194, lng: 6.5665, address: 'Groningen', city: 'Groningen' },
  'GENTS Hilversum': { lat: 52.2292, lng: 5.1669, address: 'Hilversum', city: 'Hilversum' },
  'GENTS Leiden': { lat: 52.1601, lng: 4.4970, address: 'Leiden', city: 'Leiden' },
  'GENTS Maastricht': { lat: 50.8514, lng: 5.6910, address: 'Maastricht', city: 'Maastricht' },
  'GENTS Nijmegen': { lat: 51.8126, lng: 5.8372, address: 'Nijmegen', city: 'Nijmegen' },
  'GENTS Rotterdam': { lat: 51.9244, lng: 4.4777, address: 'Rotterdam', city: 'Rotterdam' },
  'GENTS Tilburg': { lat: 51.5555, lng: 5.0913, address: 'Tilburg', city: 'Tilburg' },
  'GENTS Utrecht': { lat: 52.0907, lng: 5.1214, address: 'Utrecht', city: 'Utrecht' },
  'GENTS Zoetermeer': { lat: 52.0570, lng: 4.4933, address: 'Zoetermeer', city: 'Zoetermeer' },
  'GENTS Zwolle': { lat: 52.5168, lng: 6.0830, address: 'Zwolle', city: 'Zwolle' }
};

function normalizeKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/^\d+\s*-\s*/, '')
    .replace(/\s+\(.*?\)\s*$/, '');
}

export function getStoreLocation(storeName) {
  if (!storeName) return null;
  /* Probeer exact */
  if (GENTS_STORE_LOCATIONS[storeName]) return GENTS_STORE_LOCATIONS[storeName];
  /* Probeer fuzzy */
  const key = normalizeKey(storeName);
  for (const [name, loc] of Object.entries(GENTS_STORE_LOCATIONS)) {
    if (normalizeKey(name) === key) return loc;
  }
  /* Probeer "GENTS X" met X als city-only */
  for (const [name, loc] of Object.entries(GENTS_STORE_LOCATIONS)) {
    if (key && (key.includes(loc.city.toLowerCase()) || name.toLowerCase().includes(key))) return loc;
  }
  return null;
}

export function listStoresWithLocation() {
  return Object.entries(GENTS_STORE_LOCATIONS).map(([name, loc]) => ({ name, ...loc }));
}
