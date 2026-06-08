/**
 * GET /api/admin/pagespeed
 *
 * Google PageSpeed Insights / Core Web Vitals voor een paar sleutel-URL's van
 * gents.nl (mobiel). Cache-first; ?refresh=1 forceert een live meting (traag,
 * ~20-40s). Read-only. Auth: admin-token vereist.
 */

import { runPageSpeed, readPageSpeed, isPageSpeedFresh } from '../../lib/pagespeed-client.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 60;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  try {
    const refresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
    let data = refresh ? null : await readPageSpeed();
    let cached = Boolean(data);
    if (!data || !isPageSpeedFresh(data)) {
      data = await runPageSpeed();
      cached = false;
    }
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({ success: true, cached, pagespeed: data });
  } catch (error) {
    console.error('[admin/pagespeed]', error);
    return res.status(500).json({ success: false, message: error.message || 'PageSpeed mislukt.' });
  }
}
