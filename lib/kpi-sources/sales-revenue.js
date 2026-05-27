/**
 * KPI-source: sales_revenue
 *
 * Berekent bruto-omzet (in euro's) voor een winkel in een periode.
 * Gebruikt de gecachte SRS-revenue-cache (per branch, per dag).
 *
 * Returnt null als de winkel niet bestaat of geen cache-data heeft —
 * het loader-framework hanteert null gracieus.
 */

import { readBranchRevenue } from '../srs-revenue-cache-store.js';
import { BUSINESS_CONFIG } from '../business-config.js';

function storeToBranchId(storeName) {
  const found = BUSINESS_CONFIG.branches.list.find((b) => b.store === storeName);
  return found ? found.branchId : null;
}

export default async function compute({ store, fromDate, toDate } = {}) {
  if (!store) {
    return { value: null, meta: { error: 'store-required-for-per-store-kpi' } };
  }
  const branchId = storeToBranchId(store);
  if (!branchId) {
    return { value: null, meta: { error: `unknown-store:${store}` } };
  }
  if (!fromDate || !toDate) {
    return { value: null, meta: { error: 'period-range-required' } };
  }

  const branch = await readBranchRevenue(branchId);
  if (!branch || !branch.days) {
    return {
      value: null,
      meta: { error: 'no-cache-data', branchId, hint: 'Trigger /api/cron/srs-revenue-refresh' }
    };
  }

  /* Som over alle dagen in [fromDate, toDate] (inclusief) */
  let total = 0;
  let days = 0;
  for (const [day, payload] of Object.entries(branch.days)) {
    if (day >= fromDate && day <= toDate) {
      const v = Number(payload?.amount ?? payload?.revenue ?? payload?.total ?? 0);
      if (Number.isFinite(v)) {
        total += v;
        days += 1;
      }
    }
  }

  return {
    value: Math.round(total * 100) / 100,
    meta: {
      branchId,
      days,
      cacheUpdatedAt: branch.updatedAt,
      computedAt: new Date().toISOString()
    }
  };
}
