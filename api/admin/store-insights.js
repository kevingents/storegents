/**
 * GET /api/admin/store-insights?store=<store>&period=month|year|quarter|lifetime
 *
 * Leest pre-aggregated winkelinzicht uit Blob-cache (geschreven door
 * /api/cron/store-insights-builder die elke nacht draait).
 *
 * Als cache niet bestaat: returnt 503 met instructie om de cron te
 * triggeren (geen live SRS-fetch want dat duurt te lang en blokkeert
 * de browser).
 */

import { getBranchIdByStore } from '../../lib/branch-metrics.js';
import { readInsights } from '../../lib/store-insights-cache.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || '12345').trim();
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query?.adminToken ||
    req.query?.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(adminToken && token && token === adminToken);
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  const store = String(req.query.store || '').trim();
  const period = String(req.query.period || 'month').toLowerCase();
  if (!store) return res.status(400).json({ success: false, message: 'store query-param is verplicht.' });

  const branchId = getBranchIdByStore(store);
  if (!branchId) return res.status(400).json({ success: false, message: `Geen branchId voor "${store}".` });

  try {
    const cached = await readInsights(branchId, period);
    if (!cached) {
      return res.status(503).json({
        success: false,
        cached: false,
        message: 'Nog geen data beschikbaar voor deze winkel + periode. De cache wordt elke nacht om 03:00 gebouwd. Admins kunnen handmatig triggeren via /api/cron/store-insights-builder.',
        hint: `Trigger build: POST /api/cron/store-insights-builder?store=${encodeURIComponent(store)}&period=${period}`,
        store, branchId, period
      });
    }

    return res.status(200).json({
      success: true,
      cached: true,
      cachedAt: cached.cachedAt || null,
      store: cached.store || store,
      branchId,
      period,
      from: cached.from,
      until: cached.until,
      totals: cached.totals,
      byDayOfWeek: cached.byDayOfWeek,
      byHour: cached.byHour,
      topSizes: cached.topSizes,
      topColors: cached.topColors,
      fastMovers: cached.fastMovers,
      slowMovers: cached.slowMovers
    });
  } catch (error) {
    console.error('[store-insights]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
}
