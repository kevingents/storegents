/**
 * lib/bol-shopify-push.js
 *
 * Push Bol-orders naar Shopify zodat ze als reguliere orders verschijnen
 * (los van of Channable de fulfillment doet). Gebruik:
 *   - Bron: marketplace/bol-orders.json (gevuld door /api/cron/bol-orders)
 *   - Lookup EAN → Shopify variant via shopify-products-cache
 *   - Schrijft Shopify-order via REST /admin/api/{ver}/orders.json
 *   - Idempotency: marketplace/bol-shopify-pushed.json (bol-orderId → shopify-orderId)
 *
 * Belangrijk:
 *   - Geen prijs/klant-info beschikbaar uit onze gecachede bol-data → we maken
 *     een minimale order met financial_status=paid, inventory_behaviour=decrement
 *     en tag 'bol-marketplace' + 'bol-id-{orderId}' voor herkenning/idempotency.
 *   - Shopify gebruikt de variant-default-price als we geen prijs sturen.
 *     Voor accountancy-doeleinden moet de echte bedrag-administratie elders.
 *   - Inventory wordt correct gedecrementeerd op de Shopify-default-locatie.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { readBolOrders } from './bol-orders.js';
import { readProductsCache } from './shopify-products-cache.js';

const PUSHED_PATH = 'marketplace/bol-shopify-pushed.json';
const SHOPIFY_TIMEOUT_MS = Number(process.env.SHOPIFY_API_TIMEOUT_MS || 30000);

const clean = (v) => String(v == null ? '' : v).trim();

function getShopifyConfig() {
  const shop = (process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || '';
  const version = process.env.SHOPIFY_API_VERSION || '2025-01';
  if (!shop || !token) return null;
  return { shop, token, version };
}

/* ─── Idempotency-state ──────────────────────────────────────────────── */

async function readPushedState() {
  const data = await readJsonBlob(PUSHED_PATH, null).catch(() => null);
  if (data && typeof data === 'object' && data.pushed && typeof data.pushed === 'object') return data;
  return { pushed: {}, updatedAt: null, runCount: 0 };
}

async function writePushedState(state) {
  await writeJsonBlob(PUSHED_PATH, {
    ...state,
    updatedAt: new Date().toISOString(),
    runCount: Number(state.runCount || 0) + 1
  });
}

/* ─── EAN → Shopify variant lookup ───────────────────────────────────── */

function lookupVariantByEan(cache, ean) {
  if (!ean) return null;
  const byBarcode = cache?.byBarcode || {};
  const v = byBarcode[String(ean).toLowerCase()];
  return v || null;
}

function buildLineItems(bolItems, cache) {
  const items = [];
  const missing = [];
  for (const it of (bolItems || [])) {
    const ean = clean(it.ean);
    const qty = Math.max(1, Number(it.qty || it.quantity || 1));
    const v = lookupVariantByEan(cache, ean);
    if (!v) {
      missing.push({ ean, titel: it.titel || '' });
      continue;
    }
    const variantId = Number(v.shopifyVariantId || v.variantId || v.id || 0);
    if (!variantId) {
      missing.push({ ean, titel: it.titel || '', reason: 'variant heeft geen Shopify ID' });
      continue;
    }
    items.push({ variant_id: variantId, quantity: qty });
  }
  return { items, missing };
}

/* ─── Shopify order create ───────────────────────────────────────────── */

async function createShopifyOrder(cfg, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SHOPIFY_TIMEOUT_MS);
  try {
    const r = await fetch(`https://${cfg.shop}/admin/api/${cfg.version}/orders.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': cfg.token,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    const text = await r.text().catch(() => '');
    if (!r.ok) {
      let msg = `Shopify API ${r.status}`;
      try {
        const errJson = JSON.parse(text);
        if (errJson.errors) {
          const flat = Object.entries(errJson.errors)
            .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((m) => `${k}: ${m}`))
            .join('; ');
          if (flat) msg = flat;
        } else if (errJson.message) {
          msg = errJson.message;
        }
      } catch {
        if (text) msg = `${msg} — ${text.slice(0, 300)}`;
      }
      throw new Error(msg);
    }
    try {
      const json = JSON.parse(text);
      return json.order || {};
    } catch (_) {
      throw new Error('Shopify orderCreate gaf geen geldige JSON');
    }
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`Shopify orderCreate timeout na ${SHOPIFY_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ─── Main push-flow ─────────────────────────────────────────────────── */

/**
 * Push tot maxPerRun nieuwe Bol-orders naar Shopify.
 * @param {Object} opts
 * @param {boolean} [opts.dryRun=false]    — niets schrijven, alleen rapporteren
 * @param {number}  [opts.maxPerRun=50]    — max aantal orders deze run
 * @param {boolean} [opts.force=false]     — push ook orders die al gepusht zijn (alleen voor recovery)
 */
export async function pushBolOrdersToShopify({ dryRun = false, maxPerRun = 50, force = false } = {}) {
  const cfg = getShopifyConfig();
  if (!cfg) {
    return { success: false, configured: false, message: 'SHOPIFY_STORE_DOMAIN of SHOPIFY_ADMIN_ACCESS_TOKEN ontbreekt.' };
  }

  const [bolData, pushedState, productsCache] = await Promise.all([
    readBolOrders().catch(() => null),
    readPushedState(),
    readProductsCache().catch(() => null)
  ]);

  if (!bolData) {
    return { success: false, message: 'Geen Bol-orders-cache (draai eerst /api/cron/bol-orders).' };
  }
  if (!productsCache) {
    return { success: false, message: 'Geen Shopify products-cache (draai /api/cron/shopify-products-refresh).' };
  }

  const orders = Array.isArray(bolData.orders) ? bolData.orders : [];
  const pushedMap = { ...(pushedState.pushed || {}) };

  let pushed = 0, skippedAlready = 0, failed = 0, skippedNoVariant = 0;
  const results = [];
  let processed = 0;

  for (const order of orders) {
    if (processed >= maxPerRun) break;
    const orderId = clean(order.orderId || order.id);
    if (!orderId) {
      skippedAlready += 1;
      continue;
    }
    if (!force && pushedMap[orderId]) {
      skippedAlready += 1;
      continue;
    }

    processed += 1;
    const placedDate = clean(order.datum || order.orderPlacedDateTime || '');

    /* Map line items via EAN → Shopify variant. */
    const { items: lineItems, missing } = buildLineItems(order.items || [], productsCache);
    if (!lineItems.length) {
      skippedNoVariant += 1;
      results.push({
        orderId,
        success: false,
        error: 'Geen Shopify-varianten gevonden voor de EANs in deze order.',
        missing
      });
      continue;
    }

    const tagList = ['bol-marketplace', 'channable-bypass', `bol-id-${orderId}`];
    const payload = {
      order: {
        line_items: lineItems,
        financial_status: 'paid',
        send_receipt: false,
        send_fulfillment_receipt: false,
        inventory_behaviour: 'decrement_obeying_policy',
        taxes_included: true,
        tags: tagList.join(', '),
        note: `Bol marketplace order ${orderId}${placedDate ? ` · geplaatst ${placedDate}` : ''} · gepusht door bol-shopify-sync`,
        note_attributes: [
          { name: 'bol_order_id', value: orderId },
          { name: 'bol_placed_at', value: placedDate },
          { name: 'source', value: 'bol-shopify-push' }
        ],
        email: `bol-${orderId}@orders.gents.nl`,
        ...(placedDate ? { processed_at: (() => { try { return new Date(placedDate).toISOString(); } catch { return undefined; } })() } : {})
      }
    };

    if (dryRun) {
      pushed += 1;
      results.push({ orderId, dryRun: true, success: true, lineItems: lineItems.length, missingItems: missing.length });
      continue;
    }

    try {
      const created = await createShopifyOrder(cfg, payload);
      pushed += 1;
      pushedMap[orderId] = {
        shopifyOrderId: String(created.id || ''),
        shopifyOrderName: String(created.name || ''),
        at: new Date().toISOString(),
        lineItems: lineItems.length,
        missingItems: missing.length
      };
      results.push({
        orderId,
        success: true,
        shopifyOrderId: created.id,
        shopifyOrderName: created.name,
        lineItems: lineItems.length,
        missingItems: missing.length
      });
    } catch (e) {
      failed += 1;
      results.push({ orderId, success: false, error: e.message });
    }
  }

  if (!dryRun && pushed > 0) {
    await writePushedState({ ...pushedState, pushed: pushedMap });
  }

  return {
    success: true,
    configured: true,
    dryRun,
    summary: {
      totalBolOrders: orders.length,
      processed,
      pushed,
      skippedAlready,
      skippedNoVariant,
      failed,
      remainingUnpushed: Math.max(0, orders.length - Object.keys(pushedMap).length)
    },
    results
  };
}

/** Read-only: hoeveel orders zitten er in de pushed-state? Handig voor admin-UI. */
export async function readBolShopifyPushedState() {
  return readPushedState();
}
