/**
 * GET /api/admin/retail-anomaly?windowDays=7&threshold=25
 *
 * Omzet-anomalieën per winkel t.o.v. dezelfde weekdagen vorig jaar. Drempel +
 * venster komen uit de in-tool config (query overschrijft tijdelijk).
 *
 * Read-only. Auth: admin-token.
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { detectAnomalies } from '../../lib/retail-anomaly.js';
import { readPortalConfig, anomalyAlertConfig } from '../../lib/portal-config-store.js';

export const maxDuration = 30;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  try {
    const cfg = anomalyAlertConfig(await readPortalConfig().catch(() => ({})));
    const windowDays = req.query.windowDays ? Number(req.query.windowDays) : cfg.windowDays;
    const thresholdPct = req.query.threshold ? Number(req.query.threshold) : cfg.thresholdPct;
    const data = await detectAnomalies({ windowDays, thresholdPct });
    return res.status(200).json({ success: true, config: cfg, ...data });
  } catch (e) {
    console.error('[admin/retail-anomaly]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
