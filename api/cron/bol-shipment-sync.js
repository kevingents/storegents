/**
 * Cron: GET /api/cron/bol-shipment-sync
 *
 * Markeer in bol gepushte orders als verzonden zodra het magazijn een DHL-label
 * heeft geprint via Sendcloud (gematched op `reference = BOL-NNNN`). Voorkomt
 * dat bol orders annuleert wegens uitblijvende verzendbevestiging.
 *
 * Schedule: elk uur op :40 — na bol-orders (:00) en bol-srs-sync (:20).
 */

import { trackedCron } from '../../lib/cron-auto-track.js';
import { isCronAuthorized } from '../../lib/cron-auth.js';
import { pushBolShipments } from '../../lib/bol-shipment-push.js';

export const maxDuration = 180;

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!isCronAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const dryRun = String(req.query?.dryRun || '') === '1';
  const maxPerRun = Number(req.query?.max || process.env.BOL_SHIPMENT_MAX_PER_RUN || 50);

  try {
    const result = await pushBolShipments({ dryRun, maxPerRun });
    return res.status(200).json(result);
  } catch (e) {
    console.error('[cron/bol-shipment-sync]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}

export default trackedCron('bol-shipment-sync', handler);
