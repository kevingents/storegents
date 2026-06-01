/**
 * lib/retail-forecast.js
 *
 * Omzet-prognose + budget per winkel, bovenop de jaaranalyse-aggregatie
 * (analyzeYears). Methode (retail-standaard "seizoen-naïef × YTD-groei"):
 *   - actuals van het lopende jaar t/m de laatste maand met data (M)
 *   - YTD-groei g = omzet[jaar, jan..M] / omzet[vorig jaar, jan..M]
 *   - prognose resterende maanden = vorig jaar zelfde maand × g
 *   - prognose heel jaar = actuals + prognose-rest
 *   - budget = vorig jaar (heel) × (1 + groeidoel%)
 *   - vsBudget = prognose / budget − 1
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const omz = (cell) => (cell && cell.omzet) || 0;

/**
 * @param {object} analysis  resultaat van analyzeYears(ledger, [year, priorYear])
 * @param {object} opts { year, priorYear, groeitargetPct }
 */
export function buildForecast(analysis, { year, priorYear, groeitargetPct = 0 } = {}) {
  const y = String(year), p = String(priorYear);
  const gFactor = 1 + (Number(groeitargetPct) || 0) / 100;

  /* Laatste maand met data in het primaire jaar = grens actual/forecast. */
  const totY = (analysis.totalsByYear || {})[y] || [];
  let M = -1;
  for (let i = 0; i < totY.length; i++) { if (omz(totY[i]) > 0) M = i; }

  const stores = (analysis.stores || []).map((s) => {
    const aY = (s.byYear || {})[y] || [];
    const aP = (s.byYear || {})[p] || [];
    let actualYtd = 0, priorYtd = 0, priorFull = 0;
    for (let i = 0; i < 12; i++) {
      const pv = omz(aP[i]);
      priorFull += pv;
      if (i <= M) { actualYtd += omz(aY[i]); priorYtd += pv; }
    }
    const growth = priorYtd > 0 ? actualYtd / priorYtd : 1;

    const maandActual = [], maandForecast = [];
    let forecastRest = 0;
    for (let i = 0; i < 12; i++) {
      const av = omz(aY[i]);
      if (i <= M) { maandActual.push(round2(av)); maandForecast.push(round2(av)); }
      else { const f = round2(omz(aP[i]) * growth); maandActual.push(null); maandForecast.push(f); forecastRest += f; }
    }
    const forecastFull = round2(actualYtd + forecastRest);
    const budget = round2(priorFull * gFactor);
    return {
      store: s.store, branchId: s.branchId,
      actualYtd: round2(actualYtd), priorYtd: round2(priorYtd), priorFull: round2(priorFull),
      groeiYtdPct: priorYtd > 0 ? round1((growth - 1) * 100) : null,
      forecastRest: round2(forecastRest), forecastFull,
      budget,
      vsBudgetPct: budget > 0 ? round1((forecastFull / budget - 1) * 100) : null,
      onTrack: budget > 0 ? forecastFull >= budget : null,
      maandActual, maandForecast,
      nieuw: priorFull <= 0 && actualYtd > 0   /* nieuwe winkel (geen vorig jaar) */
    };
  }).sort((a, b) => b.forecastFull - a.forecastFull);

  /* Totalen. */
  let tActual = 0, tForecast = 0, tBudget = 0, tPriorFull = 0, tPriorYtd = 0;
  const tMaandA = Array(12).fill(0), tMaandF = Array(12).fill(0);
  for (const s of stores) {
    tActual += s.actualYtd; tForecast += s.forecastFull; tBudget += s.budget; tPriorFull += s.priorFull; tPriorYtd += s.priorYtd;
    for (let i = 0; i < 12; i++) { if (s.maandActual[i] != null) tMaandA[i] += s.maandActual[i]; tMaandF[i] += s.maandForecast[i] || 0; }
  }
  const totals = {
    actualYtd: round2(tActual), priorYtd: round2(tPriorYtd), priorFull: round2(tPriorFull),
    groeiYtdPct: tPriorYtd > 0 ? round1((tActual / tPriorYtd - 1) * 100) : null,
    forecastFull: round2(tForecast), budget: round2(tBudget),
    vsBudgetPct: tBudget > 0 ? round1((tForecast / tBudget - 1) * 100) : null,
    onTrack: tBudget > 0 ? tForecast >= tBudget : null,
    maandActual: tMaandA.map(round2), maandForecast: tMaandF.map(round2)
  };

  return { year: y, priorYear: p, cutoffMonth: M, months: analysis.months || [], groeitargetPct: Number(groeitargetPct) || 0, stores, totals };
}
