/**
 * Snapshot-store voor supplychain dashboard metrics.
 *
 * Strategie:
 *   - Daily cron (api/cron/supplychain-daily-metrics.js) berekent voor élk filiaal
 *     elke metric voor die dag, en slaat het op als één Blob-record.
 *   - Dashboard leest dagsnapshots binnen periode, aggregeert tot week/maand/kwartaal/jaar.
 *   - Niet alles is per-dag berekenbaar (financiële voorraad bv. is point-in-time op snapshot-tijd).
 *     Daar pakken we de laatste snapshot binnen de periode.
 *
 * Blob-layout:
 *   admin/supplychain-snapshots/{yyyy-mm-dd}.json
 *     {
 *       date: '2026-05-21',
 *       generatedAt: ISO,
 *       branches: [
 *         { branchId, store, metrics: { sales: 123, weborders: 45, ... } },
 *         ...
 *       ]
 *     }
 *
 * Bij grote volumes (>500 dagen × 22 winkels) kunnen we later overstappen naar
 * gearchiveerde rollups, maar voor v1 is dag-snapshot per dag prima.
 */

import { list, put } from '@vercel/blob';
import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const SNAPSHOT_PREFIX = 'admin/supplychain-snapshots/';

function pathForDate(dateStr) {
  return `${SNAPSHOT_PREFIX}${String(dateStr).slice(0, 10)}.json`;
}

/* ─── Read / write ──────────────────────────────────────────────────── */

export async function readDaySnapshot(dateStr) {
  return readJsonBlob(pathForDate(dateStr), {
    date: String(dateStr).slice(0, 10),
    generatedAt: null,
    branches: []
  });
}

export async function writeDaySnapshot(dateStr, payload) {
  const path = pathForDate(dateStr);
  await writeJsonBlob(path, {
    ...payload,
    date: String(dateStr).slice(0, 10),
    generatedAt: payload.generatedAt || new Date().toISOString()
  });
  return payload;
}

/**
 * Geef alle snapshot-paden binnen [fromDate, toDate] (inclusief).
 * Beide ISO yyyy-mm-dd.
 */
async function listSnapshotsInRange(fromDate, toDate) {
  const result = await list({ prefix: SNAPSHOT_PREFIX, limit: 2000 });
  const blobs = result.blobs || [];
  /* Filter op pad-naam — date staat in de filename */
  return blobs.filter((b) => {
    const m = b.pathname.match(/(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) return false;
    const d = m[1];
    if (fromDate && d < fromDate) return false;
    if (toDate && d > toDate) return false;
    return true;
  });
}

async function readBlobText(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Blob fetch faalde: ${response.status}`);
  return response.text();
}

export async function readRange(fromDate, toDate) {
  const blobs = await listSnapshotsInRange(fromDate, toDate);
  const days = await Promise.all(
    blobs.map(async (b) => {
      try {
        const raw = await readBlobText(b.url);
        return JSON.parse(raw || '{}');
      } catch (e) {
        console.error('[supplychain-metrics-store] read fail:', b.pathname, e.message);
        return null;
      }
    })
  );
  return days.filter(Boolean).sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/* ─── Aggregatie helpers ────────────────────────────────────────────── */

/**
 * Aggregeer een lijst day-snapshots tot één row per filiaal × metric.
 *
 * Aggregate-regels per metric-unit (uit config):
 *   - count / eur                          → SUM
 *   - score / pct (composite of percentage) → AVG
 *   - stock-value (point-in-time)           → laatste waarde in range
 *
 * @param {Array}  days        snapshots gesorteerd op datum
 * @param {Array}  metricDefs  [{key, unit, ...}] uit readMetricsConfig
 * @returns {Object}            { byBranch: { branchId: {store, metrics: {...}} }, totals: {...} }
 */
export function aggregateSnapshots(days, metricDefs) {
  const POINT_IN_TIME_KEYS = new Set(['stock-value']); /* neemt laatste waarde, niet sum */
  const AVERAGE_UNITS = new Set(['score', 'pct']);

  const byBranch = new Map();
  const totals = {};
  metricDefs.forEach((m) => { totals[m.key] = 0; });

  /* Verzamel rauwe per-dag waarden per branch × metric */
  const rawByBranch = new Map();
  for (const day of days) {
    for (const b of (day.branches || [])) {
      const id = String(b.branchId || '');
      if (!id) continue;
      if (!rawByBranch.has(id)) rawByBranch.set(id, { branchId: id, store: b.store, days: [] });
      rawByBranch.get(id).days.push({ date: day.date, metrics: b.metrics || {} });
    }
  }

  /* Aggregeer per branch */
  for (const [branchId, entry] of rawByBranch.entries()) {
    const aggregated = {};
    for (const m of metricDefs) {
      const values = entry.days.map((d) => Number(d.metrics[m.key] ?? 0)).filter((v) => Number.isFinite(v));
      let result = 0;
      if (POINT_IN_TIME_KEYS.has(m.key)) {
        /* Laatste niet-null waarde in range */
        const last = entry.days.slice().reverse().find((d) => d.metrics[m.key] != null);
        result = last ? Number(last.metrics[m.key] || 0) : 0;
      } else if (AVERAGE_UNITS.has(m.unit)) {
        result = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
      } else {
        result = values.reduce((a, b) => a + b, 0);
      }
      aggregated[m.key] = Math.round(result * 100) / 100;
      if (!POINT_IN_TIME_KEYS.has(m.key) && !AVERAGE_UNITS.has(m.unit)) {
        totals[m.key] += aggregated[m.key];
      }
    }
    byBranch.set(branchId, {
      branchId,
      store: entry.store || '',
      metrics: aggregated
    });
  }

  /* Round totals */
  Object.keys(totals).forEach((k) => { totals[k] = Math.round(totals[k] * 100) / 100; });

  return {
    byBranch: Object.fromEntries(byBranch),
    totals,
    dayCount: days.length,
    branchCount: byBranch.size
  };
}

/* ─── Period helpers ────────────────────────────────────────────────── */

/**
 * Verkrijg from/to ISO-datums voor een named period.
 *
 * @param {string} period   'week' | 'month' | 'quarter' | 'year' | 'custom'
 * @param {Date} [ref]      referentie-datum (default: nu)
 * @returns {Object}        { from, to } yyyy-mm-dd
 */
export function periodToRange(period, ref) {
  const now = ref instanceof Date ? new Date(ref.getTime()) : new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const iso = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };

  switch (String(period || '').toLowerCase()) {
    case 'week': {
      const d = new Date(today);
      const dow = (d.getDay() + 6) % 7;
      d.setDate(d.getDate() - dow);
      return { from: iso(d), to: iso(today), period: 'week' };
    }
    case 'month': {
      const d = new Date(today.getFullYear(), today.getMonth(), 1);
      return { from: iso(d), to: iso(today), period: 'month' };
    }
    case 'quarter': {
      const qStart = Math.floor(today.getMonth() / 3) * 3;
      const d = new Date(today.getFullYear(), qStart, 1);
      return { from: iso(d), to: iso(today), period: 'quarter' };
    }
    case 'year': {
      const d = new Date(today.getFullYear(), 0, 1);
      return { from: iso(d), to: iso(today), period: 'year' };
    }
    default:
      /* fallback: laatste 30 dagen */
      const from = new Date(today);
      from.setDate(from.getDate() - 29);
      return { from: iso(from), to: iso(today), period: 'custom' };
  }
}
