import { listUnavailableOrderLines } from '../../lib/unavailable-order-line-service.js';
import { syncSrsCancellationsForBranch } from '../../lib/srs-cancellation-sync-service.js';
import { syncGlobalUnavailableOrderLines } from '../../lib/srs-unavailable-global-sync-service.js';
import { getSrsReturnLogs } from '../../lib/srs-return-log-store.js';

/**
 * Bouw een map van orderNr (canonical) -> { refundedAt, srsCancelledAt } uit
 * de return-logs zodat we niet-leverbaar regels kunnen markeren als afgerond
 * wanneer de winkel het al via "Retour & terugbetaling" heeft afgehandeld.
 */
async function buildReturnLogMatchMap() {
  try {
    const logs = await getSrsReturnLogs();
    const map = new Map();
    for (const log of Array.isArray(logs) ? logs : []) {
      const key = String(log.orderNr || '').replace(/^#+/, '').trim().toLowerCase();
      if (!key) continue;
      const existing = map.get(key) || { refundedAt: '', srsCancelledAt: '' };
      if (log.shopifyRefunded && log.refundedAt && !existing.refundedAt) existing.refundedAt = log.refundedAt;
      if (log.srsCancelled && log.srsCancelledAt && !existing.srsCancelledAt) existing.srsCancelledAt = log.srsCancelledAt;
      map.set(key, existing);
    }
    return map;
  } catch (error) {
    console.warn('[unavailable-order-lines] return-log lookup failed:', error.message);
    return new Map();
  }
}

const DEFAULT_UNAVAILABLE_STATUSES = 'unavailable,niet leverbaar,not available';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-pin, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
  if (!adminToken) return true;
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

function truthy(value) {
  return ['1', 'true', 'yes', 'ja'].includes(String(value || '').toLowerCase());
}

function clean(value) {
  return String(value || '').trim();
}

function normalizeStatus(value) {
  return clean(value).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function unavailableStatusesOnly(value) {
  return clean(value || DEFAULT_UNAVAILABLE_STATUSES)
    .split(/[;,]+/)
    .map((item) => clean(item))
    .filter((item) => {
      const status = normalizeStatus(item);
      return status.includes('unavailable') || status.includes('niet leverbaar') || status.includes('not available');
    })
    .join(',') || DEFAULT_UNAVAILABLE_STATUSES;
}

function lineRowsFromRecords(records = []) {
  return records.flatMap((record) => {
    const lines = Array.isArray(record.items) && record.items.length ? record.items : [{}];

    return lines.map((line, index) => ({
      id: [record.id, line.fulfillmentId || '', line.orderLineNr || '', line.sku || line.barcode || '', index].join('::'),
      cancellationId: record.id,
      lineIndex: index,
      idempotencyKey: record.idempotencyKey || '',
      createdAt: record.createdAt || '',
      updatedAt: record.updatedAt || '',
      month: record.month || '',
      store: clean(record.store || line.lastResponsibleStore || 'Onbekend'),
      orderNr: record.orderNr || '',
      employeeName: record.employeeName || '',
      customerName: record.customerName || '',
      customerEmail: record.customerEmail || '',
      reason: record.reason || 'Niet leverbaar',
      currency: record.currency || 'EUR',
      amount: Number(line.amount || record.amount || 0),
      quantity: Number(line.quantity || line.pieces || 1),
      fulfillmentId: clean(line.fulfillmentId),
      orderLineNr: clean(line.orderLineNr),
      articleNumber: clean(line.articleNumber || line.artikelnummer || line.sku || ''),
      articleId: clean(line.articleId || line.artikelId || ''),
      sku: clean(line.sku || line.barcode || ''),
      barcode: clean(line.barcode || line.sku || ''),
      title: clean(line.title || line.productName || line.sku || line.barcode || ''),
      color: clean(line.color || line.kleur || ''),
      size: clean(line.size || line.maat || ''),
      branchId: clean(line.branchId || record.branchId || ''),
      currentBranch: clean(line.currentBranch || line.huidigFiliaal || line.branchId || ''),
      originBranch: clean(line.originBranch || line.herkomstFiliaal || record.store || ''),
      lastResponsibleStore: clean(line.lastResponsibleStore || record.store || 'Onbekend'),
      srsUnavailableStore: clean(line.srsUnavailableStore || ''),
      srsLineStatus: clean(line.srsStatus || line.status || record.srsSourceStatus || ''),
      srsStatus: clean(record.srsStatus || line.srsStatus || record.srsSourceStatus || ''),
      srsSourceStatus: clean(record.srsSourceStatus || ''),
      source: record.source || '',
      status: record.status || 'open',
      mailStatus: record.mailStatus || 'shopify_refund_mail',
      refundStatus: record.refundStatus || 'pending',
      srsCancelStatus: record.srsCancelStatus || 'pending',
      stockReturnStatus: record.stockReturnStatus || 'skipped_no_stock_return',
      processedAt: record.processedAt || '',
      processedBy: record.processedBy || '',
      processAttempts: Number(record.processAttempts || 0),
      error: record.error || '',
      problemType: 'niet_leverbaar',
      originalCancellation: record
    }));
  });
}

function mergeRows(primary = [], fallback = []) {
  const map = new Map();

  [...fallback, ...primary].forEach((row) => {
    const key = row.id || [row.cancellationId, row.fulfillmentId, row.orderLineNr, row.sku, row.barcode].join('::');
    if (key) map.set(key, row);
  });

  return Array.from(map.values());
}

function totalsForRows(rows = []) {
  return rows.reduce((acc, row) => {
    const refund = normalizeStatus(row.refundStatus);
    const srs = normalizeStatus(row.srsCancelStatus || row.srsStatus);
    acc.total += 1;
    acc.mailPending = 0;
    if (!(refund.includes('refund') || refund.includes('already'))) acc.refundPending += 1;
    if (!srs.includes('cancel')) acc.srsCancelPending += 1;
    if (row.error || normalizeStatus(row.status).includes('failed')) acc.failed += 1;
    acc.amount += Number(row.amount || 0);
    return acc;
  }, { total: 0, mailPending: 0, refundPending: 0, srsCancelPending: 0, failed: 0, amount: 0 });
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    let sync = null;
    const orderNr = clean(req.query.orderNr || req.query.order || req.query.orderNumber);
    const syncSrs = truthy(req.query.syncSrs);
    const syncUnavailableAll = truthy(req.query.syncUnavailableAll || req.query.globalUnavailable || req.query.allUnavailable || req.query.allProblemLines);
    const statuses = unavailableStatusesOnly(req.query.statuses || DEFAULT_UNAVAILABLE_STATUSES);

    if (syncSrs && (syncUnavailableAll || orderNr)) {
      sync = await syncGlobalUnavailableOrderLines({
        orderNr,
        statuses,
        dateFrom: clean(req.query.dateFrom || req.query.from || ''),
        dateTo: clean(req.query.dateTo || req.query.to || ''),
        month: clean(req.query.month || ''),
        maxRuntimeMs: Number(req.query.maxRuntimeMs || (orderNr ? 30000 : 90000)),
        maxRecords: Number(req.query.maxRecords || (orderNr ? 25 : 500)),
        includeResolved: truthy(req.query.includeResolved),
        dryRun: truthy(req.query.dryRun)
      });
    } else if (syncSrs) {
      const store = clean(req.query.store);
      const branchId = clean(req.query.branchId);

      if (!store && !branchId) {
        return res.status(400).json({
          success: false,
          message: 'Kies een winkel/branch of gebruik syncUnavailableAll=1 om alle niet-leverbare SRS orderregels op te halen.'
        });
      }

      sync = await syncSrsCancellationsForBranch({
        store,
        branchId,
        month: clean(req.query.month) || undefined,
        statuses,
        maxRuntimeMs: Number(req.query.maxRuntimeMs || 45000),
        maxRecords: Number(req.query.maxRecords || 150),
        dryRun: false
      });
    }

    const queryParts = [req.query.q, req.query.query, orderNr].filter(Boolean);

    const result = await listUnavailableOrderLines({
      store: req.query.store,
      status: req.query.status || 'open',
      dateFrom: req.query.dateFrom || req.query.from || '',
      dateTo: req.query.dateTo || req.query.to || '',
      query: queryParts.join(' ')
    });

    const syncedRows = lineRowsFromRecords(sync?.records || []);
    let rows = mergeRows(result.rows || [], syncedRows);

    /* Cross-reference: rijen waarvan dezelfde orderNr al via "Retour &
       terugbetaling" is afgehandeld (return-log) krijgen refundedAt/
       srsCancelledAt + refundStatus='completed' zodat ze in de UI als
       "Verwerkt" worden geteld i.p.v. eeuwig open te blijven staan. */
    const returnLogMatches = await buildReturnLogMatchMap();
    if (returnLogMatches.size) {
      rows = rows.map((row) => {
        const key = String(row.orderNr || '').replace(/^#+/, '').trim().toLowerCase();
        const match = key ? returnLogMatches.get(key) : null;
        if (!match) return row;
        return {
          ...row,
          refundedAt: row.refundedAt || match.refundedAt || '',
          shopifyRefunded: Boolean(row.shopifyRefunded || match.refundedAt),
          srsCancelledAt: row.srsCancelledAt || match.srsCancelledAt || '',
          srsCancelled: Boolean(row.srsCancelled || match.srsCancelledAt),
          /* Promoot enums naar 'completed' alleen wanneer een return-log
             daadwerkelijk een refund/cancel-timestamp heeft. */
          refundStatus: match.refundedAt && row.refundStatus === 'pending'
            ? 'completed' : row.refundStatus,
          srsCancelStatus: match.srsCancelledAt && (row.srsCancelStatus === 'pending')
            ? 'completed' : row.srsCancelStatus,
          srsStatus: match.srsCancelledAt && (row.srsStatus === 'pending' || !row.srsStatus)
            ? 'completed' : row.srsStatus,
          /* Audit-spoor: laat de UI tonen dat dit via return-flow is gegaan */
          processedViaReturnFlow: true
        };
      });
    }

    return res.status(200).json({
      success: true,
      mode: 'unavailable_order_lines_only',
      note: 'Toont alleen niet-leverbare SRS orderregels. Verwerking gebruikt SRS Cancel per orderregel. Shopify refund gebruikt no_restock en laat Shopify de terugbetaalmail sturen.',
      sync,
      totals: totalsForRows(rows),
      rows
    });
  } catch (error) {
    console.error('[admin/unavailable-order-lines]', error);
    return res.status(500).json({ success: false, message: error.message || 'Niet-leverbare orderregels konden niet worden opgehaald.' });
  }
}
