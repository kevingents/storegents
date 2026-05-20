import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { readBranchSnapshot } from '../../../lib/srs-stock-snapshot-store.js';
import { isFeatureEnabled } from '../../../lib/feature-flags-store.js';

/**
 * GET /api/admin/suitconcer/artikelen
 *
 * Artikelen-catalogus voor Suitconcer. Geaggregeerd op SKU-niveau
 * (zonder maat/kleur) zodat je een product-overzicht krijgt ipv per
 * variant. Bouwt op de bestaande stock-snapshot (branches 702 + 704).
 *
 * Query:
 *   ?search=xxx
 *   ?onlyAvailable=1
 *   ?groupBy=sku|barcode    (default: sku — groepeert varianten samen)
 *   ?limit=200
 *
 * Response:
 *   {
 *     success,
 *     totals: { totalProducts, totalVariants, withStock, outOfStock },
 *     rows: [{
 *       sku, title,
 *       variants: number,            // aantal kleur/maat combinaties
 *       colors: [...], sizes: [...], // unieke waarden
 *       verkoopPieces, magazijnPieces, totaalPieces
 *     }]
 *   }
 */

const VERKOOP = '702';
const MAGAZIJN = '704';

function clean(v) { return String(v || '').trim(); }
function uniq(arr) { return Array.from(new Set(arr.filter(Boolean))); }

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

  const search = clean(req.query.search).toLowerCase();
  const onlyAvailable = String(req.query.onlyAvailable || '') === '1';
  const groupBy = String(req.query.groupBy || 'sku').toLowerCase();
  const limit = Math.min(Math.max(Number(req.query.limit || 500), 10), 2000);

  try {
    const [verkoopSnap, magazijnSnap] = await Promise.all([
      readBranchSnapshot(VERKOOP),
      readBranchSnapshot(MAGAZIJN)
    ]);

    /* Combineer alle rows uit beide branches met label welke branch */
    const allRows = [
      ...((verkoopSnap?.rows || []).map((r) => ({ ...r, _branch: 'verkoop' }))),
      ...((magazijnSnap?.rows || []).map((r) => ({ ...r, _branch: 'magazijn' })))
    ];

    /* Groepeer per SKU (of barcode als groupBy='barcode') */
    const groupKey = (r) => clean(groupBy === 'barcode' ? r.barcode : (r.sku || r.barcode));
    const groups = new Map();

    for (const r of allRows) {
      const key = groupKey(r);
      if (!key) continue;
      const slot = groups.get(key) || {
        sku: clean(r.sku || r.barcode),
        title: clean(r.title || ''),
        variants: new Set(),
        colors: new Set(),
        sizes: new Set(),
        verkoopPieces: 0,
        magazijnPieces: 0
      };
      slot.variants.add(clean(r.barcode));
      if (r.color) slot.colors.add(clean(r.color));
      if (r.size) slot.sizes.add(clean(r.size));
      if (!slot.title && r.title) slot.title = clean(r.title);
      if (r._branch === 'verkoop') slot.verkoopPieces += Number(r.pieces || 0);
      else slot.magazijnPieces += Number(r.pieces || 0);
      groups.set(key, slot);
    }

    let rows = Array.from(groups.values()).map((g) => ({
      sku: g.sku,
      title: g.title,
      variants: g.variants.size,
      colors: Array.from(g.colors),
      sizes: Array.from(g.sizes),
      verkoopPieces: g.verkoopPieces,
      magazijnPieces: g.magazijnPieces,
      totaalPieces: g.verkoopPieces + g.magazijnPieces
    }));

    if (search) {
      rows = rows.filter((r) => {
        const blob = [r.sku, r.title, ...r.colors, ...r.sizes]
          .map((v) => String(v || '').toLowerCase()).join(' ');
        return blob.includes(search);
      });
    }
    if (onlyAvailable) {
      rows = rows.filter((r) => r.totaalPieces > 0);
    }

    rows.sort((a, b) => (b.totaalPieces - a.totaalPieces) || a.title.localeCompare(b.title));

    const totals = {
      totalProducts: groups.size,
      totalVariants: rows.reduce((s, r) => s + r.variants, 0),
      withStock: rows.filter((r) => r.totaalPieces > 0).length,
      outOfStock: rows.filter((r) => r.totaalPieces === 0).length
    };

    return res.status(200).json({
      success: true,
      branchIds: [VERKOOP, MAGAZIJN],
      groupBy,
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
    console.error('[suitconcer/artikelen] error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Artikelen konden niet worden opgehaald.'
    });
  }
}
