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

import { getTimesheets, getDepartments, getAbsences, getEmployees, getAbsenceTypes, getPunches } from './werktijden-client.js';
import { readLedger, aggregateLedger, periodToRange } from './srs-retail-ledger.js';
import { normalizeStoreName, listBranches } from './branch-metrics.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round = (n, d = 2) => { const f = 10 ** d; return Math.round(num(n) * f) / f; };
const isoDay = (s) => String(s || '').slice(0, 10);
const low = (s) => String(s || '').trim().toLowerCase();

/* ── Werktijden-afdeling → GENTS-winkel ────────────────────────────────────
   Werktijden gebruikt de stadsnaam zónder "GENTS "-prefix ("Almere", "Breda",
   "Den Bosch") en soms een afwijkende naam. We proberen daarom: expliciete
   override → "GENTS <naam>" (canoniek) → naam-as-is (alias). Lukt geen van die
   → niet-gematcht (bv. een kantoor-afdeling of inactieve vestiging). */
const DEPT_STORE_OVERRIDE = {
  'amsterdam van wou': 'GENTS Amsterdam',
  'amsterdam kinker': 'GENTS Amsterdam',
  'amsterdam kinkerstraat': 'GENTS Amsterdam'
};

/* Kantoor/hoofdkantoor-afdelingen — geen winkel; bron voor "wie is met verlof
   van het hoofdkantoor". Uit te breiden via env WERKTIJDEN_OFFICE_DEPTS. */
const OFFICE_DEPT_NAMES = new Set([
  'gents b.v.', 'hoofdkantoor', 'e-commerce / marketing', 'e-commerce/marketing',
  'backoffice', 'erp en operations', 'administratie'
]);
for (const extra of String(process.env.WERKTIJDEN_OFFICE_DEPTS || '').split(',')) {
  const v = low(extra); if (v) OFFICE_DEPT_NAMES.add(v);
}

function isOfficeDept(depName) {
  return OFFICE_DEPT_NAMES.has(low(depName));
}

/* Uren afleiden uit klok-momenten (timeclock): per medewerker clock_in→clock_out
   paren, duur optellen, toewijzen aan de afdeling van de clock_in. Fallback als
   er geen timesheets zijn. Returnt Map(department_id → uren). */
function hoursFromPunches(punches) {
  const byEmp = new Map();
  for (const p of punches || []) {
    const e = String(p.employee_id || '');
    if (!byEmp.has(e)) byEmp.set(e, []);
    byEmp.get(e).push(p);
  }
  const hoursByDep = new Map();
  for (const list of byEmp.values()) {
    list.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
    let open = null;
    for (const p of list) {
      const t = low(p.type);
      if (t.includes('in')) { open = p; }
      else if (t.includes('out') && open) {
        const ms = new Date(p.timestamp).getTime() - new Date(open.timestamp).getTime();
        if (ms > 0 && ms < 24 * 3600 * 1000) {
          const dep = String(open.department_id || p.department_id || '');
          hoursByDep.set(dep, num(hoursByDep.get(dep)) + ms / 3600000);
        }
        open = null;
      }
    }
  }
  return hoursByDep;
}

function deptToStore(depName, branchSet) {
  const raw = String(depName || '').trim();
  if (!raw) return null;
  const ov = DEPT_STORE_OVERRIDE[low(raw)];
  if (ov) return ov;
  const withPrefix = normalizeStoreName('GENTS ' + raw);
  if (branchSet.has(withPrefix)) return withPrefix;
  const direct = normalizeStoreName(raw);
  if (branchSet.has(direct)) return direct;
  return null;
}

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

  /* 2. Gewerkte uren per Werktijden-afdeling. Een Werktijden-fout mag de hele
     pagina niet leegmaken — omzet blijft dan zichtbaar met 0 uren + reden. */
  let deps = [];
  let sheets = [];
  let hoursError = null;
  try {
    deps = await getDepartments();
    sheets = await getTimesheets({ start: from, end: to });
  } catch (e) {
    hoursError = e.message || String(e);
  }
  const depNameById = new Map(deps.map((d) => [String(d.id), d.name || '']));
  const hoursByDep = new Map();
  for (const s of sheets) {
    const dep = String(s.department_id || '');
    hoursByDep.set(dep, num(hoursByDep.get(dep)) + num(s.hours));
  }

  /* Fallback: geen timesheet-uren? Leid de uren af uit de timeclock-punches
     (clock-in/out). Zo werkt productiviteit ook als jullie via de klok werken. */
  let hoursSource = 'timesheets';
  let punchCount = 0;
  let totalSheetHours = 0;
  for (const v of hoursByDep.values()) totalSheetHours += v;
  if (totalSheetHours === 0) {
    try {
      const punches = await getPunches({ start: from, end: to });
      punchCount = punches.length;
      if (punches.length) {
        const ph = hoursFromPunches(punches);
        if (ph.size) {
          hoursByDep.clear();
          for (const [k, v] of ph) hoursByDep.set(k, v);
          hoursSource = 'punches';
        }
      }
    } catch (e) { if (!hoursError) hoursError = e.message || String(e); }
  }

  /* 3. Uren → winkel via expliciete afdeling→winkel-mapping. Kantoor-afdelingen
     en niet-koppelbare afdelingen tellen NIET mee in winkel-productiviteit,
     maar komen wel terug zodat de mapping zichtbaar/oplosbaar blijft. */
  const branchSet = new Set(
    listBranches({ includeInternal: true }).map((b) => normalizeStoreName(b.store) || b.store)
  );
  const hoursByStore = new Map();
  const unmatched = [];
  let officeHours = 0;
  for (const [depId, hrs] of hoursByDep) {
    const depName = depNameById.get(depId) || `Afdeling ${depId}`;
    const store = deptToStore(depName, branchSet);
    if (store) {
      hoursByStore.set(store, num(hoursByStore.get(store)) + hrs);
    } else if (isOfficeDept(depName)) {
      officeHours += hrs;
    } else {
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
      winkels: rows.filter((r) => r.uren > 0 || r.omzet > 0).length,
      kantoorUren: round(officeHours, 1)
    },
    unmatchedDepartments: unmatched,
    timesheetCount: sheets.length,
    punchCount,
    hoursSource,
    ledgerFilialen: (agg.filialen || []).length,
    hoursError,
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
      isOffice: isOfficeDept(depName)
    };
  });

  rows.sort((a, b) => String(a.from).localeCompare(String(b.from)) || String(a.name).localeCompare(b.name));
  return { window: { from, to }, rows, total: rows.length };
}
