/**
 * Blob-store voor Omnichannel Winnaar van de Maand.
 *
 * Layout:
 *   monthly-winners/<YYYY-MM>.json   — winnaar + 4 subwinnaars + bottom 3 + alle scores
 *   monthly-winners-index.json       — { months: ['2026-04','2026-05',...], current: '2026-05', updatedAt }
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const INDEX_PATH = 'monthly-winners-index.json';
const MONTH_PATH_PREFIX = 'monthly-winners/';

function monthPath(yyyymm) {
  const clean = String(yyyymm || '').match(/^\d{4}-\d{2}$/)?.[0];
  if (!clean) throw new Error(`monthPath: ongeldige YYYY-MM "${yyyymm}".`);
  return `${MONTH_PATH_PREFIX}${clean}.json`;
}

export async function readWinnersIndex() {
  return readJsonBlob(INDEX_PATH, {
    months: [],
    current: '',
    updatedAt: null
  });
}

export async function writeWinnersIndex(index) {
  const cleanMonths = Array.from(new Set((index.months || []).filter(Boolean))).sort();
  const payload = {
    months: cleanMonths,
    current: index.current || cleanMonths[cleanMonths.length - 1] || '',
    updatedAt: new Date().toISOString()
  };
  await writeJsonBlob(INDEX_PATH, payload);
  return payload;
}

export async function readMonthWinner(yyyymm) {
  return readJsonBlob(monthPath(yyyymm), null);
}

/**
 * Schrijf de winnaar-resultaten voor een specifieke maand.
 *
 * @param {string} yyyymm
 * @param {{
 *   month: string,
 *   periodFrom: string,
 *   periodTo: string,
 *   winner: { store, branchId, score, tieBreaker?, transactions, pillars },
 *   subWinners: { customers, loyalty, crossChannel, data },
 *   bottom3: Array<{ store, branchId, score, reason? }>,
 *   allRows: Array<{ store, branchId, score, transactions, pillars, eligible }>,
 *   generatedAt: string,
 *   generatedBy: string,
 *   minTransactions: number,
 *   notes?: string
 * }} payload
 */
export async function writeMonthWinner(yyyymm, payload) {
  const normalized = {
    ...payload,
    month: yyyymm,
    generatedAt: payload.generatedAt || new Date().toISOString()
  };
  await writeJsonBlob(monthPath(yyyymm), normalized);

  /* Update de index. */
  const index = await readWinnersIndex();
  const months = Array.from(new Set([...(index.months || []), yyyymm])).sort();
  await writeWinnersIndex({
    months,
    current: months[months.length - 1] || yyyymm
  });

  return normalized;
}

/**
 * Geef de huidige/meest recente winnaar terug.
 */
export async function readCurrentWinner() {
  const index = await readWinnersIndex();
  if (!index.current) return null;
  return readMonthWinner(index.current);
}

/**
 * Geef de laatste N maanden winnaars terug (nieuwste eerst).
 */
export async function readRecentWinners(limit = 12) {
  const index = await readWinnersIndex();
  const months = (index.months || []).slice(-Math.max(1, Number(limit) || 12)).reverse();
  const winners = [];
  for (const month of months) {
    const winner = await readMonthWinner(month);
    if (winner) winners.push(winner);
  }
  return winners;
}

/**
 * All-time leaderboard: hoe vaak heeft elke winkel gewonnen?
 *
 * @returns {Promise<Array<{ store, branchId, totalWins, hoofdprijs, klantKoning, voorraadKampioen, crossChannelHeld, dataMeester, months }>>}
 */
export async function readAllTimeLeaderboard() {
  const index = await readWinnersIndex();
  const stats = new Map();

  function bump(store, key, month, branchId) {
    if (!store) return;
    if (!stats.has(store)) {
      stats.set(store, {
        store,
        branchId: branchId || '',
        totalWins: 0,
        hoofdprijs: 0,
        klantKoning: 0,
        voorraadKampioen: 0,
        crossChannelHeld: 0,
        dataMeester: 0,
        months: []
      });
    }
    const entry = stats.get(store);
    entry[key] += 1;
    if (key === 'hoofdprijs') {
      entry.totalWins += 1;
      entry.months.push(month);
    }
    if (branchId && !entry.branchId) entry.branchId = branchId;
  }

  for (const month of index.months || []) {
    const winner = await readMonthWinner(month);
    if (!winner) continue;
    bump(winner.winner?.store, 'hoofdprijs', month, winner.winner?.branchId);
    bump(winner.subWinners?.customers?.store, 'klantKoning', month, winner.subWinners?.customers?.branchId);
    /* Backwards-compat: oude winnaars hadden subWinners.loyalty, nieuwe hebben
       subWinners.stockReliability (voorraadvertrouwen). Beide tellen voor de
       "voorraadKampioen" bucket. */
    const stockSub = winner.subWinners?.stockReliability || winner.subWinners?.loyalty;
    bump(stockSub?.store, 'voorraadKampioen', month, stockSub?.branchId);
    bump(winner.subWinners?.crossChannel?.store, 'crossChannelHeld', month, winner.subWinners?.crossChannel?.branchId);
    bump(winner.subWinners?.data?.store, 'dataMeester', month, winner.subWinners?.data?.branchId);
  }

  return Array.from(stats.values()).sort((a, b) => {
    if (b.totalWins !== a.totalWins) return b.totalWins - a.totalWins;
    const subWinsA = a.klantKoning + a.voorraadKampioen + a.crossChannelHeld + a.dataMeester;
    const subWinsB = b.klantKoning + b.voorraadKampioen + b.crossChannelHeld + b.dataMeester;
    if (subWinsB !== subWinsA) return subWinsB - subWinsA;
    return a.store.localeCompare(b.store, 'nl');
  });
}

/**
 * Periode-helpers voor de cron.
 */
export function previousMonthBounds(reference = new Date()) {
  const ref = new Date(reference);
  const year = ref.getUTCFullYear();
  const month = ref.getUTCMonth(); /* 0-11, prev maand = month - 1 */
  const firstOfThisMonth = new Date(Date.UTC(year, month, 1));
  const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - 86400000);
  const firstOfPrevMonth = new Date(Date.UTC(lastOfPrevMonth.getUTCFullYear(), lastOfPrevMonth.getUTCMonth(), 1));

  const yyyymm = lastOfPrevMonth.toISOString().slice(0, 7);
  return {
    yyyymm,
    from: firstOfPrevMonth.toISOString().slice(0, 10),
    to: lastOfPrevMonth.toISOString().slice(0, 10)
  };
}

/**
 * Hulpdetails om labels in mails/UI consistent te tonen.
 */
export const PILLAR_LABELS = {
  customers: { key: 'customers', label: 'Klantbekendheid', icon: '🧑', max: 30, title: 'Klant-koning' },
  loyalty: { key: 'loyalty', label: 'Loyalty-activatie', icon: '🎁', max: 25, title: 'Loyalty-kampioen' },
  crossChannel: { key: 'crossChannel', label: 'Cross-channel', icon: '🔄', max: 25, title: 'Cross-channel-held' },
  data: { key: 'data', label: 'Data-kwaliteit', icon: '✅', max: 20, title: 'Data-meester' }
};

export const SUB_PILLAR_ORDER = ['customers', 'loyalty', 'crossChannel', 'data'];
