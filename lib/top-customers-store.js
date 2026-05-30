/**
 * GENTS — Top-klanten snapshot (Shopify lifetime besteding)
 * =========================================================
 *
 * Shopify is de bron-van-waarheid voor klant-besteding: online orders én de
 * offline POS-bonnen die via shopify-offline-sync als historische orders
 * worden weggeschreven. Per-klant lifetime-spend zit als amountSpent /
 * numberOfOrders op het Customer-object.
 *
 * De Shopify-API kan klanten niet server-side op besteding sorteren, dus een
 * dagelijkse cron scant de klanten (GraphQL, gepagineerd, met page-cap),
 * sorteert client-side en bewaart de top-N als blob. De rapport-fetcher leest
 * alléén die blob — snel, geen live API-call tijdens de export.
 *
 * Blob: reports/top-customers.json
 *   { generatedAt, currency, scanned, truncated, customers: [
 *       { name, email, totalSpent, orderCount, avgOrder } ] }
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const STORE_KEY = 'reports/top-customers.json';

/** Lees Shopify-config uit env (zelfde set als shopify-offline-sync). */
function shopifyConfig() {
  const domain = (
    process.env.SHOPIFY_STORE_DOMAIN ||
    process.env.SHOPIFY_SHOP_DOMAIN ||
    (process.env.SHOPIFY_STORE_URL || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
  ).trim();
  const token = (
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ||
    process.env.SHOPIFY_ACCESS_TOKEN ||
    process.env.SHOPIFY_ADMIN_API_TOKEN ||
    process.env.SHOPIFY_ADMIN_TOKEN ||
    ''
  ).trim();
  const version = (process.env.SHOPIFY_API_VERSION || '2025-01').trim();
  return { domain, token, version };
}

const EMPTY_SNAPSHOT = Object.freeze({
  generatedAt: null,
  currency: 'EUR',
  scanned: 0,
  truncated: false,
  customers: []
});

/** Lees de laatste snapshot (of een lege fallback). */
export async function readTopCustomers() {
  const data = await readJsonBlob(STORE_KEY, null);
  if (!data || typeof data !== 'object') return { ...EMPTY_SNAPSHOT };
  return {
    generatedAt: data.generatedAt || null,
    currency: data.currency || 'EUR',
    scanned: Number(data.scanned || 0),
    truncated: Boolean(data.truncated),
    note: data.note || '',
    customers: Array.isArray(data.customers) ? data.customers : []
  };
}

/** Schrijf een nieuwe snapshot. */
export async function writeTopCustomers(payload) {
  await writeJsonBlob(STORE_KEY, payload);
  return payload;
}

const TOP_CUSTOMERS_QUERY = `
  query TopCustomers($after: String) {
    customers(first: 250, after: $after) {
      edges {
        cursor
        node {
          displayName
          email
          numberOfOrders
          amountSpent { amount currencyCode }
        }
      }
      pageInfo { hasNextPage }
    }
  }
`;

/**
 * Scan Shopify-klanten (gepagineerd, met page-cap) en bouw de top-N op
 * lifetime besteding. Geeft het snapshot-object terug (schrijft NIET).
 *
 * @param {{maxPages?:number, keep?:number}} opts
 */
export async function buildTopCustomersSnapshot({ maxPages, keep } = {}) {
  const { domain, token, version } = shopifyConfig();
  const pagesCap = Math.max(1, Number(maxPages || process.env.TOP_CUSTOMERS_MAX_PAGES || 40));
  const keepN = Math.max(1, Number(keep || process.env.TOP_CUSTOMERS_KEEP || 250));

  if (!domain || !token) {
    return { ...EMPTY_SNAPSHOT, generatedAt: new Date().toISOString(), note: 'Shopify-config ontbreekt (SHOPIFY_STORE_DOMAIN / token).' };
  }

  const url = `https://${domain}/admin/api/${version}/graphql.json`;
  let after = null;
  let hasNextPage = true;
  let pages = 0;
  let scanned = 0;
  let currency = 'EUR';
  let lastError = '';
  const all = [];

  while (hasNextPage && pages < pagesCap) {
    pages++;
    let r;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: TOP_CUSTOMERS_QUERY, variables: after ? { after } : {} })
      });
    } catch (err) {
      lastError = err.message || 'fetch-fout';
      break;
    }
    if (!r.ok) { lastError = `HTTP ${r.status}`; break; }

    const data = await r.json();
    if (data?.errors?.length) { lastError = data.errors[0]?.message || 'GraphQL-fout'; break; }
    const conn = data?.data?.customers;
    const edges = conn?.edges || [];
    for (const edge of edges) {
      const node = edge.node || {};
      const amount = Number(node.amountSpent?.amount || 0);
      if (node.amountSpent?.currencyCode) currency = node.amountSpent.currencyCode;
      const orderCount = Number(node.numberOfOrders || 0);
      scanned++;
      all.push({
        name: node.displayName || '',
        email: node.email || '',
        totalSpent: Math.round(amount * 100) / 100,
        orderCount,
        avgOrder: orderCount ? Math.round((amount / orderCount) * 100) / 100 : 0
      });
      after = edge.cursor;
    }
    hasNextPage = Boolean(conn?.pageInfo?.hasNextPage) && edges.length > 0;
  }

  all.sort((a, b) => b.totalSpent - a.totalSpent);
  return {
    generatedAt: new Date().toISOString(),
    currency,
    scanned,
    /* page-cap geraakt → mogelijk niet álle klanten gescand (top kan onvolledig zijn) */
    truncated: hasNextPage,
    note: lastError ? `Gestopt na fout: ${lastError}` : '',
    customers: all.slice(0, keepN)
  };
}
