/**
 * GENTS winkel coördinaten + venstertijden voor route-berekening + maps.
 *
 * Bron: handmatig samengesteld uit openbare adres-data van gents.nl.
 * Venstertijden gebaseerd op gemeente-info (bevoorradingstijden binnensteden).
 * Update indien een winkel verhuist of gemeente regels aanpast.
 *
 * Velden:
 *   - lat / lng: coords
 *   - address: straat + postcode + plaats
 *   - city: stad
 *   - loadingWindow: { start, end, days } — venstertijd voor laden/lossen
 *      bv "07:00" / "11:00" / ['mon','tue','wed','thu','fri','sat']
 *      null = geen restrictie (winkelcentra buiten binnenstad)
 */

/* Standaard venstertijden NL binnensteden: 07:00 - 11:00 ma-za.
   Sommige gemeenten ruimer (06:00-12:00) of strikter — per winkel ingesteld. */
const WEEKDAYS_SAT = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const STANDARD_BINNENSTAD = { start: '07:00', end: '11:00', days: WEEKDAYS_SAT };
const RUIM_BINNENSTAD     = { start: '06:00', end: '11:00', days: WEEKDAYS_SAT };
const EXTRA_RUIM          = { start: '06:00', end: '12:00', days: WEEKDAYS_SAT };
const GEEN_RESTRICTIE     = null;

export const GENTS_STORE_LOCATIONS = {
  /* HQ + magazijn — geen venster, eigen pand industrieterrein */
  'GENTS Magazijn':                  { lat: 52.3009, lng: 4.9526, address: 'Lemelerbergweg 15, 1101 AJ Amsterdam', city: 'Amsterdam', loadingWindow: GEEN_RESTRICTIE },
  'GENTS Magazijn (Uitlevertafel)':  { lat: 52.3009, lng: 4.9526, address: 'Lemelerbergweg 15, 1101 AJ Amsterdam', city: 'Amsterdam', loadingWindow: GEEN_RESTRICTIE },
  'GENTS Showroom':                  { lat: 52.3009, lng: 4.9526, address: 'Lemelerbergweg 15, 1101 AJ Amsterdam', city: 'Amsterdam', loadingWindow: GEEN_RESTRICTIE },
  'Amsterdam HQ':                    { lat: 52.3009, lng: 4.9526, address: 'Lemelerbergweg 15, 1101 AJ Amsterdam', city: 'Amsterdam', loadingWindow: GEEN_RESTRICTIE },

  /* Fysieke winkels — binnenstad venstertijden ma-za 07:00-11:00 als default */
  'GENTS Almere':     { lat: 52.3702, lng: 5.2148, address: 'Stadhuisplein, Almere',  city: 'Almere',     loadingWindow: GEEN_RESTRICTIE },     /* winkelcentrum, geen venstertijd */
  'GENTS Amersfoort': { lat: 52.1561, lng: 5.3878, address: 'Binnenstad Amersfoort',  city: 'Amersfoort', loadingWindow: STANDARD_BINNENSTAD },
  'GENTS Amsterdam':  { lat: 52.3676, lng: 4.9041, address: 'Binnenstad Amsterdam',   city: 'Amsterdam',  loadingWindow: STANDARD_BINNENSTAD }, /* 07:00-11:00 incl proef-verruiming */
  'GENTS Antwerpen':  { lat: 51.2194, lng: 4.4025, address: 'Binnenstad Antwerpen',   city: 'Antwerpen',  loadingWindow: STANDARD_BINNENSTAD }, /* BE: 07:00-11:00 vergelijkbaar */
  'GENTS Arnhem':     { lat: 51.9851, lng: 5.8987, address: 'Binnenstad Arnhem',      city: 'Arnhem',     loadingWindow: RUIM_BINNENSTAD },
  'GENTS Breda':      { lat: 51.5719, lng: 4.7683, address: 'Binnenstad Breda',       city: 'Breda',      loadingWindow: RUIM_BINNENSTAD },
  'GENTS Delft':      { lat: 52.0116, lng: 4.3571, address: 'Binnenstad Delft',       city: 'Delft',      loadingWindow: STANDARD_BINNENSTAD },
  'GENTS Den Bosch':  { lat: 51.6978, lng: 5.3037, address: 'Binnenstad Den Bosch',   city: 'Den Bosch',  loadingWindow: EXTRA_RUIM },          /* 06:00-12:00 */
  'GENTS Enschede':   { lat: 52.2215, lng: 6.8937, address: 'Binnenstad Enschede',    city: 'Enschede',   loadingWindow: STANDARD_BINNENSTAD },
  'GENTS Groningen':  { lat: 53.2194, lng: 6.5665, address: 'Binnenstad Groningen',   city: 'Groningen',  loadingWindow: RUIM_BINNENSTAD },
  'GENTS Hilversum':  { lat: 52.2292, lng: 5.1669, address: 'Centrum Hilversum',      city: 'Hilversum',  loadingWindow: STANDARD_BINNENSTAD },
  'GENTS Leiden':     { lat: 52.1601, lng: 4.4970, address: 'Binnenstad Leiden',      city: 'Leiden',     loadingWindow: RUIM_BINNENSTAD },
  'GENTS Maastricht': { lat: 50.8514, lng: 5.6910, address: 'Binnenstad Maastricht',  city: 'Maastricht', loadingWindow: STANDARD_BINNENSTAD },
  'GENTS Nijmegen':   { lat: 51.8126, lng: 5.8372, address: 'Binnenstad Nijmegen',    city: 'Nijmegen',   loadingWindow: RUIM_BINNENSTAD },
  'GENTS Rotterdam':  { lat: 51.9244, lng: 4.4777, address: 'Binnenstad Rotterdam',   city: 'Rotterdam',  loadingWindow: RUIM_BINNENSTAD },
  'GENTS Tilburg':    { lat: 51.5555, lng: 5.0913, address: 'Binnenstad Tilburg',     city: 'Tilburg',    loadingWindow: STANDARD_BINNENSTAD },
  'GENTS Utrecht':    { lat: 52.0907, lng: 5.1214, address: 'Binnenstad Utrecht',     city: 'Utrecht',    loadingWindow: RUIM_BINNENSTAD },      /* 06:00-11:00 sinds 2025 */
  'GENTS Zoetermeer': { lat: 52.0570, lng: 4.4933, address: 'Stadshart Zoetermeer',   city: 'Zoetermeer', loadingWindow: GEEN_RESTRICTIE },     /* winkelcentrum */
  'GENTS Zwolle':     { lat: 52.5168, lng: 6.0830, address: 'Binnenstad Zwolle',      city: 'Zwolle',     loadingWindow: RUIM_BINNENSTAD }
};

/* Tijd in minuten voor laden + lossen per stop */
export const LOADING_TIME_MIN = 15;

/* Helper: parse 'HH:MM' → minutes since midnight */
function parseTimeToMin(timeStr) {
  const m = String(timeStr || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
function minToTime(min) {
  if (min == null) return '';
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Check of een gegeven aankomsttijd binnen het venster valt voor een winkel.
 * Returns: { ok, window, warning, suggestedEarliest, suggestedLatest }
 */
export function checkLoadingWindow(storeName, arrivalTimeStr, dayKey) {
  const loc = getStoreLocation(storeName);
  if (!loc || !loc.loadingWindow) return { ok: true, window: null };
  const win = loc.loadingWindow;

  /* Check day */
  const dayMap = { maandag: 'mon', dinsdag: 'tue', woensdag: 'wed', donderdag: 'thu', vrijdag: 'fri', zaterdag: 'sat', zondag: 'sun' };
  const dayShort = dayMap[String(dayKey || '').toLowerCase()];
  if (dayShort && win.days && !win.days.includes(dayShort)) {
    return {
      ok: false,
      window: win,
      warning: `${storeName} mag niet bevoorraad worden op ${dayKey} (alleen ${win.days.join('/')})`
    };
  }

  /* Check time */
  const arrivalMin = parseTimeToMin(arrivalTimeStr);
  if (arrivalMin == null) return { ok: true, window: win };
  const startMin = parseTimeToMin(win.start);
  const endMin = parseTimeToMin(win.end);
  const finishMin = arrivalMin + LOADING_TIME_MIN;

  if (arrivalMin < startMin) {
    return {
      ok: false,
      window: win,
      warning: `Te vroeg — venster opent om ${win.start}`,
      suggestedEarliest: win.start
    };
  }
  if (finishMin > endMin) {
    return {
      ok: false,
      window: win,
      warning: `Te laat — laden moet klaar zijn om ${win.end} (15min vóór = laatste vertrek ${minToTime(endMin - LOADING_TIME_MIN)})`,
      suggestedLatest: minToTime(endMin - LOADING_TIME_MIN)
    };
  }
  return { ok: true, window: win };
}

export { parseTimeToMin, minToTime };

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
