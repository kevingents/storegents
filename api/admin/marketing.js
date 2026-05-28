/**
 * /api/admin/marketing
 *
 * GET  → { success, campaigns, content, assets, agency, voorraadAdvies, generatedAt }
 *        voorraadAdvies = per fysieke winkel een advertentie-advies o.b.v. de
 *        voorraad-gezondheid (gezonde voorraad → adverteren zinvol; veel
 *        uitverkocht/tekort → eerst aanvullen, budget verhogen heeft beperkt zin).
 *
 * POST ?action=save-campaign|delete-campaign|save-content|delete-content|
 *              save-asset|delete-asset|save-agency
 *
 * Omzet/visits zelf haalt de frontend via de bestaande revenue-endpoints; deze
 * endpoint levert de marketing-data + het voorraad-advies.
 *
 * Auth: admin-token vereist.
 */

import { readMarketing, upsertItem, deleteItem, saveAgency } from '../../lib/marketing-store.js';
import { readVoorraadSummary } from '../../lib/srs-voorraad-store.js';
import { listBranchesFromConfig } from '../../lib/business-config.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

/* Bouw per fysieke winkel een advertentie-advies uit de voorraad-summary. */
function buildVoorraadAdvies(summary) {
  const retail = new Set(
    listBranchesFromConfig({ includeInternal: false }).map((b) => b.store)
  );
  const filialen = (summary?.filialen || []).filter((f) => retail.has(f.store));
  return filialen.map((f) => {
    const totalSkus = f.totalSkus || 0;
    const outPct = totalSkus ? (f.skusOutOfStock || 0) / totalSkus : 0;
    const underPct = totalSkus ? (f.skusUnderIdeal || 0) / totalSkus : 0;
    let status, advies;
    if (outPct >= 0.15 || underPct >= 0.40) {
      status = 'slecht';
      advies = 'Voorraad is krap (veel uitverkocht / onder streefvoorraad). Budget verhogen heeft beperkt zin — eerst aanvullen, anders adverteer je naar lege schappen.';
    } else if (underPct >= 0.20 || outPct >= 0.07) {
      status = 'matig';
      advies = 'Voorraad is redelijk maar let op tekorten. Adverteren kan; richt extra budget op goed-gevulde categorieën.';
    } else {
      status = 'goed';
      advies = 'Voorraad is gezond — goed moment om te adverteren of het budget te verhogen.';
    }
    return {
      store: f.store,
      filiaalNummer: f.filiaalNummer,
      status,
      advies,
      signals: {
        totalSkus,
        uitverkocht: f.skusOutOfStock || 0,
        onderTarget: f.skusUnderIdeal || 0,
        tekortStuks: f.shortageUnits || 0
      }
    };
  });
}

const ACTION_KIND = {
  'save-campaign': 'campaigns', 'delete-campaign': 'campaigns',
  'save-content': 'content',   'delete-content': 'content',
  'save-asset': 'assets',      'delete-asset': 'assets'
};

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const [marketing, summary] = await Promise.all([readMarketing(), readVoorraadSummary().catch(() => ({}))]);
      return res.status(200).json({
        success: true,
        campaigns: marketing.campaigns,
        content: marketing.content,
        assets: marketing.assets,
        agency: marketing.agency,
        voorraadAdvies: buildVoorraadAdvies(summary),
        voorraadGeneratedAt: summary?.generatedAt || null,
        generatedAt: new Date().toISOString()
      });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const actor = body.actor || { name: 'admin' };
      const action = String(req.query?.action || body.action || '').trim();

      if (action === 'save-agency') {
        const { agency } = await saveAgency(body.agency || {}, actor);
        return res.status(200).json({ success: true, agency });
      }

      const kind = ACTION_KIND[action];
      if (!kind) return res.status(400).json({ success: false, message: `Onbekende actie: ${action}` });

      if (action.startsWith('delete-')) {
        const itemId = String(body.id || '').trim();
        if (!itemId) return res.status(400).json({ success: false, message: 'id verplicht.' });
        await deleteItem(kind, itemId, actor);
        return res.status(200).json({ success: true });
      }

      /* save-* */
      const item = body.item || {};
      const { item: saved } = await upsertItem(kind, item, actor);
      return res.status(200).json({ success: true, item: saved });
    }

    return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });
  } catch (e) {
    console.error('[admin/marketing]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
