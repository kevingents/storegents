import { trackedCron } from '../../lib/cron-auto-track.js';
import { runProductAudit } from '../../lib/shopify-product-audit.js';

export const maxDuration = 60;

/**
 * Cron: bouw de product-zichtbaarheid-audit 1× per dag op, zodat de
 * admin-pagina direct een verse (gecachte) audit toont zonder live scan.
 *
 * Schrijft naar Blob shopify-products/audit.json. Read-only richting Shopify.
 * Vercel cron schedule:  40 3 * * *   (na de products-refresh van 03:00)
 */
async function handler(req, res) {
  const secret = String(process.env.SHOPIFY_PRODUCTS_CRON_SECRET || process.env.CRON_SECRET || '').trim();
  const incoming = String(req.headers.authorization || req.query.secret || '').replace(/^Bearer\s+/i, '').trim();
  if (secret && incoming !== secret) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  try {
    const result = await runProductAudit();
    return res.status(200).json({
      success: true,
      refreshedAt: result.refreshedAt,
      counts: result.counts,
      bucketCounts: result.bucketCounts,
      pages: result.pages
    });
  } catch (error) {
    console.error('[product-audit cron]', error);
    return res.status(500).json({ success: false, message: error.message || 'Audit mislukt.' });
  }
}

export default trackedCron('product-audit', handler);
