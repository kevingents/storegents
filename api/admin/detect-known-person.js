import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { detectKnownPerson, getKnownPeopleCount } from '../../lib/known-nl-people.js';

/**
 * GET /api/admin/detect-known-person?name=...&firstName=...&lastName=...
 *
 * Checkt of de gegeven klantnaam matcht met een bekende Nederlander.
 * Bron: handmatig samengestelde lijst in lib/known-nl-people.js
 *
 * Response: { success, matched, person, confidence, matchType, listSize }
 *
 * Privacy: deze endpoint is admin-only en wordt nooit getoond aan de klant zelf.
 */

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
  if (!adminToken) return false;
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return token === adminToken;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'public, max-age=3600'); /* lijst verandert zelden */

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const fullName = String(req.query.name || req.query.fullName || '').trim();
  const firstName = String(req.query.firstName || '').trim();
  const lastName = String(req.query.lastName || '').trim();

  const result = detectKnownPerson(fullName, firstName, lastName);

  return res.status(200).json({
    success: true,
    matched: Boolean(result),
    person: result?.person || null,
    confidence: result?.confidence || null,
    matchType: result?.matchType || null,
    listSize: getKnownPeopleCount(),
    note: 'INTERN — toon nooit aan de klant zelf. Detectie via handmatige lijst, kan vals-positief zijn bij algemene namen.'
  });
}
