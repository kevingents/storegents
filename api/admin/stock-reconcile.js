/**
 * GET /api/admin/stock-reconcile
 *
 * Reconcile SRS-voorraad ↔ Shopify-voorraad per SKU. Toont SKU's die wel in
 * het SRS-bestand (magazijn-voorraad) staan maar niet/fout in Shopify, plus
 * voorraad-verschillen.
 *
 * Query: ?refresh=1 forceert live scan; ?bucket= geeft één bucket terug.
 * Read-only. Auth: admin-token vereist.
 */

import { runStockReconcile, readStockReconcile, isReconFresh } from '../../lib/srs-shopify-stock-reconcile.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 60;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  try {
    const refresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
    let recon = refresh ? null : await readStockReconcile();
    let cached = Boolean(recon);
    if (!recon || !isReconFresh(recon)) {
      recon = await runStockReconcile();
      cached = false;
    }

    const only = String(req.query.bucket || '').trim();
    if (only && recon.buckets && recon.buckets[only]) {
      recon = { ...recon, buckets: { [only]: recon.buckets[only] } };
    }

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({ success: true, cached, ...recon });
  } catch (error) {
    console.error('[admin/stock-reconcile]', error);
    return res.status(500).json({ success: false, message: error.message || 'Voorraad-reconcile mislukt.' });
  }
}
