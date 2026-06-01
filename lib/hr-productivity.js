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

import { getTimesheets, getDepartments, getAbsences, getEmployees, getAbsenceTypes, getPunches, getShifts, getLeaves, getLeaveTypes } from './werktijden-client.js';
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

/* Uren afleiden uit het rooster (shifts). GENTS registreert de gewerkte uren
   in het rooster, niet in timesheets/klok. Per dienst nemen we bij voorkeur het
   `hours`-veld (al netto, exclusief pauze); ontbreekt dat, dan (eind − start)
   minus pauze. Gegroepeerd per afdeling. Returnt Map(department_id → uren). */
function shiftHours(s) {
  const h = num(s.hours);
  if (h > 0) return h;
  if (!s.start || !s.end) return 0;
  const ms = new Date(s.end).getTime() - new Date(s.start).getTime();
  if (!(ms > 0) || ms > 24 * 3600 * 1000) return 0;
  let hrs = ms / 3600000;
  /* break_time kan in minuten óf uren staan; >10 ⇒ vrijwel zeker minuten. */
  const br = num(s.break_time);
  if (br > 0) hrs -= br > 10 ? br / 60 : br;
  return hrs > 0 ? hrs : 0;
}
function hoursFromShifts(shifts) {
  const byDep = new Map();
  for (const s of shifts || []) {
    const hrs = shiftHours(s);
    if (hrs <= 0) continue;
    const dep = String(s.department_id || '');
    byDep.set(dep, num(byDep.get(dep)) + hrs);
  }
  return byDep;
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

  /* Geen timesheet-uren? GENTS registreert de uren in het ROOSTER (shifts).
     Val daarom terug op: rooster → anders klok-momenten (clock-in/out). */
  let hoursSource = 'timesheets';
  let punchCount = 0;
  let shiftCount = 0;
  let totalSheetHours = 0;
  for (const v of hoursByDep.values()) totalSheetHours += v;
  if (totalSheetHours === 0) {
    /* 1) Rooster (geplande/ingeroosterde diensten) — de werkelijke bron bij GENTS. */
    try {
      const shifts = await getShifts({ start: from, end: to });
      shiftCount = shifts.length;
      if (shifts.length) {
        const sh = hoursFromShifts(shifts);
        if (sh.size) {
          hoursByDep.clear();
          for (const [k, v] of sh) hoursByDep.set(k, v);
          hoursSource = 'rooster';
        }
      }
    } catch (e) { if (!hoursError) hoursError = e.message || String(e); }

    /* 2) Anders: klok-momenten (timeclock). */
    if (hoursSource !== 'rooster') {
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
    shiftCount,
    punchCount,
    hoursSource,
    ledgerFilialen: (agg.filialen || []).length,
    hoursError,
    refreshedAt: ledger.updatedAt || null
  };
}

/* Eenvoudige concurrency-loop (voor de per-medewerker verlof-fallback). */
async function runLimited(items, concurrency, worker) {
  const out = [];
  let idx = 0;
  async function runner() {
    while (idx < items.length) { const i = idx++; out[i] = await worker(items[i], i); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, () => runner()));
  return out;
}

/**
 * Verlof over [from,to], verrijkt met medewerkernaam + afdeling/winkel.
 *
 * GENTS-verlof staat in Werktijden onder /leaves (verlofaanvragen), niet in
 * /absences. We lezen beide en mergen ze. /leaves heeft department_id direct;
 * als de bulk-call employee_id vereist vallen we terug op per-medewerker.
 * `isOffice` markeert hoofdkantoor-medewerkers (winkel-paneel "wie is met verlof
 * van het hoofdkantoor").
 */
export async function getLeaveOverview({ from, to }) {
  const [absences, employees, absTypes, leaveTypes, deps] = await Promise.all([
    getAbsences({ start: from, end: to }).catch(() => []),
    getEmployees().catch(() => []),
    getAbsenceTypes().catch(() => []),
    getLeaveTypes().catch(() => []),
    getDepartments().catch(() => [])
  ]);

  const empById = new Map(employees.map((e) => [String(e.id), e]));
  const absTypeById = new Map(absTypes.map((t) => [String(t.id), t.name || t.title || t.label || '']));
  const leaveTypeById = new Map(leaveTypes.map((t) => [String(t.id), t.name || t.title || t.label || '']));
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

  /* ── Verlofaanvragen (/leaves) — bulk, met per-medewerker fallback ── */
  let leaves = [];
  let leavesError = null;
  let leavesSource = 'bulk';
  try {
    leaves = await getLeaves({ start: from, end: to });
  } catch (e) {
    leavesError = e.message || String(e);
    leaves = null;
  }
  if (leaves === null) {
    leavesSource = 'per-medewerker';
    const actEmps = (employees || []).filter((e) => e.active !== false).slice(0, 150);
    const started = Date.now();
    const collected = [];
    await runLimited(actEmps, 8, async (e) => {
      if (Date.now() - started > 18000) return;
      try {
        const ls = await getLeaves({ start: from, end: to, employeeId: e.id });
        for (const l of ls) collected.push({ ...l, employee_id: l.employee_id || e.id });
      } catch (_) { /* sla deze medewerker over */ }
    });
    leaves = collected;
    leavesError = null;
  }

  const leaveRows = (leaves || []).map((l) => {
    const e = l.employee_id ? (empById.get(String(l.employee_id)) || null) : null;
    const depId = String(l.department_id || empDeptId(e) || '');
    const depName = depNameById.get(depId) || '';
    const store = depName ? (normalizeStoreName(depName) || depName) : '';
    const name = empName(e) || (l.employee_id ? `Medewerker ${l.employee_id}` : (depName || 'Onbekend'));
    return {
      employeeId: l.employee_id || null,
      name,
      from: isoDay(l.start),
      to: isoDay(l.end),
      type: leaveTypeById.get(String(l.type_id)) || l.reason || 'Verlof',
      days: num(l.days) || null,
      hours: num(l.hours) || null,
      department: depName || null,
      store: store || null,
      isOffice: isOfficeDept(depName),
      kind: 'leave'
    };
  });

  /* ── Afwezigheid (/absences) — meenemen indien aanwezig ── */
  const absenceRows = (absences || []).map((a) => {
    const e = empById.get(String(a.employee_id)) || null;
    const depId = String(empDeptId(e) || a.department_id || '');
    const depName = depNameById.get(depId) || '';
    const store = depName ? (normalizeStoreName(depName) || depName) : '';
    const name = empName(e) || `Medewerker ${a.employee_id}`;
    return {
      employeeId: a.employee_id,
      name,
      from: isoDay(a.start),
      to: isoDay(a.end),
      type: absTypeById.get(String(a.absence_type_id)) || 'Afwezig',
      days: num(a.days) || null,
      hours: num(a.hours) || null,
      department: depName || null,
      store: store || null,
      isOffice: isOfficeDept(depName),
      kind: 'absence'
    };
  });

  const rows = [...leaveRows, ...absenceRows];
  rows.sort((a, b) => String(a.from).localeCompare(String(b.from)) || String(a.name).localeCompare(b.name));
  return {
    window: { from, to },
    rows,
    total: rows.length,
    leaveCount: leaveRows.length,
    absenceCount: absenceRows.length,
    leavesSource,
    leavesError
  };
}
