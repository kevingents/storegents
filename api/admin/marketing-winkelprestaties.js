/**
 * /api/admin/marketing-winkelprestaties
 *
 * Winkelprestaties per fysiek filiaal: bezoekers (klantentellers) × bonnen ×
 * omzet × conversie × gem. besteding, voor een gekozen periode.
 *
 *   GET ?period=vandaag|gisteren|week|maand|kwartaal|jaar|custom[&from=&to=]
 *                       → aggregeert de dagelijkse ledger voor die periode.
 *   GET ?refresh=1      → haalt verse SFTP-exports op, herbouwt de ledger, en
 *                         aggregeert daarna voor de gevraagde periode (admin).
 *
 * Auth: admin-token vereist.
 */

import { importRetailPerformance } from '../../lib/srs-retail-import.js';
import { readLedger, aggregateLedger, periodToRange } from '../../lib/srs-retail-ledger.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

/* SFTP-handshake + download + parse kan 10-30s duren. */
export const maxDuration = 60;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    const refresh = req.query?.refresh === '1' || req.query?.refresh === 'true';
    const period = String(req.query?.period || 'week');
    const range = periodToRange(period, { from: String(req.query?.from || ''), to: String(req.query?.to || '') });

    if (refresh) await importRetailPerformance();
    const ledger = await readLedger();
    const data = aggregateLedger(ledger, range);

    return res.status(200).json({ success: true, period, ...data });
  } catch (e) {
    console.error('[admin/marketing-winkelprestaties]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
