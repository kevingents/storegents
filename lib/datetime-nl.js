/**
 * lib/datetime-nl.js
 *
 * Tijdzone-helpers voor Nederlandse datum-business-logica.
 *
 * Waarom: server-tijd is UTC (Vercel), maar onze business draait in
 * Europe/Amsterdam (CET/CEST). `new Date().toISOString().slice(0, 10)` geeft
 * dus de UTC-datum — die verschilt 's avonds 22:00-24:00 (zomertijd) of
 * 23:00-24:00 (wintertijd) van de Nederlandse datum.
 *
 * Voorbeelden van bugs die je krijgt met UTC-slice:
 * - Reserveringen-expire cron rond middernacht NL: zet reserveringen die
 *   nog vandaag geldig zijn op "verlopen" (UTC ziet morgen al).
 * - Aging-watermarks: firstSeen krijgt morgen's datum → teller -1 dag off.
 * - "Vandaag"-rapporten 23:00 NL: tonen morgen's omzet/openstaande, of
 *   missen vandaag's data.
 *
 * Deze helpers zijn de canonieke source voor NL-business-data.
 */

const TZ = 'Europe/Amsterdam';

/* Intl.DateTimeFormat met 'sv-SE' locale geeft "YYYY-MM-DD HH:mm:ss" formaat
   (ISO-achtig zonder T/Z); we extracten daaruit de datum. */
const __DATE_FMT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ,
  year: 'numeric', month: '2-digit', day: '2-digit'
});

const __DATETIME_FMT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false
});

/**
 * Geef vandaag's datum in Europe/Amsterdam, formaat "YYYY-MM-DD".
 * Vervangt het anti-patroon `new Date().toISOString().slice(0, 10)`.
 */
export function nlTodayIso(now = new Date()) {
  return __DATE_FMT.format(now);
}

/**
 * Geef de datum van een Date-object in Europe/Amsterdam, "YYYY-MM-DD".
 */
export function nlDateIso(date) {
  return __DATE_FMT.format(date instanceof Date ? date : new Date(date));
}

/**
 * Geef "YYYY-MM-DD HH:mm:ss" in NL-tijd (handig voor logs/displays).
 */
export function nlDateTimeStr(date = new Date()) {
  return __DATETIME_FMT.format(date instanceof Date ? date : new Date(date));
}
