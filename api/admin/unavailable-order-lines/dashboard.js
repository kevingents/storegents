import { listUnavailableOrderLines } from '../../../lib/unavailable-order-line-service.js';
import { getUnavailableCronState } from '../../../lib/unavailable-cron-state-store.js';
import { listUnavailableProcessingLogs, summarizeUnavailableProcessingLogs, unavailableLineKey } from '../../../lib/unavailable-processing-log-store.js';

function clean(value) {
  return String(value || '').trim();
}

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return token === adminToken;
}

function euro(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function statusText(value) {
  return clean(value).toLowerCase();
}

function isRefunded(row = {}) {
  const status = statusText(row.refundStatus);
  return status.includes('refund') || status.includes('already');
}

function isAlreadyRefunded(row = {}) {
  return statusText(row.refundStatus).includes('already');
}

function isSrsCancelled(row = {}) {
  const status = statusText(row.srsCancelStatus || row.srsStatus);
  return status.includes('cancel');
}

function isFailed(row = {}) {
  const refundDone = isRefunded(row);
  const srsDone = isSrsCancelled(row);
  const srsFailed = statusText(row.srsCancelStatus).includes('failed') || statusText(row.srsStatus).includes('failed');
  if (refundDone && srsDone) return false;
  return Boolean(row.error) || statusText(row.status).includes('failed') || srsFailed;
}

function isRefundLog(log = {}) {
  const type = statusText(log.type);
  const refundStatus = statusText(log.refundStatus);
  return type === 'shopify_refund_created' ||
    type === 'shopify_already_refunded' ||
    refundStatus.includes('refunded') ||
    refundStatus.includes('already_refunded');
}

function isSrsSuccessLog(log = {}) {
  const type = statusText(log.type);
  const srsStatus = statusText(log.srsCancelStatus);
  return type === 'srs_cancel_success' ||
    type === 'srs_already_cancelled' ||
    srsStatus.includes('cancelled_in_srs') ||
    srsStatus.includes('cancelled');
}

function dateValue(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function inDateRange(row = {}, { dateFrom = '', dateTo = '' } = {}) {
  const from = dateValue(dateFrom);
  const to = dateValue(dateTo);
  const toExclusive = to ? new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1) : null;
  const candidates = [row.processedAt, row.updatedAt, row.createdAt, ...(row.reportLogs || []).map((log) => log.createdAt)].filter(Boolean);
  if (!from && !toExclusive) return true;
  return candidates.some((value) => {
    const d = dateValue(value);
    if (!d) return false;
    if (from && d < from) return false;
    if (toExclusive && d >= toExclusive) return false;
    return true;
  });
}

function lineKeyForRow(row = {}) {
  return clean(row.lineKey || unavailableLineKey(row)).toLowerCase();
}

function buildLogIndex(logs = []) {
  const map = new Map();
  logs.forEach((log) => {
    const keys = [
      clean(log.lineKey).toLowerCase(),
      unavailableLineKey(log).toLowerCase(),
      [clean(log.orderNr), clean(log.fulfillmentId), clean(log.orderLineNr), clean(log.sku || log.barcode)].join('::').toLowerCase()
    ].filter(Boolean);

    keys.forEach((key) => {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(log);
    });
  });
  return map;
}

function fallbackRowFromLogs(lineKey, logs = []) {
  const sorted = [...logs].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const latest = sorted[0] || {};
  const refundLog = sorted.find(isRefundLog);
  const srsLog = sorted.find(isSrsSuccessLog);
  const amountLog = sorted.find((log) => Number(log.amount || 0) > 0) || latest;
  return {
    id: latest.cancellationId || latest.id || lineKey,
    cancellationId: latest.cancellationId || '',
    lineKey,
    createdAt: latest.createdAt || '',
    updatedAt: latest.createdAt || '',
    processedAt: latest.createdAt || '',
    store: latest.store || 'Onbekend',
    lastResponsibleStore: latest.store || 'Onbekend',
    orderNr: latest.orderNr || '',
    shopifyOrderNr: latest.orderNr || '',
    weborderNr: latest.orderNr || '',
    customerName: '',
    customerEmail: '',
    title: latest.title || '',
    sku: latest.sku || latest.barcode || '',
    barcode: latest.barcode || latest.sku || '',
    quantity: 1,
    amount: euro(amountLog.amount || 0),
    refundStatus: refundLog ? (statusText(refundLog.type).includes('already') || statusText(refundLog.refundStatus).includes('already') ? 'already_refunded' : 'refunded') : latest.refundStatus || 'pending',
    srsCancelStatus: srsLog ? 'cancelled_in_srs' : latest.srsCancelStatus || 'pending',
    srsStatus: srsLog ? 'cancelled_in_srs' : latest.srsCancelStatus || 'pending',
    status: refundLog && srsLog ? 'processed' : 'open',
    error: '',
    source: 'processing_log_only',
    reportLogs: sorted
  };
}

function enrichRowsWithLogs(rows = [], logs = []) {
  const logIndex = buildLogIndex(logs);
  const usedKeys = new Set();

  const enrichedRows = rows.map((row) => {
    const key = lineKeyForRow(row);
    usedKeys.add(key);
    const rowLogs = logIndex.get(key) || [];
    const refundLog = rowLogs.find(isRefundLog);
    const srsLog = rowLogs.find(isSrsSuccessLog);
    const amountFromLog = rowLogs.find((log) => Number(log.amount || 0) > 0)?.amount;
    const patch = {};

    if (refundLog && !isRefunded(row)) {
      patch.refundStatus = statusText(refundLog.type).includes('already') || statusText(refundLog.refundStatus).includes('already')
        ? 'already_refunded'
        : 'refunded';
    }

    if (srsLog && !isSrsCancelled(row)) {
      patch.srsCancelStatus = 'cancelled_in_srs';
      patch.srsStatus = 'cancelled_in_srs';
      patch.error = '';
    }

    if (!Number(row.amount || 0) && Number(amountFromLog || 0) > 0) patch.amount = euro(amountFromLog);

    const enriched = { ...row, ...patch, lineKey: key, reportLogs: rowLogs };
    if (isRefunded(enriched) && isSrsCancelled(enriched)) {
      enriched.status = 'processed';
      enriched.error = '';
    }
    return enriched;
  });

  for (const [key, rowLogs] of logIndex.entries()) {
    if (!key || usedKeys.has(key)) continue;
    const meaningful = rowLogs.some((log) => log.orderNr || log.sku || log.barcode || Number(log.amount || 0) > 0);
    if (meaningful) enrichedRows.push(fallbackRowFromLogs(key, rowLogs));
  }

  return enrichedRows;
}

function dedupeReportRows(rows = []) {
  const map = new Map();
  rows.forEach((row) => {
    const key = lineKeyForRow(row) || [row.orderNr, row.fulfillmentId, row.orderLineNr, row.sku || row.barcode, row.id].map(clean).join('::').toLowerCase();
    const existing = map.get(key);
    if (!existing) {
      map.set(key, row);
      return;
    }
    const existingScore = Number(isRefunded(existing)) * 10 + Number(isSrsCancelled(existing)) * 10 + Number(existing.amount || 0) / 100000 + Number((existing.reportLogs || []).length);
    const rowScore = Number(isRefunded(row)) * 10 + Number(isSrsCancelled(row)) * 10 + Number(row.amount || 0) / 100000 + Number((row.reportLogs || []).length);
    if (rowScore >= existingScore) map.set(key, row);
  });
  return Array.from(map.values());
}

function filterReportRows(rows = [], { dateFrom = '', dateTo = '', store = '', query = '' } = {}) {
  const storeFilter = clean(store).toLowerCase();
  const q = clean(query).replace(/^#/, '').toLowerCase();
  return rows.filter((row) => {
    if (!inDateRange(row, { dateFrom, dateTo })) return false;
    if (storeFilter && !['all', 'alle', '*'].includes(storeFilter)) {
      const rowStore = clean(row.lastResponsibleStore || row.store).toLowerCase();
      if (rowStore !== storeFilter) return false;
    }
    if (q && !JSON.stringify(row).toLowerCase().includes(q)) return false;
    return true;
  });
}

function bucketBy(rows = [], keyFn) {
  const map = new Map();
  rows.forEach((row) => {
    const key = keyFn(row) || 'Onbekend';
    const current = map.get(key) || { key, rows: 0, amount: 0, refunded: 0, alreadyRefunded: 0, srsCancelled: 0, srsPending: 0, failed: 0 };
    current.rows += 1;
    current.amount += Number(row.amount || 0);
    if (isRefunded(row)) current.refunded += 1;
    if (isAlreadyRefunded(row)) current.alreadyRefunded += 1;
    if (isSrsCancelled(row)) current.srsCancelled += 1;
    else current.srsPending += 1;
    if (isFailed(row)) current.failed += 1;
    map.set(key, current);
  });

  return Array.from(map.values())
    .map((item) => ({ ...item, amount: euro(item.amount) }))
    .sort((a, b) => b.amount - a.amount || b.rows - a.rows);
}

function summarize(rows = []) {
  const summary = rows.reduce((acc, row) => {
    acc.totalRows += 1;
    acc.totalAmount += Number(row.amount || 0);
    if (isRefunded(row)) {
      acc.refundedRows += 1;
      acc.refundedAmount += Number(row.amount || 0);
    }
    if (isAlreadyRefunded(row)) {
      acc.alreadyRefundedRows += 1;
      acc.alreadyRefundedAmount += Number(row.amount || 0);
    }
    if (!isRefunded(row)) {
      acc.refundPendingRows += 1;
      acc.refundPendingAmount += Number(row.amount || 0);
    }
    if (isSrsCancelled(row)) acc.srsCancelledRows += 1;
    else acc.srsPendingRows += 1;
    if (isRefunded(row) && !isSrsCancelled(row)) {
      acc.refundedButSrsPendingRows += 1;
      acc.refundedButSrsPendingAmount += Number(row.amount || 0);
    }
    if (isFailed(row)) acc.failedRows += 1;
    return acc;
  }, {
    totalRows: 0,
    totalAmount: 0,
    refundedRows: 0,
    refundedAmount: 0,
    alreadyRefundedRows: 0,
    alreadyRefundedAmount: 0,
    refundPendingRows: 0,
    refundPendingAmount: 0,
    srsCancelledRows: 0,
    srsPendingRows: 0,
    refundedButSrsPendingRows: 0,
    refundedButSrsPendingAmount: 0,
    failedRows: 0
  });

  return {
    ...summary,
    totalAmount: euro(summary.totalAmount),
    refundedAmount: euro(summary.refundedAmount),
    alreadyRefundedAmount: euro(summary.alreadyRefundedAmount),
    refundPendingAmount: euro(summary.refundPendingAmount),
    refundedButSrsPendingAmount: euro(summary.refundedButSrsPendingAmount)
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-pin, authorization');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    const dateFrom = clean(req.query.dateFrom || req.query.from || '');
    const dateTo = clean(req.query.dateTo || req.query.to || '');
    const store = clean(req.query.store || '');
    const query = clean(req.query.q || req.query.query || req.query.orderNr || req.query.order || '');
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));

    const all = await listUnavailableOrderLines({ status: 'all' });
    const logs = await listUnavailableProcessingLogs({ limit: 5000 });
    const allRows = dedupeReportRows(enrichRowsWithLogs(all.rows, logs));
    const rows = filterReportRows(allRows, { dateFrom, dateTo, store, query });
    const filteredLogs = logs.filter((log) => filterReportRows([fallbackRowFromLogs(clean(log.lineKey || unavailableLineKey(log)).toLowerCase(), [log])], { dateFrom, dateTo, store, query }).length > 0);
    const open = rows.filter((row) => !isRefunded(row) || !isSrsCancelled(row) || isFailed(row));
    const processed = rows.filter((row) => isRefunded(row) && isSrsCancelled(row) && !isFailed(row));
    const failed = rows.filter(isFailed);
    const refundedButSrsPending = rows.filter((row) => isRefunded(row) && !isSrsCancelled(row));
    const cron = await getUnavailableCronState();

    return res.status(200).json({
      success: true,
      mode: 'unavailable_order_lines_dashboard',
      filters: { dateFrom, dateTo, store, query, limit },
      cron: {
        lastRunAt: cron.lastRunAt || '',
        lastSuccess: Boolean(cron.lastSuccess),
        lastMessage: cron.lastMessage || '',
        lastTotals: cron.lastTotals || null,
        recentRuns: (cron.runs || []).slice(0, 10)
      },
      summary: summarize(rows),
      openSummary: summarize(open),
      processedSummary: summarize(processed),
      failedSummary: summarize(failed),
      refundedButSrsPendingSummary: summarize(refundedButSrsPending),
      logSummary: summarizeUnavailableProcessingLogs(filteredLogs),
      byStore: bucketBy(rows, (row) => row.lastResponsibleStore || row.store),
      byArticle: bucketBy(rows, (row) => row.sku || row.barcode || row.title).slice(0, 50),
      openRows: open.slice(0, limit),
      processedRows: processed.slice(0, limit),
      failedRows: failed.slice(0, limit),
      refundedButSrsPendingRows: refundedButSrsPending.slice(0, limit),
      recentLogs: filteredLogs.slice(0, 100),
      debug: {
        allLocalRows: all.rows.length,
        allReportRows: allRows.length,
        filteredRows: rows.length,
        logs: logs.length,
        filteredLogs: filteredLogs.length
      }
    });
  } catch (error) {
    console.error('[admin/unavailable-order-lines/dashboard]', error);
    return res.status(500).json({ success: false, message: error.message || 'Dashboard kon niet worden opgehaald.' });
  }
}
