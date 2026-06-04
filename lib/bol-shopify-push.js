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
import { bolGet, getBolConfig } from './bol-client.js';

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

/**
 * Multi-strategy lookup voor Bol-item → Shopify variant:
 *   1. byBarcode op exacte EAN (primary path)
 *   2. bySku op EAN (in geval Shopify de EAN in SKU-veld zet)
 *   3. byBarcode op SRS-sku als die in het Bol-item bekend is (zeldzaam)
 *
 * Returnt { variant, hit } waar hit beschrijft hoe we 'm vonden.
 */
function lookupVariantByEan(cache, ean, srsSku) {
  if (!cache) return { variant: null, hit: null };
  const byBarcode = cache.byBarcode || {};
  const bySku = cache.bySku || {};
  if (ean) {
    const k = String(ean).toLowerCase();
    if (byBarcode[k]) return { variant: byBarcode[k], hit: 'barcode' };
    if (bySku[k]) return { variant: bySku[k], hit: 'sku-as-ean' };
  }
  if (srsSku) {
    const k = String(srsSku).toLowerCase();
    if (bySku[k]) return { variant: bySku[k], hit: 'srs-sku' };
    if (byBarcode[k]) return { variant: byBarcode[k], hit: 'barcode-as-sku' };
  }
  return { variant: null, hit: null };
}

/**
 * Live Shopify-search via GraphQL voor 1 barcode. Fallback wanneer onze cache
 * de barcode niet kent.
 *
 * Probeert 3 paden in volgorde (snel → breed):
 *   A) productVariants(query: "barcode:X")   — exact barcode-veld op variant
 *   B) productVariants(query: "sku:X")       — EAN als SKU gevuld (komt voor)
 *   C) products(query: "barcode:X") + scan   — zelfde wijdere search als de UI
 *      gebruikt (matcht ook metafields en tag-context); we filteren daarna op
 *      exacte variant-barcode binnen de gevonden producten.
 *
 * Self-healing voor oude producten waar de cache iets miste OF waar Shopify's
 * variant-query 'm niet vindt (search-index latency, special chars).
 */
async function searchShopifyVariantByBarcode(cfg, barcode) {
  const target = String(barcode).trim();
  if (!target) return null;
  const targetLower = target.toLowerCase();

  async function gql(query, variables) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(`https://${cfg.shop}/admin/api/${cfg.version}/graphql.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': cfg.token,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({ query, variables }),
        signal: ctrl.signal
      });
      if (!r.ok) return null;
      const j = await r.json().catch(() => null);
      if (j?.errors) return null;
      return j?.data || null;
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  const toVariant = (v, prodOverride) => {
    const variantId = clean(v.id).replace(/^gid:\/\/shopify\/ProductVariant\//, '');
    const product = prodOverride || v.product || {};
    return {
      shopifyVariantId: variantId,
      sku: clean(v.sku),
      barcode: clean(v.barcode),
      productTitle: clean(product.title),
      status: clean(product.status)
    };
  };

  const pickBest = (arr) => {
    if (!arr.length) return null;
    return arr.find((x) => clean(x.status).toLowerCase() === 'active') || arr[0];
  };

  /* Pad A: productVariants by barcode */
  {
    const data = await gql(`query($q:String!){productVariants(first:10,query:$q){nodes{id sku barcode product{id title status}}}}`, { q: `barcode:${target}` });
    const nodes = data?.productVariants?.nodes || [];
    const exact = nodes.filter((n) => clean(n.barcode).toLowerCase() === targetLower).map((n) => toVariant(n));
    const hit = pickBest(exact);
    if (hit) return hit;
  }

  /* Pad B: productVariants by sku (EAN gevuld als SKU) */
  {
    const data = await gql(`query($q:String!){productVariants(first:10,query:$q){nodes{id sku barcode product{id title status}}}}`, { q: `sku:${target}` });
    const nodes = data?.productVariants?.nodes || [];
    /* Voor SKU-pad: we accepteren ofwel exacte SKU-match ofwel exacte
       barcode-match — beide betekent dat dit het juiste product is. */
    const exact = nodes
      .filter((n) => clean(n.sku).toLowerCase() === targetLower || clean(n.barcode).toLowerCase() === targetLower)
      .map((n) => toVariant(n));
    const hit = pickBest(exact);
    if (hit) return hit;
  }

  /* Pad C: products by barcode (zelfde brede zoek als Shopify Admin UI). Scant
     alle variants per gevonden product en pakt exacte barcode-match. */
  {
    const data = await gql(`query($q:String!){products(first:5,query:$q){nodes{id title status variants(first:100){nodes{id sku barcode}}}}}`, { q: `barcode:${target}` });
    const products = data?.products?.nodes || [];
    const candidates = [];
    for (const p of products) {
      for (const v of (p.variants?.nodes || [])) {
        if (clean(v.barcode).toLowerCase() === targetLower) {
          candidates.push(toVariant(v, p));
        }
      }
    }
    const hit = pickBest(candidates);
    if (hit) return hit;
  }

  /* Niets gevonden. */
  return null;
}

async function buildLineItemsWithFallback(cfg, bolItems, cache, priceByEan) {
  const items = [];
  const missing = [];
  const lookupHits = { barcode: 0, 'sku-as-ean': 0, 'srs-sku': 0, 'barcode-as-sku': 0, 'live-search': 0 };
  for (const it of (bolItems || [])) {
    /* Bol-veld kan 'ean', 'barcode', of 'product.ean' heten — pak ze allemaal
       en de eerste niet-lege wint als identifier. */
    const ean = clean(it.ean || it.barcode || it.product?.ean || it.product?.barcode || it.gtin || '');
    const srsSku = clean(it.sku || it.offerReference || it.product?.reference || '');
    const qty = Math.max(1, Number(it.qty || it.quantity || 1));

    /* Pad 1: cache-lookup (snel) */
    let { variant: v, hit } = lookupVariantByEan(cache, ean, srsSku);

    /* Pad 2: live Shopify GraphQL-search als cache niets vond. Self-healing
       voor oude producten waar de cache-build de barcode is misgelopen. */
    if (!v && ean) {
      const live = await searchShopifyVariantByBarcode(cfg, ean);
      if (live) { v = live; hit = 'live-search'; }
    }

    if (!v) {
      missing.push({ ean, titel: it.titel || '', maat: it.maat || '', kleur: it.kleur || '' });
      continue;
    }
    if (hit) lookupHits[hit] = (lookupHits[hit] || 0) + 1;
    const variantId = Number(v.shopifyVariantId || v.variantId || v.id || 0);
    if (!variantId) {
      missing.push({ ean, titel: it.titel || '', reason: 'variant gevonden maar zonder Shopify variant_id' });
      continue;
    }
    const li = { variant_id: variantId, quantity: qty };
    const price = priceByEan ? priceByEan.get(String(ean).toLowerCase()) : null;
    if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
      li.price = price.toFixed(2);
    }
    items.push(li);
  }
  return { items, missing, lookupHits };
}

/* ─── Bol order-detail (echte klant + prijs + adres) ─────────────────── */

/**
 * Haalt detail van 1 Bol-order op (customer email, shipping address, prijzen
 * per orderitem). Returnt null bij fail — caller doet dan een minimal-stub
 * payload (oude gedrag).
 */
async function fetchBolOrderDetail(orderId) {
  try {
    const data = await bolGet(`/orders/${encodeURIComponent(orderId)}`);
    return data || null;
  } catch (e) {
    return { _error: e.message || 'detail-call mislukt' };
  }
}

/* Bouw shipping_address object voor Shopify uit Bol shipmentDetails. */
function buildShopifyAddress(d) {
  if (!d || typeof d !== 'object') return null;
  const firstName = clean(d.firstName || d.firstname);
  const lastName = clean(d.surname || d.lastName);
  const streetName = clean(d.streetName || d.street);
  const houseNumber = clean(d.houseNumber || '');
  const houseNumberExtension = clean(d.houseNumberExtension || d.houseNumberExt);
  const address1 = [streetName, houseNumber + (houseNumberExtension ? houseNumberExtension : '')].filter(Boolean).join(' ').trim();
  const zip = clean(d.zipCode || d.postalCode);
  const city = clean(d.city);
  const country = clean(d.countryCode || 'NL');
  if (!address1 && !zip && !city) return null;
  const addr = {
    first_name: firstName || 'Bol',
    last_name: lastName || 'Klant',
    address1: address1 || '-',
    zip: zip || '-',
    city: city || '-',
    country_code: country
  };
  if (d.extraAddressInformation) addr.address2 = clean(d.extraAddressInformation);
  if (d.deliveryPhoneNumber || d.phone) addr.phone = clean(d.deliveryPhoneNumber || d.phone);
  if (d.company) addr.company = clean(d.company);
  return addr;
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

    /* Per order live de Bol-detail-call doen voor: echte klant-email (anonimized
       door Bol naar consumer-XXX@verkopen.bol.com), shipping address, en prijzen
       per orderitem. Als detail-call faalt → fallback naar minimal-stub. */
    const detail = await fetchBolOrderDetail(orderId);
    const detailOk = detail && !detail._error;
    const shipmentDetails = detailOk ? (detail.shipmentDetails || {}) : {};
    const billingDetails = detailOk ? (detail.billingDetails || shipmentDetails) : {};

    /* EAN → prijs map + bron van waarheid voor barcode uit Bol-DETAIL (i.p.v.
       de soms ontbrekende EAN uit onze gecachede orders.items). Detail is altijd
       leidend wanneer de call slaagde. */
    const priceByEan = new Map();
    const detailItemsByCacheIndex = [];
    if (detailOk) {
      for (const di of (detail.orderItems || [])) {
        const ean = clean(di.ean || di.product?.ean);
        const up = Number(di.unitPrice);
        if (ean && Number.isFinite(up) && up > 0) priceByEan.set(String(ean).toLowerCase(), up);
        /* Bol kan internalReference / offer.reference hebben dat de SKU is — die
           gebruiken we als 2e identifier voor lookup. */
        detailItemsByCacheIndex.push({
          ean,
          sku: clean(di.offer?.reference || di.offerReference || di.product?.reference || ''),
          qty: Math.max(1, Number(di.quantity || 1)),
          titel: clean(di.product?.title || '')
        });
      }
    }

    /* Map line items: prefereer detail-items (echte EAN + ev. SKU) boven de
       gecachede cache-items. Detail-items zijn ECHT van Bol nu, niet uit cache.
       Met live-Shopify-fallback voor barcodes die niet in onze cache zitten. */
    const baseItems = detailOk && detailItemsByCacheIndex.length ? detailItemsByCacheIndex : (order.items || []);
    const { items: lineItems, missing, lookupHits } = await buildLineItemsWithFallback(cfg, baseItems, productsCache, priceByEan);
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

    /* Customer-email: voorkeur anonymized email uit Bol detail. */
    const bolEmail = detailOk ? clean(shipmentDetails.email || billingDetails.email) : '';
    const customerEmail = bolEmail || `bol-${orderId}@orders.gents.nl`;
    const shippingAddress = detailOk ? buildShopifyAddress(shipmentDetails) : null;
    const billingAddress = detailOk ? buildShopifyAddress(billingDetails) : null;

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
        note: `Bol marketplace order ${orderId}${placedDate ? ` · geplaatst ${placedDate}` : ''} · gepusht door bol-shopify-sync${detail?._error ? ` · DETAIL-FAIL: ${detail._error}` : ''}`,
        note_attributes: [
          { name: 'bol_order_id', value: orderId },
          { name: 'bol_placed_at', value: placedDate },
          { name: 'source', value: 'bol-shopify-push' },
          { name: 'detail_call_ok', value: detailOk ? 'true' : 'false' }
        ],
        email: customerEmail,
        ...(shippingAddress ? { shipping_address: shippingAddress } : {}),
        ...(billingAddress ? { billing_address: billingAddress } : {}),
        ...(detailOk && shipmentDetails.firstName ? {
          customer: {
            first_name: clean(shipmentDetails.firstName) || 'Bol',
            last_name: clean(shipmentDetails.surname) || 'Klant',
            email: customerEmail
          }
        } : {}),
        ...(placedDate ? { processed_at: (() => { try { return new Date(placedDate).toISOString(); } catch { return undefined; } })() } : {})
      }
    };

    if (dryRun) {
      pushed += 1;
      results.push({
        orderId,
        dryRun: true,
        success: true,
        lineItems: lineItems.length,
        missingItems: missing.length,
        detailOk,
        hasShipping: Boolean(shippingAddress),
        hasPrices: priceByEan.size > 0,
        email: customerEmail
      });
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
        missingItems: missing.length,
        detailOk,
        hasShipping: Boolean(shippingAddress),
        hasPrices: priceByEan.size > 0
      };
      results.push({
        orderId,
        success: true,
        shopifyOrderId: created.id,
        shopifyOrderName: created.name,
        lineItems: lineItems.length,
        missingItems: missing.length,
        detailOk,
        hasShipping: Boolean(shippingAddress),
        hasPrices: priceByEan.size > 0
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
