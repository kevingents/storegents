/**
 * Admin endpoint voor Bol shipment-melding.
 *
 *   GET  /api/admin/bol-shipment-sync                → state (welke gemeld)
 *   GET  /api/admin/bol-shipment-sync?dryRun=1       → preview match per order
 *   POST /api/admin/bol-shipment-sync?max=10         → echte push naar bol
 *   POST /api/admin/bol-shipment-sync?force=1        → herstuur ook gemelden
 */

import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { pushBolShipments, readBolShipmentsState, markBolOrderShippedManual } from '../../lib/bol-shipment-push.js';

export const maxDuration = 180;

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (requireAdmin(req, res)) return;

  const dryRun = String(req.query?.dryRun || '') === '1';
  const force = String(req.query?.force || '') === '1';
  const maxPerRun = Number(req.query?.max || 50);

  if (req.method === 'GET' && !dryRun) {
    const state = await readBolShipmentsState();
    return res.status(200).json({
      success: true,
      shippedCount: Object.keys(state.shipped || {}).length,
      updatedAt: state.updatedAt,
      runCount: state.runCount || 0,
      shipped: state.shipped || {}
    });
  }

  /* Handmatige enkel-order mark (body { bolOrderId, trackAndTrace, transporterCode? }) */
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (req.method === 'POST' && body.bolOrderId && body.trackAndTrace) {
    try {
      const r = await markBolOrderShippedManual(body.bolOrderId, {
        trackAndTrace: body.trackAndTrace,
        transporterCode: body.transporterCode || 'DHLFORYOU',
        shipmentReference: body.shipmentReference || '',
        shippingMethod: body.shippingMethod || ''
      });
      return res.status(200).json(r);
    } catch (e) {
      console.error('[admin/bol-shipment-sync manual-mark]', e);
      return res.status(500).json({ success: false, message: e.message || 'Manual mark mislukt.' });
    }
  }

  try {
    const result = await pushBolShipments({ dryRun, maxPerRun, force });
    return res.status(200).json(result);
  } catch (e) {
    console.error('[admin/bol-shipment-sync]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
