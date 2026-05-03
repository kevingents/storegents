import { getOrderCancellations, summarizeCancellationsByStore } from '../../../lib/order-cancellation-store.js';
import { syncSrsCancellationsForBranch } from '../../../lib/srs-cancellation-sync-service.js';
import { listBranches } from '../../../lib/branch-metrics.js';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function isAdmin(req) {
  if (String(req.query.public || '') === 'true') return true;
  if (!ADMIN_TOKEN) return true;
  const token = String(req.headers['x-admin-token'] || req.query.adminToken || '').trim();
  return token === ADMIN_TOKEN;
}

function validDate(value) {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

function currentMonthRange() {
  const now = new Date();
  return {
    from: new Date(now.getFullYear(), now.getMonth(), 1),
    to: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  };
}

function rowDate(row) {
  return validDate(row.createdAt || row.date || row.cancelledAt || row.updatedAt);
}

function cleanStatus(value) {
  return String(value || '').toLowerCase().replace(/[_-]+/g, ' ').trim();
}

function isUnavailable(row) {
  const status = cleanStatus(row.srsLineStatus || row.srsStatus || row.status || row.reason || row.srsSourceStatus);
  return status.includes('unavailable') || status.includes('niet leverbaar') || status.includes('not available');
}

function isCancelled(row) {
  const status = cleanStatus(row.srsLineStatus || row.srsStatus || row.status || row.reason || row.srsSourceStatus);
  return status.includes('cancelled') || status.includes('canceled') || status.includes('geannuleerd');
}

function isFailed(row) {
  const status = cleanStatus(row.status || row.srsStatus || row.refundStatus || row.mailStatus || row.error);
  return status.includes('failed') || status.includes('mislukt');
}

function storeFilterValue(req) {
  const value = String(req.query.store || '').trim();
  if (!value || ['all', 'alle', '*'].includes(value.toLowerCase())) return '';
  return value;
}

function filterRows(rows, req) {
  const range = currentMonthRange();
  const from = validDate(req.query.dateFrom || req.query.from) || range.from;
  const toInput = validDate(req.query.dateTo || req.query.to);
  const to = toInput ? new Date(toInput.getFullYear(), toInput.getMonth(), toInput.getDate() + 1) : range.to;
  const store = storeFilterValue(req);
  const month = String(req.query.month || '').trim();

  return rows.filter((row) => {
    if (store && row.store !== store) return false;
    if (month && /^\d{4}-\d{2}$/.test(month)) return String(row.month || '').slice(0, 7) === month;
    const d = rowDate(row);
    if (!d) return true;
    return d >= from && d < to;
  });
}

function normalizeRow(row) {
  const firstItem = Array.isArray(row.items) ? (row.items[0] || {}) : {};
  const srsLineStatus = row.srsLineStatus || firstItem.srsStatus || row.srsStatus || row.srsSourceStatus || '';
  const normalized = {
    ...row,
    fulfillmentId: row.fulfillmentId || firstItem.fulfillmentId || '',
    orderLineNr: row.orderLineNr || firstItem.orderLineNr || '',
    articleNumber: row.articleNumber || firstItem.articleNumber || firstItem.sku || firstItem.barcode || '',
    sku: row.sku || firstItem.sku || '',
    barcode: row.barcode || firstItem.barcode || firstItem.sku || '',
    title: row.title || firstItem.title || firstItem.productName || firstItem.sku || '',
    size: row.size || firstItem.size || '',
    quantity: Number(row.quantity || firstItem.quantity || 1),
    branchId: row.branchId || firstItem.branchId || '',
    srsLineStatus,
    amount: Number(row.amount || firstItem.amount || firstItem.price || 0),
    store: row.store || 'SRS zonder filiaal'
  };

  return {
    ...normalized,
    lineType: isUnavailable(normalized)
      ? 'niet_leverbaar'
      : isCancelled(normalized)
        ? 'geannuleerd'
        : 'annulering',
    impactLabel: isUnavailable(normalized)
      ? 'Voorraadverschil / niet leverbaar'
      : isCancelled(normalized)
        ? 'Geannuleerd'
        : 'Annulering'
  };
}

function buildImpactTotals(rows) {
  const unavailableRows = rows.filter(isUnavailable);
  const cancelledRows = rows.filter(isCancelled);
  const failedRows = rows.filter(isFailed);
  const withoutBranchRows = rows.filter((row) => !String(row.branchId || '').trim() || row.store === 'SRS zonder filiaal');
  const uniqueOrders = new Set(rows.map((row) => row.orderNr).filter(Boolean));

  return {
    totalCancellations: rows.length,
    totalLines: rows.length,
    uniqueOrders: uniqueOrders.size,
    unavailableLines: unavailableRows.length,
    cancelledLines: cancelledRows.length,
    failedCount: failedRows.length,
    withoutBranchLines: withoutBranchRows.length,
    unavailableAmount: unavailableRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
    cancelledAmount: cancelledRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
    lostRevenueAmount: rows.filter((row) => isUnavailable(row) || isCancelled(row)).reduce((sum, row) => sum + Number(row.amount || 0), 0),
    withoutBranchAmount: withoutBranchRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
    refundAmount: rows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
    fullCancellations: rows.filter((item) => item.type === 'full').length,
    partialCancellations: rows.filter((item) => item.type !== 'full').length
  };
}

function buildImpactSummary(rows) {
  const map = new Map();

  for (const row of rows) {
    const store = row.store || 'SRS zonder filiaal';
    const current = map.get(store) || {
      store,
      totalLines: 0,
      uniqueOrderCount: 0,
      unavailableLines: 0,
      cancelledLines: 0,
      failedLines: 0,
      withoutBranchLines: 0,
      unavailableAmount: 0,
      cancelledAmount: 0,
      lostRevenueAmount: 0,
      totalAmount: 0,
      lastAt: '',
      orderNumbers: []
    };

    current.totalLines += 1;
    current.totalAmount += Number(row.amount || 0);
    if (isUnavailable(row)) {
      current.unavailableLines += 1;
      current.unavailableAmount += Number(row.amount || 0);
      current.lostRevenueAmount += Number(row.amount || 0);
    }
    if (isCancelled(row)) {
      current.cancelledLines += 1;
      current.cancelledAmount += Number(row.amount || 0);
      current.lostRevenueAmount += Number(row.amount || 0);
    }
    if (isFailed(row)) current.failedLines += 1;
    if (!String(row.branchId || '').trim() || store === 'SRS zonder filiaal') current.withoutBranchLines += 1;
    if (row.orderNr && !current.orderNumbers.includes(row.orderNr)) current.orderNumbers.push(row.orderNr);
    current.uniqueOrderCount = current.orderNumbers.length;
    if (!current.lastAt || String(row.updatedAt || row.createdAt || '') > current.lastAt) current.lastAt = row.updatedAt || row.createdAt || '';

    map.set(store, current);
  }

  return Array.from(map.values())
    .map((row) => ({ ...row, orderNumbers: undefined }))
    .sort((a, b) => b.lostRevenueAmount - a.lostRevenueAmount || b.unavailableLines - a.unavailableLines || a.store.localeCompare(b.store, 'nl'));
}

async function syncAllStores({ month, maxRuntimeMs, maxRecords }) {
  const branches = listBranches().filter((branch) => branch.store && branch.branchId);
  const startedAt = Date.now();
  const results = [];
  const errors = [];

  for (const branch of branches) {
    if (Date.now() - startedAt > maxRuntimeMs) {
      errors.push({ store: branch.store, message: 'Max runtime bereikt; sync gedeeltelijk uitgevoerd.' });
      break;
    }

    try {
      const result = await syncSrsCancellationsForBranch({
        store: branch.store,
        month: month || undefined,
        dryRun: false,
        maxRuntimeMs: Math.min(12000, Math.max(4000, maxRuntimeMs - (Date.now() - startedAt))),
        maxRecords
      });
      results.push(result);
    } catch (error) {
      errors.push({ store: branch.store, branchId: branch.branchId, message: error.message || 'Sync mislukt.' });
    }
  }

  return {
    success: errors.length === 0,
    branchesScanned: results.length,
    found: results.reduce((sum, item) => sum + Number(item.found || 0), 0),
    created: results.reduce((sum, item) => sum + Number(item.created || 0), 0),
    duplicates: results.reduce((sum, item) => sum + Number(item.duplicates || 0), 0),
    partial: errors.length > 0,
    results,
    errors
  };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (!isAdmin(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    let syncResult = null;
    const syncSrs = String(req.query.syncSrs || '') === 'true';
    const syncAll = ['true', '1', 'yes', 'ja'].includes(String(req.query.syncAll || '').toLowerCase());
    const store = storeFilterValue(req);

    if (syncSrs && syncAll) {
      syncResult = await syncAllStores({
        month: String(req.query.month || '').trim(),
        maxRuntimeMs: Number(req.query.maxRuntimeMs || 45000),
        maxRecords: Number(req.query.maxRecords || 50)
      });
    } else if (syncSrs && store) {
      syncResult = await syncSrsCancellationsForBranch({
        store,
        month: String(req.query.month || '').trim() || undefined,
        dryRun: false,
        maxRuntimeMs: Number(req.query.maxRuntimeMs || 22000),
        maxRecords: Number(req.query.maxRecords || 50)
      });
    }

    const all = await getOrderCancellations();
    const rows = filterRows(all, req).map(normalizeRow);
    const summary = buildImpactSummary(rows);

    return res.status(200).json({
      success: true,
      mode: 'all_stores_order_lines+srs_unavailable_statuses+impact_amounts',
      note: 'Deze rapportage telt orderregels. SRS status unavailable wordt getoond als niet leverbaar en telt als gemiste omzet/voorraadimpact.',
      sync: syncResult,
      totals: buildImpactTotals(rows),
      summary,
      legacySummary: summarizeCancellationsByStore ? summarizeCancellationsByStore(rows) : [],
      rows
    });
  } catch (error) {
    console.error('Order cancellation report error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Annuleringsrapportage kon niet worden opgehaald.' });
  }
}
