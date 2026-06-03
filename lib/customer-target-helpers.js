/**
 * Pro-rata helpers voor klanten-targets.
 *
 * Targets worden per maand opgeslagen. Voor periodes die niet exact 1 maand
 * dekken (week, quarter, custom) berekenen we pro-rata: targetPeriod is een
 * gewogen som van maand-targets × (overlap-dagen / maand-dagen).
 */

import { readAllTargets, calcPct, pctColor } from './customer-targets-store.js';
/* Targets komen uit twee bronnen: het KPI-beheer (kpi-config.json, keys
   customers_new / customers_with_bon / customers_with_email) én de oude
   customer-targets (inschrijvingen / metBon / metEmail). We mergen ze (KPI
   wint), en als de rapport-periode geen eigen maand-target heeft vallen we
   terug op de laatst-ingestelde maand-target — zodat een ingevuld target
   altijd zichtbaar is, ongeacht welke periode het rapport toont. */
import { readAllKpiTargets } from './kpi-targets-store.js';
/* Targets worden ingevuld onder de winkelnaam zoals die in de Shopify-instelling
   (stores_source) staat — die kan licht afwijken van de canonieke branch-naam
   ('s-Hertogenbosch vs Den Bosch, hoofdletters, dubbele spaties). De report
   vraagt targets op per canonieke listBranches()-naam. We normaliseren beide
   kanten via normalizeStoreName zodat een ingevuld target altijd matcht. */
import { normalizeStoreName } from './branch-metrics.js';

const numOr0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/* Canonieke winkel-sleutel (alias/hoofdletters/spaties), behoud _default los. */
function canonStore(store) {
  if (store === '_default') return '_default';
  return normalizeStoreName(store) || String(store || '').trim();
}

/* Merge KPI- + legacy-targets tot { 'YYYY-MM': { canonStore|_default: {inschrijvingen,metBon,metEmail} } }.
   Sleutels worden gecanonicaliseerd zodat lookups op branch-naam altijd raken. */
async function buildUnifiedMonthly() {
  const [kpi, legacy] = await Promise.all([
    readAllKpiTargets().catch(() => ({})),
    readAllTargets().catch(() => ({}))
  ]);
  const out = {};
  for (const mk of new Set([...Object.keys(kpi || {}), ...Object.keys(legacy || {})])) {
    const kpiM = kpi[mk] || {};
    const legM = legacy[mk] || {};
    out[mk] = {};
    for (const store of new Set([...Object.keys(kpiM), ...Object.keys(legM)])) {
      const k = kpiM[store] || {};
      const l = legM[store] || {};
      const row = {
        inschrijvingen: numOr0(k.customers_new) || numOr0(l.inschrijvingen),
        metBon: numOr0(k.customers_with_bon) || numOr0(l.metBon),
        metEmail: numOr0(k.customers_with_email) || numOr0(l.metEmail)
      };
      const key = canonStore(store);
      const prev = out[mk][key];
      /* Bij naam-collisie (twee varianten → zelfde winkel): behoud per veld
         de eerste niet-nul waarde. */
      out[mk][key] = prev ? {
        inschrijvingen: row.inschrijvingen || numOr0(prev.inschrijvingen),
        metBon: row.metBon || numOr0(prev.metBon),
        metEmail: row.metEmail || numOr0(prev.metEmail)
      } : row;
    }
  }
  return out;
}

/* Laatst-ingestelde maand-target voor een winkel (of _default), ongeacht maand. */
function latestMonthlyTarget(unified, store) {
  const key = canonStore(store);
  for (const mk of Object.keys(unified).sort().reverse()) {
    const row = unified[mk][key] || unified[mk][store] || unified[mk]._default;
    if (row && (row.inschrijvingen || row.metBon || row.metEmail)) return row;
  }
  return null;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function parseDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

function monthKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Yields { year, month, daysOverlap, daysInMonth } voor elke maand tussen
 * dateFrom en dateTo (inclusief).
 */
function eachMonthInRange(dateFrom, dateTo) {
  const start = parseDate(dateFrom);
  const end = parseDate(dateTo);
  const result = [];

  let y = start.getUTCFullYear();
  let m = start.getUTCMonth() + 1;
  const endY = end.getUTCFullYear();
  const endM = end.getUTCMonth() + 1;

  while (y < endY || (y === endY && m <= endM)) {
    const monthStart = new Date(Date.UTC(y, m - 1, 1));
    const monthEnd = new Date(Date.UTC(y, m, 0));
    const overlapStart = monthStart < start ? start : monthStart;
    const overlapEnd = monthEnd > end ? end : monthEnd;
    const overlapDays = Math.max(0, Math.round((overlapEnd - overlapStart) / 86400000) + 1);
    result.push({
      year: y,
      month: m,
      daysOverlap: overlapDays,
      daysInMonth: daysInMonth(y, m)
    });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return result;
}

/**
 * Bereken target voor één winkel over de periode dateFrom..dateTo.
 *
 * Gedrag:
 *  - 1 kalendermaand (deze maand / vorige maand / etc.): volledige maand-target,
 *    GEEN pro-rata. De rapport-UI heeft tijd-gebonden kleurdrempels (na 7/14/21
 *    dagen) die signaleren of je op schema loopt — pro-rata bovenop is dubbel-op
 *    en maakt de target onherkenbaar (target 95 → "10" op dag 3 = verwarrend).
 *  - Multi-maand of <1 maand (week, kwartaal, jaar, custom): pro-rata als
 *    gewogen som van overlap-dagen × maand-target / maand-dagen.
 */
function computeStoreTarget(allTargets, store, dateFrom, dateTo) {
  const result = { inschrijvingen: 0, metBon: 0, metEmail: 0 };
  const months = eachMonthInRange(dateFrom, dateTo);
  const key = canonStore(store);

  /* Detecteer: dekt de periode exact 1 hele kalendermaand? */
  const isFullSingleMonth = months.length === 1
    && months[0].daysOverlap === months[0].daysInMonth;

  /* Detecteer: deze maand t/m vandaag (begint op de 1e)? Dan ook full target,
     zodat het rapport gedurende de maand de maand-target laat zien (geen
     krimpende pro-rata). De tijd-banden geven de progressie. */
  const startsOnFirst = String(dateFrom).slice(8, 10) === '01';
  const isMonthToDate = months.length === 1 && startsOnFirst;

  if (isFullSingleMonth || isMonthToDate) {
    const { year, month } = months[0];
    const monthData = allTargets[monthKey(year, month)] || {};
    const target = monthData[key] || monthData[store] || monthData._default;
    if (target) {
      result.inschrijvingen = Math.round(Number(target.inschrijvingen) || 0);
      result.metBon = Math.round(Number(target.metBon) || 0);
      result.metEmail = Math.round(Number(target.metEmail) || 0);
    }
    return result;
  }

  /* Multi-maand of korter dan een maand: pro-rata. */
  for (const { year, month, daysOverlap, daysInMonth: dim } of months) {
    if (daysOverlap <= 0 || dim <= 0) continue;
    const monthData = allTargets[monthKey(year, month)] || {};
    const target = monthData[key] || monthData[store] || monthData._default;
    if (!target) continue;

    const ratio = daysOverlap / dim;
    result.inschrijvingen += (Number(target.inschrijvingen) || 0) * ratio;
    result.metBon += (Number(target.metBon) || 0) * ratio;
    result.metEmail += (Number(target.metEmail) || 0) * ratio;
  }

  result.inschrijvingen = Math.round(result.inschrijvingen);
  result.metBon = Math.round(result.metBon);
  result.metEmail = Math.round(result.metEmail);

  return result;
}

/**
 * Bouw targetMap: store → target voor de periode.
 * Optioneel: pas een totaal-target toe via _all of som van per-store.
 */
export async function getTargetsForPeriod(stores, dateFrom, dateTo) {
  const unified = await buildUnifiedMonthly();
  const months = eachMonthInRange(dateFrom, dateTo);
  const periodDays = months.reduce((n, m) => n + Math.max(0, m.daysOverlap), 0) || 7;

  const map = {};
  for (const store of stores) {
    /* Pro-rata target uit de maand(en) die de periode dekken. */
    let t = computeStoreTarget(unified, store, dateFrom, dateTo);
    /* Geen eigen maand-target? → val terug op de laatst-ingestelde maand-target
       (pro-rata o.b.v. ~30 dagen), zodat een ingevuld target altijd zichtbaar is. */
    if (!t.inschrijvingen && !t.metBon && !t.metEmail) {
      const fb = latestMonthlyTarget(unified, store);
      if (fb) {
        const r = periodDays / 30;
        t = {
          inschrijvingen: Math.round(numOr0(fb.inschrijvingen) * r),
          metBon: Math.round(numOr0(fb.metBon) * r),
          metEmail: Math.round(numOr0(fb.metEmail) * r)
        };
      }
    }
    map[store] = t;
  }
  return map;
}

/**
 * Voeg target-info + percentages toe aan een rij customer-weekly-report data.
 * Mutates rij in-place.
 */
export function attachTargetsToRow(row, target, totalReceiptsInStore) {
  if (!row) return row;
  const newCount = Number(row.newCount || row.total || row.newCustomers || 0);
  const withBon = Number(row.withBon || row.withReceipt || 0);
  const withEmail = Number(row.withEmail || 0);

  row.targetInschrijvingen = target?.inschrijvingen || 0;
  row.targetMetBon = target?.metBon || 0;
  row.targetMetEmail = target?.metEmail || 0;
  row.totalReceiptsInStore = totalReceiptsInStore || 0;

  /* 4 percentages */
  row.pctInschrijvingenVsTarget = calcPct(newCount, row.targetInschrijvingen);
  row.pctMetBonVsTarget = calcPct(withBon, row.targetMetBon);
  row.pctMetEmailVsTarget = calcPct(withEmail, row.targetMetEmail);
  row.pctInschrijvingenVsBons = calcPct(newCount, row.totalReceiptsInStore);

  /* Status-kleuren voor UI */
  row.pctInschrijvingenColor = pctColor(row.pctInschrijvingenVsTarget);
  row.pctMetBonColor = pctColor(row.pctMetBonVsTarget);
  row.pctMetEmailColor = pctColor(row.pctMetEmailVsTarget);
  row.pctVsBonsColor = pctColor(row.pctInschrijvingenVsBons);

  return row;
}

/**
 * Tel unieke bonnen (receipts) per branchId uit een transactions-array.
 */
export function countReceiptsByBranch(transactions) {
  const seen = new Map(); /* branchId → Set<receiptNr> */
  for (const t of transactions || []) {
    const branchId = String(t.branchId || t.BranchId || '').trim();
    const receipt = String(t.receiptNr || t.ReceiptNr || t.receiptNo || t.ReceiptNo || t.orderNr || t.OrderNr || '').trim();
    if (!branchId || !receipt) continue;
    if (!seen.has(branchId)) seen.set(branchId, new Set());
    seen.get(branchId).add(receipt);
  }
  const result = {};
  for (const [branchId, set] of seen.entries()) {
    result[branchId] = set.size;
  }
  return result;
}
