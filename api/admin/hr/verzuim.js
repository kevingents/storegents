/**
 * GET /api/admin/hr/verzuim
 *
 * Ziekteverzuim-overzicht over een periode: verzuim%, meldingsfrequentie,
 * gemiddelde duur, Vernet-klassen (kort/middel/lang), wie is nu ziek en per
 * winkel. Ziekte-types zijn instelbaar (config hr.verzuimTypes).
 *
 *   ?period=maand|kwartaal|jaar|custom[&from=&to=]
 *   ?withPercent=0   -> sla verzuim%-berekening (rooster) over (sneller)
 *
 * Read-only. Auth: admin-token.
 */

import { getVerzuimOverview } from '../../../lib/hr-verzuim.js';
import { periodToRange } from '../../../lib/hr-productivity.js';
import { corsJson, requireAdmin } from '../../../lib/request-guards.js';

export const maxDuration = 30;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    const period = String(req.query.period || 'jaar');
    const range = periodToRange(period, { from: String(req.query.from || ''), to: String(req.query.to || '') });
    const withPercent = String(req.query.withPercent || '1') !== '0';
    const data = await getVerzuimOverview({ ...range, withPercent });
    return res.status(200).json({ success: true, period, ...data });
  } catch (e) {
    console.error('[admin/hr/verzuim]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
