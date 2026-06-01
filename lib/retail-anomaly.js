/**
 * lib/retail-anomaly.js
 *
 * Omzet-anomaliedetectie per winkel: vergelijk de laatste N dagen met exact
 * dezelfde weekdagen vorig jaar (−364 dagen = 52 weken, dus zelfde weekdag).
 * Vlagt winkels die meer dan de drempel afwijken (vooral dalingen). Smoothing
 * via een venster (default 7 dagen) tegen dag-ruis; flag alleen als er genoeg
 * basis-dagen zijn (anders onbetrouwbaar, bv. nieuwe winkel).
 */

import { readLedger } from './srs-retail-ledger.js';
import { listBranches, getStoreNameByBranchId } from './branch-metrics.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
function addDays(dateStr, n) {
  const d = new Date(String(dateStr) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function detectAnomalies({ windowDays = 7, thresholdPct = 25 } = {}) {
  const win = Math.max(1, Math.min(31, Math.round(windowDays)));
  const ledger = await readLedger().catch(() => ({ stores: {} }));
  const physical = new Set(listBranches({ includeInternal: false }).map((b) => String(b.branchId)));

  let maxDate = '0000-00-00';
  for (const [fil, s] of Object.entries(ledger.stores || {})) {
    if (physical.size && !physical.has(String(fil))) continue;
    for (const d of Object.keys(s.days || {})) if (d > maxDate) maxDate = d;
  }
  if (maxDate === '0000-00-00') {
    return { window: null, thresholdPct, windowDays: win, stores: [], flaggedCount: 0, generatedAt: new Date().toISOString() };
  }

  const winDates = [];
  for (let i = win - 1; i >= 0; i--) winDates.push(addDays(maxDate, -i));
  const baseDates = winDates.map((d) => addDays(d, -364)); /* zelfde weekdag vorig jaar */
  const minDays = Math.ceil(win / 2);

  const rows = [];
  for (const [fil, s] of Object.entries(ledger.stores || {})) {
    if (physical.size && !physical.has(String(fil))) continue;
    const days = s.days || {};
    let recent = 0, base = 0, recentDays = 0, baseDays = 0;
    for (const d of winDates) { const v = days[d]; if (v) { recent += Number(v.omzet) || 0; recentDays += 1; } }
    for (const d of baseDates) { const v = days[d]; if (v) { base += Number(v.omzet) || 0; baseDays += 1; } }
    if (base <= 0 && recent <= 0) continue;
    const devPct = base > 0 ? round1(((recent - base) / base) * 100) : null;
    const betrouwbaar = baseDays >= minDays && recentDays >= minDays;
    rows.push({
      branchId: String(fil), store: s.name || getStoreNameByBranchId(fil) || `Filiaal ${fil}`,
      recent: round2(recent), base: round2(base), devPct, verschil: round2(recent - base),
      recentDays, baseDays, betrouwbaar,
      flagged: devPct != null && betrouwbaar && Math.abs(devPct) >= thresholdPct,
      richting: devPct == null ? null : (devPct < 0 ? 'daling' : 'stijging')
    });
  }
  rows.sort((a, b) => ((a.devPct == null) ? 999 : a.devPct) - ((b.devPct == null) ? 999 : b.devPct));

  return {
    window: { from: winDates[0], to: maxDate, baseFrom: baseDates[0], baseTo: baseDates[baseDates.length - 1] },
    thresholdPct, windowDays: win,
    stores: rows,
    flaggedCount: rows.filter((r) => r.flagged).length,
    dalingen: rows.filter((r) => r.flagged && r.devPct < 0),
    generatedAt: new Date().toISOString()
  };
}
