/**
 * /api/admin/voorraad-gezondheid
 *
 * GET                       → { success, totals, filialen: [...], generatedAt, sourceFile }
 * GET ?store=GENTS+Almere   → bovenstaande + topTekorten[] voor die winkel (top 50 SKU's met grootste tekort)
 * GET ?topTekorten=1        → globale top-50 tekort-SKU's over alle filialen
 * GET ?negatief=1           → alle negatieve-voorraad rijen (data-integriteit), optioneel + &store=
 *
 * Leest snapshot uit srs-voorraad-store (gevuld door cron). Geen SFTP-call.
 *
 * Auth: admin-token vereist.
 */

import { readVoorraadSummary, readVoorraadRows } from '../../lib/srs-voorraad-store.js';
import { isExcludedFromVoorraadHealth } from '../../lib/business-config.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

/* Tel de per-filiaal velden op tot nieuwe totals (na exclusie van filialen
   die niet in voorraad-gezondheid horen, bv. webshop / Suitconcern). */
function sumTotals(filialen) {
  const keys = ['totalSkus', 'totalStock', 'skusUnderIdeal', 'skusOverIdeal', 'skusOutOfStock', 'skusNegative', 'negativeUnits', 'shortageUnits', 'overstockUnits'];
  return filialen.reduce((acc, f) => {
    keys.forEach((k) => { acc[k] = (acc[k] || 0) + (Number(f[k]) || 0); });
    return acc;
  }, {});
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  try {
    const summary = await readVoorraadSummary();
    const store = String(req.query?.store || '').trim();
    const wantNegatief = String(req.query?.negatief || '') === '1';
    const wantTopTekorten = !wantNegatief && (String(req.query?.topTekorten || '') === '1' || Boolean(store));

    /* Verberg niet-relevante filialen (webshop, Suitconcern magazijn, …) en
       herbereken de totals over de zichtbare set. */
    const filialen = (summary.filialen || []).filter((f) => !isExcludedFromVoorraadHealth(f.filiaalNummer));

    const payload = {
      success: true,
      totals: filialen.length ? sumTotals(filialen) : (summary.totals || {}),
      filialen,
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
      const visible = rows.filter((r) => !isExcludedFromVoorraadHealth(r.filiaalNummer));
      const filtered = store ? visible.filter((r) => r.store === store) : visible;
      const topTekorten = filtered
        .filter((r) => r.tekort > 0)
        .sort((a, b) => b.tekort - a.tekort)
        .slice(0, 50)
        .map((r) => ({ store: r.store, sku: r.sku, voorraad: r.voorraad, ideaal: r.ideaal, tekort: r.tekort }));
      payload.topTekorten = topTekorten;
      payload.scopedStore = store || null;
    }

    if (wantNegatief) {
      const rows = await readVoorraadRows();
      const visible = rows.filter((r) => !isExcludedFromVoorraadHealth(r.filiaalNummer));
      const filtered = (store ? visible.filter((r) => r.store === store) : visible)
        .filter((r) => r.voorraad < 0)
        .sort((a, b) => a.voorraad - b.voorraad) /* meest-negatief eerst */
        .slice(0, 500)
        .map((r) => ({ store: r.store, filiaalNummer: r.filiaalNummer, sku: r.sku, voorraad: r.voorraad, ideaal: r.ideaal }));
      payload.negatief = filtered;
      payload.negatiefScopedStore = store || null;
    }

    return res.status(200).json(payload);
  } catch (e) {
    console.error('[admin/voorraad-gezondheid]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
