/**
 * lib/shopify-offline-sync.js
 *
 * Hulpfuncties voor het synchroniseren van SRS offline (POS) transacties
 * naar Shopify als historische orders.
 *
 * Architectuur:
 *  - findShopifyCustomerByEmail()  — zoek Shopify klant + laad bestaande sync-tags
 *  - isTransactionAlreadySynced()  — lokale Set-check (na pre-load, geen extra API-call)
 *  - createOfflineOrderInShopify() — maak Shopify order van SRS transactie
 *
 * Tags op gesyncede orders:
 *   gents-offline, store-<naam>, srs-receipt-<nr>, srs-tx-<branchId>-<receiptNr>
 *
 * Idempotency: de srs-tx-tag is uniek per transactie en voorkomt
 * dat dezelfde bon twee keer wordt gesynchroniseerd.
 */

import { getLocationIdByName } from './shopify-locations.js';

/* Module-level Set: gevuld per request door findShopifyCustomerByEmail */
let _syncedTags = null;

function getConfig() {
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

  if (!domain) throw new Error('Shopify store domain ontbreekt (stel SHOPIFY_STORE_DOMAIN in).');
  if (!token)  throw new Error('Shopify API token ontbreekt (stel SHOPIFY_ADMIN_ACCESS_TOKEN in).');

  return { domain, token, version };
}

/* Bouw de unieke sync-tag op (schone alfanumerieke vorm) */
function makeSyncTag(branchId, receiptNr) {
  const b = String(branchId  || '').replace(/[^a-zA-Z0-9]/g, '-');
  const r = String(receiptNr || '').replace(/[^a-zA-Z0-9]/g, '-');
  return `srs-tx-${b}-${r}`;
}

/**
 * Zoek Shopify klant op e-mail.
 * Laadt tegelijk alle bestaande srs-tx-tags voor die klant, zodat
 * isTransactionAlreadySynced() daarna lokaal kan werken (geen extra API-calls).
 *
 * @param {string} email
 * @returns {Promise<{id,email,firstName,lastName,totalSpent,orderCount}|null>}
 */
export async function findShopifyCustomerByEmail(email) {
  const { domain, token, version } = getConfig();
  _syncedTags = new Set(); // reset per aanroep

  const url = `https://${domain}/admin/api/${version}/customers.json` +
    `?email=${encodeURIComponent(email)}&limit=1&fields=id,email,first_name,last_name,total_spent,orders_count`;

  const r = await fetch(url, {
    headers: { 'X-Shopify-Access-Token': token, Accept: 'application/json' }
  });
  if (!r.ok) return null;

  const d = await r.json();
  const c = (d.customers || [])[0];
  if (!c) return null;

  /* Pre-load bestaande offline order tags voor idempotency */
  await _preloadSyncedTags(String(c.id), { domain, token, version });

  return {
    id:         String(c.id),
    email:      c.email       || email,
    firstName:  c.first_name  || '',
    lastName:   c.last_name   || '',
    totalSpent: Number(c.total_spent  || 0),
    orderCount: Number(c.orders_count || 0)
  };
}

/**
 * Haal via GraphQL alle offline orders voor deze klant op en bewaar
 * hun srs-tx-tags in _syncedTags voor lokale duplicaat-detectie.
 */
async function _preloadSyncedTags(shopifyCustomerId, { domain, token, version }) {
  const gql = `
    query OfflineTags($q: String!, $after: String) {
      orders(first: 50, query: $q, after: $after, sortKey: CREATED_AT, reverse: true) {
        edges {
          node { tags }
          cursor
        }
        pageInfo { hasNextPage }
      }
    }
  `;

  let after = null;
  let hasNextPage = true;
  let pages = 0;

  while (hasNextPage && pages < 5) {
    pages++;
    try {
      const r = await fetch(`https://${domain}/admin/api/${version}/graphql.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: gql,
          variables: {
            q: `customer_id:${shopifyCustomerId} tag:gents-offline`,
            ...(after ? { after } : {})
          }
        })
      });
      if (!r.ok) break;

      const data = await r.json();
      const edges = data?.data?.orders?.edges || [];

      for (const edge of edges) {
        /* GraphQL Order.tags kan string[] of komma-gescheiden string zijn */
        const raw = edge.node?.tags;
        const list = Array.isArray(raw)
          ? raw
          : String(raw || '').split(',').map(t => t.trim()).filter(Boolean);

        list.forEach(t => { if (t.startsWith('srs-tx-')) _syncedTags.add(t); });
        after = edge.cursor;
      }

      hasNextPage = Boolean(data?.data?.orders?.pageInfo?.hasNextPage) && edges.length > 0;
    } catch (_err) {
      /* Pre-load fout is niet fataal — worst case: dubbele order (idempotency-tag voorkomt dat) */
      break;
    }
  }
}

/**
 * Controleer of een SRS-transactie al gesynchroniseerd is naar Shopify.
 * Werkt lokaal via de Set van findShopifyCustomerByEmail() — geen extra API-call.
 *
 * @param {{ branchId: string, receiptNr: string }} opts
 * @returns {Promise<boolean>}
 */
export async function isTransactionAlreadySynced({ branchId, receiptNr }) {
  if (!_syncedTags) return false;
  return _syncedTags.has(makeSyncTag(branchId, receiptNr));
}

/**
 * Maak een Shopify order aan voor een SRS offline (POS) transactie.
 *
 * Eigenschappen van de aangemaakte order:
 *  - financial_status: paid  (al betaald in de winkel)
 *  - fulfillment_status: fulfilled  (al ontvangen door klant)
 *  - inventory_behaviour: bypass  (geen voorraad aftrekken in Shopify)
 *  - send_receipt: false  (geen bevestigingsmail naar klant)
 *  - processed_at: SRS transactiedatum
 *  - tags: gents-offline, store-<naam>, srs-receipt-<nr>, srs-tx-<branch>-<nr>
 *
 * @param {{ shopifyCustomerId: string, transaction: object, storeName: string }} opts
 * @returns {Promise<{ id: string, name: string, total: number }>}
 */
export async function createOfflineOrderInShopify({ shopifyCustomerId, transaction, storeName }) {
  const { domain, token, version } = getConfig();

  /* Alleen positieve items (geen retouren / nul-regels) */
  const validItems = (transaction.items || []).filter(
    i => Number(i.pieces || 0) > 0 && Number(i.charged || 0) > 0
  );
  if (!validItems.length) {
    throw new Error('Geen verkoopbare artikelen in transactie (alle items zijn retour of €0).');
  }

  const lineItems = validItems.map(i => {
    const qty   = Math.max(1, Math.abs(Math.round(Number(i.pieces || 1))));
    const total = Number(i.charged || 0);
    const price = (total / qty).toFixed(2);
    /* Gebruik SRS omschrijving → fallback naar "Artikel <sku>" → "Winkel-aankoop" */
    const desc  = String(i.description || '').trim();
    const title = desc || (i.sku ? `Artikel ${i.sku}` : 'Winkel-aankoop');
    return {
      title,
      price,
      quantity:          qty,
      sku:               i.sku || '',
      requires_shipping: false,
      taxable:           false,
      gift_card:         false
    };
  });

  /* BTW: aggregeer SRS vat-bedragen per BTW-tarief voor tax_lines op de order */
  const vatByRate = new Map();
  for (const i of validItems) {
    const charged = Number(i.charged || 0);
    const vat     = Number(i.vat     || 0);
    if (vat <= 0 || charged <= 0) continue;
    const rate = Math.round((vat / charged) * 100);   /* bv. 21 */
    const prev = vatByRate.get(rate) || 0;
    vatByRate.set(rate, prev + vat);
  }
  const taxLines = [...vatByRate.entries()]
    .map(([rate, total]) => ({
      title:     `BTW ${rate}%`,
      rate:      rate / 100,
      price:     total.toFixed(2)
    }));

  /* Fulfillment locatie — zoek Shopify location_id op naam (gecached) */
  let locationId;
  try {
    const found = await getLocationIdByName(storeName);
    if (found) locationId = Number(found);
  } catch { /* niet fataal — order zonder locatie is ook geldig */ }

  const branchId  = String(transaction.branchId  || '');
  const receiptNr = String(transaction.receiptNr || '');
  const txTag     = makeSyncTag(branchId, receiptNr);
  const storeSlug = (storeName || 'onbekend')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const tags = [
    'gents-offline',
    `store-${storeSlug}`,
    `srs-receipt-${receiptNr}`,
    txTag
  ].join(', ');

  /* processed_at: SRS transactiedatum zodat de order op de juiste datum staat */
  let processedAt;
  try {
    const dt = new Date(transaction.dateTime);
    if (!isNaN(dt.getTime())) processedAt = dt.toISOString();
  } catch { /* laat undefined */ }

  const payload = {
    order: {
      customer:                 { id: Number(shopifyCustomerId) },
      line_items:               lineItems,
      financial_status:         'paid',
      fulfillment_status:       'fulfilled',
      inventory_behaviour:      'bypass',
      send_receipt:             false,
      send_fulfillment_receipt: false,
      taxes_included:           true,    /* SRS charged-bedragen bevatten al BTW */
      ...(taxLines.length    ? { tax_lines: taxLines }    : {}),
      ...(locationId         ? { location_id: locationId } : {}),
      /* Delivery method tonen als "Gekocht in winkel" i.p.v. default
         "Verzendkosten" in Shopify Admin Orders-overzicht. Prijs 0, titel
         is wat in de kolom "Delivery method" verschijnt. */
      shipping_lines: [{
        title: 'Gekocht in winkel',
        price: '0.00',
        code: 'in-store-purchase',
        source: 'winkel'
      }],
      /* Channel-kolom: "winkel" i.p.v. default "Online Store" — markeert
         dat deze order in een fysieke winkel is gekocht. */
      source_name: 'winkel',
      tags,
      note: `Offline winkel-aankoop · ${storeName || branchId} · bon ${receiptNr}`,
      note_attributes: [
        { name: 'srs_receipt_nr', value: receiptNr },
        { name: 'srs_branch_id',  value: branchId  },
        { name: 'srs_store',      value: storeName || '' }
      ],
      ...(processedAt ? { processed_at: processedAt } : {})
    }
  };

  const r = await fetch(`https://${domain}/admin/api/${version}/orders.json`, {
    method:  'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type':           'application/json',
      Accept:                   'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!r.ok) {
    const raw = await r.text().catch(() => '');
    let msg = `Shopify API ${r.status}`;
    try {
      const errJson = JSON.parse(raw);
      const msgs = Object.entries(errJson.errors || {})
        .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map(m => `${k}: ${m}`))
        .join('; ');
      if (msgs)               msg = msgs;
      else if (errJson.message) msg = errJson.message;
    } catch {
      if (raw) msg = `${msg} — ${raw.slice(0, 250)}`;
    }
    throw new Error(msg);
  }

  const d = await r.json();
  const order = d.order || {};

  /* Voeg tag toe aan lokale cache: dubbele sync binnen dezelfde run wordt zo ook geblokkeerd */
  _syncedTags?.add(txTag);

  return {
    id:    String(order.id         || ''),
    name:  String(order.name       || ''),
    total: Number(order.total_price || 0)
  };
}

/* ─── State + history persistentie (Vercel Blob) ──────────────────────────── */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const STATE_PATH   = 'shopify-offline-sync/state.json';
const HISTORY_PATH = 'shopify-offline-sync/history.json';
const MAX_HISTORY  = 200;   /* max bewaarde runs */

/**
 * Lees de meest recente run-state (bv. lastSuccessAt, createdOrders).
 * Geeft {} terug als nog nooit gedraaid.
 */
export async function readSyncState() {
  return readJsonBlob(STATE_PATH, {});
}

/**
 * Sla de run-state op.
 */
export async function writeSyncState(state) {
  return writeJsonBlob(STATE_PATH, state || {});
}

/**
 * Lees de volledige run-history.
 * Structuur: { runs: [...], updatedAt }
 */
export async function readSyncHistory() {
  return readJsonBlob(HISTORY_PATH, { runs: [] });
}

/**
 * Voeg een run toe aan de history (nieuwste eerst, max MAX_HISTORY entries).
 */
export async function appendSyncHistoryRun(run) {
  const history = await readSyncHistory();
  const runs = Array.isArray(history.runs) ? history.runs : [];
  runs.unshift({ ...run, at: run.at || new Date().toISOString() });
  return writeJsonBlob(HISTORY_PATH, { runs: runs.slice(0, MAX_HISTORY), updatedAt: new Date().toISOString() });
}

/**
 * Aggregeer statistieken uit de run-history array.
 * Wordt gebruikt door de admin status-pagina.
 *
 * @param {Array} runs
 * @returns {{
 *   totalRuns, totalOrdersAllTime,
 *   ordersLast24h, runsLast24h,
 *   ordersLast7d, runsLast7d, errorsLast7d, successRateLast7d,
 *   skippedNoShopifyLast7d, skippedNoEmailLast7d,
 *   ordersLast30d, runsLast30d,
 *   lastRun
 * }}
 */
export function summarizeSyncHistory(runs) {
  const now   = Date.now();
  const t24h  = now - 24 * 60 * 60 * 1000;
  const t7d   = now - 7  * 24 * 60 * 60 * 1000;
  const t30d  = now - 30 * 24 * 60 * 60 * 1000;

  let totalOrdersAllTime   = 0;
  let ordersLast24h = 0, runsLast24h = 0;
  let ordersLast7d  = 0, runsLast7d  = 0, errorsLast7d = 0;
  let successLast7d = 0, skippedNoShopifyLast7d = 0, skippedNoEmailLast7d = 0;
  let ordersLast30d = 0, runsLast30d = 0;

  for (const run of runs) {
    const t   = new Date(run.at || 0).getTime();
    const ord = Number(run.createdOrders || 0);
    const err = Number(run.errors        || 0);
    const ok  = Boolean(run.success);

    totalOrdersAllTime += ord;

    if (t >= t24h) { ordersLast24h += ord; runsLast24h++; }
    if (t >= t7d)  {
      ordersLast7d  += ord;
      runsLast7d++;
      errorsLast7d  += err;
      if (ok) successLast7d++;
      skippedNoShopifyLast7d += Number(run.skippedNoShopify || 0);
      skippedNoEmailLast7d   += Number(run.skippedNoEmail   || 0);
    }
    if (t >= t30d) { ordersLast30d += ord; runsLast30d++; }
  }

  return {
    totalRuns:               runs.length,
    totalOrdersAllTime,
    ordersLast24h,   runsLast24h,
    ordersLast7d,    runsLast7d,
    errorsLast7d,
    successRateLast7d: runsLast7d ? successLast7d / runsLast7d : 0,
    skippedNoShopifyLast7d,
    skippedNoEmailLast7d,
    ordersLast30d,   runsLast30d,
    lastRun: runs[0] || null
  };
}
