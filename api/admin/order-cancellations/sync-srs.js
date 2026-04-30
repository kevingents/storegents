import { getFulfillments, getWebordersWithDetails } from '../../../lib/srs-weborders-message-client.js';
import { listBranches, getStoreNameByBranchId } from '../../../lib/branch-metrics.js';
import { addOrderCancellation } from '../../../lib/order-cancellation-store.js';
import { corsJson, requireAdmin } from '../../../lib/request-guards.js';

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'ja'].includes(String(value).toLowerCase());
}

function cleanStatus(value) {
  return String(value || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isCancellationStatus(value) {
  const status = cleanStatus(value);
  return [
    'unavailable',
    'niet leverbaar',
    'not available',
    'cancelled',
    'canceled',
    'geannuleerd',
    'annulled'
  ].includes(status);
}

function statusReason(value) {
  const status = cleanStatus(value);
  if (['unavailable', 'niet leverbaar', 'not available'].includes(status)) return 'Niet leverbaar volgens SRS';
  if (['cancelled', 'canceled', 'geannuleerd', 'annulled'].includes(status)) return 'Geannuleerd volgens SRS';
  return 'SRS annulering / niet leverbaar';
}

function statusListFromRequest(req) {
  const raw = String(req.query.statuses || process.env.SRS_CANCELLATION_SYNC_STATUSES || 'unavailable,cancelled,canceled').trim();
  return raw.split(/[;,]+/).map((item) => item.trim()).filter(Boolean);
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function monthFromRequest(req) {
  return /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : currentMonth();
}

function validDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function monthKeyFromDateValue(value, fallbackMonth) {
  const date = validDate(value);
  return date ? date.toISOString().slice(0, 7) : fallbackMonth;
}

function shouldSkipBecauseOfDate(value, selectedMonth) {
  const date = validDate(value);
  const minDate = validDate(process.env.SRS_CANCELLATION_SYNC_MIN_DATE || '2026-01-01');
  const maxDate = validDate(process.env.SRS_CANCELLATION_SYNC_MAX_DATE || '');

  if (date && minDate && date < minDate) return true;
  if (date && maxDate && date >= maxDate) return true;
  if (date && selectedMonth && date.toISOString().slice(0, 7) !== selectedMonth) return true;

  return false;
}

function parseNumber(value, fallback = 0) {
  const n = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

async function getDetailsForOrder(orderNr, cache) {
  const clean = String(orderNr || '').replace(/^#/, '').trim();
  if (!clean) return null;
  if (cache.has(clean)) return cache.get(clean);

  try {
    const result = await getWebordersWithDetails(clean);
    const detail = result.detailsByOrder?.get(clean) || null;
    cache.set(clean, detail);
    return detail;
  } catch (error) {
    console.warn('SRS cancellation sync: GetWebordersWithDetails failed for', clean, error.message);
    cache.set(clean, null);
    return null;
  }
}

function detailLineForFulfillment(detail, fulfillment) {
  const sku = String(fulfillment.sku || '').trim();
  const lines = Array.isArray(detail?.items) ? detail.items : [];
  return lines.find((line) => String(line.sku || '').trim() === sku) || null;
}

function branchFilterFromRequest(req) {
  const requestedStore = String(req.query.store || '').trim();
  const requestedBranchId = String(req.query.branchId || '').trim();
  const branches = listBranches().filter((branch) => branch.branchId);

  if (requestedBranchId) {
    return [{ store: getStoreNameByBranchId(requestedBranchId), branchId: requestedBranchId }];
  }

  if (requestedStore) {
    return branches.filter((branch) => branch.store === requestedStore);
  }

  return branches;
}

async function collectSrsCancellationFulfillments(req) {
  const statuses = statusListFromRequest(req);
  const maxBranches = Math.max(1, Number(process.env.SRS_CANCELLATION_SYNC_MAX_BRANCHES || 30));
  const branches = branchFilterFromRequest(req).slice(0, maxBranches);
  const errors = [];
  const found = [];

  for (const branch of branches) {
    for (const status of statuses) {
      try {
        const result = await getFulfillments({ branchId: branch.branchId, status });
        const rows = (result.fulfillments || []).filter((item) => isCancellationStatus(item.status || status));
        rows.forEach((item) => found.push({ ...item, requestedStatus: status, branch }));
      } catch (error) {
        errors.push({ store: branch.store, branchId: branch.branchId, status, message: error.message });
      }
    }
  }

  const deduped = Array.from(new Map(found.map((item) => [
    item.fulfillmentId || `${item.orderNr}-${item.sku}-${item.branch?.branchId}-${item.status || item.requestedStatus}`,
    item
  ])).values());

  return { fulfillments: deduped, errors, statuses, branchesScanned: branches.length };
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;

  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ success: false, message: 'Alleen GET of POST is toegestaan.' });
  }

  if (!requireAdmin(req, res)) return;

  const syncEnabled = boolEnv('SRS_CANCELLATION_SYNC_ENABLED', true);
  if (!syncEnabled) {
    return res.status(200).json({
      success: true,
      disabled: true,
      message: 'SRS annuleringen synchroniseren staat uit via SRS_CANCELLATION_SYNC_ENABLED=false.',
      created: 0,
      duplicates: 0,
      scanned: 0,
      errors: []
    });
  }

  try {
    const month = monthFromRequest(req);
    const dryRun = String(req.query.dryRun || '').toLowerCase() === 'true';
    const detailsCache = new Map();
    const { fulfillments, errors, statuses, branchesScanned } = await collectSrsCancellationFulfillments(req);

    let created = 0;
    let duplicates = 0;
    let skippedByDate = 0;
    const records = [];

    for (const fulfillment of fulfillments) {
      const orderNr = String(fulfillment.orderNr || '').replace(/^#/, '').trim();
      const store = fulfillment.branch?.store || fulfillment.fulfilmentStore || fulfillment.fulfillmentStore || getStoreNameByBranchId(fulfillment.branch?.branchId || fulfillment.branchId || fulfillment.fulfilmentBranchId);
      const detail = await getDetailsForOrder(orderNr, detailsCache);
      const line = detailLineForFulfillment(detail, fulfillment);
      const quantity = parseNumber(line?.pieces || fulfillment.quantity || fulfillment.pieces, 1);
      const unitAmount = parseNumber(line?.price || fulfillment.productPrice || fulfillment.price, 0);
      const amount = Math.max(0, quantity * unitAmount);
      const status = fulfillment.status || fulfillment.requestedStatus || 'unavailable';
      const reason = statusReason(status);
      const srsDate = fulfillment.updatedAt || fulfillment.createdAt || fulfillment.date || fulfillment.orderDate || '';

      if (shouldSkipBecauseOfDate(srsDate, month)) {
        skippedByDate += 1;
        continue;
      }

      const payload = {
        idempotencyKey: [
          'srs-sync',
          String(store || '').toLowerCase().trim(),
          orderNr,
          fulfillment.fulfillmentId || '',
          line?.orderLineNr || fulfillment.orderLineNr || '',
          fulfillment.sku || '',
          cleanStatus(status)
        ].join('::'),
        createdAt: srsDate || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        month: monthKeyFromDateValue(srsDate, month),
        store,
        employeeName: 'SRS automatische synchronisatie',
        orderNr,
        type: 'partial',
        reason,
        customerEmail: detail?.customerEmail || '',
        customerName: detail?.customerName || fulfillment.customerName || '',
        amount,
        currency: 'EUR',
        items: [
          {
            fulfillmentId: fulfillment.fulfillmentId || '',
            orderLineNr: line?.orderLineNr || fulfillment.orderLineNr || '',
            sku: fulfillment.sku || '',
            title: fulfillment.productName || line?.sku || fulfillment.sku || '',
            quantity,
            amount,
            srsStatus: status,
            branchId: fulfillment.branch?.branchId || fulfillment.branchId || fulfillment.fulfilmentBranchId || ''
          }
        ],
        status: 'completed',
        srsStatus: cleanStatus(status).includes('cancel') || cleanStatus(status).includes('geannuleerd') ? 'cancelled_in_srs' : 'unavailable_in_srs',
        refundStatus: 'pending',
        mailStatus: 'pending',
        srsResult: {
          source: 'srs_get_fulfillments_sync',
          detectedStatus: status,
          fulfillmentId: fulfillment.fulfillmentId || '',
          branchId: fulfillment.branch?.branchId || fulfillment.branchId || fulfillment.fulfilmentBranchId || '',
          syncedAt: new Date().toISOString()
        }
      };

      records.push(payload);
      if (!dryRun) {
        const result = await addOrderCancellation(payload);
        if (result.duplicate) duplicates += 1;
        else created += 1;
      }
    }

    return res.status(200).json({
      success: true,
      dryRun,
      month,
      source: 'srs_get_fulfillments',
      statuses,
      branchesScanned,
      scanned: fulfillments.length,
      created: dryRun ? 0 : created,
      duplicates: dryRun ? 0 : duplicates,
      skippedByDate,
      preview: dryRun ? records.slice(0, 50) : [],
      errors,
      message: dryRun
        ? `Dry-run klaar. ${records.length} SRS annulering(en)/niet-leverbaar regel(s) gevonden. ${skippedByDate} buiten maand/datumbereik overgeslagen.`
        : `Synchronisatie klaar. ${created} nieuw, ${duplicates} al bekend, ${skippedByDate} buiten maand/datumbereik overgeslagen.`
    });
  } catch (error) {
    console.error('SRS cancellation sync error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'SRS annuleringen konden niet worden gesynchroniseerd.'
    });
  }
}
