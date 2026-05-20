import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { getSrsReturnLogs } from '../../lib/srs-return-log-store.js';

/**
 * GET /api/admin/refunds-daily?date=YYYY-MM-DD
 *
 * Aggregaat van wat er op een specifieke dag is TERUGGESTORT (refunds
 * via portal). Bron: srs-returns/returns.json (winkel-retour-logs).
 *
 * Per response:
 *   - byStore: [{ store, refundCount, totalRefunded, employees: [{name, count, amount}] }]
 *   - timeline: [{ time, store, employee, orderNr, amount, refundedAt }]
 *   - totals: { count, amount, uniqueStores, uniqueEmployees }
 *
 * Filter: alleen records met BEWIJS van uitgevoerde refund
 *   (shopifyRefundId aanwezig OF success=true OF srsTransactionId).
 *
 * Query:
 *   ?date=2026-05-20    → 1 dag (default vandaag)
 *   ?dateFrom + dateTo  → custom range
 */

function clean(v) { return String(v || '').trim(); }
function moneyNum(v) { return Math.round(Number(v || 0) * 100) / 100; }

function hasRefundProof(l) {
  if (clean(l.shopifyRefundId)) return true;
  if (l.success === true) return true;
  if (clean(l.srsTransactionId)) return true;
  return false;
}

function calcRefundAmount(log) {
  if (log.refundAmount && Number(log.refundAmount) > 0) return moneyNum(log.refundAmount);
  const items = Array.isArray(log.items) ? log.items : [];
  return moneyNum(items.reduce((s, it) => s + (Number(it.amount || it.price || 0) * Number(it.quantity || it.pieces || 1)), 0));
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (requireAdmin(req, res)) return;

  /* Date range */
  const date = clean(req.query.date);
  let from, to;
  if (date) {
    from = new Date(`${date}T00:00:00`);
    to = new Date(`${date}T23:59:59.999`);
  } else if (req.query.dateFrom) {
    from = new Date(`${clean(req.query.dateFrom)}T00:00:00`);
    to = clean(req.query.dateTo) ? new Date(`${clean(req.query.dateTo)}T23:59:59.999`) : new Date();
  } else {
    /* Default: vandaag */
    from = new Date(); from.setHours(0, 0, 0, 0);
    to = new Date(); to.setHours(23, 59, 59, 999);
  }

  try {
    const allLogs = await getSrsReturnLogs();
    /* Filter: in periode + heeft refund-bewijs */
    const inPeriod = allLogs.filter((l) => {
      const dt = new Date(l.refundedAt || l.createdAt || 0);
      if (isNaN(dt.getTime())) return false;
      return dt >= from && dt <= to;
    }).filter(hasRefundProof);

    /* Aggregeer per winkel + medewerker */
    const byStoreMap = new Map();
    const timeline = [];

    for (const log of inPeriod) {
      const store = clean(log.store) || '(onbekend)';
      const employee = clean(log.employeeName) || '(onbekend)';
      const amount = calcRefundAmount(log);
      const time = log.refundedAt || log.createdAt;
      const orderNr = clean(log.orderNr).replace(/^#/, '');

      /* By store */
      const storeEntry = byStoreMap.get(store) || {
        store,
        refundCount: 0,
        totalRefunded: 0,
        employees: new Map()
      };
      storeEntry.refundCount += 1;
      storeEntry.totalRefunded += amount;
      const empEntry = storeEntry.employees.get(employee) || { name: employee, count: 0, amount: 0 };
      empEntry.count += 1;
      empEntry.amount += amount;
      storeEntry.employees.set(employee, empEntry);
      byStoreMap.set(store, storeEntry);

      /* Timeline */
      timeline.push({
        time,
        store,
        employee,
        orderNr,
        amount: moneyNum(amount),
        refundedAt: log.refundedAt || null,
        shopifyRefundId: log.shopifyRefundId || '',
        srsTransactionId: log.srsTransactionId || '',
        customerName: clean(log.customerName),
        customerEmail: clean(log.customerEmail),
        reason: clean(log.reason)
      });
    }

    /* Sort: tijdlijn nieuwst eerst */
    timeline.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));

    /* By store → array gesorteerd op bedrag */
    const byStore = Array.from(byStoreMap.values())
      .map((s) => ({
        ...s,
        totalRefunded: moneyNum(s.totalRefunded),
        employees: Array.from(s.employees.values())
          .map((e) => ({ ...e, amount: moneyNum(e.amount) }))
          .sort((a, b) => b.amount - a.amount)
      }))
      .sort((a, b) => b.totalRefunded - a.totalRefunded);

    const totals = {
      count: timeline.length,
      amount: moneyNum(timeline.reduce((s, t) => s + t.amount, 0)),
      uniqueStores: byStore.length,
      uniqueEmployees: new Set(timeline.map((t) => t.employee)).size
    };

    return res.status(200).json({
      success: true,
      range: { from: from.toISOString(), to: to.toISOString() },
      totals,
      byStore,
      timeline,
      note: 'Bron: srs-returns/returns.json — winkel-portal retouren met bewijs van uitgevoerde refund (Shopify refund ID, SRS transaction ID, of success=true).'
    });
  } catch (error) {
    console.error('[admin/refunds-daily] error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Refund-rapport kon niet worden opgehaald.' });
  }
}
