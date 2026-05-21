/**
 * Uitwisselingen rapportage — per filiaal + totaal + periode.
 *
 *   GET /api/admin/exchanges-report?from=2026-05-01&to=2026-05-31[&store=GENTS Arnhem]
 *
 * Statistieken per winkel:
 *   - received: uitwisselingen ontvangen (createdAt/firstDetectedAt valt in periode)
 *   - completed: afgerond (closedAt valt in periode)
 *   - openOverOneWeek: nog open EN openDays >= 7 (op moment van rapportage)
 *
 * Data komt uit srs-exchange-open-state-store (Blob met historische closedAt).
 * Voor "currently open >1 week" raadplegen we ook de live SRS endpoint.
 *
 * Auth: admin-token vereist.
 */

import { list } from '@vercel/blob';
import { getStoreNameByBranchId } from '../../lib/branch-metrics.js';
import { getAllOpenstaandeUitwisselingen } from '../../lib/srs-exchanges-client.js';
import { enrichOpenExchangeState } from '../../lib/srs-exchange-open-state-store.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

const STATE_KEY = 'srs-exchanges/open-exchange-state.json';

function clean(v) { return String(v ?? '').trim(); }
function isoDate(d) { return d.toISOString().slice(0, 10); }

function isInRange(isoTimestamp, fromIso, toIso) {
  if (!isoTimestamp) return false;
  const ts = isoTimestamp.slice(0, 10);
  if (fromIso && ts < fromIso) return false;
  if (toIso && ts > toIso) return false;
  return true;
}

async function readStateBlob() {
  try {
    const result = await list({ prefix: STATE_KEY, limit: 1 });
    const blob = (result.blobs || []).find((b) => b.pathname === STATE_KEY) || result.blobs?.[0];
    if (!blob?.url) return { exchanges: {} };
    const response = await fetch(blob.url, { cache: 'no-store' });
    if (!response.ok) return { exchanges: {} };
    const text = await response.text();
    return JSON.parse(text || '{"exchanges":{}}');
  } catch (err) {
    console.error('[exchanges-report] readStateBlob:', err);
    return { exchanges: {} };
  }
}

function aggregateByStore(stateExchanges, fromIso, toIso, currentOpenByStore) {
  /* store → { received, completed, openOverOneWeek } */
  const byStore = new Map();
  const getOrInit = (store) => {
    if (!byStore.has(store)) {
      byStore.set(store, {
        store,
        received: 0,
        completed: 0,
        openOverOneWeek: 0,
        avgOpenDaysCompleted: 0,
        _totalOpenDaysCompleted: 0
      });
    }
    return byStore.get(store);
  };

  for (const ex of Object.values(stateExchanges || {})) {
    const naarBranchId = String(ex.naarFiliaal || '').trim();
    const store = getStoreNameByBranchId(naarBranchId) || `Filiaal ${naarBranchId}`;

    /* received: srsCreatedAt of firstDetectedAt valt in periode */
    const createdAt = ex.srsCreatedAt || ex.firstDetectedAt || '';
    if (isInRange(createdAt, fromIso, toIso)) {
      getOrInit(store).received += 1;
    }

    /* completed: closedAt valt in periode */
    if (ex.closedAt && isInRange(ex.closedAt, fromIso, toIso)) {
      const row = getOrInit(store);
      row.completed += 1;
      /* Bereken openDays op moment van sluiting */
      const opened = new Date(ex.srsCreatedAt || ex.firstDetectedAt || ex.closedAt);
      const closed = new Date(ex.closedAt);
      if (!Number.isNaN(opened.getTime()) && !Number.isNaN(closed.getTime())) {
        const days = Math.max(0, Math.floor((closed - opened) / 86400000));
        row._totalOpenDaysCompleted += days;
      }
    }
  }

  /* Voor "nog open >1 week" gebruiken we de live current-open lijst (snapshot van NU) */
  for (const [store, count] of Object.entries(currentOpenByStore || {})) {
    getOrInit(store).openOverOneWeek = count;
  }

  /* Compute gemiddelde openDays voor afgeronde */
  for (const row of byStore.values()) {
    if (row.completed > 0) {
      row.avgOpenDaysCompleted = Math.round(row._totalOpenDaysCompleted / row.completed * 10) / 10;
    }
    delete row._totalOpenDaysCompleted;
  }

  return Array.from(byStore.values()).sort((a, b) =>
    (b.received - a.received) || a.store.localeCompare(b.store, 'nl')
  );
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  const from = clean(req.query.from);
  const to = clean(req.query.to);
  const onlyStore = clean(req.query.store);

  if (!from || !to) {
    /* Default: deze maand */
    const now = new Date();
    const firstOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const defaultFrom = isoDate(firstOfMonth);
    const defaultTo = isoDate(now);
    return handleWithRange(req, res, from || defaultFrom, to || defaultTo, onlyStore);
  }
  return handleWithRange(req, res, from, to, onlyStore);
}

async function handleWithRange(req, res, from, to, onlyStore) {
  try {
    /* 1. State-store voor historische close-data */
    const state = await readStateBlob();
    const stateExchanges = state.exchanges || {};

    /* 2. Live current-open lijst voor "nog open >1 week" snapshot.
       Pull ééns alle stores en filter daarna. */
    let currentOpenByStore = {};
    try {
      const live = await getAllOpenstaandeUitwisselingen({ days: 60 });
      const enriched = await enrichOpenExchangeState(live.exchanges || []);
      for (const ex of enriched) {
        if (Number(ex.openDays || 0) < 7) continue;
        const naarBranchId = String(ex.naarFiliaal || '').trim();
        const store = getStoreNameByBranchId(naarBranchId) || `Filiaal ${naarBranchId}`;
        currentOpenByStore[store] = (currentOpenByStore[store] || 0) + 1;
      }
    } catch (err) {
      console.warn('[exchanges-report] live fetch failed:', err.message);
    }

    let rows = aggregateByStore(stateExchanges, from, to, currentOpenByStore);
    if (onlyStore) rows = rows.filter((r) => r.store === onlyStore);

    const totals = rows.reduce((acc, r) => ({
      received: acc.received + r.received,
      completed: acc.completed + r.completed,
      openOverOneWeek: acc.openOverOneWeek + r.openOverOneWeek
    }), { received: 0, completed: 0, openOverOneWeek: 0 });

    return res.status(200).json({
      success: true,
      from,
      to,
      store: onlyStore || '',
      totals,
      rows,
      note: 'received = nieuwe uitwisselingen in periode; completed = afgerond in periode; openOverOneWeek = nu nog open en >= 7 dagen oud.'
    });
  } catch (error) {
    console.error('[exchanges-report]', error);
    return res.status(500).json({ success: false, message: error.message || 'Rapportage mislukt.' });
  }
}
