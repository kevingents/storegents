/**
 * GET /api/admin/retour-redenen
 *
 * Winkel-retouren per reden (klacht/retour/ruiling/overig), per winkel, periode-
 * instelbaar. Bron: reports/retour-redenen.json (opgebouwd door de retail-import
 * uit de SRS verkopen-export). Pure winkel-retouren — webshop is uitgesloten.
 *
 * Query: ?period=vandaag|week|maand|kwartaal|jaar  óf  ?from=YYYY-MM-DD&to=YYYY-MM-DD
 *        ?store=<naam>   (optioneel)
 *        ?details=1      (voeg detailregels toe, max 5000)
 *
 * Auth: admin-token vereist.
 */

import { readRetourRedenen, aggregateRetourRedenen, retourDetailsInRange } from '../../lib/retour-redenen-store.js';
import { periodToRange } from '../../lib/srs-retail-ledger.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  try {
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const range = (from && to) ? periodToRange('custom', { from, to }) : periodToRange(String(req.query.period || 'maand'));
    const store = String(req.query.store || '').trim();
    const wantDetails = ['1', 'true', 'yes'].includes(String(req.query.details || '').toLowerCase());

    const data = await readRetourRedenen();
    const agg = aggregateRetourRedenen(data, { from: range.from, to: range.to });
    const perStore = store ? agg.perStore.filter((r) => String(r.store || '').toLowerCase() === store.toLowerCase()) : agg.perStore;

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({
      success: true,
      window: range,
      updatedAt: data.updatedAt,
      perStore,
      totals: agg.totals,
      totaalRegels: agg.totaalRegels,
      totaalEur: agg.totaalEur,
      ...(wantDetails ? { details: retourDetailsInRange(data, { from: range.from, to: range.to, store }).slice(0, 5000) } : {})
    });
  } catch (error) {
    console.error('[admin/retour-redenen]', error);
    return res.status(500).json({ success: false, message: error.message || 'Retour-redenen kon niet worden opgehaald.' });
  }
}
