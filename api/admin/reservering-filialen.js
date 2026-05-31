/**
 * GET /api/admin/reservering-filialen
 *
 * READ-ONLY: toont de echte inhoud van de SRS RES-filialen (reserverings-
 * filialen 201-222) per winkel, uit de dagelijkse voorraad-snapshot. We
 * kunnen niet naar SRS schrijven; dit toont alleen "wat staat er gereserveerd
 * per winkel".
 *
 * Zelf-verifiërend: `totalResRows` / `resBranchesWithStock` laten zien of de
 * RES-filialen überhaupt in de voorraad-export zitten. Is dat 0, dan exporteert
 * SRS de RES-filialen (nog) niet mee en moeten we een andere bron zoeken.
 *
 * Query: ?store=<winkelnaam>  (optioneel — alleen die winkel)
 *
 * Auth: admin-token vereist.
 */

import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { readVoorraadRows, readVoorraadSummary } from '../../lib/srs-voorraad-store.js';
import { listReserveringBranches } from '../../lib/reserveringen-branch-mapping.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  try {
    const storeFilter = String(req.query.store || '').trim();
    const branches = listReserveringBranches();
    const branchById = new Map(branches.map((b) => [String(b.branchId), b]));

    const byStore = new Map();
    for (const b of branches) {
      byStore.set(b.store, { store: b.store, resBranchId: String(b.branchId), resName: b.resName, skuCount: 0, stuks: 0, items: [] });
    }

    const rows = await readVoorraadRows();
    let totalResRows = 0;
    for (const r of rows) {
      const b = branchById.get(String(r.filiaalNummer));
      if (!b) continue;
      const v = Number(r.voorraad || 0);
      if (v <= 0) continue;
      totalResRows += 1;
      const cell = byStore.get(b.store);
      cell.skuCount += 1;
      cell.stuks += v;
      cell.items.push({ sku: r.sku, voorraad: v });
    }

    let out = [...byStore.values()];
    if (storeFilter) out = out.filter((s) => s.store.toLowerCase() === storeFilter.toLowerCase());
    out.sort((a, b) => b.stuks - a.stuks);

    let summaryAt = null;
    try { summaryAt = (await readVoorraadSummary())?.generatedAt || null; } catch (_) {}

    return res.status(200).json({
      success: true,
      voorraadGeneratedAt: summaryAt,
      resBranchesConfigured: branches.length,
      resBranchesWithStock: out.filter((s) => s.stuks > 0).length,
      totalResRows,
      byStore: out
    });
  } catch (error) {
    console.error('[admin/reservering-filialen]', error);
    return res.status(500).json({ success: false, message: error.message || 'Reservering-filialen kon niet worden gelezen.' });
  }
}
