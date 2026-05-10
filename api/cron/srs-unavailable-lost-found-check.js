import { getOrderCancellations, saveOrderCancellations } from '../../lib/order-cancellation-store.js';
import { cancellationLineRows } from '../../lib/order-cancellation-store.js';
import { getUnavailableStockSnapshot } from '../../lib/srs-stock-client.js';
import { getBranchIdByStore } from '../../lib/branch-metrics.js';
import { appendUnavailableCronRun } from '../../lib/unavailable-cron-state-store.js';

function clean(value) {
  return String(value || '').trim();
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-pin, authorization');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function isAuthorizedCron(req) {
  const expected = clean(process.env.CRON_SECRET || '');
  const adminToken = clean(process.env.ADMIN_TOKEN || '12345');
  const authHeader = clean(req.headers.authorization || '');
  const querySecret = clean(req.query.secret || '');
  const queryAdminToken = clean(req.query.adminToken || req.query.admin_token || '');
  const headerAdminToken = clean(req.headers['x-admin-token'] || req.headers['x-admin-pin'] || '');
  const userAgent = clean(req.headers['user-agent'] || '');

  if (adminToken && (queryAdminToken === adminToken || headerAdminToken === adminToken)) return true;
  if (!expected) return userAgent.includes('vercel-cron/1.0');
  return authHeader === `Bearer ${expected}` || querySecret === expected;
}

function daysAgoDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - Number(days || 0));
  return d;
}

function isUnavailableRow(row = {}) {
  const text = [row.reason, row.source, row.srsLineStatus, row.srsSourceStatus, row.srsStatus].map(clean).join(' ').toLowerCase();
  return text.includes('niet leverbaar') || text.includes('unavailable') || text.includes('not available');
}

function shouldCheck(row = {}, { since } = {}) {
  if (!isUnavailableRow(row)) return false;
  const created = new Date(row.createdAt || row.updatedAt || '');
  if (since && created && !Number.isNaN(created.getTime()) && created < since) return false;
  const sku = clean(row.barcode || row.sku);
  if (!sku) return false;
  return true;
}

function suspicionFrom({ row, snapshot, current } = {}) {
  const stockAtUnavailable = Number(snapshot?.storeStock ?? 0);
  const lostFoundAtUnavailable = Number(snapshot?.lostFoundStock ?? 0);
  const storeNow = Number(current?.storeStock ?? 0);
  const lostFoundNow = Number(current?.lostFoundStock ?? 0);
  const lostFoundDelta = lostFoundNow - lostFoundAtUnavailable;
  const storeDelta = storeNow - stockAtUnavailable;

  let status = 'no_signal';
  let level = 'low';
  let score = 0;

  if (stockAtUnavailable > 0) {
    status = 'stock_present_at_unavailable';
    level = 'medium';
    score = 50;
  }

  if (lostFoundDelta > 0) {
    status = stockAtUnavailable > 0 ? 'found_after_balance' : 'lost_found_increased_after_unavailable';
    level = 'high';
    score = Math.max(score, 80);
  }

  if (stockAtUnavailable > 0 && storeNow === 0 && lostFoundDelta > 0) {
    status = 'strong_lost_found_signal';
    level = 'very_high';
    score = 95;
  }

  if (storeDelta > 0) {
    status = 'store_stock_returned';
    level = score >= 80 ? level : 'medium';
    score = Math.max(score, 60);
  }

  return {
    status,
    level,
    score,
    stockAtUnavailable,
    lostFoundAtUnavailable,
    storeStockNow: storeNow,
    lostFoundStockNow: lostFoundNow,
    lostFoundDelta,
    storeDelta,
    amount: Number(row.amount || 0),
    quantity: Number(row.quantity || 1)
  };
}

function patchCancellation(cancellation, row, check) {
  const items = Array.isArray(cancellation.items) ? cancellation.items.map((item, index) => {
    const same = clean(item.fulfillmentId) === clean(row.fulfillmentId) ||
      (clean(item.orderLineNr) === clean(row.orderLineNr) && clean(item.sku || item.barcode) === clean(row.sku || row.barcode)) ||
      index === Number(row.lineIndex || 0);
    return same ? { ...item, lostFoundCheck: check } : item;
  }) : cancellation.items;

  return {
    ...cancellation,
    items,
    lostFoundCheck: check,
    updatedAt: new Date().toISOString()
  };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen GET of POST is toegestaan.' });
  if (!isAuthorizedCron(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const startedAt = Date.now();
  try {
    const daysBack = Number(req.query.daysBack || 60);
    const maxRecords = Math.max(1, Math.min(100, Number(req.query.maxRecords || 25)));
    const lostFoundBranchId = clean(req.query.lostFoundBranchId || process.env.SRS_LOST_FOUND_BRANCH_ID || '706');
    const dryRun = ['1', 'true', 'yes', 'ja'].includes(clean(req.query.dryRun).toLowerCase());
    const since = daysAgoDate(daysBack);

    const cancellations = await getOrderCancellations();
    const rows = cancellationLineRows(cancellations).filter((row) => shouldCheck(row, { since }));
    const selected = rows.slice(0, maxRecords);
    const results = [];
    const errors = [];
    let nextCancellations = [...cancellations];

    for (const row of selected) {
      const snapshot = row.stockSnapshot || null;
      const branchId = clean(snapshot?.branchId || row.branchId || getBranchIdByStore(row.lastResponsibleStore || row.store));
      try {
        const current = await getUnavailableStockSnapshot({
          barcode: row.barcode || row.sku,
          sku: row.sku || row.barcode,
          branchId,
          lostFoundBranchId
        });
        const signal = suspicionFrom({ row, snapshot, current });
        const check = {
          checkedAt: new Date().toISOString(),
          branchId,
          lostFoundBranchId,
          barcode: row.barcode || row.sku,
          sku: row.sku || row.barcode,
          current,
          snapshot,
          signal
        };

        results.push({
          orderNr: row.orderNr,
          store: row.lastResponsibleStore || row.store,
          sku: row.sku || row.barcode,
          amount: row.amount,
          signal
        });

        if (!dryRun) {
          nextCancellations = nextCancellations.map((item) => item.id === row.cancellationId ? patchCancellation(item, row, check) : item);
        }
      } catch (error) {
        errors.push({ orderNr: row.orderNr, sku: row.sku || row.barcode, message: error.message || String(error) });
      }
    }

    if (!dryRun && results.length) await saveOrderCancellations(nextCancellations);

    const high = results.filter((item) => ['high', 'very_high'].includes(item.signal?.level)).length;
    const medium = results.filter((item) => item.signal?.level === 'medium').length;
    const message = `Lost & Found check klaar. ${results.length} gecontroleerd, ${high} hoog signaal, ${medium} middel signaal.`;

    await appendUnavailableCronRun({
      type: 'srs_unavailable_lost_found_check',
      success: errors.length === 0,
      message,
      totals: {
        type: 'srs_unavailable_lost_found_check',
        checked: results.length,
        high,
        medium,
        errors: errors.length,
        runtimeMs: Date.now() - startedAt
      },
      errors: errors.slice(0, 25)
    });

    return res.status(errors.length ? 207 : 200).json({
      success: errors.length === 0,
      partial: errors.length > 0,
      mode: 'srs_unavailable_lost_found_check',
      dryRun,
      daysBack,
      lostFoundBranchId,
      candidates: rows.length,
      checked: results.length,
      high,
      medium,
      results,
      errors,
      message
    });
  } catch (error) {
    console.error('[cron/srs-unavailable-lost-found-check]', error);
    await appendUnavailableCronRun({ type: 'srs_unavailable_lost_found_check', success: false, message: error.message || 'Lost & Found check mislukt.' });
    return res.status(500).json({ success: false, message: error.message || 'Lost & Found check mislukt.' });
  }
}
