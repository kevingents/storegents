/**
 * lib/srs-retail-ledger.js
 *
 * Dagelijkse omzet/bezoekers-ledger per fysiek filiaal, opgebouwd uit de
 * SRS-verkopen + klantentellers (srs-retail-import). Hiermee kan het
 * marketing-dashboard winkelprestaties tonen voor élke periode (vandaag,
 * gisteren, week, maand, kwartaal, jaar, eigen periode) — niet alleen het
 * 14-daagse export-venster. De ledger stapelt zich op: nieuwe imports
 * overschrijven hun dagen en bewaren de rest.
 *
 * Blob srs/verkopen-daily.json:
 *   { updatedAt, coverage:{from,to}, stores:{ [filiaal]:{ name, days:{ 'YYYY-MM-DD':{ omzet, bonnen, bezoekers } } } } }
 */

import { readJsonBlob, mutateJsonBlob } from './json-blob-store.js';
import { getStoreNameByBranchId } from './branch-metrics.js';

const PATH = 'srs/verkopen-daily.json';
const MAX_DAYS = 420; /* bewaar ~14 maanden historie per winkel */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

export async function readLedger() {
  const d = await readJsonBlob(PATH, { stores: {}, coverage: null, updatedAt: null });
  return (d && typeof d === 'object' && d.stores) ? d : { stores: {}, coverage: null, updatedAt: null };
}

/**
 * Voeg per-(filiaal,datum) data toe en bewaar.
 * @param {Object} newData { [filiaal]: { 'YYYY-MM-DD': { omzet, bonnen, bezoekers } } }
 */
export async function mergeLedger(newData) {
  /* Read-modify-write via mutateJsonBlob: conflict-detectie + retry zodat een
     overlappende import (bv. handmatige trigger tijdens de scheduled run) niet
     een hele dag omzet/bezoekers overschrijft. */
  return mutateJsonBlob(
    PATH,
    (led0) => {
      const led = (led0 && typeof led0 === 'object' && led0.stores) ? led0 : { stores: {}, coverage: null, updatedAt: null };
      const stores = led.stores || {};
      for (const [fil, days] of Object.entries(newData || {})) {
        if (!stores[fil]) stores[fil] = { name: getStoreNameByBranchId(fil), days: {} };
        stores[fil].name = getStoreNameByBranchId(fil);
        if (!stores[fil].days) stores[fil].days = {};
        for (const [date, v] of Object.entries(days)) {
          stores[fil].days[date] = {
            omzet: round2(v.omzet),
            gross: round2(v.gross != null ? v.gross : v.omzet),
            refund: round2(v.refund),
            bonnen: Number(v.bonnen) || 0,
            refundBonnen: Number(v.refundBonnen) || 0,
            grossItems: Number(v.grossItems) || 0,
            refundItems: Number(v.refundItems) || 0,
            bezoekers: Number(v.bezoekers) || 0
          };
        }
      }
      let from = '9999-99-99', to = '0000-00-00';
      for (const s of Object.values(stores)) {
        const dates = Object.keys(s.days || {}).sort();
        if (dates.length > MAX_DAYS) {
          for (const d of dates.slice(0, dates.length - MAX_DAYS)) delete s.days[d];
        }
        for (const d of Object.keys(s.days || {})) { if (d < from) from = d; if (d > to) to = d; }
      }
      return { stores, coverage: from <= to ? { from, to } : null, updatedAt: new Date().toISOString() };
    },
    { fallback: { stores: {}, coverage: null, updatedAt: null }, cacheMaxAge: 0 }
  );
}

/* ── Periode → datumbereik (Europe/Amsterdam 'vandaag') ──────────────────── */
function nlToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' }); /* 'YYYY-MM-DD' */
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function startOfWeek(dateStr) { /* maandag */
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;
  return addDays(dateStr, -dow);
}
function startOfMonth(dateStr) { return dateStr.slice(0, 8) + '01'; }
function startOfQuarter(dateStr) {
  const m = parseInt(dateStr.slice(5, 7), 10);
  const qm = Math.floor((m - 1) / 3) * 3 + 1;
  return `${dateStr.slice(0, 4)}-${String(qm).padStart(2, '0')}-01`;
}
function startOfYear(dateStr) { return dateStr.slice(0, 4) + '-01-01'; }

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

export const PERIODS = ['vandaag', 'gisteren', 'week', 'maand', 'kwartaal', 'jaar', 'custom'];

export function periodToRange(period, { from = '', to = '' } = {}) {
  const today = nlToday();
  switch (String(period || '').toLowerCase()) {
    case 'vandaag': return { from: today, to: today };
    case 'gisteren': { const y = addDays(today, -1); return { from: y, to: y }; }
    case 'week': return { from: startOfWeek(today), to: today };
    case 'maand': return { from: startOfMonth(today), to: today };
    case 'kwartaal': return { from: startOfQuarter(today), to: today };
    case 'jaar': return { from: startOfYear(today), to: today };
    case 'custom': {
      const f = isDate(from) ? from : today;
      const t = isDate(to) ? to : today;
      return f <= t ? { from: f, to: t } : { from: t, to: f };
    }
    default: return { from: startOfWeek(today), to: today };
  }
}

function daysBetween(from, to) {
  const a = new Date(from + 'T00:00:00Z'); const b = new Date(to + 'T00:00:00Z');
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

/** Aggregeer de ledger over [from,to] → winkelprestatie-vorm. */
export function aggregateLedger(ledger, { from, to }) {
  const filialen = [];
  let tBez = 0, tBon = 0, tOmz = 0, tGross = 0, tRefund = 0, tGItems = 0, tRItems = 0, tRefBon = 0, tBezC = 0, tBonC = 0;
  let covFrom = '', covTo = '';
  const dayNet = new Map(); /* datum → netto-omzet (alle winkels) voor de trend */
  for (const [fil, s] of Object.entries(ledger.stores || {})) {
    let omzet = 0, gross = 0, refund = 0, bonnen = 0, refundBonnen = 0, grossItems = 0, refundItems = 0, bezoekers = 0, hit = false;
    for (const [date, v] of Object.entries(s.days || {})) {
      if (date < from || date > to) continue;
      omzet += v.omzet || 0;
      gross += (v.gross != null ? v.gross : v.omzet) || 0;
      refund += v.refund || 0;
      bonnen += v.bonnen || 0;
      refundBonnen += v.refundBonnen || 0;
      grossItems += v.grossItems || 0;
      refundItems += v.refundItems || 0;
      bezoekers += v.bezoekers || 0;
      dayNet.set(date, (dayNet.get(date) || 0) + (v.omzet || 0));
      hit = true;
      if (!covFrom || date < covFrom) covFrom = date;
      if (!covTo || date > covTo) covTo = date;
    }
    if (!hit) continue;
    const heeftTeller = bezoekers > 0;
    filialen.push({
      filiaalNummer: fil,
      store: s.name || getStoreNameByBranchId(fil),
      bezoekers,
      bonnen,
      refundBonnen,
      omzet: round2(omzet),
      gross: round2(gross),
      refund: round2(refund),
      items: grossItems - refundItems,
      grossItems,
      refundItems,
      conversie: heeftTeller ? round1((bonnen / bezoekers) * 100) : null,
      gemBesteding: bonnen ? round2(omzet / bonnen) : 0,
      heeftTeller
    });
    tBez += bezoekers; tBon += bonnen; tOmz += omzet; tGross += gross; tRefund += refund;
    tGItems += grossItems; tRItems += refundItems; tRefBon += refundBonnen;
    if (heeftTeller) { tBezC += bezoekers; tBonC += bonnen; }
  }
  filialen.sort((a, b) => b.omzet - a.omzet);
  return {
    window: { from, to, dagen: daysBetween(from, to) },
    coverage: ledger.coverage || null,
    dataRange: covFrom && covTo ? { from: covFrom, to: covTo } : null,
    refreshedAt: ledger.updatedAt || null,
    totals: {
      bezoekers: tBez,
      bonnen: tBon,
      refundBonnen: tRefBon,
      omzet: round2(tOmz),
      gross: round2(tGross),
      refund: round2(tRefund),
      items: tGItems - tRItems,
      grossItems: tGItems,
      refundItems: tRItems,
      conversie: tBezC ? round1((tBonC / tBezC) * 100) : null,
      gemBesteding: tBon ? round2(tOmz / tBon) : 0,
      winkels: filialen.length
    },
    filialen,
    days: [...dayNet.entries()].map(([day, revenue]) => ({ day, revenue: round2(revenue) })).sort((a, b) => a.day.localeCompare(b.day))
  };
}
