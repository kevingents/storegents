/**
 * KPI-source: on_time_delivery — % weborders dat binnen deadline is verwerkt.
 *
 * Voor v1 gebruiken we de huidige open-orders snapshot:
 *   on_time_pct = (openCount - overdueCount) / openCount × 100
 *
 * Dit is een momentane indicator van "hoeveel van de huidige openstaande
 * orders zijn nog niet te laat". Voor een echte rolling-window berekening
 * (verwerkte orders in periode) zou een processed-orders archive nodig zijn.
 *
 * Deelt cache met overdue-orders.js.
 */

import { getCachedOpenWeborders } from './overdue-orders.js';
import { BUSINESS_CONFIG } from '../business-config.js';

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
    const openItems = items.filter(isOpenStatus);
    const threshold = deadlineHours();
    const overdue = openItems.filter((it) => ageInHours(it.createdAt) > threshold).length;
    const open = openItems.length;

    if (open === 0) {
      /* Geen open orders → 100% on-time (perfect score, niets te laat) */
      return {
        value: 100,
        meta: {
          branchId, store,
          openTotal: 0,
          overdue: 0,
          note: 'no-open-orders',
          computedAt: new Date().toISOString()
        }
      };
    }

    const pct = ((open - overdue) / open) * 100;
    return {
      value: Math.round(pct * 10) / 10,
      meta: {
        branchId, store,
        openTotal: open,
        overdue,
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
