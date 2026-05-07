import { listUnavailableOrderLines } from '../../../lib/unavailable-order-line-service.js';
import { getUnavailableCronState } from '../../../lib/unavailable-cron-state-store.js';

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

function isSrsCancelled(row = {}) {
  const status = statusText(row.srsCancelStatus || row.srsStatus);
  return status.includes('cancel');
}

function isFailed(row = {}) {
  return Boolean(row.error) || statusText(row.status).includes('failed');
}

function bucketBy(rows = [], keyFn) {
  const map = new Map();
  rows.forEach((row) => {
    const key = keyFn(row) || 'Onbekend';
    const current = map.get(key) || { key, rows: 0, amount: 0, refunded: 0, srsCancelled: 0, failed: 0 };
    current.rows += 1;
    current.amount += Number(row.amount || 0);
    if (isRefunded(row)) current.refunded += 1;
    if (isSrsCancelled(row)) current.srsCancelled += 1;
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
    if (!isRefunded(row)) {
      acc.refundPendingRows += 1;
      acc.refundPendingAmount += Number(row.amount || 0);
    }
    if (isSrsCancelled(row)) acc.srsCancelledRows += 1;
    else acc.srsPendingRows += 1;
    if (isFailed(row)) acc.failedRows += 1;
    return acc;
  }, {
    totalRows: 0,
    totalAmount: 0,
    refundedRows: 0,
    refundedAmount: 0,
    refundPendingRows: 0,
    refundPendingAmount: 0,
    srsCancelledRows: 0,
    srsPendingRows: 0,
    failedRows: 0
  });

  return {
    ...summary,
    totalAmount: euro(summary.totalAmount),
    refundedAmount: euro(summary.refundedAmount),
    refundPendingAmount: euro(summary.refundPendingAmount)
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

    const all = await listUnavailableOrderLines({ status: 'all', dateFrom, dateTo, store, query });
    const open = all.rows.filter((row) => !isRefunded(row) || !isSrsCancelled(row) || isFailed(row));
    const processed = all.rows.filter((row) => isRefunded(row) && isSrsCancelled(row) && !isFailed(row));
    const failed = all.rows.filter(isFailed);
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
      summary: summarize(all.rows),
      openSummary: summarize(open),
      processedSummary: summarize(processed),
      failedSummary: summarize(failed),
      byStore: bucketBy(all.rows, (row) => row.lastResponsibleStore || row.store),
      byArticle: bucketBy(all.rows, (row) => row.sku || row.barcode || row.title).slice(0, 50),
      openRows: open.slice(0, limit),
      processedRows: processed.slice(0, limit),
      failedRows: failed.slice(0, limit)
    });
  } catch (error) {
    console.error('[admin/unavailable-order-lines/dashboard]', error);
    return res.status(500).json({ success: false, message: error.message || 'Dashboard kon niet worden opgehaald.' });
  }
}
