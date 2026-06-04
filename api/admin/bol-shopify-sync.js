/**
 * Admin endpoint: handmatige trigger + status van bol-shopify-sync.
 *
 *   GET  /api/admin/bol-shopify-sync                   → pushed-state (read-only)
 *   GET  /api/admin/bol-shopify-sync?dryRun=1          → wat zou er gebeuren (geen schrijfacties)
 *   POST /api/admin/bol-shopify-sync?max=10            → echte sync, max 10 orders
 *   POST /api/admin/bol-shopify-sync?force=1&max=1     → herpush 1 order (recovery)
 */

import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { pushBolOrdersToShopify, readBolShopifyPushedState } from '../../lib/bol-shopify-push.js';

export const maxDuration = 120;

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (requireAdmin(req, res)) return;

  const dryRun = String(req.query?.dryRun || '') === '1';
  const force = String(req.query?.force || '') === '1';
  const maxPerRun = Number(req.query?.max || 50);

  /* GET zonder dryRun → alleen state retourneren */
  if (req.method === 'GET' && !dryRun) {
    const state = await readBolShopifyPushedState();
    return res.status(200).json({
      success: true,
      pushedCount: Object.keys(state.pushed || {}).length,
      updatedAt: state.updatedAt,
      runCount: state.runCount || 0,
      recent: Object.entries(state.pushed || {})
        .map(([orderId, info]) => ({ orderId, ...info }))
        .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
        .slice(0, 20)
    });
  }

  try {
    const result = await pushBolOrdersToShopify({ dryRun, maxPerRun, force });
    return res.status(200).json(result);
  } catch (e) {
    console.error('[admin/bol-shopify-sync]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
