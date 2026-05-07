import { listUnavailableOrderLines } from '../../lib/unavailable-order-line-service.js';
import { syncSrsCancellationsForBranch } from '../../lib/srs-cancellation-sync-service.js';
import { syncGlobalUnavailableOrderLines } from '../../lib/srs-unavailable-global-sync-service.js';

const DEFAULT_UNAVAILABLE_STATUSES = 'unavailable,niet leverbaar,not available';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-pin, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
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

function totalsForRows(rows = []) {
  return rows.reduce((acc, row) => {
    const mail = normalizeStatus(row.mailStatus);
    const refund = normalizeStatus(row.refundStatus);
    const srs = normalizeStatus(row.srsCancelStatus || row.srsStatus);
    acc.total += 1;
    if (mail !== 'sent') acc.mailPending += 1;
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

    const rows = result.rows || [];

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
