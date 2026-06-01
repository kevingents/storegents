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
  const byEmp = new Map();   /* Bradford: per medewerker spells (S) + dagen (D). */
  const trend = new Map();   /* instroom per maand. */
  let meldingen = 0, ziekteUren = 0, ziekteDagen = 0, ziekteDagenVol = 0, kort = 0, middel = 0, lang = 0;
  const nuZiek = [];

  for (const r of sick) {
    meldingen += 1;
    if (r.employeeId) empAll.add(String(r.employeeId));

    const fFrom = String(r.from || '');
    const fTo = String(r.to || r.from || '');
    /* Volledige duur van de melding → Vernet-klasse + gemiddelde duur. */
    const fullDgn = r.days != null ? num(r.days) : dayspan(fFrom, fTo);
    const fullUren = num(r.hours);

    /* Pro-rata: alleen het deel van de melding dat binnen [from,to] valt telt
       mee voor het verzuim% (uren) en de in-periode dagen. */
    const cFrom = (fFrom && fFrom > from) ? fFrom : from;
    const cTo = (fTo && fTo < to) ? fTo : to;
    const overlapDays = (fFrom && fTo && cFrom <= cTo) ? dayspan(cFrom, cTo) : 0;
    const fullSpan = (fFrom && fTo) ? dayspan(fFrom, fTo) : 1;
    const ratio = fullSpan > 0 ? Math.min(1, overlapDays / fullSpan) : 1;

    const periodUren = fullUren * ratio;
    const periodDagen = fullDgn * ratio;

    ziekteUren += periodUren; ziekteDagen += periodDagen; ziekteDagenVol += fullDgn;
    if (fullDgn <= 7) kort += 1; else if (fullDgn <= 42) middel += 1; else lang += 1;

    const key = r.store || r.department || 'Onbekend';
    let s = stores.get(key);
    if (!s) { s = { store: key, isOffice: !!r.isOffice, meldingen: 0, emp: new Set(), uren: 0, dagen: 0, kort: 0, middel: 0, lang: 0 }; stores.set(key, s); }
    s.meldingen += 1; if (r.employeeId) s.emp.add(String(r.employeeId)); s.uren += periodUren; s.dagen += periodDagen;
    if (fullDgn <= 7) s.kort += 1; else if (fullDgn <= 42) s.middel += 1; else s.lang += 1;

    /* Bradford-factor per medewerker (S² × D) — signaleert frequent kortverzuim. */
    if (r.employeeId) {
      const ek = String(r.employeeId);
      let be = byEmp.get(ek);
      if (!be) { be = { employeeId: ek, name: r.name, store: key, isOffice: !!r.isOffice, spells: 0, dagen: 0 }; byEmp.set(ek, be); }
      be.spells += 1; be.dagen += fullDgn;
    }
    /* Instroom-trend: meldingen + ziektedagen op de start-maand. */
    const ym = fFrom.slice(0, 7);
    if (ym) { const tt = trend.get(ym) || { ym, meldingen: 0, ziektedagen: 0 }; tt.meldingen += 1; tt.ziektedagen += fullDgn; trend.set(ym, tt); }

    if (fFrom <= today && today <= fTo) {
      nuZiek.push({ name: r.name, store: key, type: r.type, from: r.from, to: r.to, dagen: fullDgn, isOffice: !!r.isOffice, dagenLopend: dayspan(fFrom, today) });
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
      gemDuur: meldingen ? round1(ziekteDagenVol / meldingen) : null,
      kort, middel, lang,
      verzuimPct, geplandeUren: round1(geplandeTotaal),
      headcount, meldingsfreqJaar, targetPct
    },
    perStore,
    nuZiek,
    bradford: [...byEmp.values()]
      .map((e) => ({ employeeId: e.employeeId, name: e.name, store: e.store, isOffice: e.isOffice, spells: e.spells, dagen: Math.round(e.dagen), bradford: e.spells * e.spells * Math.round(e.dagen) }))
      .sort((a, b) => b.bradford - a.bradford)
      .slice(0, 25),
    trend: [...trend.values()].sort((a, b) => a.ym.localeCompare(b.ym)).map((t) => ({ ym: t.ym, meldingen: t.meldingen, ziektedagen: round1(t.ziektedagen) })),
    typesGevonden: [...new Set(sick.map((r) => r.type))].sort(),
    leavesSource: lo.leavesSource,
    error: lo.leavesError
  };
}
