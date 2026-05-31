import { trackedCron } from '../../lib/cron-auto-track.js';
import { runStockReconcile } from '../../lib/srs-shopify-stock-reconcile.js';

export const maxDuration = 60;

/**
 * Cron: bouw de SRS↔Shopify voorraad-reconcile 1× per dag op (na de voorraad-
 * import + products-refresh), zodat de admin-pagina direct een verse cache toont.
 * Schedule: 50 3 * * *
 */
async function handler(req, res) {
  const secret = String(process.env.SHOPIFY_PRODUCTS_CRON_SECRET || process.env.CRON_SECRET || '').trim();
  const incoming = String(req.headers.authorization || req.query.secret || '').replace(/^Bearer\s+/i, '').trim();
  if (secret && incoming !== secret) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }
  try {
    const r = await runStockReconcile();
    return res.status(200).json({ success: true, refreshedAt: r.refreshedAt, basis: r.basis, counts: r.counts, bucketCounts: r.bucketCounts, pages: r.pages });
  } catch (error) {
    console.error('[stock-reconcile cron]', error);
    return res.status(500).json({ success: false, message: error.message || 'Reconcile mislukt.' });
  }
}

export default trackedCron('stock-reconcile', handler);
