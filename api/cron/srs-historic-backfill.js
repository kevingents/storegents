import { getFulfillments, isSrsCancelledStatus } from '../../lib/srs-weborders-message-client.js';
import { addOrderCancellationsBulk } from '../../lib/order-cancellation-bulk-store.js';
import { getStoreNameByBranchId } from '../../lib/branch-metrics.js';
import { trackedCron } from '../../lib/cron-auto-track.js';

/**
 * Nachtelijke cron: backfill van CANCELLED weborder-fulfillments uit SRS
 * voor het hele lopende jaar. Persist in lokale order-cancellation store.
 *
 * Schedule: 03:00 NL tijd (vercel.json: "0 1 * * *" = 01:00 UTC = 03:00 NL CET)
 *
 * - Chunked per branch (kleinere SRS calls, minder 503 kans)
 * - Persistent via addOrderCancellationsBulk
 * - Idempotent (dedupe op fulfillmentId + sku)
 */

const BRANCH_IDS = ['1','2','3','4','5','8','10','12','13','14','15','16','17','18','19','20','22','23','50','97','99','700'];
const CANCELLED_STATUSES = ['cancelled', 'canceled', 'geannuleerd'];

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function clean(value) { return String(value || '').trim(); }

function isAuthorized(req) {
  /* Vercel cron stuurt User-Agent vercel-cron, dat accepteren we direct */
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  if (ua.includes('vercel-cron')) return true;
  /* Daarnaast handmatige trigger met admin token */
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  const token = String(req.headers['x-admin-token'] || req.query.adminToken || '').trim();
  return token === adminToken;
}

function inCurrentYear(value) {
  const dt = new Date(value || 0);
  if (Number.isNaN(dt.getTime())) return false;
  return dt.getFullYear() === new Date().getFullYear() || dt.getFullYear() === new Date().getFullYear() - 1;
}

function buildRecord(fulfillment) {
  const orderNr = clean(fulfillment.orderNr).replace(/^#/, '');
  const fulfillmentId = clean(fulfillment.fulfillmentId || fulfillment.id);
  const orderLineNr = clean(fulfillment.orderLineNr);
  const sku = clean(fulfillment.sku || fulfillment.barcode);
  const branchId = clean(fulfillment.branchId || fulfillment.fulfillmentBranchId || '');
  const store = branchId ? getStoreNameByBranchId(branchId) : 'SRS zonder filiaal';
  const amount = Number(fulfillment.totalPrice || fulfillment.amount || fulfillment.price || 0);
  const date = clean(fulfillment.updatedAt || fulfillment.createdAt || fulfillment.orderDate || new Date().toISOString());

  return {
    idempotencyKey: ['srs-historic-backfill', orderNr, fulfillmentId, orderLineNr, sku].filter(Boolean).join('::'),
    createdAt: date,
    updatedAt: new Date().toISOString(),
    processedAt: new Date().toISOString(),
    store,
    branchId,
    orderNr,
    weborderNr: orderNr,
    shopifyOrderNr: orderNr,
    employeeName: 'Nachtelijke cron',
    customerName: clean(fulfillment.customerName),
    customerEmail: clean(fulfillment.customerEmail),
    reason: 'SRS geannuleerd — nachtelijke backfill',
    type: 'partial',
    currency: 'EUR',
    amount,
    items: [{
      sku, barcode: clean(fulfillment.barcode || sku),
      title: clean(fulfillment.productName || fulfillment.title || sku),
      articleNumber: clean(fulfillment.articleNumber || fulfillment.artikelnummer || sku),
      orderLineNr,
      quantity: Number(fulfillment.quantity || fulfillment.pieces || 1),
      amount
    }],
    status: 'processed',
    problemType: 'niet_leverbaar',
    srsStatus: 'cancelled_in_srs',
    srsCancelStatus: 'cancelled_in_srs',
    refundStatus: 'already_refunded',
    mailStatus: 'shopify_refund_mail',
    source: 'srs_historic_nightly_backfill',
    srsSourceStatus: clean(fulfillment.status || 'cancelled')
  };
}

async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const startedAt = Date.now();
  const maxRuntimeMs = Number(req.query.maxRuntimeMs || 240000); /* 4 min */
  const dryRun = clean(req.query.dryRun) === '1';

  const allFulfillments = [];
  const branchErrors = [];
  let branchesProcessed = 0;

  /* Per branch query — kleinere datasets, minder 503 risico */
  for (const branchId of BRANCH_IDS) {
    if (Date.now() - startedAt > maxRuntimeMs - 30000) {
      branchErrors.push({ branchId, message: 'Runtime-budget bijna op — stop' });
      break;
    }

    for (const status of CANCELLED_STATUSES) {
      try {
        const result = await getFulfillments({ branchId, status });
        const items = (result.fulfillments || [])
          .filter((row) => isSrsCancelledStatus(row.status || status))
          .filter((row) => inCurrentYear(row.updatedAt || row.createdAt || row.orderDate));
        items.forEach((item) => allFulfillments.push({ ...item, _branchId: branchId, _status: status }));
      } catch (error) {
        branchErrors.push({ branchId, status, message: error.message || String(error) });
      }
    }
    branchesProcessed++;
  }

  /* Dedupe op fulfillmentId */
  const deduped = Array.from(
    new Map(allFulfillments.map((item) => [
      item.fulfillmentId || `${item.orderNr}-${item.orderLineNr}-${item.sku || item.barcode}`,
      item
    ])).values()
  );

  let stored = 0;
  let duplicates = 0;

  if (!dryRun && deduped.length) {
    try {
      const records = deduped.map(buildRecord);
      const result = await addOrderCancellationsBulk(records);
      stored = result.added || result.created || records.length;
      duplicates = result.duplicates || result.skipped || 0;
    } catch (error) {
      branchErrors.push({ source: 'addOrderCancellationsBulk', message: error.message || String(error) });
    }
  }

  return res.status(200).json({
    success: true,
    mode: 'srs_historic_nightly_backfill',
    runtimeMs: Date.now() - startedAt,
    dryRun,
    branchesProcessed,
    totalBranches: BRANCH_IDS.length,
    foundFulfillments: allFulfillments.length,
    afterDedupe: deduped.length,
    stored,
    duplicates,
    errors: branchErrors,
    year: new Date().getFullYear()
  });
}

export default trackedCron('srs-historic-backfill', handler);
