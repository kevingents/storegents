/**
 * /api/admin/voorraad-gezondheid
 *
 * GET                       → { success, totals, filialen: [...], generatedAt, sourceFile }
 * GET ?store=GENTS+Almere   → bovenstaande + topTekorten[] voor die winkel (top 50 SKU's met grootste tekort)
 * GET ?topTekorten=1        → globale top-50 tekort-SKU's over alle filialen
 *
 * Leest snapshot uit srs-voorraad-store (gevuld door cron). Geen SFTP-call.
 *
 * Auth: admin-token vereist.
 */

import { readVoorraadSummary, readVoorraadRows } from '../../lib/srs-voorraad-store.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  try {
    const summary = await readVoorraadSummary();
    const store = String(req.query?.store || '').trim();
    const wantTopTekorten = String(req.query?.topTekorten || '') === '1' || Boolean(store);

    const payload = {
      success: true,
      totals: summary.totals || {},
      filialen: summary.filialen || [],
      generatedAt: summary.generatedAt || null,
      sourceFile: summary.sourceFile || null,
      rowCount: summary.rowCount || 0
    };

    if (!payload.generatedAt) {
      return res.status(200).json({
        ...payload,
        empty: true,
        message: 'Nog geen voorraad-snapshot. Trigger /api/cron/srs-voorraad-import.'
      });
    }

    if (wantTopTekorten) {
      const rows = await readVoorraadRows();
      const filtered = store ? rows.filter((r) => r.store === store) : rows;
      const topTekorten = filtered
        .filter((r) => r.tekort > 0)
        .sort((a, b) => b.tekort - a.tekort)
        .slice(0, 50)
        .map((r) => ({ store: r.store, sku: r.sku, voorraad: r.voorraad, ideaal: r.ideaal, tekort: r.tekort }));
      payload.topTekorten = topTekorten;
      payload.scopedStore = store || null;
    }

    return res.status(200).json(payload);
  } catch (e) {
    console.error('[admin/voorraad-gezondheid]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
