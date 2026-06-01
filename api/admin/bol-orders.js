/**
 * /api/admin/bol-orders
 *
 * GET → openstaande bol-orders (FBR) met verzend-deadline + magazijn-
 *       leverbaarheid (verzendbevestiging-bewaking). ?refresh=1 = live scan.
 *
 * Auth: admin-token vereist. Read-only — schrijft niets naar bol.
 */

import { runBolOrders, readBolOrders, isBolOrdersFresh } from '../../lib/bol-orders.js';
import { isBolConfigured } from '../../lib/bol-client.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 300;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
    if (!isBolConfigured()) return res.status(200).json({ success: true, configured: false, reason: 'bol niet gekoppeld' });

    const refresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
    let data = refresh ? null : await readBolOrders();
    if (!data || !isBolOrdersFresh(data)) data = await runBolOrders();
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({ success: true, bolGekoppeld: isBolConfigured(), cached: !refresh && Boolean(data?.refreshedAt), ...data });
  } catch (error) {
    console.error('[admin/bol-orders]', error);
    return res.status(500).json({ success: false, message: error.message || 'bol-orders mislukt.' });
  }
}
