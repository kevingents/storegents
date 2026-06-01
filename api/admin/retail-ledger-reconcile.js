/**
 * GET /api/admin/retail-ledger-reconcile?period=week|maand|custom[&from=&to=]
 *
 * Vergelijkt per dag de winkel-omzet-ledger (dashboard-bron) met de live SRS-
 * transacties. Toont waar het klopt en waar een import-gat/afwijking zit.
 *
 * Read-only. Auth: admin-token.
 */

import { reconcileRevenue } from '../../lib/retail-ledger-reconcile.js';
import { periodToRange } from '../../lib/srs-retail-ledger.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 60;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    const period = String(req.query.period || 'week');
    const range = periodToRange(period, { from: String(req.query.from || ''), to: String(req.query.to || '') });
    const data = await reconcileRevenue(range);
    return res.status(200).json({ success: true, period, ...data });
  } catch (e) {
    console.error('[admin/retail-ledger-reconcile]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
