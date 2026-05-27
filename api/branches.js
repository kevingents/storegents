import { handleCors, setCorsHeaders } from '../lib/cors.js';
import { BUSINESS_CONFIG } from '../lib/business-config.js';

/**
 * /api/branches
 *
 * Publieke endpoint die de canonical lijst van winkels + branchIds levert.
 * Frontend (Liquid + JS) leest hier uit zodat we niet langer 3 driftende
 * kopieën onderhouden (zie BUSINESS_CONFIG.branches in lib/business-config.js).
 *
 * Query: ?kind=retail  → alleen fysieke winkels (default: alle)
 *        ?kind=all     → alle inclusief warehouse/showroom/admin
 *
 * Response: { success, branches: [{ store, branchId, kind }], updatedAt }
 *
 * Cache: 1 uur edge cache — wijziging vereist deploy + cache-purge.
 */
export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  const kindFilter = String(req.query?.kind || 'retail').toLowerCase();
  let branches = BUSINESS_CONFIG.branches.list;

  if (kindFilter !== 'all') {
    branches = branches.filter((b) => b.kind === kindFilter);
  }

  return res.status(200).json({
    success: true,
    branches,
    count: branches.length,
    /* Voor frontend convenience: alleen namen als array */
    storeNames: branches.map((b) => b.store)
  });
}
