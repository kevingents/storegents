/**
 * GET /api/admin/hr/verlof
 *
 * Verlof-/afwezigheidsoverzicht over een periode, verrijkt met medewerkernaam,
 * afdeling en een `isOffice`-vlag (hoofdkantoor) voor het winkel-paneel
 * "wie is er met verlof van het hoofdkantoor".
 *
 *   ?period=week|maand|...|custom[&from=&to=]
 *   ?office=1   -> alleen hoofdkantoor-medewerkers
 *
 * Read-only. Auth: admin-token vereist.
 */

import { getLeaveOverview, periodToRange } from '../../../lib/hr-productivity.js';
import { corsJson, requireAdmin } from '../../../lib/request-guards.js';

export const maxDuration = 30;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    const period = String(req.query.period || 'week');
    const range = periodToRange(period, { from: String(req.query.from || ''), to: String(req.query.to || '') });
    const data = await getLeaveOverview(range);
    if (String(req.query.office || '') === '1') {
      data.rows = (data.rows || []).filter((r) => r.isOffice);
      data.total = data.rows.length;
    }
    return res.status(200).json({ success: true, period, ...data });
  } catch (e) {
    console.error('[admin/hr/verlof]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
