import { getOrderCancellations, filterCancellationsByMonth, summarizeCancellationsByStore, monthKeyFromInput } from '../../../lib/order-cancellation-store.js';
import { corsJson, requireAdmin, requireGet } from '../../../lib/request-guards.js';

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireGet(req, res)) return;
  if (!requireAdmin(req, res)) return;

  try {
    const month = monthKeyFromInput(req.query.month);
    const all = await getOrderCancellations();
    const rows = filterCancellationsByMonth(all, month);
    const summary = summarizeCancellationsByStore(rows);

    return res.status(200).json({
      success: true,
      month,
      totals: {
        totalCancellations: rows.length,
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
