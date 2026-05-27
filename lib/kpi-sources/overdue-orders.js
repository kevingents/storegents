/**
 * KPI-source: overdue_orders — openstaande weborders waarvan deadline is verlopen.
 *
 * Snapshot-KPI: telt momentane situatie, niet over periode. fromDate/toDate
 * worden genegeerd — overdue is "nu te laat" voor de gegeven store.
 *
 * Logica:
 *   1. Haal open weborders via getSrsOpenWeborders({ store, branchId })
 *   2. Filter op (status === 'open' || 'accepted') AND ageHours > deadline (48h)
 *   3. Return count
 *
 * Caching: 60s in-memory per branch om herhaalde calls in dezelfde matrix
 * te bufferen.
 */

import { getSrsOpenWeborders } from '../srs-open-weborders-client.js';
import { BUSINESS_CONFIG } from '../business-config.js';

const CACHE_TTL_MS = 60 * 1000;
const CACHE = new Map(); /* key = branchId → { items, expiresAt } */

function storeToBranchId(storeName) {
  const found = BUSINESS_CONFIG.branches.list.find((b) => b.store === storeName);
  return found ? String(found.branchId) : null;
}

function deadlineHours() {
  const days = BUSINESS_CONFIG.deadlines?.weborderOperationalDays ?? 2;
  return days * 24;
}

function ageInHours(createdAt) {
  if (!createdAt) return 0;
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return 0;
  return Math.max(0, (Date.now() - date.getTime()) / 36e5);
}

export async function getCachedOpenWeborders(branchId) {
  const cached = CACHE.get(branchId);
  if (cached && cached.expiresAt > Date.now()) return cached.items;
  const result = await getSrsOpenWeborders({ branchId });
  const items = Array.isArray(result?.items) ? result.items : [];
  CACHE.set(branchId, { items, expiresAt: Date.now() + CACHE_TTL_MS });
  return items;
}

function isOpenStatus(item) {
  const s = String(item?.status || '').toLowerCase();
  return s === 'open' || s === 'accepted' || s === 'pending' || s === '';
}

export default async function compute({ store } = {}) {
  if (!store) return { value: null, meta: { error: 'store-required-for-per-store-kpi' } };
  const branchId = storeToBranchId(store);
  if (!branchId) return { value: null, meta: { error: `unknown-store:${store}` } };

  try {
    const items = await getCachedOpenWeborders(branchId);
    const threshold = deadlineHours();
    const overdue = items.filter((it) => isOpenStatus(it) && ageInHours(it.createdAt) > threshold);

    return {
      value: overdue.length,
      meta: {
        branchId,
        store,
        openTotal: items.length,
        deadlineHours: threshold,
        computedAt: new Date().toISOString()
      }
    };
  } catch (err) {
    return {
      value: null,
      meta: {
        error: 'srs-open-weborders-fetch-failed',
        message: String(err?.message || err),
        store
      }
    };
  }
}
