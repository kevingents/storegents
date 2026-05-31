/**
 * GET /api/admin/bol-returns
 *
 * Retouranalyse bol.com: retouren per product, reden-uitsplitsing, "beter niet
 * verkopen"-kandidaten en content-verbeterkandidaten (uit fit/verwacht-retouren).
 *
 * Query: ?refresh=1 forceert een live bol-scan.
 * Read-only. Auth: admin-token vereist.
 */

import { runBolReturns, readBolReturns, isBolReturnsFresh } from '../../lib/bol-returns.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 60;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  try {
    const refresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
    let data = refresh ? null : await readBolReturns();
    let cached = Boolean(data);
    if (!data || !isBolReturnsFresh(data)) {
      data = await runBolReturns();
      cached = false;
    }
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({ success: true, cached, ...data });
  } catch (error) {
    console.error('[admin/bol-returns]', error);
    return res.status(500).json({ success: false, message: error.message || 'bol-retouranalyse mislukt.' });
  }
}
