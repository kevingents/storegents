/**
 * GET /api/admin/werktijden-test
 *
 * Diagnose van de Werktijden.nl-koppeling: haalt de afdelingen op + kleine
 * samples van timesheets/absences/employees zodat we de echte department-namen,
 * ids en veld-vormen zien (handig voor de winkel<->afdeling-mapping). Read-only.
 *
 * Optioneel: ?start=YYYY-MM-DD&end=YYYY-MM-DD (default: laatste 14 dagen).
 * Auth: admin-token vereist.
 */

import { probeWerktijden } from '../../lib/werktijden-client.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 30;

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    const start = String(req.query.start || isoDaysAgo(14)).slice(0, 10);
    const end = String(req.query.end || isoDaysAgo(0)).slice(0, 10);
    const result = await probeWerktijden({ start, end });
    return res.status(200).json({ success: true, window: { start, end }, ...result });
  } catch (e) {
    console.error('[admin/werktijden-test]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
