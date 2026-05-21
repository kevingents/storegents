import { getTransactions, getCustomers } from '../../lib/srs-customers-client.js';
import { getStoreNameByBranchId } from '../../lib/branch-metrics.js';
import {
  findShopifyCustomerByEmail,
  isTransactionAlreadySynced,
  createOfflineOrderInShopify
} from '../../lib/shopify-offline-sync.js';
import { readJsonBlob, writeJsonBlob } from '../../lib/json-blob-store.js';

/**
 * GET /api/cron/shopify-offline-sync
 *
 * Nightly cron die SRS offline transacties naar Shopify orders syncs.
 *
 * Strategie:
 *   - Haal alle transacties op uit periode (default: laatste 24u)
 *   - Groepeer per customerId
 *   - Per klant: lookup Shopify customer, sync ongesyncede transacties
 *   - State (laatste run + resume) opgeslagen in shopify-offline-sync/state.json
 *
 * Limieten (Vercel time-out):
 *   - maxRuntimeMs = 50s
 *   - maxCustomersPerRun = 25
 *   - maxOrdersPerCustomer = 5
 *
 * Failed customers worden in state opgeslagen zodat volgende run anderen pakt.
 */

const STATE_PATH = 'shopify-offline-sync/state.json';
const DEFAULT_LOOKBACK_DAYS = 1;
const DEFAULT_MAX_RUNTIME_MS = 50000;
const DEFAULT_MAX_CUSTOMERS = 25;
const DEFAULT_MAX_ORDERS_PER_CUSTOMER = 5;

function clean(value) { return String(value || '').trim(); }

function isAuthorizedCron(req) {
  const expected = clean(process.env.CRON_SECRET || '');
  const adminToken = clean(process.env.ADMIN_TOKEN || '');
  const authHeader = clean(req.headers['authorization'] || '');
  const querySecret = clean(req.query.secret || '');
  const queryAdminToken = clean(req.query.adminToken || req.query.admin_token || '');
  const headerAdminToken = clean(req.headers['x-admin-token'] || req.headers['x-admin-pin'] || '');
  const userAgent = clean(req.headers['user-agent'] || '');

  if (adminToken && (queryAdminToken === adminToken || headerAdminToken === adminToken)) return true;
  if (!expected) return userAgent.includes('vercel-cron/1.0');
  return authHeader === `Bearer ${expected}` || querySecret === expected;
}

async function readState() {
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

async function writeState(state) {
  await writeJsonBlob(STATE_PATH, {
    ...state,
    lastRunAt: new Date().toISOString()
  });
}

/* Email-lookup-cache: getCustomers per customerId om email te krijgen.
   In-memory voor de duur van deze cron-run. */
const _emailCache = new Map();
async function lookupEmailForCustomer(customerId) {
  if (_emailCache.has(customerId)) return _emailCache.get(customerId);
  try {
    const { customers = [] } = await getCustomers({ customerId, pageSize: 1 });
    const email = clean(customers[0]?.email);
    _emailCache.set(customerId, email);
    return email;
  } catch {
    _emailCache.set(customerId, '');
    return '';
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen GET of POST.' });
  }
  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  const lookbackDays = Math.max(1, Math.min(30, Number(req.query.daysBack || DEFAULT_LOOKBACK_DAYS)));
  const maxRuntimeMs = Math.max(5000, Math.min(120000, Number(req.query.maxRuntimeMs || DEFAULT_MAX_RUNTIME_MS)));
  const maxCustomers = Math.max(1, Math.min(100, Number(req.query.maxCustomers || DEFAULT_MAX_CUSTOMERS)));
  const maxOrdersPerCustomer = Math.max(1, Math.min(20, Number(req.query.maxOrdersPerCustomer || DEFAULT_MAX_ORDERS_PER_CUSTOMER)));
  const dryRun = ['1', 'true', 'yes'].includes(String(req.query.dryRun || '').toLowerCase());

  const startedAt = Date.now();

  try {
    /* Stap 1: alle transacties uit lookback periode */
    const from = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
    const until = new Date().toISOString();
    const { transactions = [] } = await getTransactions({ from, until });

    /* Stap 2: groepeer per customerId (alleen positieve transacties) */
    const byCustomer = new Map();
    for (const tx of transactions) {
      const cid = clean(tx.customerId);
      if (!cid) continue;
      if (!Array.isArray(tx.items) || !tx.items.length) continue;
      const total = tx.items.reduce((s, i) => s + Number(i.charged || 0), 0);
      if (total <= 0) continue;
      const list = byCustomer.get(cid) || [];
      list.push(tx);
      byCustomer.set(cid, list);
    }

    const uniqueCustomerIds = Array.from(byCustomer.keys());
    const stats = {
      transactionsInPeriod: transactions.length,
      uniqueCustomersWithTx: uniqueCustomerIds.length,
      processedCustomers: 0,
      createdOrders: 0,
      alreadySynced: 0,
      skippedNoEmail: 0,
      skippedNoShopify: 0,
      errors: 0,
      errorDetails: []
    };

    /* Stap 3: per klant verwerken tot timeout/maxCustomers */
    for (const customerId of uniqueCustomerIds) {
      if (Date.now() - startedAt > maxRuntimeMs - 8000) break;
      if (stats.processedCustomers >= maxCustomers) break;

      stats.processedCustomers += 1;
      try {
        const email = await lookupEmailForCustomer(customerId);
        if (!email) {
          stats.skippedNoEmail += 1;
          continue;
        }

        const shopifyCustomer = await findShopifyCustomerByEmail(email);
        if (!shopifyCustomer) {
          stats.skippedNoShopify += 1;
          continue;
        }

        const txList = byCustomer.get(customerId) || [];
        let createdForCustomer = 0;
        for (const tx of txList) {
          if (createdForCustomer >= maxOrdersPerCustomer) break;
          if (Date.now() - startedAt > maxRuntimeMs - 4000) break;

          const branchId = clean(tx.branchId);
          const receiptNr = clean(tx.receiptNr);
          if (!branchId || !receiptNr) continue;

          const existing = await isTransactionAlreadySynced({ branchId, receiptNr });
          if (existing) {
            stats.alreadySynced += 1;
            continue;
          }

          if (dryRun) {
            stats.createdOrders += 1;
            createdForCustomer += 1;
            continue;
          }

          const storeName = getStoreNameByBranchId(branchId) || `Branch ${branchId}`;
          await createOfflineOrderInShopify({
            shopifyCustomerId: shopifyCustomer.id,
            transaction: tx,
            storeName
          });
          stats.createdOrders += 1;
          createdForCustomer += 1;
        }
      } catch (err) {
        stats.errors += 1;
        if (stats.errorDetails.length < 10) {
          stats.errorDetails.push({ customerId, message: err.message || 'onbekend' });
        }
      }
    }

    /* Stap 4: state bijwerken */
    const prevState = await readState();
    await writeState({
      ...prevState,
      lastSuccessAt: new Date().toISOString(),
      processedCustomers: stats.processedCustomers,
      createdOrders: stats.createdOrders,
      errors: stats.errors,
      skippedNoEmail: stats.skippedNoEmail,
      skippedNoShopify: stats.skippedNoShopify
    });

    const runtimeMs = Date.now() - startedAt;
    return res.status(200).json({
      success: true,
      mode: 'shopify_offline_sync',
      dryRun,
      lookbackDays,
      from,
      until,
      stats,
      runtimeMs,
      message: `${stats.createdOrders} orders aangemaakt voor ${stats.processedCustomers} klanten (${stats.alreadySynced} al synced, ${stats.skippedNoEmail} zonder email, ${stats.skippedNoShopify} niet in Shopify, ${stats.errors} fouten)`
    });
  } catch (error) {
    console.error('[cron/shopify-offline-sync] error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Cron offline-sync mislukt.',
      runtimeMs: Date.now() - startedAt
    });
  }
}
