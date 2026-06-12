/**
 * lib/caller-store-scope.js
 *
 * Winkel-scope van de huidige caller, uit de header `x-user-stores`. Die wordt
 * server-side door de portal-BFF gezet uit de ONDERTEKENDE sessie (de browser
 * kan 'm niet vervalsen) en bevat de winkels waar de gebruiker bij mag.
 *
 * Belangrijk: de portal injecteert voor rol-gebruikers met een `page.*`-recht de
 * admin-token, waardoor de backend hen anders als system-admin ziet (= álle
 * winkels). Door óók de winkelset mee te sturen kan een store-scoped endpoint
 * de data alsnog beperken tot de winkels van de gebruiker.
 *
 * @returns {string[]|null} lijst winkelnamen, of null = geen restrictie
 *   (master-admin / interne tools sturen geen x-user-stores mee).
 */
export function callerStoreScope(req) {
  const raw = String(req.headers?.['x-user-stores'] || '').trim();
  if (!raw) return null;
  const list = raw.split('|').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : null;
}

/**
 * Filter een lijst objecten met een winkelnaam-veld op de caller-scope.
 * Geen scope → ongewijzigd terug.
 *
 * @param {object} req
 * @param {Array}  rows
 * @param {(row:any)=>string} getStoreName
 */
export function applyStoreScope(req, rows, getStoreName) {
  const scope = callerStoreScope(req);
  if (!scope || !Array.isArray(rows)) return rows;
  const allow = new Set(scope.map((s) => s.toLowerCase()));
  return rows.filter((r) => allow.has(String(getStoreName(r) || '').toLowerCase()));
}
