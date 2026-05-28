/**
 * /api/admin/marketing-winkelprestaties
 *
 * Winkelprestaties per fysiek filiaal: bezoekers (klantentellers) × bonnen ×
 * omzet × conversie × gem. besteding, over een gemeenschappelijk venster.
 *
 *   GET                 → laatste snapshot (blob).
 *   GET ?refresh=1      → haalt verse SFTP-exports op en herberekent (admin).
 *
 * Auth: admin-token vereist.
 */

import { readRetailPerformance } from '../../lib/srs-retail-store.js';
import { importRetailPerformance } from '../../lib/srs-retail-import.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

/* SFTP-handshake + download + parse kan 10-30s duren. */
export const maxDuration = 60;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    const refresh = req.query?.refresh === '1' || req.query?.refresh === 'true';
    const data = refresh ? await importRetailPerformance() : await readRetailPerformance();
    return res.status(200).json({ success: true, ...data });
  } catch (e) {
    console.error('[admin/marketing-winkelprestaties]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
