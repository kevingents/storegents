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

function hasSnapshot(snapshot = null) {
  return Boolean(snapshot && snapshot.checkedAt && (snapshot.storeStock !== null || snapshot.lostFoundStock !== null));
}

function rowKey(row = {}) {
  return [
    row.orderNr,
    row.fulfillmentId,
    row.orderLineNr,
    row.sku || row.barcode,
    row.lastResponsibleStore || row.store
  ].map((value) => clean(value).toLowerCase()).join('::');
}

function rowScore(row = {}) {
  const snapshotScore = hasSnapshot(row.stockSnapshot) ? 100 : 0;
  const checkScore = row.lostFoundCheck?.checkedAt ? 20 : 0;
  const processedScore = row.status === 'processed' ? 5 : 0;
  return snapshotScore + checkScore + processedScore + Number(row.amount || 0) / 100000;
}

function dedupeRows(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const key = rowKey(row);
    const existing = map.get(key);
    if (!existing || rowScore(row) >= rowScore(existing)) map.set(key, row);
  }
  return Array.from(map.values());
}

function shouldCheck(row = {}, { since, requireSnapshot = false } = {}) {
  if (!isUnavailableRow(row)) return false;
  if (requireSnapshot && !hasSnapshot(row.stockSnapshot)) return false;
  const created = new Date(row.createdAt || row.updatedAt || '');
  if (since && created && !Number.isNaN(created.getTime()) && created < since) return false;
  const sku = clean(row.barcode || row.sku);
  if (!sku) return false;
  return true;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/* GENTS lost & found flow:
   - Winkel meldt 'niet leverbaar' → SRS verplaatst voorraad naar lost+found
     locatie (storestock -> 0, lostFound +N). Dit is EXPECTED, geen signaal.
   - Inventarisatie volgt (binnen ~1 week). Daarna hoort het artikel
     definitief weg te zijn — OF er hangt een verkoop aan.
   - Echt signaal: na de inventarisatie-week komt voorraad alsnog terug
     in de winkel (= 'found in store'), zonder dat er een verkoop bij
     hoorde → winkel hield mogelijk express achter of keek niet goed.

   Scoring:
   - stock_present_at_unavailable (40, medium): winkel zei niet
     leverbaar maar SRS-voorraad stond op >0 bij melding (didn't look)
   - store_stock_returned_early (45, medium): voorraad terug <7 dagen
     na melding — inventarisatie nog niet gedaan, milde indicatie
   - store_stock_returned_post_inventory (90, very_high): voorraad
     terug ≥7 dagen na melding — sterk signaal
   - lost_found_decreased_back (70, high): lost+found locatie kreeg
     het terug en gaf het later weer af aan de winkel (terugboek
     zonder verkoop)

   NIET als signaal beschouwd:
   - lost+found increase direct na niet-leverbaar (dat is exact wat
     de flow doet)
*/
function suspicionFrom({ row, snapshot, current } = {}) {
  const snapshotAvailable = hasSnapshot(snapshot);
  const stockAtUnavailable = snapshotAvailable ? numberOrNull(snapshot.storeStock) : null;
  const lostFoundAtUnavailable = snapshotAvailable ? numberOrNull(snapshot.lostFoundStock) : null;
  const storeNow = numberOrNull(current?.storeStock) ?? 0;
  const lostFoundNow = numberOrNull(current?.lostFoundStock) ?? 0;
  const lostFoundDelta = lostFoundAtUnavailable === null ? null : lostFoundNow - lostFoundAtUnavailable;
  const storeDelta = stockAtUnavailable === null ? null : storeNow - stockAtUnavailable;

  /* Dagen sinds 'niet leverbaar' melding (om inventarisatie-window te bepalen) */
  const unavailableAt = row.createdAt || row.updatedAt || row.srsUpdatedAt || null;
  const daysSinceUnavailable = unavailableAt
    ? Math.floor((Date.now() - new Date(unavailableAt).getTime()) / (24 * 3600 * 1000))
    : null;
  const postInventory = daysSinceUnavailable !== null && daysSinceUnavailable >= 7;

  let status = snapshotAvailable ? 'no_signal' : 'no_snapshot_yet';
  let level = 'low';
  let score = 0;

  /* Signaal 1: voorraad stond op >0 bij melding 'niet leverbaar' */
  if (stockAtUnavailable !== null && stockAtUnavailable > 0) {
    status = 'stock_present_at_unavailable';
    level = 'medium';
    score = 40;
  }

  /* Signaal 2: voorraad terug in winkel — week-window bepaalt severity */
  if (storeDelta !== null && storeDelta > 0) {
    if (postInventory) {
      status = 'store_stock_returned_post_inventory';
      level = 'very_high';
      score = Math.max(score, 90);
    } else {
      status = 'store_stock_returned_early';
      level = level === 'low' ? 'medium' : level;
      score = Math.max(score, 45);
    }
  }

  /* Signaal 3: lost+found gaf het terug aan winkel (decrease) */
  if (lostFoundDelta !== null && lostFoundDelta < 0) {
    status = 'lost_found_decreased_back';
    level = level === 'very_high' ? level : 'high';
    score = Math.max(score, 70);
  }

  return {
    status,
    level,
    score,
    snapshotAvailable,
    stockAtUnavailable,
    lostFoundAtUnavailable,
    storeStockNow: storeNow,
    lostFoundStockNow: lostFoundNow,
    lostFoundDelta,
    storeDelta,
    daysSinceUnavailable,
    postInventory,
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
    const requireSnapshot = ['1', 'true', 'yes', 'ja'].includes(clean(req.query.requireSnapshot).toLowerCase());
    const since = daysAgoDate(daysBack);

    const cancellations = await getOrderCancellations();
    const rawRows = cancellationLineRows(cancellations).filter((row) => shouldCheck(row, { since, requireSnapshot }));
    const rows = dedupeRows(rawRows);
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
    const noSnapshot = results.filter((item) => item.signal?.status === 'no_snapshot_yet').length;
    const message = `Lost & Found check klaar. ${results.length} gecontroleerd, ${high} hoog signaal, ${medium} middel signaal, ${noSnapshot} zonder oude snapshot.`;

    await appendUnavailableCronRun({
      type: 'srs_unavailable_lost_found_check',
      success: errors.length === 0,
      message,
      totals: {
        type: 'srs_unavailable_lost_found_check',
        candidatesRaw: rawRows.length,
        candidates: rows.length,
        checked: results.length,
        high,
        medium,
        noSnapshot,
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
      candidatesRaw: rawRows.length,
      candidates: rows.length,
      checked: results.length,
      high,
      medium,
      noSnapshot,
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
