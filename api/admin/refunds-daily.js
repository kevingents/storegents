import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { getSrsReturnLogs } from '../../lib/srs-return-log-store.js';
import { getUnavailableProcessingLogs } from '../../lib/unavailable-processing-log-store.js';

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
    /* Bron 1: srs-returns/returns.json — winkel-portal retouren */
    const allReturnLogs = await getSrsReturnLogs();
    const returnsInPeriod = allReturnLogs.filter((l) => {
      const dt = new Date(l.refundedAt || l.createdAt || 0);
      if (isNaN(dt.getTime())) return false;
      return dt >= from && dt <= to;
    }).filter(hasRefundProof);

    /* Bron 2: unavailable-processing-logs — niet-leverbaar refunds */
    let unavailableInPeriod = [];
    let failuresInPeriod = [];
    try {
      const allUnavailableLogs = await getUnavailableProcessingLogs();
      /* Eerst: alle logs binnen periode */
      const logsInRange = allUnavailableLogs.filter((l) => {
        const dt = new Date(l.createdAt || 0);
        if (isNaN(dt.getTime())) return false;
        return dt >= from && dt <= to;
      });
      /* Successvolle refunds */
      unavailableInPeriod = logsInRange.filter((l) => {
        if (l.success === false) return false;
        if (!(Number(l.amount || 0) > 0)) return false;
        const type = String(l.type || '').toLowerCase();
        const refundStatus = String(l.refundStatus || '').toLowerCase();
        const validRefundTypes = ['refund', 'shopify-refund', 'process', 'process-refund', 'completed'];
        return validRefundTypes.includes(type) || refundStatus === 'completed' || refundStatus === 'refunded';
      });
      /* Cron/handmatig FOUTEN — voor de "Vandaag in actie"-banner zodat
         beheerders zien wat er niet werkt. Filteren op success=false OF
         expliciete failure-types. */
      failuresInPeriod = logsInRange.filter((l) => {
        if (l.success === false) return true;
        const type = String(l.type || '').toLowerCase();
        const failureTypes = ['failed', 'error', 'srs_cancel_failed', 'process_failed', 'shopify_refund_failed'];
        return failureTypes.some(t => type.includes(t));
      });
    } catch (error) {
      console.warn('[refunds-daily] kon unavailable-logs niet laden:', error.message);
    }

    /* Aggregeer per winkel + medewerker + bron */
    const byStoreMap = new Map();
    const timeline = [];

    for (const log of returnsInPeriod) {
      const store = clean(log.store) || '(onbekend)';
      const employee = clean(log.employeeName) || '(onbekend)';
      const amount = calcRefundAmount(log);
      const time = log.refundedAt || log.createdAt;
      const orderNr = clean(log.orderNr).replace(/^#/, '');

      const storeEntry = byStoreMap.get(store) || { store, refundCount: 0, totalRefunded: 0, employees: new Map(), bySource: { return: 0, unavailable: 0 } };
      storeEntry.refundCount += 1;
      storeEntry.totalRefunded += amount;
      storeEntry.bySource.return += amount;
      const empEntry = storeEntry.employees.get(employee) || { name: employee, count: 0, amount: 0 };
      empEntry.count += 1;
      empEntry.amount += amount;
      storeEntry.employees.set(employee, empEntry);
      byStoreMap.set(store, storeEntry);

      timeline.push({
        source: 'return',
        sourceLabel: '↩ Retour (winkel)',
        time,
        store,
        employee,
        orderNr,
        amount: moneyNum(amount),
        shopifyRefundId: log.shopifyRefundId || '',
        srsTransactionId: log.srsTransactionId || '',
        customerName: clean(log.customerName),
        customerEmail: clean(log.customerEmail),
        reason: clean(log.reason)
      });
    }

    for (const log of unavailableInPeriod) {
      const store = clean(log.store) || '(onbekend)';
      const employee = clean(log.processedBy) || '(onbekend)';
      const amount = moneyNum(log.amount);
      const time = log.createdAt;
      const orderNr = clean(log.orderNr).replace(/^#/, '');

      const storeEntry = byStoreMap.get(store) || { store, refundCount: 0, totalRefunded: 0, employees: new Map(), bySource: { return: 0, unavailable: 0 } };
      storeEntry.refundCount += 1;
      storeEntry.totalRefunded += amount;
      storeEntry.bySource.unavailable += amount;
      const empEntry = storeEntry.employees.get(employee) || { name: employee, count: 0, amount: 0 };
      empEntry.count += 1;
      empEntry.amount += amount;
      storeEntry.employees.set(employee, empEntry);
      byStoreMap.set(store, storeEntry);

      timeline.push({
        source: 'unavailable',
        sourceLabel: '✕ Niet leverbaar',
        time,
        store,
        employee,
        orderNr,
        amount,
        sku: clean(log.sku),
        title: clean(log.title),
        reason: clean(log.message) || 'niet leverbaar'
      });
    }

    /* Sort: tijdlijn nieuwst eerst */
    timeline.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));

    /* By store → array gesorteerd op bedrag */
    const byStore = Array.from(byStoreMap.values())
      .map((s) => ({
        ...s,
        totalRefunded: moneyNum(s.totalRefunded),
        bySource: {
          return: moneyNum(s.bySource.return),
          unavailable: moneyNum(s.bySource.unavailable)
        },
        employees: Array.from(s.employees.values())
          .map((e) => ({ ...e, amount: moneyNum(e.amount) }))
          .sort((a, b) => b.amount - a.amount)
      }))
      .sort((a, b) => b.totalRefunded - a.totalRefunded);

    const returnTotal = moneyNum(timeline.filter((t) => t.source === 'return').reduce((s, t) => s + t.amount, 0));
    const unavailableTotal = moneyNum(timeline.filter((t) => t.source === 'unavailable').reduce((s, t) => s + t.amount, 0));

    /* Per-winkel breakdown van failures voor evt. drill-down */
    const failuresByStore = new Map();
    for (const log of failuresInPeriod) {
      const store = clean(log.store) || '(onbekend)';
      const amt = moneyNum(log.amount);
      const e = failuresByStore.get(store) || { store, count: 0, amount: 0 };
      e.count += 1;
      e.amount += amt;
      failuresByStore.set(store, e);
    }

    const totals = {
      count: timeline.length,
      amount: moneyNum(timeline.reduce((s, t) => s + t.amount, 0)),
      returnCount: returnsInPeriod.length,
      returnAmount: returnTotal,
      unavailableCount: unavailableInPeriod.length,
      unavailableAmount: unavailableTotal,
      uniqueStores: byStore.length,
      uniqueEmployees: new Set(timeline.map((t) => t.employee)).size,
      /* Failures (cron of handmatig) — voor dashboard-banner */
      failureCount: failuresInPeriod.length,
      failureAmount: moneyNum(failuresInPeriod.reduce((s, l) => s + Number(l.amount || 0), 0))
    };

    return res.status(200).json({
      success: true,
      range: { from: from.toISOString(), to: to.toISOString() },
      totals,
      byStore,
      timeline,
      failures: {
        count: failuresInPeriod.length,
        amount: totals.failureAmount,
        byStore: Array.from(failuresByStore.values())
          .map(e => ({ ...e, amount: moneyNum(e.amount) }))
          .sort((a, b) => b.amount - a.amount),
        items: failuresInPeriod.map(l => ({
          createdAt: l.createdAt,
          type: l.type,
          orderNr: clean(l.orderNr),
          store: clean(l.store),
          processedBy: clean(l.processedBy),
          amount: moneyNum(l.amount),
          refundStatus: clean(l.refundStatus),
          srsCancelStatus: clean(l.srsCancelStatus),
          message: clean(l.message)
        }))
      },
      note: 'Bronnen: srs-returns/returns.json (winkel-retouren) + unavailable-processing-logs (niet-leverbaar refunds + failures).'
    });
  } catch (error) {
    console.error('[admin/refunds-daily] error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Refund-rapport kon niet worden opgehaald.' });
  }
}
