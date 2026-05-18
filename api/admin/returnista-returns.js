import { getReturnRequests, normalizeReturnRequest } from '../../lib/returnista-client.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

/**
 * GET /api/admin/returnista-returns
 *
 * Haalt online retouren op via Returnista API.
 * Bron: https://core.returnista.com/api/v0/account/{accountId}/return-requests
 *
 * Filters:
 *   - dateFrom : ISO datum (default: 90 dagen terug)
 *   - dateTo   : ISO datum (optioneel)
 *   - maxRecords : max records op te halen (default 2000)
 *
 * Cache: 10 min in-memory om Returnista API niet onnodig te belasten.
 */

const CACHE_TTL_MS = 10 * 60 * 1000;
let CACHE = { ts: 0, key: '', rows: [], meta: {} };

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

function clean(value) { return String(value || '').trim(); }

function computeTotals(rows) {
  const totals = {
    total: rows.length,
    amount: 0,
    refundCount: 0,
    storeCreditCount: 0,
    repairCount: 0,
    replacementCount: 0,
    otherCount: 0,
    uniqueOrders: new Set(),
    statusBreakdown: {}
  };
  for (const r of rows) {
    totals.amount += Number(r.amount || 0);
    if (r.purchaseOrderNumber) totals.uniqueOrders.add(r.purchaseOrderNumber);
    const res = String(r.resolution || r.requestedResolution || '').toLowerCase();
    if (res === 'refund') totals.refundCount++;
    else if (res === 'storecredit' || res === 'store_credit') totals.storeCreditCount++;
    else if (res === 'repair') totals.repairCount++;
    else if (res === 'replacement') totals.replacementCount++;
    else totals.otherCount++;
    const st = String(r.status || 'unknown');
    totals.statusBreakdown[st] = (totals.statusBreakdown[st] || 0) + 1;
  }
  return {
    total: totals.total,
    amount: Math.round(totals.amount * 100) / 100,
    refundCount: totals.refundCount,
    storeCreditCount: totals.storeCreditCount,
    repairCount: totals.repairCount,
    replacementCount: totals.replacementCount,
    otherCount: totals.otherCount,
    uniqueOrders: totals.uniqueOrders.size,
    statusBreakdown: totals.statusBreakdown
  };
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const dateFrom = clean(req.query.dateFrom || req.query.from);
  const dateTo = clean(req.query.dateTo || req.query.to);
  const maxRecords = Math.max(10, Math.min(5000, Number(req.query.maxRecords || 2000)));
  const forceRefresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());

  const cacheKey = `${dateFrom}::${dateTo}::${maxRecords}`;

  if (!forceRefresh && CACHE.key === cacheKey && (Date.now() - CACHE.ts) < CACHE_TTL_MS) {
    return res.status(200).json({
      success: true,
      mode: 'returnista_return_requests',
      cached: true,
      cacheAge: Math.round((Date.now() - CACHE.ts) / 1000),
      ...CACHE.meta,
      rows: CACHE.rows
    });
  }

  try {
    const records = await getReturnRequests({
      createdFrom: dateFrom || undefined,
      createdTo: dateTo || undefined,
      maxRecords
    });

    const rows = records.map(normalizeReturnRequest);
    const totals = computeTotals(rows);
    const meta = {
      dateFrom: dateFrom || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      dateTo: dateTo || null,
      fetched: rows.length,
      totals,
      note: 'Bron: Returnista return-requests (online retouren). Pakket arriveert bij magazijn voor fysieke verwerking.'
    };

    CACHE = { ts: Date.now(), key: cacheKey, rows, meta };

    return res.status(200).json({
      success: true,
      mode: 'returnista_return_requests',
      cached: false,
      ...meta,
      rows
    });
  } catch (error) {
    console.error('[admin/returnista-returns]', error);
    /* Belangrijk: success: TRUE met configured-flag zodat frontend niet error-throwt
       maar duidelijk de status kan tonen in een banner */
    const msg = String(error.message || 'Returnista API call mislukt.');
    const isConfigError = msg.includes('ontbreekt in Vercel');
    return res.status(200).json({
      success: true,
      configured: !isConfigError,
      mode: 'returnista_return_requests',
      error: msg,
      message: isConfigError
        ? msg + ' Zet RETURNISTA_API_TOKEN en RETURNISTA_ACCOUNT_ID in Vercel env vars.'
        : `Returnista API fout: ${msg}`,
      rows: [],
      totals: { total: 0, amount: 0 }
    });
  }
}
