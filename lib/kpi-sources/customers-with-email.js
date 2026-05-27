/**
 * KPI-source: customers_with_email — nieuwe klanten met email-adres.
 *
 * Wrapt customers-new logica + filter op aanwezigheid van email.
 * Deelt dezelfde 5-min cache (geen duplicate SRS-call wanneer beide KPI's
 * in dezelfde matrix-request zitten).
 */

import customersNewCompute from './customers-new.js';
import { getCustomers } from '../srs-customers-client.js';
import { BUSINESS_CONFIG } from '../business-config.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE = new Map();
const PAGE_SIZE = 500;
const MAX_PAGES = 20;

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
  if (!store) return { value: null, meta: { error: 'store-required-for-per-store-kpi' } };
  const branchId = storeToBranchId(store);
  if (!branchId) return { value: null, meta: { error: `unknown-store:${store}` } };
  if (!fromDate || !toDate) return { value: null, meta: { error: 'period-range-required' } };

  try {
    const customers = await fetchAllCustomersForPeriod(fromDate, toDate);
    const forBranch = customers.filter((c) => String(c.registeredInBranchId || '').trim() === branchId);
    const withEmail = forBranch.filter((c) => Boolean(String(c.email || '').trim()));
    return {
      value: withEmail.length,
      meta: {
        branchId,
        totalNewInBranch: forBranch.length,
        store, fromDate, toDate,
        emailRatePct: forBranch.length > 0 ? Math.round((withEmail.length / forBranch.length) * 100) : null,
        computedAt: new Date().toISOString()
      }
    };
  } catch (err) {
    return {
      value: null,
      meta: { error: 'srs-customers-fetch-failed', message: String(err?.message || err), store, fromDate, toDate }
    };
  }
}
