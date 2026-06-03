/**
 * lib/srs-dragers-history-store.js
 *
 * Houdt afgesloten dragers bij — wie was te laat, hoe lang, welke winkel.
 *
 * Werking: een drager verdwijnt uit het SRS-export bestand zodra hij 'binnen'
 * is geboekt op de bestemming. Bij elke nachtelijke import vergelijken we de
 * vorige snapshot (srs/dragers.json) met het nieuwe bestand; ID's die voorheen
 * in zaten maar nu niet meer, registreren we hier als afgesloten — mét de
 * doorlooptijd (created → closedAt) en een wasTeLaat-vlag.
 *
 * Rolling 365 dagen — oudere records vallen weg om de blob niet onbeperkt te
 * laten groeien. Bij dedupe (mocht een drager 2x in/uit komen) wint de meest
 * recente sluit-registratie.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const PATH = 'srs/dragers-history.json';
const DAG_MS = 86400000;
const MAX_AGE_DAYS = 365;

export async function readDragersHistory() {
  const d = await readJsonBlob(PATH, { closed: [], updatedAt: null });
  return {
    closed: Array.isArray(d?.closed) ? d.closed : [],
    updatedAt: d?.updatedAt || null
  };
}

/**
 * Voeg nieuwe afgesloten dragers toe aan de history.
 * @param {Array} newClosed  records met {id, herkomst, herkomstNaam,
 *   bestemming, bestemmingNaam, created, closedAt, durationHours, wasTeLaat,
 *   regels}
 * @returns {Promise<{added:number, total:number}>}
 */
export async function appendClosedDragers(newClosed = []) {
  if (!Array.isArray(newClosed) || newClosed.length === 0) {
    return { added: 0, total: 0 };
  }
  const cur = await readDragersHistory();
  const all = [...cur.closed, ...newClosed];

  /* Dedupe op id (laatste wint). */
  const map = new Map();
  for (const d of all) {
    if (!d || !d.id) continue;
    map.set(String(d.id), d);
  }

  /* Rolling drop: alles ouder dan 365 dagen sluit-datum weg. */
  const cutoff = Date.now() - (MAX_AGE_DAYS * DAG_MS);
  const trimmed = [...map.values()]
    .filter((d) => {
      const t = Date.parse(d.closedAt || '');
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt));

  await writeJsonBlob(PATH, {
    closed: trimmed,
    updatedAt: new Date().toISOString()
  });
  return { added: newClosed.length, total: trimmed.length };
}

/**
 * Bereken statistieken over een (gefilterde) set afgesloten dragers.
 * Per-store: aantal afgesloten, aantal te laat, % te laat, gemiddelde duur,
 * mediaan duur, langste open + welke drager.
 */
export function computeDragersHistoryStats(rows = []) {
  const byStore = new Map();
  let totalClosed = 0;
  let totalLate = 0;
  let durations = [];

  for (const r of rows) {
    const dur = Number(r.durationHours);
    const late = Boolean(r.wasTeLaat);
    const store = r.bestemmingNaam || `Filiaal ${r.bestemming || '?'}`;
    totalClosed += 1;
    if (late) totalLate += 1;
    if (Number.isFinite(dur)) durations.push(dur);

    let s = byStore.get(store);
    if (!s) {
      s = { store, bestemming: r.bestemming, total: 0, late: 0, durations: [], longest: null };
      byStore.set(store, s);
    }
    s.total += 1;
    if (late) s.late += 1;
    if (Number.isFinite(dur)) {
      s.durations.push(dur);
      if (!s.longest || dur > s.longest.durationHours) {
        s.longest = { id: r.id, durationHours: dur, created: r.created, closedAt: r.closedAt };
      }
    }
  }

  const median = (arr) => {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  };
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((s, n) => s + n, 0) / arr.length) : null);

  const perStore = [...byStore.values()].map((s) => ({
    store: s.store,
    bestemming: s.bestemming,
    total: s.total,
    late: s.late,
    pctLate: s.total ? Math.round((s.late / s.total) * 100) : 0,
    avgHours: avg(s.durations),
    medianHours: median(s.durations),
    longest: s.longest
  })).sort((a, b) => b.pctLate - a.pctLate || b.late - a.late);

  return {
    totals: {
      closed: totalClosed,
      late: totalLate,
      pctLate: totalClosed ? Math.round((totalLate / totalClosed) * 100) : 0,
      avgHours: avg(durations),
      medianHours: median(durations)
    },
    perStore
  };
}
