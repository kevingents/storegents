import { trackedCron } from '../../lib/cron-auto-track.js';
import { runSeoAudit } from '../../lib/seo-audit.js';

export const maxDuration = 60;

/**
 * Cron: bouw de on-page SEO-audit 1× per dag op zodat de SEO-pagina direct een
 * verse cache toont. Schedule: 45 3 * * *. Read-only richting Shopify.
 */
async function handler(req, res) {
  const secret = String(process.env.SHOPIFY_PRODUCTS_CRON_SECRET || process.env.CRON_SECRET || '').trim();
  const incoming = String(req.headers.authorization || req.query.secret || '').replace(/^Bearer\s+/i, '').trim();
  if (secret && incoming !== secret) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }
  try {
    const r = await runSeoAudit();
    return res.status(200).json({ success: true, refreshedAt: r.refreshedAt, score: r.score, counts: r.counts, bucketCounts: r.bucketCounts, pages: r.pages });
  } catch (error) {
    console.error('[seo-audit cron]', error);
    return res.status(500).json({ success: false, message: error.message || 'SEO-audit mislukt.' });
  }
}

export default trackedCron('seo-audit', handler);
