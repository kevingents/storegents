/**
 * lib/omzet-forecast.js
 *
 * Omzet-forecast voor de REST van de lopende maand, per fysieke winkel + totaal.
 * Uitlegbaar (geen black-box), op basis van de dagelijkse SRS-retail-ledger:
 *
 *   - run-rate  : gemiddelde dag-omzet (trailing 28 dagen) × resterende dagen
 *   - seizoen   : maand-tot-nu × (vorig jaar HELE maand ÷ vorig jaar tot-zelfde-dag)
 *                 → vangt het intra-maand-seizoenspatroon (YoY)
 *   - base      : gemiddelde van run-rate en seizoen (of de beschikbare)
 *   - best/worst: base ± een datagedreven bandbreedte (volatiliteit van de dag-omzet)
 *
 * Faalt zacht: geen ledger → lege forecast.
 */

import { readLedger } from './srs-retail-ledger.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const nlToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
const pad2 = (n) => String(n).padStart(2, '0');
const daysInMonth = (y, m) => new Date(y, m, 0).getDate(); /* m = 1-12 */
function addDays(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

function sumRange(days, from, to) {
  let s = 0;
  for (const [d, v] of Object.entries(days || {})) if (d >= from && d <= to) s += (v.omzet || 0);
  return r2(s);
}
function dailyValues(days, from, to) {
  const out = [];
  for (const [d, v] of Object.entries(days || {})) if (d >= from && d <= to) out.push(v.omzet || 0);
  return out;
}
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function cv(a) { const m = mean(a); if (!m) return 0; const varr = mean(a.map((x) => (x - m) * (x - m))); return Math.sqrt(varr) / m; }

function forecastDays(days, ctx) {
  const { today, monthStart, dayOfMonth, dim, lyStart, lySameDay, lyEnd } = ctx;
  const mtd = sumRange(days, monthStart, today);
  const remainingDays = Math.max(0, dim - dayOfMonth);

  /* Run-rate: trailing 28 kalenderdagen, gemiddelde per dag (gesloten dagen tellen
     als 0 → conservatief). */
  const trail = dailyValues(days, addDays(today, -27), today);
  const runRatePerDay = r2(trail.reduce((s, x) => s + x, 0) / 28);
  const runRateRest = r2(runRatePerDay * remainingDays);

  /* Seizoen (YoY): rest van de maand volgens vorig jaars maand-vorm. */
  const lyMtd = sumRange(days, lyStart, lySameDay);
  const lyFull = sumRange(days, lyStart, lyEnd);
  const haveYoy = lyMtd > 0 && lyFull > 0;
  const seasonalRest = haveYoy ? r2(mtd * (lyFull / lyMtd) - mtd) : null;

  let baseRest;
  if (seasonalRest != null && remainingDays > 0) baseRest = r2((seasonalRest + runRateRest) / 2);
  else baseRest = runRateRest;
  baseRest = Math.max(0, baseRest);

  const band = Math.min(0.30, Math.max(0.08, cv(trail) * 0.6));
  return {
    mtd,
    remainingDays,
    runRatePerDay,
    base: r2(mtd + baseRest),
    best: r2(mtd + baseRest * (1 + band)),
    worst: r2(mtd + baseRest * (1 - band)),
    bandPct: r2(band * 100),
    lyFullMonth: haveYoy ? lyFull : null,
    yoyPct: lyMtd > 0 ? r2((mtd / lyMtd - 1) * 100) : null,
    method: seasonalRest != null ? 'run-rate + YoY-seizoen' : 'run-rate'
  };
}

export async function computeOmzetForecast() {
  const ledger = await readLedger();
  const today = nlToday();
  const [Y, M, D] = today.split('-').map(Number);
  const monthStart = `${Y}-${pad2(M)}-01`;
  const dim = daysInMonth(Y, M);
  const ly = Y - 1;
  const lyDim = daysInMonth(ly, M);
  const ctx = {
    today, monthStart, dayOfMonth: D, dim,
    lyStart: `${ly}-${pad2(M)}-01`,
    lySameDay: `${ly}-${pad2(M)}-${pad2(Math.min(D, lyDim))}`,
    lyEnd: `${ly}-${pad2(M)}-${pad2(lyDim)}`
  };

  const stores = [];
  const totalDays = {};
  for (const [fil, s] of Object.entries(ledger.stores || {})) {
    const f = forecastDays(s.days || {}, ctx);
    if (f.mtd <= 0 && f.runRatePerDay <= 0 && f.lyFullMonth == null) continue; /* lege winkel overslaan */
    stores.push({ filiaalNummer: fil, store: s.name || fil, ...f });
    for (const [d, v] of Object.entries(s.days || {})) {
      if (!totalDays[d]) totalDays[d] = { omzet: 0 };
      totalDays[d].omzet += (v.omzet || 0);
    }
  }
  stores.sort((a, b) => b.base - a.base);

  return {
    today,
    month: `${Y}-${pad2(M)}`,
    dim,
    dayOfMonth: D,
    total: { store: 'Alle winkels', ...forecastDays(totalDays, ctx) },
    stores,
    refreshedAt: ledger.updatedAt || null,
    coverage: ledger.coverage || null
  };
}
