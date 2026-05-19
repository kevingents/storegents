/**
 * /api/admin/store-emails
 *   GET                  — lijst van alle winkel-emails (mix Blob + env-fallback)
 *   POST                 — bulk-update: { updates: { 'GENTS Tilburg': 'mail@...' } }
 *
 * Auth: admin-token verplicht.
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getAllStoreEmails, bulkSetStoreEmails, getEmailForStore } from '../../lib/store-emails-store.js';
import { listReserveringBranches } from '../../lib/reserveringen-branch-mapping.js';

function isAuthorized(req) {
  const expected = String(process.env.ADMIN_TOKEN || '12345').trim();
  const given = String(
    req.headers['x-admin-token'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(expected && given && expected === given);
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  if (req.method === 'GET') {
    try {
      const blobMap = await getAllStoreEmails();
      /* Bouw lijst met alle 19 winkels (RES-mapping als bron van waarheid).
         Per winkel: blob-waarde + env-fallback + effectief mailadres. */
      const branches = listReserveringBranches();
      const rows = await Promise.all(branches.map(async (b) => {
        const fromBlob = blobMap[b.store] || '';
        const effective = await getEmailForStore(b.store);
        return {
          store: b.store,
          branchId: b.branchId,
          emailBlob: fromBlob,
          emailEffective: effective,
          source: fromBlob ? 'blob' : effective ? 'env' : 'none'
        };
      }));
      const fallback = {
        FACILITAIR_STORE_MAIL_DEFAULT: process.env.FACILITAIR_STORE_MAIL_DEFAULT || '',
        STORE_MAIL: process.env.STORE_MAIL || ''
      };
      return res.status(200).json({ success: true, count: rows.length, rows, fallback });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const updates = body.updates && typeof body.updates === 'object' ? body.updates : null;
      if (!updates) return res.status(400).json({ success: false, message: 'Geef { updates: {...} } mee.' });
      const result = await bulkSetStoreEmails(updates);
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
  }

  return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
}
