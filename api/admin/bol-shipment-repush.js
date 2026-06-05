/**
 * POST /api/admin/bol-shipment-repush
 *
 * Admin-wrapper om de bol-shipment-sync handmatig te draaien vanuit de console
 * of een knop (de cron-endpoint zelf heeft geen CORS). Haalt de Sendcloud-parcels
 * op, matcht ze aan open bol-orders en zet de tracking door naar bol → orders
 * sluiten. Handig om een achterstand ("oude verzendingen") in te halen.
 *
 * Body (JSON):
 *   { dryRun?: true, max?: 200 }
 *   - dryRun : alleen matchen + tonen wat er zou worden doorgezet, niets sturen.
 *   - max    : max aantal orders per run (default 50).
 *
 * Auth: admin-token (header x-admin-token).
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { pushBolShipments, markBolOrderShippedManual, findBolOrderBySrsOrderId } from '../../lib/bol-shipment-push.js';

export const maxDuration = 180;

const clean = (v) => String(v == null ? '' : v).trim();
const truthy = (v) => v === true || v === 1 || ['1', 'true', 'yes', 'ja'].includes(String(v).toLowerCase());

export default async function handler(req, res) {
  if (corsJson(req, res, ['POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};

    /* ── Handmatig 1 order afmelden (stragglers die niet auto-matchen) ──
       Body: { srsOrderId?: "BOL-00XX", bolOrderId?: "C00...", trackAndTrace, transporterCode? } */
    const trackAndTrace = clean(body.trackAndTrace);
    if (trackAndTrace) {
      let bolOrderId = clean(body.bolOrderId);
      const srsOrderId = clean(body.srsOrderId);
      if (!bolOrderId && srsOrderId) {
        const found = await findBolOrderBySrsOrderId(srsOrderId);
        if (!found) return res.status(404).json({ success: false, message: `Geen bol-order met srsOrderId ${srsOrderId}.` });
        bolOrderId = clean(found.bolOrderId);
      }
      if (!bolOrderId) return res.status(400).json({ success: false, message: 'Geef srsOrderId (BOL-NNNN) of bolOrderId mee bij handmatig afmelden.' });
      const result = await markBolOrderShippedManual(bolOrderId, {
        trackAndTrace,
        transporterCode: clean(body.transporterCode) || 'DHLFORYOU',
        shipmentReference: srsOrderId || clean(body.shipmentReference),
        shippingMethod: clean(body.shippingMethod) || 'handmatig-portal'
      });
      return res.status(200).json({ success: true, manual: true, bolOrderId, srsOrderId: srsOrderId || null, result });
    }

    /* ── Bulk: hele achterstand inhalen (Sendcloud-match) ── */
    const dryRun = truthy(body.dryRun);
    const maxPerRun = Number(body.max) > 0 ? Math.min(Number(body.max), 500) : 50;
    const result = await pushBolShipments({ dryRun, maxPerRun });
    return res.status(200).json({ success: true, dryRun, maxPerRun, result });
  } catch (e) {
    console.error('[admin/bol-shipment-repush]', e);
    return res.status(500).json({ success: false, message: e.message || 'Shipment-repush mislukt.' });
  }
}
