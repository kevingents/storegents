/**
 * Sync SRS offline transacties (winkel-aankopen) naar Shopify als orders.
 *
 * Doel: in Shopify Admin de complete klant-history zien (online + offline).
 *
 * Strategie:
 *   - Per SRS-transactie wordt een Shopify Order aangemaakt met:
 *     - customer = bestaande Shopify klant (via email match)
 *     - line_items: SKU/barcode lookup → variant_id; geen match → custom title
 *     - financial_status='paid', fulfillment_status='fulfilled'
 *     - tags: gents-offline, store:<name>, srs-receipt:<nr>
 *     - source_name = 'pos-<store>' voor herkenning in Shopify
 *     - processed_at = SRS dateTime (zodat datum klopt in customer history)
 *     - send_receipt/send_fulfillment_receipt = false (geen mail naar klant)
 *
 * Idempotency:
 *   - Voor elke transactie zoeken we eerst in Shopify of een order met
 *     tag srs-tx:<branchId>-<receiptNr> al bestaat. Zo ja → skip.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';
const HISTORY_PATH = 'shopify-offline-sync/history.json';
const STATE_PATH = 'shopify-offline-sync/state.json';
const MAX_HISTORY_RUNS = 100;
const MAX_ERROR_DETAILS = 50;

function getShopifyConfig() {
  const shop = String(process.env.SHOPIFY_STORE_URL || process.env.SHOPIFY_SHOP_DOMAIN || '')
    .replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/\/admin.*$/i, '');
  const token = String(process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || '').trim();
  if (!shop || !token) throw new Error('Shopify config ontbreekt (SHOPIFY_STORE_URL of SHOPIFY_ACCESS_TOKEN).');
  return { shop, token, apiVersion: SHOPIFY_API_VERSION };
}

function clean(v) { return String(v || '').trim(); }
function money(v) { return Math.round(Number(v || 0) * 100) / 100; }

async function shopifyRest(path, { method = 'GET', body = null } = {}) {
  const { shop, token, apiVersion } = getShopifyConfig();
  const url = `https://${shop}/admin/api/${apiVersion}${path}`;
  const headers = { 'X-Shopify-Access-Token': token, 'Accept': 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`Shopify gaf ongeldige JSON: ${text.slice(0, 200)}`); }
  if (!response.ok) {
    const detail = data?.errors || data?.error || text.slice(0, 200);
    throw new Error(`Shopify ${method} ${path} faalde (${response.status}): ${JSON.stringify(detail)}`);
  }
  return data;
}

async function shopifyGql(query, variables = {}) {
  const { shop, token, apiVersion } = getShopifyConfig();
  const response = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Shopify GraphQL gaf geen JSON: ${text.slice(0, 200)}`); }
  if (!response.ok || data.errors) throw new Error(`Shopify GraphQL fout: ${JSON.stringify(data.errors || text).slice(0, 300)}`);
  return data.data;
}

/* ────────────────────────────────────────────────────────────────── */

/**
 * Zoek Shopify klant op email. Returnt {id, email, firstName, lastName} of null.
 */
export async function findShopifyCustomerByEmail(email) {
  const e = clean(email);
  if (!e) return null;
  const data = await shopifyGql(`
    query FindCustomer($q: String!) {
      customers(first: 1, query: $q) {
        edges { node { id email firstName lastName totalSpent { amount currencyCode } numberOfOrders } }
      }
    }
  `, { q: `email:${e}` });
  const node = data?.customers?.edges?.[0]?.node;
  if (!node) return null;
  return {
    gid: node.id,
    id: String(node.id || '').split('/').pop(), /* numeric ID voor REST */
    email: node.email,
    firstName: node.firstName,
    lastName: node.lastName,
    totalSpent: node.totalSpent?.amount || '0',
    orderCount: node.numberOfOrders || 0
  };
}

/**
 * Zoek Shopify variant op SKU of barcode.
 */
export async function findShopifyVariantBySku(skuOrBarcode) {
  const q = clean(skuOrBarcode);
  if (!q) return null;
  const data = await shopifyGql(`
    query FindVariant($q: String!) {
      productVariants(first: 1, query: $q) {
        edges { node { id sku barcode title price product { id title } } }
      }
    }
  `, { q: `sku:${q} OR barcode:${q}` });
  const node = data?.productVariants?.edges?.[0]?.node;
  if (!node) return null;
  return {
    gid: node.id,
    id: String(node.id || '').split('/').pop(),
    sku: node.sku,
    barcode: node.barcode,
    title: node.title,
    productTitle: node.product?.title || '',
    price: node.price
  };
}

/**
 * Check of een SRS-transactie al gesynced is naar Shopify.
 * Zoekt orders met tag srs-tx:<branchId>-<receiptNr>.
 */
export async function isTransactionAlreadySynced({ branchId, receiptNr }) {
  const tag = `srs-tx:${clean(branchId)}-${clean(receiptNr)}`;
  const data = await shopifyGql(`
    query CheckTag($q: String!) {
      orders(first: 1, query: $q) { edges { node { id name tags } } }
    }
  `, { q: `tag:${tag}` });
  const found = data?.orders?.edges?.[0]?.node;
  return found ? { id: found.id, name: found.name } : null;
}

/**
 * Maak een Shopify Order aan voor één SRS-transactie.
 *
 * @param {Object} args
 * @param {string} args.shopifyCustomerId — numeric Shopify customer ID
 * @param {Object} args.transaction       — SRS transaction object
 * @param {string} args.storeName         — winkelnaam (bv. 'GENTS Amsterdam')
 * @returns {Promise<{id, name, total}>}
 */
export async function createOfflineOrderInShopify({ shopifyCustomerId, transaction, storeName }) {
  if (!shopifyCustomerId) throw new Error('shopifyCustomerId ontbreekt');
  if (!transaction || !Array.isArray(transaction.items)) throw new Error('transaction.items ontbreekt');

  /* Bouw line items met variant_id lookup */
  const lineItems = [];
  for (const item of transaction.items) {
    const pieces = Math.max(1, Number(item.pieces || 1));
    const charged = money(item.charged);
    const unitPrice = pieces > 0 ? money(charged / pieces) : 0;
    const variant = await findShopifyVariantBySku(item.sku || item.barcode).catch(() => null);
    if (variant) {
      lineItems.push({
        variant_id: Number(variant.id),
        quantity: pieces,
        price: unitPrice.toFixed(2)
      });
    } else {
      lineItems.push({
        title: `SRS ${clean(item.sku) || 'onbekend artikel'} (geen variant-match)`,
        quantity: pieces,
        price: unitPrice.toFixed(2),
        sku: clean(item.sku),
        requires_shipping: false,
        taxable: false
      });
    }
  }

  if (!lineItems.length) throw new Error('Geen line items om aan te maken');

  const tags = [
    'gents-offline',
    `store:${clean(storeName).replace(/[^A-Za-z0-9_-]/g, '_')}`,
    `srs-receipt:${clean(transaction.receiptNr)}`,
    `srs-tx:${clean(transaction.branchId)}-${clean(transaction.receiptNr)}`
  ].filter(Boolean).join(', ');

  const sourceName = `pos-${clean(storeName).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const total = lineItems.reduce((s, li) => s + Number(li.price) * Number(li.quantity), 0);

  const body = {
    order: {
      customer: { id: Number(shopifyCustomerId) },
      line_items: lineItems,
      tags,
      financial_status: 'paid',
      fulfillment_status: 'fulfilled',
      processed_at: clean(transaction.dateTime) || new Date().toISOString(),
      source_name: sourceName,
      note: `Offline aankoop @ ${clean(storeName)} · bon ${clean(transaction.receiptNr) || '-'} · ${clean(transaction.dateTime) || ''}`,
      send_receipt: false,
      send_fulfillment_receipt: false,
      inventory_behaviour: 'bypass', /* niet decrementeren — al verkocht in fysieke winkel */
      transactions: total > 0 ? [{
        kind: 'sale',
        status: 'success',
        amount: total.toFixed(2),
        gateway: 'manual'
      }] : undefined
    }
  };

  const data = await shopifyRest('/orders.json', { method: 'POST', body });
  const order = data.order;
  return {
    id: order.id,
    name: order.name,
    total: Number(order.total_price || total),
    tagsApplied: tags
  };
}

/* ─── Sync history (voor monitoring-pagina) ──────────────────────── */

export async function readSyncState() {
  return readJsonBlob(STATE_PATH, {
    lastRunAt: null,
    lastSuccessAt: null,
    processedCustomers: 0,
    createdOrders: 0,
    errors: 0,
    skippedNoEmail: 0,
    skippedNoShopify: 0
  });
}

export async function writeSyncState(state) {
  await writeJsonBlob(STATE_PATH, {
    ...state,
    lastRunAt: new Date().toISOString()
  });
}

export async function readSyncHistory() {
  return readJsonBlob(HISTORY_PATH, { runs: [] });
}

export async function appendSyncHistoryRun(run) {
  const data = await readSyncHistory();
  const runs = Array.isArray(data.runs) ? data.runs : [];
  const entry = {
    at: new Date().toISOString(),
    success: run.success !== false,
    durationMs: Number(run.durationMs || 0),
    dryRun: Boolean(run.dryRun),
    lookbackDays: Number(run.lookbackDays || 1),
    transactionsInPeriod: Number(run.transactionsInPeriod || 0),
    uniqueCustomersWithTx: Number(run.uniqueCustomersWithTx || 0),
    processedCustomers: Number(run.processedCustomers || 0),
    createdOrders: Number(run.createdOrders || 0),
    alreadySynced: Number(run.alreadySynced || 0),
    skippedNoEmail: Number(run.skippedNoEmail || 0),
    skippedNoShopify: Number(run.skippedNoShopify || 0),
    errors: Number(run.errors || 0),
    errorDetails: (run.errorDetails || []).slice(0, MAX_ERROR_DETAILS),
    message: String(run.message || ''),
    triggeredBy: String(run.triggeredBy || 'cron')
  };
  /* Nieuwste vooraan, oudere verderop. Beperk total length. */
  runs.unshift(entry);
  if (runs.length > MAX_HISTORY_RUNS) runs.length = MAX_HISTORY_RUNS;
  await writeJsonBlob(HISTORY_PATH, { runs, updatedAt: new Date().toISOString() });
  return entry;
}

export function summarizeSyncHistory(runs = []) {
  const last24h = Date.now() - 24 * 60 * 60 * 1000;
  const last7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const last30d = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const stats = {
    totalRuns: runs.length,
    runsLast24h: 0,
    runsLast7d: 0,
    totalOrdersAllTime: 0,
    ordersLast24h: 0,
    ordersLast7d: 0,
    ordersLast30d: 0,
    errorsLast7d: 0,
    skippedNoShopifyLast7d: 0,
    skippedNoEmailLast7d: 0,
    successRateLast7d: 1,
    lastRun: runs[0] || null
  };
  let runsLast7dCount = 0;
  let successfulLast7d = 0;
  for (const run of runs) {
    if (!run.at) continue;
    const t = new Date(run.at).getTime();
    if (Number.isNaN(t)) continue;
    stats.totalOrdersAllTime += Number(run.createdOrders || 0);
    if (t >= last24h) {
      stats.runsLast24h += 1;
      stats.ordersLast24h += Number(run.createdOrders || 0);
    }
    if (t >= last7d) {
      stats.runsLast7d += 1;
      stats.ordersLast7d += Number(run.createdOrders || 0);
      stats.errorsLast7d += Number(run.errors || 0);
      stats.skippedNoShopifyLast7d += Number(run.skippedNoShopify || 0);
      stats.skippedNoEmailLast7d += Number(run.skippedNoEmail || 0);
      runsLast7dCount += 1;
      if (run.success !== false) successfulLast7d += 1;
    }
    if (t >= last30d) {
      stats.ordersLast30d += Number(run.createdOrders || 0);
    }
  }
  stats.successRateLast7d = runsLast7dCount > 0 ? successfulLast7d / runsLast7dCount : 1;
  return stats;
}
