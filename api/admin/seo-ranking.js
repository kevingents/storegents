/**
 * GET /api/admin/seo-ranking
 *
 * SEO-ranking: on-page-audit van de Shopify-producten + (indien gekoppeld)
 * Google Search Console-cijfers (zoektermen, posities, klikken, impressies).
 *
 * Query: ?refresh=1 forceert een live on-page-scan; ?bucket= geeft één bucket.
 * Read-only. Auth: admin-token vereist.
 */

import { runSeoAudit, readSeoAudit, isSeoAuditFresh } from '../../lib/seo-audit.js';
import { getSearchConsoleSummary } from '../../lib/google-search-console-client.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 60;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  try {
    const refresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());

    let onpage = refresh ? null : await readSeoAudit();
    let cached = Boolean(onpage);
    if (!onpage || !isSeoAuditFresh(onpage)) {
      onpage = await runSeoAudit();
      cached = false;
    }

    const only = String(req.query.bucket || '').trim();
    if (only && onpage.buckets && onpage.buckets[only]) {
      onpage = { ...onpage, buckets: { [only]: onpage.buckets[only] } };
    }

    /* Search Console parallel — faalt nooit de hele response. */
    let gsc;
    try { gsc = await getSearchConsoleSummary({ days: 28 }); }
    catch (e) { gsc = { configured: false, reason: e.message || 'Search Console-fout.' }; }

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({ success: true, cached, onpage, gsc });
  } catch (error) {
    console.error('[admin/seo-ranking]', error);
    return res.status(500).json({ success: false, message: error.message || 'SEO-ranking mislukt.' });
  }
}
