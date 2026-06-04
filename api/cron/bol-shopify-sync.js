/**
 * Cron: GET /api/cron/bol-shopify-sync
 *
 * Pusht nieuwe Bol-orders (uit marketplace/bol-orders.json) naar Shopify.
 * Draait 30 minuten na bol-orders cron zodat de blob vers is.
 * Schedule: 30 7,11,15,19 * * * (4× per dag, vlak na bol-orders).
 */

import { trackedCron } from '../../lib/cron-auto-track.js';
import { isCronAuthorized } from '../../lib/cron-auth.js';
import { pushBolOrdersToShopify } from '../../lib/bol-shopify-push.js';

export const maxDuration = 120;

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!isCronAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const dryRun = String(req.query?.dryRun || '') === '1';
  const maxPerRun = Number(req.query?.max || process.env.BOL_SHOPIFY_MAX_PER_RUN || 50);

  try {
    const result = await pushBolOrdersToShopify({ dryRun, maxPerRun });
    return res.status(200).json(result);
  } catch (e) {
    console.error('[cron/bol-shopify-sync]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}

export default trackedCron('bol-shopify-sync', handler);
