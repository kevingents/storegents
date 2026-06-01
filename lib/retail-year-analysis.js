/**
 * lib/retail-year-analysis.js
 *
 * Aggregeert de omzet-ledger (srs/verkopen-daily.json) naar maand × winkel ×
 * jaar, voor jaar-op-jaar analyse (omzet, bonnen, stuks, bezoekers). De
 * frontend leidt daar gem. bonbedrag (omzet/bonnen) en conversie (bonnen/
 * bezoekers) uit af, en de YoY-vergelijking.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const FIELDS = ['omzet', 'gross', 'refund', 'bonnen', 'grossItems', 'refundItems', 'bezoekers'];

export const MONTH_LABELS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

function blankMonths() {
  return Array.from({ length: 12 }, () => ({ omzet: 0, gross: 0, refund: 0, bonnen: 0, grossItems: 0, refundItems: 0, bezoekers: 0 }));
}
function roundMonths(months) {
  return months.map((c) => ({
    omzet: round2(c.omzet), gross: round2(c.gross), refund: round2(c.refund),
    bonnen: Math.round(c.bonnen), grossItems: Math.round(c.grossItems),
    refundItems: Math.round(c.refundItems), bezoekers: Math.round(c.bezoekers)
  }));
}

/**
 * @param {object} ledger  { stores: { [filiaal]: { name, days: { 'YYYY-MM-DD': {...} } } } }
 * @param {string[]} years bv. ['2026','2025']
 * @returns {{years, months, stores:[{branchId,store,byYear:{[y]:Month[12]}, yearTotals:{[y]:Month}}], totalsByYear, anyVisitors}}
 */
export function analyzeYears(ledger, years) {
  const yset = (years || []).map(String);
  const totalsByYear = {};
  for (const y of yset) totalsByYear[y] = blankMonths();

  const stores = [];
  let anyVisitors = false;

  for (const [fil, s] of Object.entries((ledger && ledger.stores) || {})) {
    const byYear = {};
    for (const y of yset) byYear[y] = blankMonths();
    let hit = false;

    for (const [date, v] of Object.entries(s.days || {})) {
      const y = String(date).slice(0, 4);
      if (!yset.includes(y)) continue;
      const mi = Number(String(date).slice(5, 7)) - 1;
      if (mi < 0 || mi > 11) continue;
      const cell = byYear[y][mi];
      const tcell = totalsByYear[y][mi];
      for (const k of FIELDS) {
        const n = Number(v[k]) || 0;
        cell[k] += n; tcell[k] += n;
        if (k === 'bezoekers' && n > 0) anyVisitors = true;
      }
      hit = true;
    }
    if (!hit) continue;

    /* Jaartotaal per store. */
    const yearTotals = {};
    let grandOmzet = 0;
    for (const y of yset) {
      const t = { omzet: 0, gross: 0, refund: 0, bonnen: 0, grossItems: 0, refundItems: 0, bezoekers: 0 };
      for (const c of byYear[y]) for (const k of FIELDS) t[k] += c[k];
      yearTotals[y] = { omzet: round2(t.omzet), gross: round2(t.gross), refund: round2(t.refund), bonnen: Math.round(t.bonnen), grossItems: Math.round(t.grossItems), refundItems: Math.round(t.refundItems), bezoekers: Math.round(t.bezoekers) };
      grandOmzet += t.omzet;
    }
    /* Lege/0-omzet stores (bv. magazijn) overslaan. */
    if (grandOmzet <= 0) continue;

    const out = { branchId: fil, store: s.name || fil, byYear: {}, yearTotals, grandOmzet: round2(grandOmzet) };
    for (const y of yset) out.byYear[y] = roundMonths(byYear[y]);
    stores.push(out);
  }

  stores.sort((a, b) => b.grandOmzet - a.grandOmzet);

  const totals = {};
  for (const y of yset) totals[y] = roundMonths(totalsByYear[y]);

  return { years: yset, months: MONTH_LABELS, stores, totalsByYear: totals, anyVisitors };
}
