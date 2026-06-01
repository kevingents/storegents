/**
 * lib/werktijden-client.js
 *
 * Dunne client voor de Werktijden.nl API (v2). Gebruikt voor het HR-menu:
 * gewerkte uren per filiaal (timesheets), verlof/afwezigheid (absences) en
 * de afdelingen-lijst (departments) om Werktijden-afdelingen aan GENTS-winkels
 * te koppelen.
 *
 * ENV (Vercel):
 *   WERKTIJDEN_API_TOKEN   Bearer-token (verplicht)
 *   WERKTIJDEN_TIMEOUT_MS  optioneel, default 20000
 *
 * Docs: https://developer.werktijden.nl/reference
 *   Base: https://api.werktijden.nl/2
 *   Auth: Authorization: Bearer {token}
 */

const BASE = 'https://api.werktijden.nl/2';
const TIMEOUT_MS = Number(process.env.WERKTIJDEN_TIMEOUT_MS || 20000);

const clean = (v) => String(v == null ? '' : v).trim();

export function readWerktijdenConfig() {
  return { token: clean(process.env.WERKTIJDEN_API_TOKEN), base: BASE };
}

/* Sommige API's wikkelen arrays in { data: [...] } of { results: [...] }. */
function asArray(d) {
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.data)) return d.data;
  if (d && Array.isArray(d.results)) return d.results;
  if (d && Array.isArray(d.items)) return d.items;
  return [];
}

async function wtFetch(path, params = {}) {
  const { token } = readWerktijdenConfig();
  if (!token) throw new Error('WERKTIJDEN_API_TOKEN ontbreekt.');

  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal
    });
    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    if (!resp.ok) {
      const msg = (data && (data.message || data.error || data.error_description)) || `Werktijden API fout ${resp.status}`;
      const err = new Error(msg);
      err.status = resp.status;
      err.body = data;
      throw err;
    }
    return data;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`Werktijden API timeout na ${TIMEOUT_MS}ms.`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ── Endpoints ─────────────────────────────────────────────────────────── */

/** Afdelingen (= filialen in Werktijden). Velden: id, name, employees_count, active. */
export async function getDepartments() {
  return asArray(await wtFetch('/departments'));
}

/** Medewerkers (voor naam-lookup bij verlof). */
export async function getEmployees() {
  return asArray(await wtFetch('/employees'));
}

/**
 * Timesheets (gewerkte uren) binnen [start,end] (ISO 8601), optioneel per
 * afdeling/medewerker. Veld `hours` = totaal gewerkte uren per regel.
 */
export async function getTimesheets({ start, end, departmentId, employeeId } = {}) {
  return asArray(await wtFetch('/timesheets', {
    start, end, department_id: departmentId, employee_id: employeeId
  }));
}

/** Afwezigheid/verlof binnen [start,end]. Velden: employee_id, absence_type_id, start, end, days, hours, closed. */
export async function getAbsences({ start, end, employeeId, closed } = {}) {
  return asArray(await wtFetch('/absences', {
    start, end, employee_id: employeeId, closed
  }));
}

/** Verlof-/afwezigheidstypes (id → naam). Best-effort: lege lijst bij 404. */
export async function getAbsenceTypes() {
  for (const p of ['/absence_types', '/leave_types']) {
    try { return asArray(await wtFetch(p)); } catch (_) { /* probeer volgende */ }
  }
  return [];
}

/* ── Diagnose / verbindingstest ────────────────────────────────────────── */

/**
 * Probe: vertelt of de koppeling werkt en geeft kleine samples terug zodat we
 * de echte department-namen/ids + veld-vormen zien. Gooit nooit.
 */
export async function probeWerktijden({ start, end } = {}) {
  const cfg = readWerktijdenConfig();
  const out = {
    config: { token: Boolean(cfg.token), base: cfg.base, timeoutMs: TIMEOUT_MS },
    ok: false
  };
  if (!cfg.token) {
    out.diagnosis = 'WERKTIJDEN_API_TOKEN ontbreekt in de omgeving (Vercel).';
    return out;
  }

  try {
    const deps = await getDepartments();
    out.ok = true;
    out.departmentsCount = deps.length;
    out.departments = deps.map((d) => ({ id: d.id, name: d.name, employees: d.employees_count, active: d.active }));
  } catch (e) {
    out.error = e.message;
    out.diagnosis = `Verbinding mislukte: ${e.message}. Controleer WERKTIJDEN_API_TOKEN.`;
    return out;
  }

  /* Kleine samples — handig om de mapping + veldnamen te bevestigen. */
  try {
    const sheets = await getTimesheets({ start, end });
    out.timesheetsSample = sheets.slice(0, 3);
    out.timesheetsCount = sheets.length;
  } catch (e) { out.timesheetsError = e.message; }

  try {
    const abs = await getAbsences({ start, end });
    out.absencesSample = abs.slice(0, 3);
    out.absencesCount = abs.length;
  } catch (e) { out.absencesError = e.message; }

  try {
    const emps = await getEmployees();
    out.employeesCount = emps.length;
    out.employeesSample = emps.slice(0, 2);
  } catch (e) { out.employeesError = e.message; }

  out.diagnosis = `Verbinding werkt. ${out.departmentsCount} afdeling(en).`
    + (out.timesheetsCount != null ? ` ${out.timesheetsCount} timesheet-regel(s) in venster.` : '')
    + (out.absencesCount != null ? ` ${out.absencesCount} afwezigheid(en) in venster.` : '');
  return out;
}
