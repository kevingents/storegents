/**
 * lib/retail-ledger-reconcile.js
 *
 * Controleert of de winkel-omzet-ledger (srs/verkopen-daily.json — de bron voor
 * dashboard/jaaranalyse) per dag overeenkomt met de live SRS-transacties
 * (GetTransactions). Beide zijn netto winkel-omzet, excl. webshop, incl. BTW —
 * dus ze horen gelijk te zijn. Verschillen wijzen op een import-gat of timing.
 *
 * Returnt per dag {ledger, srs, diff, diffPct, ok} + totalen. ok = binnen
 * tolerantie (€1 of 1%).
 */

import { readLedger } from './srs-retail-ledger.js';
import { getTransactions } from './srs-customers-client.js';
import { listBranches } from './branch-metrics.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ABS_TOL = 1;     /* € */
const REL_TOL = 0.01;  /* 1% */

function physicalSet() {
  const s = new Set();
  try { for (const b of listBranches({ includeInternal: false })) s.add(String(b.branchId)); } catch { /* geen filter */ }
  return s;
}

/**
 * @param {{from:string,to:string}} range  'YYYY-MM-DD'
 */
export async function reconcileRevenue({ from, to }) {
  const physical = physicalSet();

  /* 1. Ledger — netto omzet per dag (alleen fysieke winkels). */
  const ledger = await readLedger().catch(() => ({ stores: {} }));
  const ledgerByDay = new Map();
  for (const [fil, s] of Object.entries(ledger.stores || {})) {
    if (physical.size && !physical.has(String(fil))) continue;
    for (const [date, v] of Object.entries(s.days || {})) {
      if (date < from || date > to) continue;
      ledgerByDay.set(date, (ledgerByDay.get(date) || 0) + (Number(v.omzet) || 0));
    }
  }

  /* 2. Live SRS — netto winkel-omzet per dag (pure POS, excl. alle weborders). */
  const srsByDay = new Map();
  let srsError = null, txCount = 0;
  try {
    const { transactions = [] } = await getTransactions({ from: `${from}T00:00:00`, until: `${to}T23:59:59` });
    for (const tx of transactions) {
      const branchId = String(tx.branchId || '').trim();
      if (physical.size && !physical.has(branchId)) continue;
      const hasReceipt = Boolean(String(tx.receiptNr || '').trim());
      const hasOrderNr = Boolean(String(tx.orderNr || '').trim());
      if (!hasReceipt || hasOrderNr) continue; /* webshop/pickup → niet winkel-omzet */
      const day = String(tx.dateTime || '').slice(0, 10);
      if (!day || day < from || day > to) continue;
      srsByDay.set(day, (srsByDay.get(day) || 0) + (Number(tx.total) || 0));
      txCount += 1;
    }
  } catch (e) { srsError = e.message || String(e); }

  /* 3. Per dag vergelijken. */
  const allDates = new Set([...ledgerByDay.keys(), ...srsByDay.keys()]);
  const days = [...allDates].sort().map((d) => {
    const l = round2(ledgerByDay.get(d) || 0);
    const srs = round2(srsByDay.get(d) || 0);
    const diff = round2(l - srs);
    const base = Math.max(Math.abs(srs), Math.abs(l));
    const ok = Math.abs(diff) <= Math.max(ABS_TOL, REL_TOL * base);
    return { date: d, ledger: l, srs, diff, diffPct: srs ? round2((diff / srs) * 100) : (l ? 100 : 0), ok, inLedger: ledgerByDay.has(d), inSrs: srsByDay.has(d) };
  });

  let lt = 0, st = 0, off = 0;
  for (const d of days) { lt += d.ledger; st += d.srs; if (!d.ok) off += 1; }

  return {
    from, to,
    days,
    totals: {
      ledger: round2(lt), srs: round2(st), diff: round2(lt - st),
      diffPct: st ? round2(((lt - st) / st) * 100) : 0,
      dagen: days.length, afwijkend: off, gelijk: days.length - off
    },
    srsError, txCount,
    ledgerCoverage: ledger.coverage || null
  };
}
