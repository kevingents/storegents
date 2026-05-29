/**
 * GET /api/admin/stock/snapshot?store=GENTS Delft&onlyAvailable=true
 * GET /api/admin/stock/snapshot?branchId=5&barcode=2900003680040
 *
 * Snel uitlezen van de SFTP delta-stock snapshot. Geen live SOAP-call —
 * data is hoogstens 5-30 min oud (afhankelijk van delta-cron interval).
 *
 * Response:
 *   {
 *     success: true,
 *     branchId, store,
 *     updatedAt, ageMs, fresh,
 *     totals: { rows, available, oos },
 *     rows: [{ barcode, sku, pieces, title, color, size, articleNumber, unitPrice }]
 *   }
 *
 * Als de snapshot ontbreekt of stale is, antwoord 200 met fresh:false + ageMs.
 * De frontend kan dan beslissen om alsnog een live call te doen.
 */

import { getBranchIdByStore, getStoreNameByBranchId } from '../../../lib/branch-metrics.js';
import {
  getBranchSnapshotFresh,
  pickBranchStockRows,
  readSnapshotIndex
} from '../../../lib/srs-stock-snapshot-store.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()))).trim();
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers.authorization ||
    req.query?.adminToken ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(adminToken && token && token === adminToken);
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }
  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  const storeRaw = String(req.query.store || '').trim();
  const branchIdRaw = String(req.query.branchId || '').trim();
  const onlyAvailable = String(req.query.onlyAvailable || 'true').toLowerCase() !== 'false';
  const barcode = String(req.query.barcode || '').trim();
  const sku = String(req.query.sku || '').trim();

  let branchId = branchIdRaw || (storeRaw ? getBranchIdByStore(storeRaw) : '');
  if (!branchId && storeRaw) {
    return res.status(400).json({ success: false, message: `Onbekende winkel: ${storeRaw}` });
  }

  /* Geen filter: geef de index zodat de FE weet welke winkels beschikbaar zijn. */
  if (!branchId) {
    const index = await readSnapshotIndex();
    return res.status(200).json({
      success: true,
      mode: 'index',
      index
    });
  }

  const store = storeRaw || getStoreNameByBranchId(branchId) || `branch-${branchId}`;
  const { snapshot, fresh, ageMs } = await getBranchSnapshotFresh(branchId);

  if (!snapshot || !snapshot.rows?.length) {
    return res.status(200).json({
      success: true,
      branchId,
      store,
      fresh: false,
      ageMs,
      message: 'Snapshot ontbreekt — wacht op cron of trigger /api/cron/srs-stock-delta-import?mode=full',
      totals: { rows: 0, available: 0, oos: 0 },
      rows: []
    });
  }

  const rows = pickBranchStockRows(snapshot, { onlyAvailable, barcode, sku });
  const available = rows.filter((row) => Number(row.pieces || 0) > 0).length;

  return res.status(200).json({
    success: true,
    branchId,
    store,
    updatedAt: snapshot.updatedAt,
    fresh,
    ageMs,
    filters: { onlyAvailable, barcode, sku },
    totals: {
      rows: rows.length,
      available,
      oos: rows.length - available
    },
    rows
  });
}
