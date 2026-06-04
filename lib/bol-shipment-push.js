/**
 * lib/bol-shipment-push.js
 *
 * Markeer Bol-orders als verzonden zodra het magazijn een DHL-label heeft
 * geprint. Voorkomt dat bol orders annuleert wegens uitblijvende verzend-
 * bevestiging.
 *
 * Trigger-mechanisme:
 *   1. Bol-order is naar SRS gepushed met BOL-NNNN als ordernummer (bol-srs-push)
 *   2. Magazijn print label via Sendcloud met `reference = BOL-NNNN`
 *   3. Deze module scant Sendcloud-labels + match op reference → tracking-code
 *   4. PUT /retailer/orders/{bolOrderId}/shipment met transporter + tracking
 *   5. Markeer in marketplace/bol-shipments-sent.json (idempotency)
 *
 * Bol-transportercodes (subset, meestgebruikt):
 *   DHLFORYOU  — DHL eCommerce NL (Parcel) ← default voor ons
 *   DHL        — DHL Express
 *   DHL-DE     — DHL Duitsland
 *   POSTNL     — PostNL
 *   DPD        — DPD
 *   UPS        — UPS
 *   BPOST      — bpost België
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { readBolSrsPushedState } from './bol-srs-push.js';
import { getLabels } from '../sendcloud-labels-store.js';
import { bolPost } from './bol-client.js';

const SHIPPED_PATH = 'marketplace/bol-shipments-sent.json';

const clean = (v) => String(v == null ? '' : v).trim();

/* ─── Idempotency-state ──────────────────────────────────────────────── */

async function readShippedState() {
  const data = await readJsonBlob(SHIPPED_PATH, null).catch(() => null);
  if (data && typeof data === 'object' && data.shipped && typeof data.shipped === 'object') return data;
  return { shipped: {}, updatedAt: null, runCount: 0 };
}

async function writeShippedState(state) {
  await writeJsonBlob(SHIPPED_PATH, {
    ...state,
    updatedAt: new Date().toISOString(),
    runCount: Number(state.runCount || 0) + 1
  });
}

/* ─── Carrier-mapping Sendcloud shippingMethod → Bol transporterCode ─── */

function mapTransporterCode(shippingMethod) {
  const s = clean(shippingMethod).toLowerCase();
  if (!s) return 'DHLFORYOU'; /* default */
  if (s.includes('dhl express')) return 'DHL';
  if (s.includes('dhl') && s.includes('de')) return 'DHL-DE';
  if (s.includes('dhl')) return 'DHLFORYOU';
  if (s.includes('postnl') || s.includes('post nl')) return 'POSTNL';
  if (s.includes('dpd')) return 'DPD';
  if (s.includes('ups')) return 'UPS';
  if (s.includes('bpost') || s.includes('belgium')) return 'BPOST';
  if (s.includes('gls')) return 'GLS';
  return 'DHLFORYOU';
}

/* ─── Sendcloud labels → match op BOL-NNNN reference ────────────────── */

/**
 * Build map: srsOrderId (BOL-NNNN) → { trackingNumber, shippingMethod, labelId, createdAt }
 * Pakt het MEEST RECENTE label per reference (in geval van retouren/herprint).
 */
function buildLabelsByReference(labels) {
  const map = new Map();
  for (const l of (labels || [])) {
    const ref = clean(l.reference);
    if (!ref || !ref.toUpperCase().startsWith('BOL-')) continue;
    const tracking = clean(l.trackingNumber);
    if (!tracking) continue;
    const existing = map.get(ref);
    if (!existing || (l.createdAt && existing.createdAt && l.createdAt > existing.createdAt)) {
      map.set(ref, {
        trackingNumber: tracking,
        trackingUrl: clean(l.trackingUrl),
        shippingMethod: clean(l.shippingMethod),
        labelId: clean(l.id),
        createdAt: l.createdAt || ''
      });
    }
  }
  return map;
}

/* ─── Bol shipment API call ─────────────────────────────────────────── */

/**
 * PUT /retailer/orders/{order-id}/shipment
 * Body: { shipmentReference?, transport: { transporterCode, trackAndTrace } }
 *
 * Zonder orderItems-array shipt bol de complete order. Voor onze flow is dat
 * juist — 1 sendcloud-label = 1 bol-order = complete pakketverzending.
 */
async function bolMarkShipped(bolOrderId, { transporterCode, trackAndTrace, shipmentReference }) {
  const body = {
    transport: {
      transporterCode,
      trackAndTrace
    }
  };
  if (shipmentReference) body.shipmentReference = shipmentReference;
  /* Bol Retailer API is process-async: returnt process-status-link, niet
     direct success. Voor MVP nemen we 200/202 als success. */
  return await bolPost(`/orders/${encodeURIComponent(bolOrderId)}/shipment`, body, { method: 'PUT' });
}

/* ─── Main flow ─────────────────────────────────────────────────────── */

/**
 * Scan alle gepushte BOL-orders, matched tegen Sendcloud-labels op reference,
 * en markeer als verzonden in bol.
 *
 * @param {Object} opts
 * @param {boolean} [opts.dryRun=false] — geen Bol-call, alleen rapporteren
 * @param {number}  [opts.maxPerRun=50]
 * @param {boolean} [opts.force=false]  — herstuur ook al-doorgegeven shipments
 */
export async function pushBolShipments({ dryRun = false, maxPerRun = 50, force = false } = {}) {
  const [pushedState, shippedState, labels] = await Promise.all([
    readBolSrsPushedState(),
    readShippedState(),
    getLabels().catch(() => [])
  ]);

  const pushed = pushedState.pushed || {};
  const shipped = { ...(shippedState.shipped || {}) };
  const byRef = buildLabelsByReference(labels);

  let processed = 0, sent = 0, skippedNoLabel = 0, skippedAlready = 0, failed = 0;
  const results = [];

  for (const [bolOrderId, info] of Object.entries(pushed)) {
    if (processed >= maxPerRun) break;
    if (!force && shipped[bolOrderId]) {
      skippedAlready += 1;
      continue;
    }

    const srsOrderId = clean(info?.srsOrderId);
    if (!srsOrderId) { skippedNoLabel += 1; continue; }

    /* Zoek label met reference = BOL-NNNN */
    const label = byRef.get(srsOrderId);
    if (!label) {
      skippedNoLabel += 1;
      results.push({ bolOrderId, srsOrderId, status: 'no-label', message: 'Geen Sendcloud-label gevonden met reference ' + srsOrderId });
      continue;
    }

    processed += 1;
    const transporterCode = mapTransporterCode(label.shippingMethod);
    const trackAndTrace = label.trackingNumber;

    if (dryRun) {
      sent += 1;
      results.push({
        bolOrderId,
        srsOrderId,
        dryRun: true,
        success: true,
        transporterCode,
        trackAndTrace,
        shippingMethod: label.shippingMethod,
        labelId: label.labelId
      });
      continue;
    }

    try {
      const bolResponse = await bolMarkShipped(bolOrderId, {
        transporterCode,
        trackAndTrace,
        shipmentReference: srsOrderId
      });
      sent += 1;
      shipped[bolOrderId] = {
        srsOrderId,
        transporterCode,
        trackAndTrace,
        shippingMethod: label.shippingMethod,
        labelId: label.labelId,
        at: new Date().toISOString(),
        bolProcessId: bolResponse?.processStatusId || bolResponse?.id || null
      };
      results.push({
        bolOrderId, srsOrderId, success: true,
        transporterCode, trackAndTrace,
        bolProcessId: bolResponse?.processStatusId || null
      });
    } catch (e) {
      failed += 1;
      results.push({
        bolOrderId, srsOrderId, success: false,
        transporterCode, trackAndTrace,
        error: (e?.message || String(e)).slice(0, 500)
      });
    }
  }

  if (!dryRun && sent > 0) {
    await writeShippedState({ ...shippedState, shipped });
  }

  return {
    success: true,
    dryRun,
    summary: {
      totalPushedOrders: Object.keys(pushed).length,
      processed,
      sent,
      skippedNoLabel,
      skippedAlready,
      failed,
      remainingUnshipped: Math.max(0, Object.keys(pushed).length - Object.keys(shipped).length)
    },
    results
  };
}

export async function readBolShipmentsState() {
  return readShippedState();
}
