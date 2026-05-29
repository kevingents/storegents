/**
 * /api/admin/mixmatch-analytics
 *
 * Voorraad-impact van Mix & Match-pakken: per pak de maat-beschikbaarheid,
 * KPI's, belangrijkste combinaties, lage-voorraad-alerts en overstock.
 * Read-only. Auth: admin-token vereist.
 */

import { buildMixMatchAnalytics } from '../../lib/mixmatch-analytics.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 60;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    const data = await buildMixMatchAnalytics();
    return res.status(200).json({ success: true, ...data });
  } catch (e) {
    console.error('[admin/mixmatch-analytics]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
