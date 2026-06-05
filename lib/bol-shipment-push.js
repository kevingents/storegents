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
import { getLabels } from './sendcloud-labels-store.js';
import { bolPost, bolOrdersWriteVersion } from './bol-client.js';
import { readBolCancellationsState } from './bol-cancellations-store.js';
import { fetchBolOrderDetail, deliveryAddressFromDetail } from './bol-srs-push.js';
import { fetchRecentParcels, buildParcelMatchIndex, findParcelForOrder } from './sendcloud-parcels.js';

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
 * POST /retailer/shipments   (v10)
 * Body: { orderItems:[{orderItemId}], shipmentReference?, transport:{transporterCode, trackAndTrace} }
 *
 * De oude PUT /orders/{order-id}/shipment is in v10 VERVALLEN — bol geeft daar
 * 403 "Unauthorized request". Shipment-bevestiging gaat nu via POST /shipments,
 * met de orderItemIds van de order. We halen die uit de order-detail (GET, v10)
 * en sturen alleen de nog-te-verzenden regels mee (1 sendcloud-label = hele order).
 */
async function bolMarkShipped(bolOrderId, { transporterCode, trackAndTrace, shipmentReference }) {
  const detail = await fetchBolOrderDetail(bolOrderId);
  if (!detail || detail._error) {
    throw new Error(`order-detail ophalen mislukt: ${detail?._error || 'onbekend'}`);
  }
  const orderItems = (detail.orderItems || [])
    .filter((it) => {
      const q = Number(it.quantity || 0);
      const shipped = Number(it.quantityShipped || 0);
      const cancelled = Number(it.quantityCancelled || 0);
      return clean(it.orderItemId) && (q - shipped - cancelled) > 0;
    })
    .map((it) => ({ orderItemId: clean(it.orderItemId) }));
  if (!orderItems.length) {
    /* Niets meer te verzenden → order is al verzonden of geannuleerd op bol.
       (Verklaart een eerdere 403 op het oude pad voor al-geannuleerde orders.) */
    const e = new Error('geen open orderItems — order is al verzonden of geannuleerd op bol');
    e.code = 'NO_SHIPPABLE_ITEMS';
    throw e;
  }
  const body = { orderItems, transport: { transporterCode, trackAndTrace } };
  if (shipmentReference) body.shipmentReference = shipmentReference;
  /* Bol is process-async: returnt een processStatusId. Non-throw = geaccepteerd. */
  return await bolPost('/shipments', body, { method: 'POST', version: bolOrdersWriteVersion() });
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
  /* readBolCancellationsState, fetchBolOrderDetail, fetchRecentParcels etc.
     worden als statische imports bovenaan het bestand geladen. */

  const [pushedState, shippedState, labels, cancelState, parcels] = await Promise.all([
    readBolSrsPushedState(),
    readShippedState(),
    getLabels().catch(() => []),
    readBolCancellationsState().catch(() => ({ cancelled: {} })),
    /* Sendcloud-parcels: bevat ook labels die SRS aanmaakt (staan NIET in de
       lokale labels-blob). Match op adres / order_number. */
    fetchRecentParcels({ max: 500 }).catch((e) => { console.warn('[bol-shipment] sendcloud-parcels faalde:', e.message); return []; })
  ]);

  const pushed = pushedState.pushed || {};
  const shipped = { ...(shippedState.shipped || {}) };
  const byRef = buildLabelsByReference(labels);
  const cancelledMap = (cancelState && cancelState.cancelled) || {};
  const parcelIndex = buildParcelMatchIndex(parcels || []);

  let processed = 0, sent = 0, skippedNoLabel = 0, skippedAlready = 0, skippedCancelled = 0, failed = 0;
  let matchedLocal = 0, matchedSendcloud = 0;
  const results = [];

  for (const [bolOrderId, info] of Object.entries(pushed)) {
    if (processed >= maxPerRun) break;
    if (!force && shipped[bolOrderId]) {
      skippedAlready += 1;
      continue;
    }
    /* Geannuleerde orders niet als verzonden markeren. */
    if (cancelledMap[bolOrderId]) {
      skippedCancelled += 1;
      continue;
    }

    const srsOrderId = clean(info?.srsOrderId);
    if (!srsOrderId) { skippedNoLabel += 1; continue; }

    /* Resolve het verzendlabel: eerst lokale labels-blob (portal-flow), dan
       Sendcloud-parcels (SRS-flow) via adres- of order_number-match. */
    let trackAndTrace = '', transporterCode = '', shippingMethod = '', labelId = '', matchSource = '';
    const localLabel = byRef.get(srsOrderId);
    if (localLabel) {
      trackAndTrace = localLabel.trackingNumber;
      transporterCode = mapTransporterCode(localLabel.shippingMethod);
      shippingMethod = localLabel.shippingMethod;
      labelId = localLabel.labelId;
      matchSource = 'local-label';
      matchedLocal += 1;
    } else {
      /* Sendcloud-parcels-match: probeer eerst order_number, anders adres.
         Adres-match vereist het delivery-adres uit de bol-order detail. */
      let delivery = { postalCode: clean(info?.deliveryPostalCode), houseNumber: clean(info?.deliveryHouseNumber) };
      if (!delivery.postalCode || !delivery.houseNumber) {
        const detail = await fetchBolOrderDetail(bolOrderId);
        if (detail && !detail._error) delivery = deliveryAddressFromDetail(detail);
      }
      const match = findParcelForOrder(parcelIndex, {
        srsOrderId,
        postalCode: delivery.postalCode,
        houseNumber: delivery.houseNumber
      });
      if (match) {
        trackAndTrace = match.parcel.trackingNumber;
        transporterCode = match.parcel.transporterCode;
        shippingMethod = match.parcel.shippingMethod || match.parcel.carrierCode;
        labelId = `sc-${match.parcel.parcelId}`;
        matchSource = `sendcloud-${match.matchType}`;
        matchedSendcloud += 1;
      }
    }

    if (!trackAndTrace) {
      skippedNoLabel += 1;
      results.push({ bolOrderId, srsOrderId, status: 'no-label', message: `Geen label gevonden (lokaal noch Sendcloud) voor ${srsOrderId}.` });
      continue;
    }

    processed += 1;

    if (dryRun) {
      sent += 1;
      results.push({ bolOrderId, srsOrderId, dryRun: true, success: true, transporterCode, trackAndTrace, shippingMethod, matchSource });
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
        shippingMethod,
        labelId,
        matchSource,
        at: new Date().toISOString(),
        bolProcessId: bolResponse?.processStatusId || bolResponse?.id || null
      };
      results.push({
        bolOrderId, srsOrderId, success: true,
        transporterCode, trackAndTrace, matchSource,
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
      skippedCancelled,
      failed,
      matchedLocal,
      matchedSendcloud,
      parcelsFetched: (parcels || []).length,
      remainingUnshipped: Math.max(0, Object.keys(pushed).length - Object.keys(shipped).length)
    },
    results
  };
}

export async function readBolShipmentsState() {
  return readShippedState();
}

/**
 * Zoek het bolOrderId dat hoort bij een SRS-ordernummer (BOL-NNNN). Voor de
 * Sendcloud-webhook die alleen het order_number (= BOL-NNNN) kent.
 * @returns {Promise<{ bolOrderId, info }|null>}
 */
export async function findBolOrderBySrsOrderId(srsOrderId) {
  const want = clean(srsOrderId);
  if (!want) return null;
  const pushedState = await readBolSrsPushedState().catch(() => ({ pushed: {} }));
  for (const [bolOrderId, info] of Object.entries(pushedState?.pushed || {})) {
    if (clean(info?.srsOrderId) === want) return { bolOrderId, info };
  }
  return null;
}

/** Is een bol-order al als verzonden gemarkeerd (idempotency voor webhook)? */
export async function isBolOrderShipped(bolOrderId) {
  const id = clean(bolOrderId);
  if (!id) return false;
  const state = await readShippedState();
  return !!(state.shipped && state.shipped[id]);
}

/**
 * Handmatige shipment-melding voor 1 bol-order. Voor edge-cases waar het
 * magazijn vergeet om reference=BOL-NNNN te zetten in Sendcloud, of voor
 * recovery na een failed cron-call.
 */
export async function markBolOrderShippedManual(bolOrderId, {
  trackAndTrace,
  transporterCode = 'DHLFORYOU',
  shipmentReference = '',
  shippingMethod = ''
}) {
  const id = clean(bolOrderId);
  const trackId = clean(trackAndTrace);
  const carrier = clean(transporterCode) || 'DHLFORYOU';
  if (!id) throw new Error('bolOrderId verplicht.');
  if (!trackId) throw new Error('trackAndTrace verplicht.');

  const bolResponse = await bolMarkShipped(id, {
    transporterCode: carrier,
    trackAndTrace: trackId,
    shipmentReference: clean(shipmentReference) || undefined
  });

  /* Update shipped-state zodat cron deze niet opnieuw verzendt. */
  const state = await readShippedState();
  const shipped = { ...(state.shipped || {}) };
  shipped[id] = {
    srsOrderId: clean(shipmentReference),
    transporterCode: carrier,
    trackAndTrace: trackId,
    shippingMethod: clean(shippingMethod) || 'manual-entry',
    labelId: 'manual',
    at: new Date().toISOString(),
    bolProcessId: bolResponse?.processStatusId || bolResponse?.id || null,
    manualEntry: true
  };
  await writeShippedState({ ...state, shipped });
  return { success: true, bolOrderId: id, transporterCode: carrier, trackAndTrace: trackId, bolProcessId: bolResponse?.processStatusId || null };
}
