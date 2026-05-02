import { getOrderCancellations, summarizeCancellationsByStore } from '../../../lib/order-cancellation-store.js';
import { syncSrsCancellationsForBranch } from '../../../lib/srs-cancellation-sync-service.js';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
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
  return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) };
}

function rowDate(row) { return validDate(row.createdAt || row.date || row.cancelledAt || row.updatedAt); }
function cleanStatus(value) { return String(value || '').toLowerCase().replace(/[_-]+/g, ' ').trim(); }
function isUnavailable(row) { const s = cleanStatus(row.srsLineStatus || row.srsStatus || row.status || row.reason); return s.includes('unavailable') || s.includes('niet leverbaar') || s.includes('not available'); }
function isCancelled(row) { const s = cleanStatus(row.srsLineStatus || row.srsStatus || row.status || row.reason); return s.includes('cancelled') || s.includes('canceled') || s.includes('geannuleerd'); }

function filterRows(rows, req) {
  const range = currentMonthRange();
  const from = validDate(req.query.dateFrom || req.query.from) || range.from;
  const toInput = validDate(req.query.dateTo || req.query.to);
  const to = toInput ? new Date(toInput.getFullYear(), toInput.getMonth(), toInput.getDate() + 1) : range.to;
  const store = String(req.query.store || '').trim();
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
  const srsLineStatus = row.srsLineStatus || firstItem.srsStatus || row.srsStatus || '';
  return {
    ...row,
    fulfillmentId: row.fulfillmentId || firstItem.fulfillmentId || '',
    orderLineNr: row.orderLineNr || firstItem.orderLineNr || '',
    articleNumber: row.articleNumber || firstItem.articleNumber || firstItem.sku || '',
    sku: row.sku || firstItem.sku || '',
    barcode: row.barcode || firstItem.barcode || '',
    size: row.size || firstItem.size || '',
    quantity: row.quantity || firstItem.quantity || 1,
    branchId: row.branchId || firstItem.branchId || '',
    srsLineStatus,
    amount: row.amount || firstItem.amount || 0,
    lineType: isUnavailable({ ...row, srsLineStatus }) ? 'niet_leverbaar' : isCancelled({ ...row, srsLineStatus }) ? 'geannuleerd' : 'annulering'
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
    const store = String(req.query.store || '').trim();
    if (syncSrs && store) {
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
    const summary = summarizeCancellationsByStore ? summarizeCancellationsByStore(rows) : [];

    return res.status(200).json({
      success: true,
      mode: 'order_lines+srs_unavailable_statuses',
      note: 'Deze rapportage telt orderregels. SRS status unavailable wordt getoond als niet leverbaar op orderregelniveau.',
      sync: syncResult,
      totals: {
        totalCancellations: rows.length,
        totalLines: rows.length,
        unavailableLines: rows.filter(isUnavailable).length,
        cancelledLines: rows.filter(isCancelled).length,
        fullCancellations: rows.filter((item) => item.type === 'full').length,
        partialCancellations: rows.filter((item) => item.type !== 'full').length,
        refundAmount: rows.reduce((sum, item) => sum + Number(item.amount || 0), 0),
        failedCount: rows.filter((item) => item.status === 'failed').length
      },
      summary,
      rows
    });
  } catch (error) {
    console.error('Order cancellation report error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Annuleringsrapportage kon niet worden opgehaald.' });
  }
}
