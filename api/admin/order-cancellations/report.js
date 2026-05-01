import { getOrderCancellations, filterCancellationsByMonth, summarizeCancellationsByStore, cancellationLineRows, monthKeyFromInput } from '../../../lib/order-cancellation-store.js';
import { corsJson, requireAdmin, requireGet } from '../../../lib/request-guards.js';

function isIsoDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')); }
function inDateRange(row, from, to) {
  const date = String(row.createdAt || '').slice(0, 10);
  if (from && isIsoDate(from) && date < from) return false;
  if (to && isIsoDate(to) && date > to) return false;
  return true;
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireGet(req, res)) return;
  if (!requireAdmin(req, res)) return;
  try {
    const month = monthKeyFromInput(req.query.month);
    const store = String(req.query.store || '').trim();
    const from = String(req.query.from || req.query.dateFrom || '').trim();
    const to = String(req.query.to || req.query.dateTo || '').trim();
    const all = await getOrderCancellations();
    const monthRows = filterCancellationsByMonth(all, month);
    const storeRows = store ? monthRows.filter((item) => String(item.store || '').trim() === store) : monthRows;
    const cancellations = storeRows.filter((item) => inDateRange(item, from, to));
    const rows = cancellationLineRows(cancellations);
    const summary = summarizeCancellationsByStore(cancellations);
    const uniqueOrders = new Set(rows.map((item) => item.orderNr).filter(Boolean));
    return res.status(200).json({
      success: true, month, store: store || '', from, to, mode: 'order_lines',
      note: 'Rapportage telt SRS orderregels/leveropdrachten. Een order met meerdere niet-leverbare regels telt dus meerdere regels.',
      totals: { totalCancellations: rows.length, totalOrderLines: rows.length, uniqueOrderCount: uniqueOrders.size, fullCancellations: rows.filter((item) => item.type === 'full').length, partialCancellations: rows.filter((item) => item.type !== 'full').length, itemCount: rows.reduce((sum, item) => sum + Number(item.quantity || 1), 0), refundAmount: rows.reduce((sum, item) => sum + Number(item.amount || 0), 0), failedCount: rows.filter((item) => item.status === 'failed').length },
      summary,
      rows,
      exportRows: rows.map((row) => ({ Datum: row.createdAt, Winkel: row.store, Order: row.orderNr, Leveropdracht: row.fulfillmentId, Orderregel: row.orderLineNr, Artikel: row.articleNumber || row.sku, Barcode: row.barcode, Maat: row.size, Aantal: row.quantity, Status: row.srsLineStatus || row.srsStatus, Reden: row.reason, Bedrag: row.amount }))
    });
  } catch (error) {
    console.error('Order cancellation report error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Annuleringsrapportage kon niet worden opgehaald.' });
  }
}
