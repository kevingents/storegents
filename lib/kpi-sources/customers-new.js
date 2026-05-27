/**
 * KPI-source: customers_new — nieuwe klantinschrijvingen per winkel.
 *
 * Wraps de SRS Customers webservice (GetCustomers met Created-filter):
 *   1. Haal klanten op die in [fromDate, toDate] zijn aangemaakt
 *   2. Filter op registeredInBranchId == branchId van de gevraagde store
 *   3. Return count
 *
 * NB: SRS staat GEEN RegisteredInBranchId-filter toe in de request — we
 * moeten lokaal filteren. Daarom paginated fetch met PageSize 500.
 *
 * Caching: in-memory per (createdFrom, createdUntil) voor 5 minuten zodat
 * het matrix-endpoint (alle stores in 1 call) niet 10× dezelfde SRS-call doet.
 */

import { getCustomers } from '../srs-customers-client.js';
import { BUSINESS_CONFIG } from '../business-config.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE = new Map(); /* key = `${createdFrom}|${createdUntil}` → { customers, expiresAt } */
const PAGE_SIZE = 500;
const MAX_PAGES = 20; /* hard cap → 10k customers per period */

function storeToBranchId(storeName) {
  const found = BUSINESS_CONFIG.branches.list.find((b) => b.store === storeName);
  return found ? String(found.branchId) : null;
}

async function fetchAllCustomersForPeriod(createdFrom, createdUntil) {
  const cacheKey = `${createdFrom}|${createdUntil}`;
  const cached = CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.customers;

  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { customers } = await getCustomers({
      createdFrom,
      createdUntil,
      skip: page * PAGE_SIZE,
      pageSize: PAGE_SIZE
    });
    if (!customers || customers.length === 0) break;
    all.push(...customers);
    if (customers.length < PAGE_SIZE) break;
  }

  CACHE.set(cacheKey, { customers: all, expiresAt: Date.now() + CACHE_TTL_MS });
  return all;
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

  /* SRS verwacht YYYY-MM-DD; fromDate/toDate komen al in dat formaat */
  try {
    const customers = await fetchAllCustomersForPeriod(fromDate, toDate);
    const forBranch = customers.filter((c) => String(c.registeredInBranchId || '').trim() === branchId);

    return {
      value: forBranch.length,
      meta: {
        branchId,
        totalCustomersInPeriod: customers.length,
        store,
        fromDate,
        toDate,
        computedAt: new Date().toISOString()
      }
    };
  } catch (err) {
    return {
      value: null,
      meta: {
        error: 'srs-customers-fetch-failed',
        message: String(err?.message || err),
        store,
        fromDate,
        toDate
      }
    };
  }
}
