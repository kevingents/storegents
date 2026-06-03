/**
 * GET /api/srs/open-weborders/charts?store=GENTS Delft&days=7
 *
 * Geeft echte data voor de twee dashboard-charts in het winkelportaal:
 *
 *   1. trend:           per dag aantal open + te-laat orders (laatste N dagen)
 *   2. statusBreakdown: tel per SRS-status (open, pending, processed, picked,
 *                       dispatched, klaar voor afhaal, etc.)
 *
 * Eén SRS-call (via cache als beschikbaar). De huidige `renderStoreTrendChart`
 * en `renderStoreStatusDonut` op de FE draaiden op synthetic / hardcoded data.
 */

import { getStoreNameByBranchId, getBranchIdByStore } from '../../../lib/branch-metrics.js';
import { getCachedWeborders } from '../../../lib/srs-weborders-cache.js';
import { nlTodayIso } from '../../../lib/datetime-nl.js';
import {
  normalizeWeborder,
  isOrderLineOpenForStore,
  isOverdueWeborder,
  isOpenWeborderStatus,
  isClosedWeborderStatus
} from '../../../lib/weborder-request-store.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function clean(value) { return String(value || '').trim(); }
function dateKey(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/**
 * Normaliseer SRS / dummy statussen naar een kleine, herkenbare set die de
 * frontend kan kleuren. We mappen op de meest-voorkomende SRS terminologie:
 *
 *   open              → wacht op verwerking
 *   in_progress       → in behandeling / gepickt
 *   ready             → klaar voor afhaal / dispatched
 *   shipped           → onderweg / verzonden
 *   delivered_today   → vandaag afgerond
 *   other             → fallback
 */
function bucketStatus(status, ageHours) {
  const s = String(status || '').toLowerCase();
  if (!s) return 'open';
  if (/geleverd|delivered|completed|afgerond|afgehaald|picked.?up/i.test(s)) return 'delivered_today';
  if (/dispatched|shipped|verzonden|onderweg/i.test(s)) return 'shipped';
  if (/ready|klaar.*afhaal|prepared/i.test(s)) return 'ready';
  if (/processed|picked|in.?(behandel|progress)|in.?bewerking/i.test(s)) return 'in_progress';
  if (/open|new|nieuw|pending|wacht/i.test(s)) return 'open';
  return 'other';
}

function buildTrend(items, days, storeName) {
  /* Tel per dag de open + te-laat orderlijnen waarvan createdAt op die dag valt. */
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    buckets.push({
      date: d.toISOString().slice(0, 10),
      label: d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }),
      open: 0,
      overdue: 0
    });
  }

  const byDate = new Map(buckets.map((b) => [b.date, b]));

  for (const item of items) {
    const createdKey = dateKey(item.createdAt || item.orderDate || item.dateTime);
    if (!createdKey) continue;
    const bucket = byDate.get(createdKey);
    if (!bucket) continue;

    if (storeName && !isOrderLineOpenForStore(item, storeName) && !isClosedWeborderStatus(item.status)) {
      continue;
    }

    if (isClosedWeborderStatus(item.status)) continue;
    bucket.open += 1;
    if (isOverdueWeborder(item)) bucket.overdue += 1;
  }

  return buckets;
}

function buildStatusBreakdown(items, storeName) {
  const counts = {
    open: 0,
    in_progress: 0,
    ready: 0,
    shipped: 0,
    delivered_today: 0,
    other: 0
  };
  /* NL-tijdzone, niet UTC: chart 'vandaag' moet matchen met wat de gebruiker
     in NL ziet, ook na 22:00 wanneer UTC al morgen denkt te zijn. */
  const todayStr = nlTodayIso();

  for (const item of items) {
    if (storeName && !isOrderLineOpenForStore(item, storeName) && !isClosedWeborderStatus(item.status)) {
      continue;
    }

    const bucket = bucketStatus(item.status, item.ageHours);
    if (bucket === 'delivered_today') {
      /* Tel alleen vandaag-afgeleverde mee in donut */
      const updatedKey = dateKey(item.updatedAt || item.deliveredAt || item.dateTime);
      if (updatedKey !== todayStr) continue;
    }
    counts[bucket] += 1;
  }

  const total = Object.values(counts).reduce((sum, v) => sum + v, 0);
  return {
    total,
    counts,
    slices: [
      { key: 'open',            label: 'Open',                value: counts.open,            color: '#3b82f6' },
      { key: 'in_progress',     label: 'In verwerking',       value: counts.in_progress,     color: '#f59e0b' },
      { key: 'ready',           label: 'Klaar voor verzending', value: counts.ready,         color: '#10b981' },
      { key: 'shipped',         label: 'Verzonden',           value: counts.shipped,         color: '#8b5cf6' },
      { key: 'delivered_today', label: 'Vandaag afgerond',    value: counts.delivered_today, color: '#0ea5e9' },
      { key: 'other',           label: 'Overig',              value: counts.other,           color: '#94a3b8' }
    ]
  };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  const store = clean(req.query.store);
  const branchIdRaw = clean(req.query.branchId);
  const branchId = branchIdRaw || String(getBranchIdByStore?.(store) || '').trim();
  const resolvedStore = store || getStoreNameByBranchId(branchId) || '';
  const days = Math.max(1, Math.min(30, Number(req.query.days || 7) || 7));

  if (!resolvedStore) {
    return res.status(400).json({ success: false, message: 'store of branchId verplicht.' });
  }

  try {
    /* Probeer cache eerst — staat sowieso ververst door srs-cache-refresh cron */
    let items = [];
    let source = '';

    const cached = await getCachedWeborders(resolvedStore);
    if (cached && !cached.stale) {
      items = (cached.items || []).map((item) => normalizeWeborder(item));
      source = 'srs_cache';
    } else {
      const client = await import('../../../lib/srs-open-weborders-client.js');
      const result = await client.getSrsOpenWeborders({ store: resolvedStore, branchId });
      items = (result.items || []).map((item) => normalizeWeborder(item));
      source = 'srs_live';
    }

    const trend = buildTrend(items, days, resolvedStore);
    const statusBreakdown = buildStatusBreakdown(items, resolvedStore);

    return res.status(200).json({
      success: true,
      store: resolvedStore,
      branchId,
      days,
      source,
      trend,
      statusBreakdown,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[open-weborders/charts]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Charts data ophalen mislukt.',
      degraded: true
    });
  }
}
