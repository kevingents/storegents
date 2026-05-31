/**
 * /api/admin/bol-content
 *
 * GET  → content-optimalisatieplan (dekking, gaten, families, per-EAN voorstel).
 *        ?refresh=1 herberekent uit de Shopify-cache.
 * POST → { action:'refresh' }            herbereken het plan
 *        { action:'push', eans:[...], dryRun }  bouw/push bol-content
 *                          dryRun!=false → toont alleen het payload (veilig).
 *                          dryRun===false → schrijft live naar bol (vereist creds).
 *
 * Auth: admin-token vereist. De live-push is bewust achter dryRun:false gezet.
 */

import { buildBolContentPlan, readBolContentPlan, isPlanFresh } from '../../lib/bol-content-optimizer.js';
import { pushBolContent, runBolContentAuto, discoverBolCatalog } from '../../lib/bol-content-writer.js';
import { isBolConfigured } from '../../lib/bol-client.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 60;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const refresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
      let plan = refresh ? null : await readBolContentPlan();
      if (!plan || !isPlanFresh(plan)) plan = await buildBolContentPlan();
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      return res.status(200).json({ success: true, bolGekoppeld: isBolConfigured(), ...plan });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const action = String(body.action || '').toLowerCase();

      if (action === 'refresh') {
        const plan = await buildBolContentPlan();
        return res.status(200).json({ success: true, ...plan });
      }

      if (action === 'push') {
        const dryRun = body.dryRun !== false; /* standaard veilig */
        const out = await pushBolContent({ eans: body.eans || [], dryRun });
        return res.status(200).json({ success: true, bolGekoppeld: isBolConfigured(), ...out });
      }

      if (action === 'auto') {
        /* Autonoom alle push-klare producten optimaliseren (alleen wat wijzigde). */
        const dryRun = body.dryRun !== false;
        const out = await runBolContentAuto({ dryRun, maxPush: Number(body.maxPush) || 300 });
        return res.status(200).json({ success: true, bolGekoppeld: isBolConfigured(), ...out });
      }

      if (action === 'discover') {
        /* Lees de echte bol-attribuut-id's + labels voor één EAN uit de catalogus. */
        const out = await discoverBolCatalog(body.ean);
        return res.status(200).json({ success: true, ...out });
      }

      return res.status(400).json({ success: false, message: 'Onbekende action (refresh|push|auto|discover).' });
    }

    return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });
  } catch (error) {
    console.error('[admin/bol-content]', error);
    return res.status(500).json({ success: false, message: error.message || 'bol-content mislukt.' });
  }
}
