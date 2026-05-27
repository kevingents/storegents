/**
 * /api/admin/report-builder/sources
 *
 * GET → { success, sources: [{key, label, description, icon, availableColumns,
 *                              defaultColumns, availableFilters}],
 *         filterOptions: { stores: [...] } }
 *
 * Discovery-endpoint voor de frontend builder. Geeft alle data-bronnen +
 * hun beschikbare kolommen/filters + dynamische filter-option-bronnen
 * (bv. winkellijst).
 *
 * Auth: admin-token vereist.
 */

import { listSources, resolveFilterOptionsSource } from '../../../lib/report-builder-sources.js';
import { corsJson, requireAdmin } from '../../../lib/request-guards.js';

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  try {
    const sources = listSources();

    /* Resolve dynamische options-sources (bv. 'stores' = lijst winkels) */
    const filterOptionsByKey = {};
    sources.forEach((s) => {
      (s.availableFilters || []).forEach((f) => {
        if (f.source && !filterOptionsByKey[f.source]) {
          filterOptionsByKey[f.source] = resolveFilterOptionsSource(f.source);
        }
      });
    });

    return res.status(200).json({
      success: true,
      sources,
      filterOptions: filterOptionsByKey,
      generatedAt: new Date().toISOString()
    });
  } catch (e) {
    console.error('[admin/report-builder/sources]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
