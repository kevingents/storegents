/**
 * GET /api/admin/hr/productivity
 *
 * Per periode (week/maand/custom) per filiaal: omzet, totaal gewerkte uren
 * (alle medewerkers samen) en productiviteit (omzet / uren).
 *
 *   ?period=week|maand|kwartaal|jaar|vandaag|gisteren|custom[&from=&to=]
 *
 * Read-only. Auth: admin-token vereist.
 */

import { computeHrProductivity, periodToRange } from '../../../lib/hr-productivity.js';
import { corsJson, requireAdmin } from '../../../lib/request-guards.js';

export const maxDuration = 60;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    const period = String(req.query.period || 'week');
    const range = periodToRange(period, { from: String(req.query.from || ''), to: String(req.query.to || '') });
    const data = await computeHrProductivity(range);
    return res.status(200).json({ success: true, period, ...data });
  } catch (e) {
    console.error('[admin/hr/productivity]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
