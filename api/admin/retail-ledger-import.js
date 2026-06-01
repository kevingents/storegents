/**
 * /api/admin/retail-ledger-import
 *
 * Laad een vooraf-geaggregeerde verkoop-daily-JSON (uit de SRS Rapportontwerper-
 * export, per filiaal per dag) in de omzet-ledger (srs/verkopen-daily.json).
 * Hiermee kun je hele jaren omzet+bonnen ineens vullen/rechttrekken zonder op de
 * dagelijkse SFTP te wachten.
 *
 * POST {
 *   days: { [branchId]: { 'YYYY-MM-DD': { omzet, gross, refund, bonnen, grossItems, refundItems, bezoekers } } },
 *   include: 'physical' (default) | 'all'   // physical = alleen echte winkels; webshop/magazijn eruit
 * }
 *
 * mergeLedger overschrijft per (filiaal,datum) en bewaart de rest. Auth: admin.
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { mergeLedger } from '../../lib/srs-retail-ledger.js';
import { listBranches, getStoreNameByBranchId } from '../../lib/branch-metrics.js';

export const maxDuration = 60;

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
}
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export default async function handler(req, res) {
  if (corsJson(req, res, ['POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });

  try {
    const body = parseBody(req);
    const days = (body.days && typeof body.days === 'object') ? body.days : body;
    if (!days || typeof days !== 'object' || Array.isArray(days)) {
      return res.status(400).json({ success: false, message: 'Geen geldige data: verwacht { days: { branchId: { datum: {...} } } }.' });
    }
    const include = String(body.include || 'physical').toLowerCase();

    /* Fysieke winkels (geen webshop/magazijn/intern). */
    const physical = new Set(listBranches({ includeInternal: false }).map((b) => String(b.branchId)));

    const filtered = {};
    const loaded = [];
    const skipped = [];
    for (const [fil, dmap] of Object.entries(days)) {
      if (!dmap || typeof dmap !== 'object') continue;
      const isPhys = physical.has(String(fil));
      if (include !== 'all' && !isPhys) { skipped.push({ branchId: fil, name: getStoreNameByBranchId(fil) || '' }); continue; }
      filtered[fil] = dmap;
      loaded.push({ branchId: fil, name: getStoreNameByBranchId(fil) || '' });
    }
    if (!Object.keys(filtered).length) {
      return res.status(400).json({ success: false, message: 'Geen (fysieke) filialen om te laden.', skipped });
    }

    await mergeLedger(filtered);

    /* Samenvatting. */
    let totOmzet = 0, dagEntries = 0, minD = '9999-99-99', maxD = '0000-00-00';
    for (const dmap of Object.values(filtered)) {
      for (const [date, e] of Object.entries(dmap)) {
        totOmzet += Number(e.omzet) || 0; dagEntries += 1;
        if (date < minD) minD = date; if (date > maxD) maxD = date;
      }
    }
    return res.status(200).json({
      success: true,
      include,
      filialenGeladen: loaded.length,
      dagEntries,
      totaalOmzet: round2(totOmzet),
      range: { from: minD, to: maxD },
      geladen: loaded.sort((a, b) => Number(a.branchId) - Number(b.branchId)),
      overgeslagen: skipped
    });
  } catch (e) {
    console.error('[admin/retail-ledger-import]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
