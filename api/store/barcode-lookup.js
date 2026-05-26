/**
 * GET /api/store/barcode-lookup?barcode=2900001049023&store=GENTS+Almere
 *
 * Lookup een barcode in de SRS branch-snapshots. Bedoeld als 3e fallback
 * voor de voorraad-correctie scan-flow nadat:
 *   1. Shopify realtime search (article-search-live) niets vond
 *   2. Shopify products cache (article-search) niets vond
 *
 * Veel SRS-barcodes (29000xxxxxxxx) staan niet in Shopify als variant.barcode
 * maar zitten wél in de dagelijkse SRS Stock-snapshot per filiaal. Dit
 * endpoint zoekt de barcode op in ALLE branch-snapshots en bouwt een
 * frontend-vriendelijk artikel-resultaat.
 *
 * Returns:
 *   {
 *     success: true,
 *     found: true|false,
 *     barcode: '2900001049023',
 *     result: {
 *       articleNumber: '',  // onbekend uit snapshot
 *       sku: '2900001049023',
 *       barcode: '2900001049023',
 *       title: 'Onbekend artikel (alleen barcode bekend uit SRS)',
 *       color: '',
 *       size: '',
 *       branches: [{ branchId, store, pieces, isOwn, type }],
 *       totalPieces: 5,
 *       branchCount: 2,
 *       price: 0
 *     },
 *     snapshotAge: '4h12m'  // hoe oud de snapshot is
 *   }
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { listAllBranches, getStoreNameByBranchId, isWarehouseStore } from '../../lib/branch-metrics.js';
import { readSnapshotIndex, readBranchSnapshot } from '../../lib/srs-stock-snapshot-store.js';

function clean(v) { return String(v || '').trim(); }

function formatAge(ms) {
  if (!ms || ms < 0) return '';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins - hours * 60;
  if (hours < 24) return remMins > 0 ? `${hours}h${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  const barcode = clean(req.query.barcode);
  const ownStore = clean(req.query.store);

  if (!barcode) {
    return res.status(400).json({ success: false, message: 'Parameter "barcode" verplicht.' });
  }
  if (!/^\d{6,14}$/.test(barcode)) {
    return res.status(400).json({ success: false, message: 'Barcode moet 6-14 cijfers zijn.' });
  }

  try {
    /* Read index voor branchIds én snapshot-leeftijd */
    const index = await readSnapshotIndex();
    const branchIds = Array.isArray(index?.branchIds) ? index.branchIds : [];
    const generatedAt = index?.generatedAt || index?.deltaGeneratedAt || index?.fullGeneratedAt || '';
    const snapshotAgeMs = generatedAt ? Date.now() - new Date(generatedAt).getTime() : null;

    /* Fallback: gebruik listAllBranches() als index leeg is */
    const allBranches = listAllBranches();
    const branchesToScan = branchIds.length
      ? branchIds.map((id) => {
          const meta = allBranches.find((b) => String(b.branchId) === String(id));
          return { branchId: String(id), store: meta?.store || getStoreNameByBranchId(id) || `Branch ${id}` };
        })
      : allBranches.map((b) => ({ branchId: String(b.branchId), store: b.store }));

    /* Loop door alle branches en verzamel matches */
    const branches = [];
    let foundTitle = '';
    let foundSku = '';
    let foundColor = '';
    let foundSize = '';

    await Promise.all(branchesToScan.map(async ({ branchId, store }) => {
      const snap = await readBranchSnapshot(branchId);
      if (!snap || !Array.isArray(snap.rows)) return;
      const match = snap.rows.find((row) => clean(row.barcode) === barcode || clean(row.sku) === barcode);
      if (!match) return;
      const pieces = Number(match.pieces || 0);
      branches.push({
        branchId,
        store,
        pieces: Math.max(0, pieces),
        isOwn: !!(ownStore && store === ownStore),
        type: isWarehouseStore(store) ? 'warehouse' : 'retail'
      });
      /* Eerste niet-lege metadata winnen */
      if (!foundTitle && match.title) foundTitle = clean(match.title);
      if (!foundSku && match.sku) foundSku = clean(match.sku);
      if (!foundColor && match.color) foundColor = clean(match.color);
      if (!foundSize && match.size) foundSize = clean(match.size);
    }));

    if (!branches.length) {
      return res.status(200).json({
        success: true,
        found: false,
        barcode,
        result: null,
        snapshotAge: formatAge(snapshotAgeMs),
        snapshotGeneratedAt: generatedAt,
        message: 'Barcode niet gevonden in SRS-snapshots — mogelijk een nieuwe/onbekende code'
      });
    }

    /* Sorteer branches: eigen winkel eerst, dan op aantal */
    branches.sort((a, b) => {
      if (a.isOwn !== b.isOwn) return a.isOwn ? -1 : 1;
      if (a.pieces !== b.pieces) return b.pieces - a.pieces;
      return String(a.store || '').localeCompare(String(b.store || ''));
    });

    const totalPieces = branches.reduce((sum, b) => sum + Number(b.pieces || 0), 0);
    const branchCount = branches.filter((b) => b.pieces > 0).length;

    const result = {
      articleNumber: '',
      sku: foundSku || barcode,
      barcode,
      title: foundTitle || `Onbekend artikel · barcode ${barcode}`,
      color: foundColor,
      size: foundSize,
      vendor: '',
      productType: '',
      image: '',
      images: [],
      productUrl: '',
      branches,
      totalPieces,
      branchCount,
      price: 0,
      source: 'srs-snapshot'
    };

    return res.status(200).json({
      success: true,
      found: true,
      barcode,
      result,
      results: [result],  /* compat: frontend kan dit ook als array gebruiken */
      snapshotAge: formatAge(snapshotAgeMs),
      snapshotGeneratedAt: generatedAt
    });
  } catch (error) {
    console.error('[barcode-lookup]', error);
    return res.status(500).json({
      success: false,
      message: error?.message || 'Barcode-lookup faalde.'
    });
  }
}
