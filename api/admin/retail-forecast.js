/**
 * GET  /api/admin/retail-forecast?year=2026&priorYear=2025&groeitarget=0
 * POST /api/admin/retail-forecast { groeitargetPct }   → bewaar groeidoel
 *
 * Omzet-prognose + budget per winkel uit de omzet-ledger. Het groeidoel
 * (budget = vorig jaar × (1+groei%)) staat in de in-tool config; de query-param
 * overschrijft tijdelijk voor "wat-als".
 *
 * Read-only (GET). Auth: admin-token.
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { readLedger } from '../../lib/srs-retail-ledger.js';
import { analyzeYears } from '../../lib/retail-year-analysis.js';
import { buildForecast } from '../../lib/retail-forecast.js';
import { readPortalConfig, savePortalConfig } from '../../lib/portal-config-store.js';

export const maxDuration = 30;

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  if (req.method === 'POST') {
    try {
      const b = parseBody(req);
      const cfg = await savePortalConfig({ forecast: { groeitargetPct: b.groeitargetPct } }, 'admin');
      return res.status(200).json({ success: true, groeitargetPct: (cfg.forecast || {}).groeitargetPct ?? 0 });
    } catch (e) {
      return res.status(500).json({ success: false, message: e.message || 'Opslaan mislukt.' });
    }
  }
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });

  try {
    const ledger = await readLedger().catch(() => ({ stores: {} }));
    /* Beschikbare jaren uit de ledger. */
    const yearsSet = new Set();
    for (const s of Object.values(ledger.stores || {})) {
      for (const d of Object.keys(s.days || {})) yearsSet.add(String(d).slice(0, 4));
    }
    const beschikbareJaren = [...yearsSet].sort().reverse();

    const cfg = await readPortalConfig().catch(() => ({ forecast: {} }));
    const savedGroei = Number((cfg.forecast || {}).groeitargetPct) || 0;

    const year = String(req.query.year || beschikbareJaren[0] || new Date().getFullYear());
    const priorYear = String(req.query.priorYear || beschikbareJaren.find((y) => y < year) || (Number(year) - 1));
    const groeitargetPct = req.query.groeitarget != null && req.query.groeitarget !== ''
      ? Number(req.query.groeitarget) : savedGroei;

    const analysis = analyzeYears(ledger, [year, priorYear]);
    const forecast = buildForecast(analysis, { year, priorYear, groeitargetPct });

    return res.status(200).json({ success: true, beschikbareJaren, anyVisitors: analysis.anyVisitors, savedGroeitargetPct: savedGroei, ...forecast });
  } catch (e) {
    console.error('[admin/retail-forecast]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
