import { listUnavailableOrderLines } from '../../lib/unavailable-order-line-service.js';
import { syncSrsCancellationsForBranch } from '../../lib/srs-cancellation-sync-service.js';
import { syncGlobalUnavailableOrderLines } from '../../lib/srs-unavailable-global-sync-service.js';

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

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    let sync = null;
    const orderNr = clean(req.query.orderNr || req.query.order || req.query.orderNumber);
    const syncSrs = truthy(req.query.syncSrs);
    const syncUnavailableAll = truthy(req.query.syncUnavailableAll || req.query.globalUnavailable || req.query.allUnavailable);

    if (syncSrs && (syncUnavailableAll || orderNr)) {
      sync = await syncGlobalUnavailableOrderLines({
        orderNr,
        statuses: clean(req.query.statuses || 'unavailable'),
        dateFrom: clean(req.query.dateFrom || req.query.from || ''),
        dateTo: clean(req.query.dateTo || req.query.to || ''),
        month: clean(req.query.month || ''),
        maxRuntimeMs: Number(req.query.maxRuntimeMs || (orderNr ? 30000 : 65000)),
        maxRecords: Number(req.query.maxRecords || (orderNr ? 25 : 250)),
        dryRun: truthy(req.query.dryRun)
      });
    } else if (syncSrs) {
      const store = clean(req.query.store);
      const branchId = clean(req.query.branchId);

      if (!store && !branchId) {
        return res.status(400).json({
          success: false,
          message: 'Kies een winkel/branch of gebruik syncUnavailableAll=1 om alle SRS unavailable orderregels zonder branchfilter op te halen.'
        });
      }

      sync = await syncSrsCancellationsForBranch({
        store,
        branchId,
        month: clean(req.query.month) || undefined,
        statuses: clean(req.query.statuses || 'niet leverbaar,unavailable,not available,geannuleerd,cancelled,canceled'),
        maxRuntimeMs: Number(req.query.maxRuntimeMs || 25000),
        maxRecords: Number(req.query.maxRecords || 50),
        dryRun: false
      });
    }

    const queryParts = [
      req.query.q,
      req.query.query,
      orderNr
    ].filter(Boolean);

    const result = await listUnavailableOrderLines({
      store: req.query.store,
      status: req.query.status || 'open',
      dateFrom: req.query.dateFrom || req.query.from || '',
      dateTo: req.query.dateTo || req.query.to || '',
      query: queryParts.join(' ')
    });

    return res.status(200).json({
      success: true,
      mode: 'unavailable_order_lines_srs_cancel_workflow_global_unavailable',
      note: 'Orderregels worden per regel verwerkt. SRS gebruikt Cancel, niet Return. Shopify refund gebruikt no_restock. syncUnavailableAll=1 haalt SRS unavailable zonder branchfilter op.',
      sync,
      totals: result.totals,
      rows: result.rows
    });
  } catch (error) {
    console.error('[admin/unavailable-order-lines]', error);
    return res.status(500).json({ success: false, message: error.message || 'Niet-leverbare orderregels konden niet worden opgehaald.' });
  }
}
