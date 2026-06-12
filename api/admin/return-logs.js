import { getSrsReturnLogs, saveSrsReturnLogs } from '../../lib/srs-return-log-store.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

/**
 * GET /api/admin/return-logs
 *
 * Levert ALLE echte retour-registraties uit srs-returns/returns.json.
 * Bron: winkel-medewerker registreert retour via /api/return-refund.
 *
 * Filters (optioneel):
 *   - store      : exacte winkel match (bv. "GENTS Amsterdam")
 *   - branchId   : exacte SRS branchId match
 *   - dateFrom   : ISO datum (inclusief)
 *   - dateTo     : ISO datum (inclusief)
 *   - status     : "success" | "failed" | "all" (default: all)
 *   - limit      : default 5000
 *
 * Response:
 *   { success, totals, rows: [...], note }
 *
 * Rijen zijn al genormaliseerd naar 1-rij-per-orderregel (flatMap items),
 * zodat de admin-portal direct kan groeperen op orderregel-niveau.
 */

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
  if (!adminToken) return false;
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

function clean(value) { return String(value || '').trim(); }
function moneyNumber(value) { return Math.round(Number(value || 0) * 100) / 100; }
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

function parseDate(value) {
  if (!value) return null;
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function lineRowsFromLog(log) {
  const items = Array.isArray(log.items) && log.items.length ? log.items : [{}];

  return items.map((item, index) => ({
    /* Identificatie */
    id: [log.id, item.fulfillmentId || '', item.orderLineNr || '', item.sku || item.barcode || '', index].join('::'),
    logId: log.id,
    lineIndex: index,
    createdAt: log.createdAt || '',

    /* Wie + waar */
    store: clean(log.store),
    branchId: clean(log.branchId),
    employeeName: clean(log.employeeName),

    /* Order */
    orderNr: clean(log.orderNr).replace(/^#/, ''),
    shopifyOrderId: clean(log.shopifyOrderId),
    shopifyOrderNr: clean(log.orderNr).replace(/^#/, ''),

    /* Item */
    sku: clean(item.sku || item.barcode || ''),
    barcode: clean(item.barcode || item.sku || ''),
    articleNumber: clean(item.articleNumber || item.artikelnummer || item.sku || ''),
    title: clean(item.title || item.productName || item.sku || ''),
    color: clean(item.color || item.kleur || ''),
    size: clean(item.size || item.maat || ''),
    quantity: Number(item.quantity || item.pieces || 1),
    amount: moneyNumber(item.amount || item.price || 0),
    fulfillmentId: clean(item.fulfillmentId),
    orderLineNr: clean(item.orderLineNr),

    /* Retour-proces metadata */
    status: clean(log.status || (log.success ? 'success' : 'failed')),
    success: Boolean(log.success),
    srsTransactionId: clean(log.srsTransactionId),
    reasonChecked: Boolean(log.reasonChecked),
    crossSellMade: Boolean(log.crossSellMade),
    crossSellAmount: moneyNumber(log.crossSellAmount),
    reason: clean(item.reason || log.reason || ''),
    message: clean(log.message),
    error: clean(log.error),

    /* Kanaal — voor real retour-logs ALTIJD 'store' want dit is een winkelactie */
    channel: 'store',
    source: 'srs_return_log'
  }));
}

function computeTotals(rows) {
  const totals = {
    total: rows.length,
    successCount: 0,
    failedCount: 0,
    amount: 0,
    crossSellCount: 0,
    crossSellAmount: 0,
    reasonCheckedCount: 0,
    uniqueOrders: new Set(),
    uniqueCustomers: new Set(),
    uniqueStores: new Set(),
    uniqueEmployees: new Set()
  };

  for (const row of rows) {
    if (row.success) totals.successCount += 1; else totals.failedCount += 1;
    totals.amount += Number(row.amount || 0);
    if (row.crossSellMade) totals.crossSellCount += 1;
    totals.crossSellAmount += Number(row.crossSellAmount || 0);
    if (row.reasonChecked) totals.reasonCheckedCount += 1;
    if (row.orderNr) totals.uniqueOrders.add(row.orderNr);
    if (row.store) totals.uniqueStores.add(row.store);
    if (row.employeeName) totals.uniqueEmployees.add(row.employeeName);
  }

  return {
    total: totals.total,
    successCount: totals.successCount,
    failedCount: totals.failedCount,
    amount: moneyNumber(totals.amount),
    crossSellCount: totals.crossSellCount,
    crossSellAmount: moneyNumber(totals.crossSellAmount),
    crossSellRate: totals.total ? Math.round((totals.crossSellCount / totals.total) * 100) : 0,
    reasonCheckedCount: totals.reasonCheckedCount,
    reasonCheckedRate: totals.total ? Math.round((totals.reasonCheckedCount / totals.total) * 100) : 0,
    uniqueOrders: totals.uniqueOrders.size,
    uniqueStores: totals.uniqueStores.size,
    uniqueEmployees: totals.uniqueEmployees.size
  };
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  /* POST: eenmalige reparatie van false-negatives — retouren die SRS wél als
     'completed' verwerkte maar door een parse-bug als mislukt zijn gelogd
     (status bevatte de hele XML-blob i.p.v. "completed"). Idempotent. */
  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
    if (clean(body.action) !== 'repair-completed-status') {
      return res.status(400).json({ success: false, message: 'Onbekende actie.' });
    }
    try {
      const logs = await getSrsReturnLogs({ strict: true });
      let changed = 0;
      const fixed = [];
      for (const log of logs) {
        if (!log.success && /completed/i.test(String(log.status || '')) && clean(log.srsTransactionId)) {
          log.success = true;
          log.status = 'completed';
          log.message = 'Retour verwerkt in SRS.';
          log.error = '';
          log.srsCancelled = true;
          if (!log.srsCancelledAt) log.srsCancelledAt = log.createdAt || null;
          changed += 1;
          fixed.push({ orderNr: log.orderNr, srsTransactionId: log.srsTransactionId });
        }
      }
      if (changed) await saveSrsReturnLogs(logs);
      return res.status(200).json({ success: true, changed, total: logs.length, fixed });
    } catch (error) {
      console.error('[admin/return-logs repair]', error);
      return res.status(500).json({ success: false, message: error.message || 'Reparatie mislukt.' });
    }
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET of POST.' });
  }

  try {
    const allLogs = await getSrsReturnLogs();
    /* Strikte filter: alleen records met BEWIJS van een uitgevoerde refund.
       Een record telt als 'echte retour' als minstens ÉÉN van:
         - shopifyRefundId aanwezig → Shopify gaf een refund-ID terug
         - success === true expliciet gezet
         - srsTransactionId aanwezig → SRS GetReturn slaagde

       Records waar alleen 'orderNr' is ingevuld (zonder bewijs van refund)
       zijn pseudo-records: een medewerker startte een retour-flow maar
       voltooide hem nooit. Tonen ze in 't overzicht geeft misleidende
       cijfers — Shopify zegt zelf ook 'niks terugbetaald'.

       Override met ?includeAll=1 voor diagnose. */
    const includeAll = String(req.query.includeAll || req.query.includeOrphans || '') === '1';

    const hasRefundProof = (l) => {
      if (clean(l.shopifyRefundId)) return true;
      if (l.success === true) return true;
      if (clean(l.srsTransactionId)) return true;
      return false;
    };

    const realReturns = allLogs.filter(hasRefundProof);
    const pseudoRecords = allLogs.filter((l) => !hasRefundProof(l));

    const logs = includeAll ? allLogs : realReturns;
    const filterStats = {
      totalLogs: allLogs.length,
      realReturns: realReturns.length,
      pseudoRecords: pseudoRecords.length,
      shown: logs.length,
      note: pseudoRecords.length > 0
        ? `${pseudoRecords.length} record(s) verborgen omdat ze geen Shopify-refund of SRS-transaction bewijs hebben.`
        : null
    };
    let rows = (Array.isArray(logs) ? logs : []).flatMap(lineRowsFromLog);

    /* Filters */
    const storeFilter = clean(req.query.store);
    if (storeFilter && !['all', 'alle', '*'].includes(storeFilter.toLowerCase())) {
      rows = rows.filter((r) => r.store === storeFilter);
    }

    const branchFilter = clean(req.query.branchId);
    if (branchFilter) rows = rows.filter((r) => r.branchId === branchFilter);

    const statusFilter = clean(req.query.status).toLowerCase();
    if (statusFilter === 'success') rows = rows.filter((r) => r.success);
    if (statusFilter === 'failed') rows = rows.filter((r) => !r.success);

    const from = parseDate(req.query.dateFrom || req.query.from);
    const to = parseDate(req.query.dateTo || req.query.to);
    if (from) rows = rows.filter((r) => { const d = parseDate(r.createdAt); return !d || d >= from; });
    if (to) {
      const toExc = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
      rows = rows.filter((r) => { const d = parseDate(r.createdAt); return !d || d < toExc; });
    }

    /* Sort: newest first */
    rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    const limit = Math.max(1, Math.min(20000, Number(req.query.limit || 5000)));
    if (rows.length > limit) rows = rows.slice(0, limit);

    return res.status(200).json({
      success: true,
      mode: 'srs_return_logs',
      note: 'Bron: srs-returns/returns.json. Bevat ALLEEN winkel-verwerkte retouren (via /api/return-refund). Online retouren via Sendcloud/Shopify komen uit een aparte stream.',
      totals: computeTotals(rows),
      filterStats,
      rows
    });
  } catch (error) {
    console.error('[admin/return-logs]', error);
    return res.status(500).json({ success: false, message: error.message || 'Retour-logs konden niet worden opgehaald.' });
  }
}
