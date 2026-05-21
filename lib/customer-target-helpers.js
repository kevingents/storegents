/**
 * Pro-rata helpers voor klanten-targets.
 *
 * Targets worden per maand opgeslagen. Voor periodes die niet exact 1 maand
 * dekken (week, quarter, custom) berekenen we pro-rata: targetPeriod is een
 * gewogen som van maand-targets × (overlap-dagen / maand-dagen).
 */

import { readAllTargets, calcPct, pctColor } from './customer-targets-store.js';

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
 * Bereken pro-rata target voor één winkel over de periode dateFrom..dateTo.
 * Gebruikt _default uit dezelfde maand als fallback voor winkels zonder eigen target.
 */
function computeStoreTarget(allTargets, store, dateFrom, dateTo) {
  const result = { inschrijvingen: 0, metBon: 0, metEmail: 0 };
  const months = eachMonthInRange(dateFrom, dateTo);

  for (const { year, month, daysOverlap, daysInMonth: dim } of months) {
    if (daysOverlap <= 0 || dim <= 0) continue;
    const monthData = allTargets[monthKey(year, month)] || {};
    const own = monthData[store];
    const def = monthData._default;
    const target = own || def;
    if (!target) continue;

    const ratio = daysOverlap / dim;
    result.inschrijvingen += (Number(target.inschrijvingen) || 0) * ratio;
    result.metBon += (Number(target.metBon) || 0) * ratio;
    result.metEmail += (Number(target.metEmail) || 0) * ratio;
  }

  /* Rond af op hele getallen — pro-rata fracties zijn niet betekenisvol */
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
  const allTargets = await readAllTargets();
  const map = {};
  for (const store of stores) {
    map[store] = computeStoreTarget(allTargets, store, dateFrom, dateTo);
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
