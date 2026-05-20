import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { readBranchSnapshot } from '../../../lib/srs-stock-snapshot-store.js';
import { listAllBranches, getStoreNameByBranchId } from '../../../lib/branch-metrics.js';
import { isFeatureEnabled } from '../../../lib/feature-flags-store.js';

/**
 * GET /api/admin/suitconcer/voorraad-vergelijking
 *
 * Vergelijking Suitconcer (702 + 704) vs alle GENTS branches.
 *
 * Voor elke barcode bepalen we waar hij in voorraad is (pieces > 0):
 *   - onlySuitconcer: alleen bij Suitconcer (702/704), niet bij GENTS
 *   - onlyGents:      alleen bij GENTS, niet bij Suitconcer
 *   - beide:          op voorraad bij beiden
 *
 * Query:
 *   ?side=only-suitconcer | only-gents | all  (default: all)
 *   ?search=xxx
 *   ?limit=500  (max 5000)
 *
 * Response:
 *   {
 *     success,
 *     totals: { onlySuitconcer, onlyGents, beide, totalSuitconcer, totalGents },
 *     rows: [{
 *       barcode, sku, title, color, size,
 *       suitconcer: { verkoop, magazijn, totaal },
 *       gents: { totaal, branchCount, branches: [{branch, branchId, pieces}] }
 *     }],
 *     branchesUsed: [...],
 *     missingSnapshots: [...]   // branches waar geen snapshot beschikbaar is
 *   }
 *
 * Cache: 5 min in-memory.
 */

const SUITCONCER_BRANCHES = new Set(['702', '704']);
const CACHE_TTL_MS = Number(process.env.SUITCONCER_DIFF_CACHE_MS || 5 * 60 * 1000);
const cache = new Map();

function clean(v) { return String(v || '').trim(); }

function normRow(row) {
  return {
    barcode: clean(row.barcode),
    sku: clean(row.sku || row.barcode),
    title: clean(row.title || ''),
    color: clean(row.color || ''),
    size: clean(row.size || ''),
    pieces: Number(row.pieces || 0)
  };
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (requireAdmin(req, res)) return;

  if (!(await isFeatureEnabled('suitconcer'))) {
    return res.status(403).json({
      success: false,
      message: 'Suitconcer is uitgeschakeld. Zet de feature aan in Instellingen.'
    });
  }

  const side = clean(req.query.side).toLowerCase() || 'all';
  const search = clean(req.query.search).toLowerCase();
  const limit = Math.min(Math.max(Number(req.query.limit || 500), 10), 5000);

  const cacheKey = `${side}|${search}|${limit}`;
  const cached = cache.get(cacheKey);
  if (cached && (Date.now() - cached.at) < CACHE_TTL_MS) {
    return res.status(200).json({ ...cached.data, cached: true });
  }

  try {
    const allBranches = listAllBranches();
    const branchIds = allBranches.map((b) => b.branchId).filter(Boolean);

    /* Parallel: lees snapshots voor alle branches */
    const snapshots = await Promise.all(
      branchIds.map(async (bid) => {
        try {
          const snap = await readBranchSnapshot(bid);
          return { branchId: bid, snap, error: null };
        } catch (error) {
          return { branchId: bid, snap: null, error: error.message };
        }
      })
    );

    const missingSnapshots = [];
    const branchesUsed = [];

    /* Twee maps: één voor Suitconcer-voorraad, één voor GENTS */
    /* Suitconcer: barcode -> { verkoop, magazijn, sku, title, color, size } */
    /* GENTS:      barcode -> { totaal, branches: [{branch, branchId, pieces}], sku, title, color, size } */
    const suitconcerMap = new Map();
    const gentsMap = new Map();

    for (const { branchId, snap } of snapshots) {
      const branchName = getStoreNameByBranchId(branchId);
      if (!snap || !Array.isArray(snap.rows)) {
        missingSnapshots.push({ branchId, branch: branchName });
        continue;
      }
      branchesUsed.push({ branchId, branch: branchName, rowCount: snap.rows.length, updatedAt: snap.updatedAt });

      const isSuitconcer = SUITCONCER_BRANCHES.has(branchId);

      for (const raw of snap.rows) {
        const r = normRow(raw);
        if (!r.barcode || r.pieces <= 0) continue;

        if (isSuitconcer) {
          const existing = suitconcerMap.get(r.barcode) || {
            barcode: r.barcode,
            sku: r.sku,
            title: r.title,
            color: r.color,
            size: r.size,
            verkoop: 0,
            magazijn: 0
          };
          if (branchId === '702') existing.verkoop += r.pieces;
          if (branchId === '704') existing.magazijn += r.pieces;
          /* Vul ontbrekende metadata aan */
          if (!existing.sku && r.sku) existing.sku = r.sku;
          if (!existing.title && r.title) existing.title = r.title;
          if (!existing.color && r.color) existing.color = r.color;
          if (!existing.size && r.size) existing.size = r.size;
          suitconcerMap.set(r.barcode, existing);
        } else {
          const existing = gentsMap.get(r.barcode) || {
            barcode: r.barcode,
            sku: r.sku,
            title: r.title,
            color: r.color,
            size: r.size,
            totaal: 0,
            branches: []
          };
          existing.totaal += r.pieces;
          existing.branches.push({ branch: branchName, branchId, pieces: r.pieces });
          if (!existing.sku && r.sku) existing.sku = r.sku;
          if (!existing.title && r.title) existing.title = r.title;
          if (!existing.color && r.color) existing.color = r.color;
          if (!existing.size && r.size) existing.size = r.size;
          gentsMap.set(r.barcode, existing);
        }
      }
    }

    /* Bouw drie buckets */
    const onlySuitconcerRows = [];
    const onlyGentsRows = [];
    const beideRows = [];

    for (const [barcode, sc] of suitconcerMap.entries()) {
      const totaal = sc.verkoop + sc.magazijn;
      const gentsEntry = gentsMap.get(barcode);
      const row = {
        barcode,
        sku: sc.sku,
        title: sc.title,
        color: sc.color,
        size: sc.size,
        suitconcer: { verkoop: sc.verkoop, magazijn: sc.magazijn, totaal },
        gents: gentsEntry
          ? { totaal: gentsEntry.totaal, branchCount: gentsEntry.branches.length, branches: gentsEntry.branches }
          : { totaal: 0, branchCount: 0, branches: [] }
      };
      if (!gentsEntry) onlySuitconcerRows.push(row);
      else beideRows.push(row);
    }

    for (const [barcode, g] of gentsMap.entries()) {
      if (suitconcerMap.has(barcode)) continue; /* zit in beide */
      onlyGentsRows.push({
        barcode,
        sku: g.sku,
        title: g.title,
        color: g.color,
        size: g.size,
        suitconcer: { verkoop: 0, magazijn: 0, totaal: 0 },
        gents: { totaal: g.totaal, branchCount: g.branches.length, branches: g.branches }
      });
    }

    /* Sorteer & filter */
    function filterRows(rows) {
      let r = rows;
      if (search) {
        r = r.filter((x) => {
          const blob = [x.barcode, x.sku, x.title, x.color, x.size]
            .map((v) => String(v || '').toLowerCase()).join(' ');
          return blob.includes(search);
        });
      }
      return r;
    }

    onlySuitconcerRows.sort((a, b) => b.suitconcer.totaal - a.suitconcer.totaal || (a.title || '').localeCompare(b.title || ''));
    onlyGentsRows.sort((a, b) => b.gents.totaal - a.gents.totaal || (a.title || '').localeCompare(b.title || ''));
    beideRows.sort((a, b) => (b.suitconcer.totaal + b.gents.totaal) - (a.suitconcer.totaal + a.gents.totaal));

    const filteredOnlySc = filterRows(onlySuitconcerRows);
    const filteredOnlyGn = filterRows(onlyGentsRows);
    const filteredBeide = filterRows(beideRows);

    /* Kies welke side wordt teruggegeven */
    let rows;
    if (side === 'only-suitconcer') rows = filteredOnlySc;
    else if (side === 'only-gents') rows = filteredOnlyGn;
    else if (side === 'beide') rows = filteredBeide;
    else rows = filteredOnlySc; /* default als 'all': eerst alleen-Suitconcer */

    const data = {
      success: true,
      generatedAt: new Date().toISOString(),
      side,
      totals: {
        onlySuitconcer: onlySuitconcerRows.length,
        onlyGents: onlyGentsRows.length,
        beide: beideRows.length,
        totalSuitconcer: suitconcerMap.size,
        totalGents: gentsMap.size
      },
      rows: rows.slice(0, limit),
      truncated: rows.length > limit,
      totalRows: rows.length,
      branchesUsed,
      missingSnapshots
    };

    cache.set(cacheKey, { at: Date.now(), data });
    return res.status(200).json(data);
  } catch (error) {
    console.error('[suitconcer/voorraad-vergelijking] error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Vergelijking kon niet worden opgehaald.'
    });
  }
}
