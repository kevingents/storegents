import { trackedCron } from '../../lib/cron-auto-track.js';
import { buildShopifyStockSnapshots } from '../../lib/shopify-stock-snapshot-builder.js';

/**
 * Cron: bouw de voorraad-snapshots vanuit Shopify (single source of truth).
 * Schrijft naar dezelfde blobs die alle voorraad-tools lezen
 * (srs-stock-snapshot/branch-*.json + srs-voorraad/rows-latest.json), zodat
 * winkel-lookup, reserveringen, dashboards en rapporten Shopify-data tonen.
 *
 * `voorraad` = Shopify inventoryLevels (live). `ideaal` (SRS-streefwaarde,
 * geen voorraad) wordt gemerged uit de laatste SRS-rows.
 *
 * Schedule: elke 20 min tussen 06:00-22:00 (zie vercel.json).
 */
export const maxDuration = 300;

async function handler(req, res) {
  try {
    const out = await buildShopifyStockSnapshots();
    if (!out.ok) {
      return res.status(200).json({ success: false, ...out, ts: new Date().toISOString() });
    }
    return res.status(200).json({ success: true, ...out, ts: new Date().toISOString() });
  } catch (e) {
    console.error('[cron/shopify-stock-snapshot]', e);
    return res.status(500).json({ success: false, message: e.message });
  }
}

export default trackedCron('shopify-stock-snapshot', handler);
