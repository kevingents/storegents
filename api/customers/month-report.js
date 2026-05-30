/**
 * GET /api/customers/month-report?store=<winkel>
 *
 * Store-scoped variant van het klant-maandrapport. De portal roept dit pad aan
 * voor het "Recent ingeschreven"-paneel wanneer er één specifieke winkel actief
 * is (niet-admin context). Tot nu toe bestond de route niet → 404 ("Kon recente
 * klanten niet laden"). Dit is dezelfde handler als de admin-varianten
 * (admin/customers/month-report.js en monthly-store-report.js zijn identieke
 * re-exports); de ?store= parameter scoped 'm naar één filiaal.
 *
 * Auth is ongewijzigd: weekly-report.js controleert het admin-token, dat de
 * portal via fetchJson bij elke /api/-call meestuurt.
 */
export { default } from '../admin/customers/weekly-report.js';
