/**
 * /api/admin/retail-year-analysis
 *
 * Jaaranalyse over de omzet-ledger (srs/verkopen-daily.json): omzet/bonnen/
 * stuks/bezoekers per maand × winkel × jaar, voor jaar-op-jaar vergelijking.
 * De frontend leidt gem. bonbedrag (omzet/bonnen), conversie (bonnen/bezoekers)
 * en YoY-% daaruit af.
 *
 * GET ?years=2026,2025   (of ?yearA=2026&yearB=2025)
 *   → { success, years, months, stores:[{branchId,store,byYear,yearTotals}], totalsByYear, anyVisitors, beschikbareJaren, updatedAt }
 *
 * Auth: admin.
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { readLedger } from '../../lib/srs-retail-ledger.js';
import { analyzeYears } from '../../lib/retail-year-analysis.js';

export const maxDuration = 30;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  try {
    const q = req.query || {};
    let years = [];
    if (q.years) {
      years = String(q.years).split(',').map((s) => s.trim()).filter((s) => /^\d{4}$/.test(s));
    } else {
      for (const k of ['yearA', 'yearB', 'yearC']) {
        if (q[k] && /^\d{4}$/.test(String(q[k]).trim())) years.push(String(q[k]).trim());
      }
    }

    const ledger = await readLedger();

    /* Welke jaren zitten überhaupt in de ledger? */
    const jaarSet = new Set();
    for (const s of Object.values(ledger.stores || {})) {
      for (const d of Object.keys(s.days || {})) {
        const y = String(d).slice(0, 4);
        if (/^\d{4}$/.test(y)) jaarSet.add(y);
      }
    }
    const beschikbareJaren = [...jaarSet].sort().reverse();

    /* Geen jaren opgegeven → pak de twee meest recente beschikbare jaren. */
    if (!years.length) years = beschikbareJaren.slice(0, 2);
    if (!years.length) {
      return res.status(200).json({
        success: true, years: [], months: [], stores: [], totalsByYear: {},
        anyVisitors: false, beschikbareJaren, updatedAt: ledger.updatedAt || null,
        leeg: true, message: 'Nog geen verkoop-historie geladen. Importeer eerst via Instellingen → Verkoop-historie.'
      });
    }
    /* Uniek + aflopend (nieuwste jaar eerst). */
    years = [...new Set(years.map(String))].sort().reverse();

    const analysis = analyzeYears(ledger, years);
    return res.status(200).json({
      success: true,
      ...analysis,
      beschikbareJaren,
      updatedAt: ledger.updatedAt || null
    });
  } catch (e) {
    console.error('[admin/retail-year-analysis]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
