import { listUnavailableOrderLines } from '../../lib/unavailable-order-line-service.js';
import { syncSrsCancellationsForBranch } from '../../lib/srs-cancellation-sync-service.js';

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

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    let sync = null;

    if (['1', 'true', 'yes', 'ja'].includes(String(req.query.syncSrs || '').toLowerCase())) {
      const store = String(req.query.store || '').trim();
      const branchId = String(req.query.branchId || '').trim();

      if (!store && !branchId) {
        return res.status(400).json({ success: false, message: 'Kies een winkel of geef branchId mee voor syncSrs=1.' });
      }

      sync = await syncSrsCancellationsForBranch({
        store,
        branchId,
        month: String(req.query.month || '').trim() || undefined,
        statuses: String(req.query.statuses || 'niet leverbaar,unavailable,not available,geannuleerd,cancelled,canceled').trim(),
        maxRuntimeMs: Number(req.query.maxRuntimeMs || 25000),
        maxRecords: Number(req.query.maxRecords || 50),
        dryRun: false
      });
    }

    const result = await listUnavailableOrderLines({
      store: req.query.store,
      status: req.query.status || 'open',
      dateFrom: req.query.dateFrom || req.query.from || '',
      dateTo: req.query.dateTo || req.query.to || '',
      query: req.query.q || req.query.query || ''
    });

    return res.status(200).json({
      success: true,
      mode: 'unavailable_order_lines_srs_cancel_workflow',
      note: 'Orderregels worden per regel verwerkt. SRS gebruikt Cancel, niet Return. Shopify refund gebruikt no_restock.',
      sync,
      totals: result.totals,
      rows: result.rows
    });
  } catch (error) {
    console.error('[admin/unavailable-order-lines]', error);
    return res.status(500).json({ success: false, message: error.message || 'Niet-leverbare orderregels konden niet worden opgehaald.' });
  }
}
