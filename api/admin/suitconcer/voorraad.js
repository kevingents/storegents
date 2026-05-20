import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { readBranchSnapshot } from '../../../lib/srs-stock-snapshot-store.js';
import { isFeatureEnabled } from '../../../lib/feature-flags-store.js';

/**
 * GET /api/admin/suitconcer/voorraad
 *
 * Voorraad-overzicht voor Suitconcer (B2B). Combineert:
 *   - Branch 702 (verkoop)
 *   - Branch 704 (magazijn)
 *
 * Leest uit de bestaande srs-stock-snapshot Blob (gegenereerd via
 * nachtelijke SFTP full-snapshot + 5-min delta updates). Geen live
 * SOAP-calls — schaalt onbeperkt.
 *
 * Query params:
 *   ?search=blauw          zoek op barcode/sku/title
 *   ?onlyAvailable=1       toon alleen items met pieces > 0
 *   ?limit=200             max rows (default 500, max 2000)
 *
 * Response:
 *   {
 *     success, branchIds: ['702', '704'],
 *     totals: { totalSkus, withStock, outOfStock, totalPieces, magazijnPieces, verkoopPieces },
 *     rows: [{ barcode, sku, title, color, size, verkoop, magazijn, totaal }]
 *   }
 */

const VERKOOP = '702';
const MAGAZIJN = '704';

function clean(v) { return String(v || '').trim(); }

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (requireAdmin(req, res)) return;

  /* Feature flag check */
  if (!(await isFeatureEnabled('suitconcer'))) {
    return res.status(403).json({
      success: false,
      message: 'Suitconcer is uitgeschakeld. Zet de feature aan in Instellingen.'
    });
  }

  const search = clean(req.query.search).toLowerCase();
  const onlyAvailable = String(req.query.onlyAvailable || '') === '1';
  const limit = Math.min(Math.max(Number(req.query.limit || 500), 10), 2000);

  try {
    const [verkoopSnap, magazijnSnap] = await Promise.all([
      readBranchSnapshot(VERKOOP),
      readBranchSnapshot(MAGAZIJN)
    ]);

    /* Merge per barcode — verkoop + magazijn voorraad samenvoegen */
    const byBarcode = new Map();

    for (const row of (verkoopSnap?.rows || [])) {
      const barcode = clean(row.barcode);
      if (!barcode) continue;
      byBarcode.set(barcode, {
        barcode,
        sku: clean(row.sku || row.barcode),
        title: clean(row.title || ''),
        color: clean(row.color || ''),
        size: clean(row.size || ''),
        verkoop: Number(row.pieces || 0),
        magazijn: 0
      });
    }

    for (const row of (magazijnSnap?.rows || [])) {
      const barcode = clean(row.barcode);
      if (!barcode) continue;
      const existing = byBarcode.get(barcode) || {
        barcode,
        sku: clean(row.sku || row.barcode),
        title: clean(row.title || ''),
        color: clean(row.color || ''),
        size: clean(row.size || ''),
        verkoop: 0,
        magazijn: 0
      };
      existing.magazijn = Number(row.pieces || 0);
      /* Magazijn heeft vaak rijkere titel-info — overrule alleen als leeg */
      if (!existing.title && row.title) existing.title = clean(row.title);
      if (!existing.color && row.color) existing.color = clean(row.color);
      if (!existing.size && row.size) existing.size = clean(row.size);
      byBarcode.set(barcode, existing);
    }

    let rows = Array.from(byBarcode.values()).map((r) => ({
      ...r,
      totaal: r.verkoop + r.magazijn
    }));

    /* Filter */
    if (search) {
      rows = rows.filter((r) => {
        const blob = [r.barcode, r.sku, r.title, r.color, r.size]
          .map((v) => String(v || '').toLowerCase()).join(' ');
        return blob.includes(search);
      });
    }
    if (onlyAvailable) {
      rows = rows.filter((r) => r.totaal > 0);
    }

    /* Sorteer: meest voorraad eerst, daarna alfabetisch op titel */
    rows.sort((a, b) => (b.totaal - a.totaal) || a.title.localeCompare(b.title));

    /* Totalen */
    const totals = {
      totalSkus: byBarcode.size,
      withStock: rows.filter((r) => r.totaal > 0).length,
      outOfStock: rows.filter((r) => r.totaal === 0).length,
      totalPieces: rows.reduce((s, r) => s + r.totaal, 0),
      verkoopPieces: rows.reduce((s, r) => s + r.verkoop, 0),
      magazijnPieces: rows.reduce((s, r) => s + r.magazijn, 0)
    };

    return res.status(200).json({
      success: true,
      branchIds: [VERKOOP, MAGAZIJN],
      generatedAt: {
        verkoop: verkoopSnap?.updatedAt || null,
        magazijn: magazijnSnap?.updatedAt || null
      },
      totals,
      rows: rows.slice(0, limit),
      truncated: rows.length > limit,
      totalRows: rows.length
    });
  } catch (error) {
    console.error('[suitconcer/voorraad] error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Voorraad kon niet worden opgehaald.'
    });
  }
}
