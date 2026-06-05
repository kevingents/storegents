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
import { pushBolShipments } from '../../lib/bol-shipment-push.js';

export const maxDuration = 180;

const truthy = (v) => v === true || v === 1 || ['1', 'true', 'yes', 'ja'].includes(String(v).toLowerCase());

export default async function handler(req, res) {
  if (corsJson(req, res, ['POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const dryRun = truthy(body.dryRun);
    const maxPerRun = Number(body.max) > 0 ? Math.min(Number(body.max), 500) : 50;

    const result = await pushBolShipments({ dryRun, maxPerRun });
    return res.status(200).json({ success: true, dryRun, maxPerRun, result });
  } catch (e) {
    console.error('[admin/bol-shipment-repush]', e);
    return res.status(500).json({ success: false, message: e.message || 'Shipment-repush mislukt.' });
  }
}
