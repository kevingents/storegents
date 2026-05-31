/**
 * /api/admin/bol-stock
 *
 * GET  → voorraad-syncplan (bol-voorraad = magazijnvoorraad per EAN).
 *        ?refresh=1 herberekent uit de SRS-snapshot + productcache.
 * POST → { action:'plan' }                    herbereken plan
 *        { action:'refresh-map' }             ververs EAN→offerId map (bol-export, traag)
 *        { action:'sync', dryRun, onlyChanged } sync magazijnvoorraad → bol
 *                          dryRun!=false → toont alleen wat zou wijzigen (veilig)
 *
 * Auth: admin-token vereist. Live-sync zit achter dryRun:false.
 */

import { buildBolStockPlan, readBolStockPlan, isStockPlanFresh, runBolStockSync, refreshBolOfferMap } from '../../lib/bol-stock-sync.js';
import { isBolConfigured } from '../../lib/bol-client.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 60;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const refresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
      let plan = refresh ? null : await readBolStockPlan();
      if (!plan || !isStockPlanFresh(plan)) plan = await buildBolStockPlan();
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      return res.status(200).json({ success: true, bolGekoppeld: isBolConfigured(), ...plan });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const action = String(body.action || '').toLowerCase();

      if (action === 'plan') {
        const plan = await buildBolStockPlan();
        return res.status(200).json({ success: true, ...plan });
      }
      if (action === 'refresh-map') {
        const out = await refreshBolOfferMap();
        return res.status(200).json({ success: true, ...out });
      }
      if (action === 'sync') {
        const dryRun = body.dryRun !== false;
        const out = await runBolStockSync({ dryRun, onlyChanged: body.onlyChanged !== false, refreshMap: body.refreshMap === true });
        return res.status(200).json({ success: true, bolGekoppeld: isBolConfigured(), ...out });
      }
      return res.status(400).json({ success: false, message: 'Onbekende action (plan|refresh-map|sync).' });
    }

    return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });
  } catch (error) {
    console.error('[admin/bol-stock]', error);
    return res.status(500).json({ success: false, message: error.message || 'bol-voorraadsync mislukt.' });
  }
}
