/**
 * lib/hr-productivity.js
 *
 * HR-dashboard voor de directie: per periode (week/maand) per filiaal de
 * omzet, het totaal gewerkte uren (alle medewerkers samen) en de
 * productiviteit (omzet / uren). Plus een verlof-overzicht (wie is afwezig).
 *
 * Bronnen:
 *   - Omzet:  verkoop-SFTP-ledger (srs/verkopen-daily.json) via aggregateLedger.
 *   - Uren:   Werktijden.nl timesheets, gegroepeerd per afdeling (= filiaal).
 *   - Verlof: Werktijden.nl absences + employees (naam-lookup) + types.
 *
 * Werktijden-afdelingen worden aan GENTS-winkels gekoppeld via de afdelingsnaam
 * (genormaliseerd met normalizeStoreName). Afdelingen die niet matchen komen
 * terug in `unmatchedDepartments` zodat de mapping zichtbaar/oplosbaar blijft.
 */

import { getTimesheets, getDepartments, getAbsences, getEmployees, getAbsenceTypes } from './werktijden-client.js';
import { readLedger, aggregateLedger, periodToRange } from './srs-retail-ledger.js';
import { normalizeStoreName, listBranches } from './branch-metrics.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round = (n, d = 2) => { const f = 10 ** d; return Math.round(num(n) * f) / f; };
const isoDay = (s) => String(s || '').slice(0, 10);

/* Heuristiek voor "hoofdkantoor"-afdelingen (verlof voor winkels). Kan later
   verfijnd worden met een expliciete config. */
const OFFICE_RE = /kantoor|hoofdkantoor|office|centraal|\bhq\b|administr/i;

export { periodToRange };

/**
 * Omzet + uren + productiviteit per filiaal over [from,to].
 * @returns {Promise<{window, rows, totals, unmatchedDepartments, refreshedAt}>}
 */
export async function computeHrProductivity({ from, to }) {
  /* 1. Omzet per winkel uit de verkoop-ledger (canonieke winkelnaam als sleutel). */
  const ledger = await readLedger();
  const agg = aggregateLedger(ledger, { from, to });
  const revByStore = new Map();
  for (const f of agg.filialen || []) {
    const key = normalizeStoreName(f.store) || f.store;
    revByStore.set(key, round(num(revByStore.get(key)) + num(f.omzet)));
  }

  /* 2. Gewerkte uren per Werktijden-afdeling. */
  const deps = await getDepartments();
  const depNameById = new Map(deps.map((d) => [String(d.id), d.name || '']));
  const sheets = await getTimesheets({ start: from, end: to });
  const hoursByDep = new Map();
  for (const s of sheets) {
    const dep = String(s.department_id || '');
    hoursByDep.set(dep, num(hoursByDep.get(dep)) + num(s.hours));
  }

  /* 3. Uren → winkel via afdelingsnaam (genormaliseerd). */
  const branchNames = new Set(
    listBranches({ includeInternal: true }).map((b) => normalizeStoreName(b.store) || b.store)
  );
  const hoursByStore = new Map();
  const unmatched = [];
  for (const [depId, hrs] of hoursByDep) {
    const depName = depNameById.get(depId) || `Afdeling ${depId}`;
    const store = normalizeStoreName(depName) || depName;
    hoursByStore.set(store, num(hoursByStore.get(store)) + hrs);
    if (!branchNames.has(store)) {
      unmatched.push({ departmentId: depId, departmentName: depName, uren: round(hrs, 1) });
    }
  }

  /* 4. Combineer per winkel. */
  const stores = new Set([...revByStore.keys(), ...hoursByStore.keys()]);
  let tOmzet = 0, tUren = 0;
  const rows = [];
  for (const store of stores) {
    const omzet = round(revByStore.get(store) || 0);
    const uren = round(hoursByStore.get(store) || 0, 1);
    rows.push({ store, omzet, uren, productiviteit: uren > 0 ? round(omzet / uren) : null });
    tOmzet += omzet; tUren += uren;
  }
  rows.sort((a, b) => (b.productiviteit || 0) - (a.productiviteit || 0));

  return {
    window: { from, to },
    rows,
    totals: {
      omzet: round(tOmzet),
      uren: round(tUren, 1),
      productiviteit: tUren > 0 ? round(tOmzet / tUren) : null,
      winkels: rows.filter((r) => r.uren > 0 || r.omzet > 0).length
    },
    unmatchedDepartments: unmatched,
    timesheetCount: sheets.length,
    refreshedAt: ledger.updatedAt || null
  };
}

/**
 * Verlof/afwezigheid over [from,to], verrijkt met medewerkernaam + afdeling.
 * `isOffice` markeert (heuristisch) hoofdkantoor-medewerkers — handig voor het
 * winkel-paneel "wie is er met verlof van het hoofdkantoor".
 */
export async function getLeaveOverview({ from, to }) {
  const [absences, employees, types, deps] = await Promise.all([
    getAbsences({ start: from, end: to }),
    getEmployees().catch(() => []),
    getAbsenceTypes().catch(() => []),
    getDepartments().catch(() => [])
  ]);

  const empById = new Map(employees.map((e) => [String(e.id), e]));
  const typeById = new Map(types.map((t) => [String(t.id), t.name || t.title || t.label || '']));
  const depNameById = new Map(deps.map((d) => [String(d.id), d.name || '']));

  const empName = (e) => {
    if (!e) return '';
    return e.name || e.full_name || e.fullname ||
      [e.first_name || e.firstname, e.last_name || e.lastname].filter(Boolean).join(' ') || '';
  };
  const empDeptId = (e) => {
    if (!e) return '';
    if (e.department_id) return e.department_id;
    if (e.primary_department_id) return e.primary_department_id;
    if (Array.isArray(e.departments) && e.departments[0]) {
      const d0 = e.departments[0];
      return (d0 && (d0.id || d0)) || '';
    }
    return '';
  };

  const rows = (absences || []).map((a) => {
    const e = empById.get(String(a.employee_id)) || null;
    const depId = String(empDeptId(e) || '');
    const depName = depNameById.get(depId) || '';
    const store = depName ? (normalizeStoreName(depName) || depName) : '';
    const name = empName(e) || `Medewerker ${a.employee_id}`;
    return {
      employeeId: a.employee_id,
      name,
      from: isoDay(a.start),
      to: isoDay(a.end),
      type: typeById.get(String(a.absence_type_id)) || 'Afwezig',
      days: num(a.days) || null,
      department: depName || null,
      store: store || null,
      isOffice: Boolean(OFFICE_RE.test(depName) || OFFICE_RE.test(name))
    };
  });

  rows.sort((a, b) => String(a.from).localeCompare(String(b.from)) || String(a.name).localeCompare(b.name));
  return { window: { from, to }, rows, total: rows.length };
}
