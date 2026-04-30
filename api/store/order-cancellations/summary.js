import { getOrderCancellations, filterCancellationsByMonth, cancellationLineRows } from '../../../lib/order-cancellation-store.js';
import { corsJson, requireGet } from '../../../lib/request-guards.js';

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireGet(req, res)) return;

  try {
    const store = String(req.query.store || '').trim();
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : currentMonth();
    const all = await getOrderCancellations();
    const cancellations = filterCancellationsByMonth(all, month).filter((item) => !store || item.store === store);
    const rows = cancellationLineRows(cancellations);
    const uniqueOrders = new Set(rows.map((item) => item.orderNr).filter(Boolean));

    return res.status(200).json({
      success: true,
      month,
      store,
      mode: 'order_lines',
      totalCancellations: rows.length,
      totalOrderLines: rows.length,
      uniqueOrderCount: uniqueOrders.size,
      fullCancellations: rows.filter((item) => item.type === 'full').length,
      partialCancellations: rows.filter((item) => item.type !== 'full').length,
      itemCount: rows.reduce((sum, item) => sum + Number(item.quantity || 1), 0),
      failedCount: rows.filter((item) => item.status === 'failed').length,
      refundAmount: rows.reduce((sum, item) => sum + Number(item.amount || 0), 0)
    });
  } catch (error) {
    console.error('Order cancellation summary error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Annuleringen konden niet worden opgehaald.' });
  }
}
