/**
 * GENTS — Verzend-deadline calculator (werkdagen + cutoff)
 * ========================================================
 *
 * Bepaalt wanneer een order uiterlijk VERZONDEN (niet geleverd) moet zijn, en
 * of een order "te laat" is. Drijft de Te-late-orders KPI's (winkel + online
 * apart). Per kanaal instelbaar via lib/order-cutoff-config-store.js.
 *
 * MODEL (default, instelbaar):
 *   - shipByWorkingDays (default 1): order moet binnen zoveel werkdagen
 *     verzonden zijn; de effectieve order-werkdag telt als dag 1.
 *   - cutoffHour:cutoffMinute (default 14:00, NL-tijd): orders OP/NA de cutoff
 *     tellen als de volgende werkdag besteld.
 *   - Weekend (za/zo) → eerstvolgende werkdag (maandag).
 *   - Werkdagen = ma–vr. (NL-feestdagen optioneel later via holidays[].)
 *
 *   Met shipByWorkingDays=1 is de deadline = einde van de effectieve
 *   order-werkdag. Dat matcht de praktijk: vrijdag ná 14:00 + weekend →
 *   verzonden maandag.
 *
 * Voorbeeld-mapping (shipByWorkingDays=1, cutoff 14:00):
 *   do 13:00 → deadline do        do 15:00 → deadline vr
 *   vr 13:00 → deadline vr        vr 15:00 → deadline ma
 *   za / zo  → deadline ma
 *
 * TIJDZONE: alle cutoff/werkdag-logica rekent in NL-tijd (Europe/Amsterdam),
 * DST-veilig via Intl. Vergelijkingen gebeuren op civiele datum (YYYY-MM-DD)
 * zodat we geen UTC↔NL-conversie-fouten introduceren.
 */

const NL_TZ = 'Europe/Amsterdam';

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** NL-lokale datum/tijd-onderdelen van een Date (DST-veilig). */
function nlParts(date) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: NL_TZ,
    weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  let hour = Number(p.hour);
  if (hour === 24) hour = 0; /* en-GB kan middernacht als '24' geven */
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour,
    minute: Number(p.minute),
    weekday: WEEKDAY_INDEX[p.weekday] /* 0=zo … 6=za */
  };
}

/* ── Civiele-datum helpers (geen tijdzone-afhankelijkheid) ──────────────── */
function weekdayOfCivil(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); /* 0=zo … 6=za */
}
function addCivilDays(y, m, d, n) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}
function isWeekend(weekday) {
  return weekday === 0 || weekday === 6;
}
function civilNum(c) {
  return c.year * 10000 + c.month * 100 + c.day;
}
function civilIso(c) {
  return `${c.year}-${String(c.month).padStart(2, '0')}-${String(c.day).padStart(2, '0')}`;
}

function normalizeConfig(config = {}) {
  return {
    shipByWorkingDays: Math.max(1, Math.min(20, Number(config.shipByWorkingDays ?? 1) || 1)),
    cutoffHour: Math.max(0, Math.min(23, Number(config.cutoffHour ?? 14))),
    cutoffMinute: Math.max(0, Math.min(59, Number(config.cutoffMinute ?? 0)))
  };
}

function rollToNextWorkingDay(c) {
  let next = { ...c };
  let wd = weekdayOfCivil(next.year, next.month, next.day);
  while (isWeekend(wd)) {
    next = addCivilDays(next.year, next.month, next.day, 1);
    wd = weekdayOfCivil(next.year, next.month, next.day);
  }
  return next;
}

/**
 * Bepaal de uiterste verzend-werkdag (civiele datum) voor een order.
 * @returns {{year,month,day,iso}|null}
 */
export function computeShipDeadline(orderedAt, config = {}) {
  const d = toDate(orderedAt);
  if (!d) return null;
  const cfg = normalizeConfig(config);
  const p = nlParts(d);

  let civil = { year: p.year, month: p.month, day: p.day };
  const wd = weekdayOfCivil(civil.year, civil.month, civil.day);
  const afterCutoff =
    p.hour > cfg.cutoffHour || (p.hour === cfg.cutoffHour && p.minute >= cfg.cutoffMinute);

  /* Effectieve order-werkdag: weekend of ná cutoff → volgende werkdag. */
  if (isWeekend(wd)) {
    civil = rollToNextWorkingDay(civil);
  } else if (afterCutoff) {
    civil = rollToNextWorkingDay(addCivilDays(civil.year, civil.month, civil.day, 1));
  }

  /* Resterende werkdagen optellen (dag 1 = de effectieve order-werkdag). */
  let remaining = cfg.shipByWorkingDays - 1;
  while (remaining > 0) {
    civil = rollToNextWorkingDay(addCivilDays(civil.year, civil.month, civil.day, 1));
    remaining -= 1;
  }

  return { ...civil, iso: civilIso(civil) };
}

/**
 * Is een order te laat met verzenden?
 * Te laat = nog niet verzonden EN de deadline-werkdag is volledig voorbij
 * (NL-vandaag valt ná de deadline-datum). Op de deadline-dag zelf nog niet.
 */
export function isShipOverdue({ orderedAt, shippedAt = null, config = {}, now = new Date() } = {}) {
  if (shippedAt) return false; /* al verzonden → nooit te laat */
  const deadline = computeShipDeadline(orderedAt, config);
  if (!deadline) return false;
  const today = nlParts(toDate(now) || new Date());
  return civilNum(today) > civilNum(deadline);
}

/** Hoeveel werkdagen een order al te laat is (0 als niet te laat). */
export function shipOverdueWorkingDays({ orderedAt, shippedAt = null, config = {}, now = new Date() } = {}) {
  if (!isShipOverdue({ orderedAt, shippedAt, config, now })) return 0;
  const deadline = computeShipDeadline(orderedAt, config);
  const today = nlParts(toDate(now) || new Date());
  let cursor = { ...deadline };
  let count = 0;
  /* tel werkdagen vanaf (deadline+1) t/m vandaag */
  while (civilNum(cursor) < civilNum(today)) {
    cursor = addCivilDays(cursor.year, cursor.month, cursor.day, 1);
    const wd = weekdayOfCivil(cursor.year, cursor.month, cursor.day);
    if (!isWeekend(wd)) count += 1;
  }
  return count;
}

/**
 * Edge-case self-checks (documenteren het model). Geeft { passed, failed, cases }.
 * Aan te roepen via api/admin/order-cutoff-config.js?selfCheck=1 of node-run.
 */
export function runSelfChecks() {
  /* Vaste NL-tijdstippen (winter, geen DST-rand). 2026-01: do=8, vr=9, za=10, zo=11, ma=12. */
  const cfg = { shipByWorkingDays: 1, cutoffHour: 14, cutoffMinute: 0 };
  const at = (iso) => computeShipDeadline(iso, cfg)?.iso;
  const cases = [
    { label: 'do 13:00 → do',  in: '2026-01-08T13:00:00+01:00', expect: '2026-01-08' },
    { label: 'do 15:00 → vr',  in: '2026-01-08T15:00:00+01:00', expect: '2026-01-09' },
    { label: 'vr 13:00 → vr',  in: '2026-01-09T13:00:00+01:00', expect: '2026-01-09' },
    { label: 'vr 15:00 → ma',  in: '2026-01-09T15:00:00+01:00', expect: '2026-01-12' },
    { label: 'za → ma',        in: '2026-01-10T11:00:00+01:00', expect: '2026-01-12' },
    { label: 'zo → ma',        in: '2026-01-11T20:00:00+01:00', expect: '2026-01-12' },
    { label: 'precies 14:00 → telt als na cutoff (vr→ma)', in: '2026-01-09T14:00:00+01:00', expect: '2026-01-12' }
  ];
  const results = cases.map((c) => ({ ...c, got: at(c.in), ok: at(c.in) === c.expect }));
  /* Overdue-check: order do 13:00, deadline do; op vrijdag is het te laat (niet verzonden). */
  const overdue = [
    {
      label: 'do-order, vr-now, niet verzonden → te laat',
      ok: isShipOverdue({ orderedAt: '2026-01-08T13:00:00+01:00', now: '2026-01-09T09:00:00+01:00', config: cfg }) === true
    },
    {
      label: 'do-order, do-now (deadline-dag zelf) → niet te laat',
      ok: isShipOverdue({ orderedAt: '2026-01-08T13:00:00+01:00', now: '2026-01-08T18:00:00+01:00', config: cfg }) === false
    },
    {
      label: 'verzonden → nooit te laat',
      ok: isShipOverdue({ orderedAt: '2026-01-08T13:00:00+01:00', shippedAt: '2026-01-08T16:00:00+01:00', now: '2026-02-01T09:00:00+01:00', config: cfg }) === false
    }
  ];
  const all = [...results, ...overdue];
  return {
    passed: all.filter((x) => x.ok).length,
    failed: all.filter((x) => !x.ok).length,
    cases: all
  };
}
