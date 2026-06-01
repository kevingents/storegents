/**
 * /api/admin/bol-insights
 *
 * GET  → omzet, best-sellers, buy-box-positie + performance (cachebaar).
 *        ?refresh=1 forceert een live bol-scan.
 * POST → { action:'refresh' }          herbereken
 *        { action:'reprice', ean }      repricing-advies vs buy-box-winnaar
 *
 * Auth: admin-token vereist. Read-only (reprice is advies, schrijft niets).
 */

import { runBolInsights, readBolInsights, isInsightsFresh, getRepriceAdvice } from '../../lib/bol-insights.js';
import { buildBolPricePlan, runBolPriceSync } from '../../lib/bol-price-sync.js';
import { isBolConfigured } from '../../lib/bol-client.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 300;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      if (!isBolConfigured()) return res.status(200).json({ success: true, configured: false, reason: 'bol niet gekoppeld' });
      const refresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
      let data = refresh ? null : await readBolInsights();
      if (!data || !isInsightsFresh(data)) data = await runBolInsights();
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      return res.status(200).json({ success: true, cached: !refresh && Boolean(data?.refreshedAt), ...data });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const action = String(body.action || '').toLowerCase();
      if (action === 'refresh') return res.status(200).json({ success: true, ...(await runBolInsights()) });
      if (action === 'reprice') return res.status(200).json({ success: true, ...(await getRepriceAdvice(body.ean)) });
      if (action === 'price-plan') return res.status(200).json({ success: true, ...(await buildBolPricePlan()) });
      if (action === 'price-sync') {
        const dryRun = body.dryRun !== false;
        return res.status(200).json({ success: true, bolGekoppeld: isBolConfigured(), ...(await runBolPriceSync({ dryRun, onlyChanged: body.onlyChanged !== false })) });
      }
      return res.status(400).json({ success: false, message: 'Onbekende action (refresh|reprice|price-plan|price-sync).' });
    }

    return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });
  } catch (error) {
    console.error('[admin/bol-insights]', error);
    return res.status(500).json({ success: false, message: error.message || 'bol-inzichten mislukt.' });
  }
}
