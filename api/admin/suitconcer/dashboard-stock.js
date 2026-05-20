import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { readBranchSnapshot } from '../../../lib/srs-stock-snapshot-store.js';
import { isFeatureEnabled } from '../../../lib/feature-flags-store.js';

/**
 * GET /api/admin/suitconcer/dashboard-stock
 *
 * Snel: leest alleen de stock-snapshots van branch 702/704 (geen SRS).
 * Wordt gebruikt door het frontend om de voorraad-secties van het
 * Suitconcer dashboard direct te vullen, zonder te wachten op de
 * trage GetTransactions-calls voor omzet.
 *
 * Response:
 *   { success, totalSkus, withStock, outOfStock, totalPieces,
 *     verkoopPieces, magazijnPieces, lowStock: [...],
 *     snapshotUpdatedAt: { verkoop, magazijn } }
 */

const VERKOOP = '702';
const MAGAZIJN = '704';
const LOW_STOCK_THRESHOLD = Number(process.env.SUITCONCER_LOW_STOCK_THRESHOLD || 5);

function clean(v) { return String(v || '').trim(); }

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (requireAdmin(req, res)) return;

  if (!(await isFeatureEnabled('suitconcer'))) {
    return res.status(403).json({ success: false, message: 'Suitconcer is uitgeschakeld.' });
  }

  try {
    const [verkoopSnap, magazijnSnap] = await Promise.all([
      readBranchSnapshot(VERKOOP).catch((e) => ({ rows: [], updatedAt: null, error: e.message })),
      readBranchSnapshot(MAGAZIJN).catch((e) => ({ rows: [], updatedAt: null, error: e.message }))
    ]);

    const byBarcode = new Map();

    for (const r of (verkoopSnap?.rows || [])) {
      const barcode = clean(r.barcode);
      if (!barcode) continue;
      byBarcode.set(barcode, {
        barcode,
        sku: clean(r.sku || r.barcode),
        title: clean(r.title || ''),
        color: clean(r.color || ''),
        size: clean(r.size || ''),
        verkoop: Number(r.pieces || 0),
        magazijn: 0
      });
    }
    for (const r of (magazijnSnap?.rows || [])) {
      const barcode = clean(r.barcode);
      if (!barcode) continue;
      const existing = byBarcode.get(barcode) || {
        barcode,
        sku: clean(r.sku || r.barcode),
        title: clean(r.title || ''),
        color: clean(r.color || ''),
        size: clean(r.size || ''),
        verkoop: 0,
        magazijn: 0
      };
      existing.magazijn = Number(r.pieces || 0);
      if (!existing.title && r.title) existing.title = clean(r.title);
      byBarcode.set(barcode, existing);
    }

    const all = Array.from(byBarcode.values()).map((r) => ({ ...r, totaal: r.verkoop + r.magazijn }));

    const lowStock = all
      .filter((r) => r.totaal > 0 && r.totaal < LOW_STOCK_THRESHOLD)
      .sort((a, b) => a.totaal - b.totaal)
      .slice(0, 20);

    return res.status(200).json({
      success: true,
      branchIds: { verkoop: VERKOOP, magazijn: MAGAZIJN },
      totalSkus: byBarcode.size,
      withStock: all.filter((r) => r.totaal > 0).length,
      outOfStock: all.filter((r) => r.totaal === 0).length,
      totalPieces: all.reduce((s, r) => s + r.totaal, 0),
      verkoopPieces: all.reduce((s, r) => s + r.verkoop, 0),
      magazijnPieces: all.reduce((s, r) => s + r.magazijn, 0),
      lowStock,
      lowStockThreshold: LOW_STOCK_THRESHOLD,
      snapshotUpdatedAt: {
        verkoop: verkoopSnap?.updatedAt || null,
        magazijn: magazijnSnap?.updatedAt || null
      },
      snapshotErrors: {
        verkoop: verkoopSnap?.error || null,
        magazijn: magazijnSnap?.error || null
      }
    });
  } catch (error) {
    console.error('[suitconcer/dashboard-stock] error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Stock kon niet worden opgehaald.'
    });
  }
}
