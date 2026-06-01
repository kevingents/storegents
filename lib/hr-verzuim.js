/**
 * lib/hr-verzuim.js
 *
 * Ziekteverzuim-analyse bovenop het bestaande verlof-/afwezigheidsoverzicht
 * (Werktijden /leaves + /absences). Verzuim = de rijen waarvan het type als
 * ziekte telt — instelbaar via de in-tool config (hr.verzuimTypes), default
 * matcht "ziek/verzuim". Berekent de Nederlandse standaard-KPI's:
 *   - verzuimpercentage = ziekte-uren / geplande (rooster)uren
 *   - meldingsfrequentie (ziekmeldingen per medewerker per jaar)
 *   - gemiddelde verzuimduur + Vernet-klassen kort (≤7d) / middel (8-42d) / lang (>42d)
 *   - wie is er nu ziek + per winkel
 */

import { getLeaveOverview, computeHrProductivity } from './hr-productivity.js';
import { getEmployees } from './werktijden-client.js';
import { readPortalConfig } from './portal-config-store.js';

const num = (n) => Number(n) || 0;
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const nlToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
function dayspan(from, to) {
  const a = new Date(String(from) + 'T00:00:00Z');
  const b = new Date(String(to || from) + 'T00:00:00Z');
  if (isNaN(a) || isNaN(b)) return 1;
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}
function sicknessMatcher(types) {
  const list = (types || []).map((s) => String(s).toLowerCase().trim()).filter(Boolean);
  if (list.length) return (t) => { const x = String(t || '').toLowerCase(); return list.some((s) => x.includes(s)); };
  return (t) => /ziek|verzuim/i.test(String(t || ''));
}

/**
 * @param {object} p
 * @param {string} p.from 'YYYY-MM-DD'
 * @param {string} p.to   'YYYY-MM-DD'
 * @param {boolean} [p.withPercent=true]  bereken verzuim% via rooster-uren
 */
export async function getVerzuimOverview({ from, to, withPercent = true } = {}) {
  const cfg = await readPortalConfig().catch(() => ({}));
  const hrCfg = (cfg && cfg.hr) || {};
  const isSick = sicknessMatcher(hrCfg.verzuimTypes);
  const targetPct = Number(hrCfg.verzuimTargetPct) > 0 ? Number(hrCfg.verzuimTargetPct) : null;

  const lo = await getLeaveOverview({ from, to });
  const sick = (lo.rows || []).filter((r) => isSick(r.type));

  const today = nlToday();
  const periodDays = dayspan(from, to);

  const stores = new Map();
  const empAll = new Set();
  let meldingen = 0, ziekteUren = 0, ziekteDagen = 0, kort = 0, middel = 0, lang = 0;
  const nuZiek = [];

  for (const r of sick) {
    meldingen += 1;
    if (r.employeeId) empAll.add(String(r.employeeId));
    const dgn = r.days != null ? num(r.days) : dayspan(r.from, r.to);
    const urn = num(r.hours);
    ziekteDagen += dgn; ziekteUren += urn;
    if (dgn <= 7) kort += 1; else if (dgn <= 42) middel += 1; else lang += 1;

    const key = r.store || r.department || 'Onbekend';
    let s = stores.get(key);
    if (!s) { s = { store: key, isOffice: !!r.isOffice, meldingen: 0, emp: new Set(), uren: 0, dagen: 0, kort: 0, middel: 0, lang: 0 }; stores.set(key, s); }
    s.meldingen += 1; if (r.employeeId) s.emp.add(String(r.employeeId)); s.uren += urn; s.dagen += dgn;
    if (dgn <= 7) s.kort += 1; else if (dgn <= 42) s.middel += 1; else s.lang += 1;

    if (String(r.from) <= today && today <= String(r.to || r.from)) {
      nuZiek.push({ name: r.name, store: key, type: r.type, from: r.from, to: r.to, dagen: dgn, isOffice: !!r.isOffice, dagenLopend: dayspan(r.from, today) });
    }
  }

  /* Geplande (rooster)uren als noemer voor het verzuim% — best-effort. */
  let geplandeByStore = null, geplandeTotaal = 0;
  if (withPercent) {
    try {
      const prod = await computeHrProductivity({ from, to });
      geplandeByStore = new Map((prod.rows || []).map((r) => [r.store, num(r.uren)]));
      geplandeTotaal = num(prod.totals && prod.totals.uren);
    } catch { /* uren-bron faalt → toon KPI's zonder % */ }
  }

  /* Headcount voor meldingsfrequentie (per medewerker per jaar) — best-effort. */
  let headcount = 0;
  try { headcount = (await getEmployees()).length; } catch { /* geen headcount → freq null */ }

  const perStore = [...stores.values()].map((s) => {
    const planned = geplandeByStore ? (geplandeByStore.get(s.store) || 0) : 0;
    return {
      store: s.store, isOffice: s.isOffice,
      meldingen: s.meldingen, medewerkers: s.emp.size,
      uren: round1(s.uren), dagen: round1(s.dagen),
      kort: s.kort, middel: s.middel, lang: s.lang,
      verzuimPct: planned > 0 ? round1((s.uren / planned) * 100) : null
    };
  }).sort((a, b) => (b.verzuimPct || 0) - (a.verzuimPct || 0) || b.meldingen - a.meldingen);

  const verzuimPct = geplandeTotaal > 0 ? round1((ziekteUren / geplandeTotaal) * 100) : null;
  const meldingsfreqJaar = headcount > 0 ? round1((meldingen / headcount) * (365 / periodDays)) : null;

  nuZiek.sort((a, b) => String(a.from).localeCompare(String(b.from)));

  return {
    window: { from, to, dagen: periodDays },
    totals: {
      meldingen, medewerkers: empAll.size,
      ziekteUren: round1(ziekteUren), ziekteDagen: round1(ziekteDagen),
      gemDuur: meldingen ? round1(ziekteDagen / meldingen) : null,
      kort, middel, lang,
      verzuimPct, geplandeUren: round1(geplandeTotaal),
      headcount, meldingsfreqJaar, targetPct
    },
    perStore,
    nuZiek,
    typesGevonden: [...new Set(sick.map((r) => r.type))].sort(),
    leavesSource: lo.leavesSource,
    error: lo.leavesError
  };
}
