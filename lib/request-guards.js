/**
 * lib/request-guards.js — common guard-functies voor admin/store endpoints.
 *
 * ⚠️  NAAM-COLLISION WAARSCHUWING (audit-finding):
 *
 *   Er bestaat OOK een `requireAdmin` in `lib/cors.js` met OMGEKEERDE return-
 *   semantiek:
 *
 *     - cors.js:           if (requireAdmin(req, res)) return;   // true = NIET bevoegd
 *     - request-guards.js: if (!ensureAdmin(req, res)) return;   // true = OK
 *
 *   Verkeerd geïmporteerd = auth-bypass of altijd-401. Daarom heet de canonieke
 *   functie in deze file nu `ensureAdmin` (= guarantees admin-status, returnt
 *   boolean). De oude naam `requireAdmin` blijft als deprecated alias bestaan
 *   voor backward-compat (96+ endpoints gebruiken hem nog) — nieuwe code moet
 *   `ensureAdmin` gebruiken zodat een toekomstige sweep eenduidig is.
 */

import { handleCors, setCorsHeaders } from './cors.js';

export function corsJson(req, res, methods = ['GET', 'POST', 'OPTIONS']) {
  if (handleCors(req, res, methods)) return true;
  setCorsHeaders(res, methods);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return false;
}

export function isAdmin(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.admin_token ||
    req.body?.adminToken ||
    req.body?.admin_token ||
    ''
  )
    .replace(/^Bearer\s+/i, '')
    .trim();

  return Boolean(adminToken) && token === adminToken;
}

/**
 * Canonieke admin-guard. Returnt boolean.
 *   true  = admin-token geldig (caller mag doorgaan)
 *   false = niet bevoegd; deze functie schreef al 401 naar res
 *
 * Gebruik: `if (!ensureAdmin(req, res)) return;`
 */
export function ensureAdmin(req, res) {
  if (!isAdmin(req)) {
    res.status(401).json({ success: false, message: 'Niet bevoegd.' });
    return false;
  }
  return true;
}

/**
 * @deprecated Gebruik `ensureAdmin`. Naam botst met `requireAdmin` uit
 * `lib/cors.js` die de OMGEKEERDE return-semantiek heeft. Behouden voor
 * backward-compatibility met bestaande imports.
 */
export const requireAdmin = ensureAdmin;

export function requirePost(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, message: 'Alleen POST is toegestaan.' });
    return false;
  }
  return true;
}

export function requireGet(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
    return false;
  }
  return true;
}
