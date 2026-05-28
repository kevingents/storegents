/**
 * /api/admin/voorraad-magazijn-vs-winkel
 *
 * Signaleert SKU's die WÉL op voorraad liggen in het magazijn (kind=warehouse)
 * maar bij GEEN ENKELE fysieke winkel (kind=retail) op voorraad zijn.
 * → indicatie dat uitlevering / herbevoorrading naar de winkels mogelijk hapert.
 *
 * Per SKU wordt ook `winkelsMetTarget` berekend: het aantal retail-winkels dat
 * een ideaal (>0) voor die SKU heeft maar 0 of minder op voorraad. Dat zijn de
 * ECHTE uitlever-gaps — een winkel zou het moeten voeren, het magazijn heeft
 * het, maar de winkel staat leeg.
 *
 * GET                       → { success, totals, rows: top-100, generatedAt }
 * GET ?all=1                → alle rijen (max 1000)
 * GET ?onlyGap=1            → alleen SKU's met winkelsMetTarget > 0
 *
 * Auth: admin-token vereist.
 */

import { readVoorraadRows, computeMagazijnNietWinkel } from '../../lib/srs-voorraad-store.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  try {
    const voorraadRows = await readVoorraadRows();
    if (!voorraadRows.length) {
      return res.status(200).json({
        success: true,
        empty: true,
        totals: { skus: 0, stuks: 0, metTarget: 0, metTargetStuks: 0 },
        rows: [],
        message: 'Voorraad-snapshot ontbreekt. Trigger /api/cron/srs-voorraad-import.'
      });
    }

    const onlyGap = String(req.query?.onlyGap || '') === '1';
    const all = String(req.query?.all || '') === '1';

    /* Gedeelde cross-reference (zelfde definitie als rapport-bouwer-bron) */
    let rows = computeMagazijnNietWinkel(voorraadRows);
    if (onlyGap) rows = rows.filter((r) => r.winkelsMetTarget > 0);

    const totals = {
      skus: rows.length,
      stuks: rows.reduce((s, r) => s + r.magazijnVoorraad, 0),
      metTarget: rows.filter((r) => r.winkelsMetTarget > 0).length,
      metTargetStuks: rows.filter((r) => r.winkelsMetTarget > 0).reduce((s, r) => s + r.magazijnVoorraad, 0)
    };

    const limit = all ? 1000 : 100;
    return res.status(200).json({
      success: true,
      totals,
      rows: rows.slice(0, limit),
      truncated: rows.length > limit,
      generatedAt: new Date().toISOString()
    });
  } catch (e) {
    console.error('[admin/voorraad-magazijn-vs-winkel]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
