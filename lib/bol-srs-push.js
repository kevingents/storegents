/**
 * lib/bol-srs-push.js
 *
 * Push Bol-marketplace-orders direct naar SRS (geen Shopify, geen Channable).
 * Genereert een eigen ordernummer met prefix BOL- (BOL-0001, BOL-0002, ...).
 *
 * Pijplijn:
 *   1. Lees marketplace/bol-orders.json (gevuld door /api/cron/bol-orders)
 *   2. Per niet-eerder-gepushte order:
 *      a) Live /orders/{id} detail-call → echte klant/adres/prijzen
 *      b) Lookup EAN → SRS-SKU via shopify-products-cache (sku-veld = SRS artikelnr)
 *      c) Genereer volgende BOL-NNNN ordernummer
 *      d) Bouw SRS weborder-XML + verstuur via SOAP OrderPlaced
 *   3. Sla pushed-state op (bolOrderId → { bolMarketplaceId, srsOrderId, at })
 *
 * Idempotency: marketplace/bol-srs-pushed.json
 * Counter:     marketplace/bol-order-counter.json
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { readBolOrders } from './bol-orders.js';
import { readProductsCache } from './shopify-products-cache.js';
import { bolGet } from './bol-client.js';
import {
  getCachedWeborderSession,
  invalidateSrsWeborderSession
} from './srs-weborder-client.js';
import { reserveNextBolOrderId } from './bol-order-counter.js';
import { recordBolSrsFailure, clearBolSrsFailure } from './bol-srs-failures-store.js';
import { readBolCancellationsState } from './bol-cancellations-store.js';

const PUSHED_PATH = 'marketplace/bol-srs-pushed.json';
const SRS_WEBORDER_PATH = '/webservices/si_weborder.php';
const SRS_TIMEOUT_MS = Number(process.env.SRS_SOAP_TIMEOUT_MS || 25000);

const clean = (v) => String(v == null ? '' : v).trim();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function cdata(value) {
  return `<![CDATA[${String(value ?? '').replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}
function formatAmount(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
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

/* ─── EAN → SRS-SKU lookup ───────────────────────────────────────────── */

function lookupSrsSkuByEan(cache, ean) {
  if (!cache || !ean) return null;
  const k = String(ean).toLowerCase();
  const variant = cache.byBarcode?.[k] || cache.bySku?.[k];
  if (!variant) return null;
  /* Shopify-cache slaat SRS-artikelnr op in het 'sku'-veld (zoals gebruiker
     bevestigde via barcode-batch-lookup: sku 2900002049039 voor barcode 5018746019861). */
  return {
    sku: clean(variant.sku),
    title: clean(variant.title),
    color: clean(variant.color),
    size: clean(variant.size),
    price: Number(variant.price) || 0
  };
}

/* ─── SRS weborder XML voor Bol-order ────────────────────────────────── */

function splitStreetHouse(streetName, houseNumber) {
  const street = clean(streetName);
  const num_ = clean(houseNumber);
  if (num_) return { street, houseNumber: num_ };
  /* Fallback: split eind van street op laatste cijfer-groep */
  const m = street.match(/^(.+?)\s+([0-9]+[a-zA-Z0-9\-/]*)$/);
  return m ? { street: m[1], houseNumber: m[2] } : { street, houseNumber: '' };
}

function addressXml(tag, addr) {
  if (!addr) return `<${tag}></${tag}>`;
  const { street, houseNumber } = splitStreetHouse(
    addr.streetName || addr.street,
    addr.houseNumber || ''
  );
  const ext = clean(addr.houseNumberExtension);
  const name = clean(`${addr.firstName || ''} ${addr.surname || addr.lastName || ''}`.trim()) || 'Bol Klant';
  return `
  <${tag}>
    <name>${xmlEscape(name.slice(0, 50))}</name>
    <street>${xmlEscape(street)}</street>
    <housenumber>${xmlEscape(houseNumber + (ext ? ext : ''))}</housenumber>
    ${addr.extraAddressInformation ? `<address>${xmlEscape(clean(addr.extraAddressInformation))}</address>` : ''}
    <postalcode>${xmlEscape(clean(addr.zipCode || addr.postalCode))}</postalcode>
    <city>${xmlEscape(clean(addr.city))}</city>
    <country>${xmlEscape(clean(addr.countryCode || 'NL'))}</country>
  </${tag}>`;
}

function productsXml(detailItems, cache) {
  const lines = [];
  const missing = [];
  for (const di of (detailItems || [])) {
    const ean = clean(di.ean || di.product?.ean);
    const qty = Math.max(1, num(di.quantity || 1));
    const lookup = lookupSrsSkuByEan(cache, ean);
    if (!lookup || !lookup.sku) {
      missing.push({ ean, productTitle: clean(di.product?.title) });
      continue;
    }
    const unitPrice = num(di.unitPrice) || lookup.price || 0;
    /* SRS adviseert per stuk een aparte product-regel. */
    for (let i = 0; i < qty; i += 1) {
      lines.push(`
    <product>
      <product_sku>${xmlEscape(lookup.sku)}</product_sku>
      <product_name>${xmlEscape((lookup.title || di.product?.title || lookup.sku).slice(0, 80))}</product_name>
      <product_quantity>1</product_quantity>
      <product_price>${formatAmount(unitPrice)}</product_price>
      <tax_perc>${formatAmount(process.env.SRS_BOL_TAX_PERC || 21)}</tax_perc>
    </product>`);
    }
  }
  return { xml: lines.join('\n'), missing };
}

function extendedAttribute(name, value) {
  if (value === undefined || value === null || String(value).trim() === '') return '';
  return `
    <extended_attribute>
      <name>${xmlEscape(name)}</name>
      <value>${xmlEscape(value)}</value>
    </extended_attribute>`;
}

function buildBolWeborderXml({ orderId, bolOrderId, detail, productsXmlStr, total, placedAt }) {
  const shipment = detail?.shipmentDetails || {};
  const billing = detail?.billingDetails || shipment;
  const email = clean(shipment.email || billing.email || `bol-${bolOrderId}@orders.gents.nl`);
  const phone = clean(shipment.deliveryPhoneNumber || billing.deliveryPhoneNumber || '');
  const sellingBranchId = clean(process.env.SRS_BOL_SELLING_BRANCH_ID || '700'); /* Showroom default */
  const fulfilmentBranchId = clean(process.env.SRS_BOL_FULFILMENT_BRANCH_ID || '99'); /* Magazijn default */
  const shopId = clean(process.env.SRS_BOL_SHOP_ID || process.env.SRS_WEBORDER_SHOP_ID || '10');
  const paymentType = clean(process.env.SRS_BOL_PAYMENT_TYPE || 'eft');
  const dateTime = placedAt
    ? new Date(placedAt).toISOString().slice(0, 16).replace('T', ' ')
    : new Date().toISOString().slice(0, 16).replace('T', ' ');

  /* SRS GENTS-config heeft de meeste extended_attribute-namen NIET vooraf
     geregistreerd, geeft dan error 140 "Problem adding order extended
     attribute" — bewezen issue ook in lib/srs-weborder-client.js reservering-
     pad. Default: GEEN extended_attributes. Filiaal-routing gaat post-place
     via een aparte SOAP-call SetFulfillments (volgende stap).
     Admin kan via env SRS_BOL_ATTRS=afhaal_filiaal,verkoop_filiaal opt-in
     als SRS de namen later wel registreert. */
  const allowedAttrs = String(process.env.SRS_BOL_ATTRS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const attrPool = {
    verkoop_filiaal: sellingBranchId,
    afhaal_filiaal: fulfilmentBranchId,
    verzend_filiaal: fulfilmentBranchId,
    aangemaakt_in_filiaal: sellingBranchId,
    opmerking: `BOL marketplace · ${bolOrderId}`
  };
  const extendedAttrsXml = allowedAttrs
    .map((name) => attrPool[name] !== undefined ? extendedAttribute(name, attrPool[name]) : '')
    .filter(Boolean)
    .join('');
  const extendedAttributesBlock = extendedAttrsXml
    ? `<extended_attributes>${extendedAttrsXml}</extended_attributes>`
    : '';

  /* Defaults zoals reservering-pad (open weborder): geen <crm_link>, geen
     <payments> — beide kunnen door SRS als 'extended attribute' worden
     geïnterpreteerd en error 140 triggeren. Opt-in via env als SRS ze accepteert.
       SRS_BOL_INCLUDE_CRM_LINK=1    -> voeg <crm_link>true</crm_link> toe
       SRS_BOL_INCLUDE_PAYMENTS=1    -> voeg <payments><payment>...</payment></payments> toe
     Voor bol-marketplace is "open weborder" semantisch juist: betaling loopt via
     Bol-uitkering, niet via een directe POS-payment. */
  const includeCrm = String(process.env.SRS_BOL_INCLUDE_CRM_LINK || '') === '1';
  const includePayments = String(process.env.SRS_BOL_INCLUDE_PAYMENTS || '') === '1';

  const crmLinkBlock = includeCrm ? '<crm_link>true</crm_link>' : '';
  const paymentsBlock = includePayments
    ? `<payments>
    <payment>
      <type>${xmlEscape(paymentType)}</type>
      <amount>${formatAmount(total)}</amount>
    </payment>
  </payments>`
    : '';

  /* Contact-velden alleen meesturen als gevuld. Lege XML-tags (<phone></phone>)
     kunnen SRS-validatie laten falen op "verplichte velden". */
  const contactLines = [
    `<email>${xmlEscape(email)}</email>`,
    phone ? `<phone>${xmlEscape(phone)}</phone>` : '',
    phone ? `<mobile>${xmlEscape(phone)}</mobile>` : ''
  ].filter(Boolean).join('\n    ');

  return `<order>
  <shopid>${xmlEscape(shopId)}</shopid>
  <orderid>${xmlEscape(orderId)}</orderid>
  ${crmLinkBlock}
  <date_time>${xmlEscape(dateTime)}</date_time>
  ${addressXml('billing', billing)}
  ${addressXml('delivery', shipment)}
  <contact>
    ${contactLines}
  </contact>
  <orderinfo>
    ${productsXmlStr}
  </orderinfo>
  ${paymentsBlock}
  ${extendedAttributesBlock}
</order>`;
}

/* ─── SOAP-call OrderPlaced ──────────────────────────────────────────── */

function getApiConfig() {
  const baseUrl = (process.env.SRS_API_BASE_URL || process.env.SRS_BASE_URL || 'https://ws.srs.nl').replace(/\/$/, '');
  return { endpoint: `${baseUrl}${SRS_WEBORDER_PATH}` };
}

async function placeWeborderSoap(sessionId, orderXml) {
  const { endpoint } = getApiConfig();
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:si="https://www.storeinfo.nl/webservices/si_weborder.php">
  <soapenv:Header/>
  <soapenv:Body>
    <si:OrderPlaced soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
      <session_id xsi:type="xsd:string">${xmlEscape(sessionId)}</session_id>
      <order_xml xsi:type="xsd:string">${cdata(orderXml)}</order_xml>
    </si:OrderPlaced>
  </soapenv:Body>
</soapenv:Envelope>`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SRS_TIMEOUT_MS);
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'OrderPlaced' },
      body: envelope,
      signal: ctrl.signal
    });
    const text = await r.text();
    if (!r.ok) {
      throw new Error(`SRS weborder HTTP ${r.status}: ${text.slice(0, 2000)}`);
    }
    /* SOAP-fault? */
    const faultStr = (text.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i) || [])[1];
    if (faultStr) throw new Error(`SRS SOAP fault: ${faultStr.trim()} — RAW: ${text.slice(0, 1500)}`);
    /* return-veld moet 'true' of '1' zijn */
    const ret = (text.match(/<return[^>]*>([\s\S]*?)<\/return>/i) || [])[1];
    if (!ret || (String(ret).toLowerCase().trim() !== 'true' && String(ret).trim() !== '1')) {
      throw new Error(`SRS OrderPlaced gaf geen positieve return: ${ret || text.slice(0, 200)}`);
    }
    return { ok: true, raw: text };
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`SRS OrderPlaced timeout na ${SRS_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ─── Bol order-detail ──────────────────────────────────────────────── */

export async function fetchBolOrderDetail(bolOrderId) {
  try {
    const data = await bolGet(`/orders/${encodeURIComponent(bolOrderId)}`);
    return data || null;
  } catch (e) {
    return { _error: e.message || 'detail-call mislukt' };
  }
}

/* Extraheer het delivery-adres (postcode + huisnummer) uit een bol-order-
   detail. Gebruikt door bol-shipment-push om Sendcloud-parcels te matchen. */
export function deliveryAddressFromDetail(detail) {
  const shipment = detail?.shipmentDetails || detail?.billingDetails || {};
  return {
    postalCode: clean(shipment.zipCode || shipment.postalCode),
    houseNumber: clean(shipment.houseNumber),
    houseNumberExtension: clean(shipment.houseNumberExtension),
    surname: clean(shipment.surname || shipment.lastName),
    firstName: clean(shipment.firstName),
    city: clean(shipment.city),
    countryCode: clean(shipment.countryCode || 'NL')
  };
}

/* ─── Main push-flow ─────────────────────────────────────────────────── */

/**
 * Push tot maxPerRun nieuwe Bol-orders naar SRS.
 * @param {Object} opts
 * @param {boolean} [opts.dryRun=false]        — geen SOAP-call, geen counter-increment
 * @param {number}  [opts.maxPerRun=50]
 * @param {boolean} [opts.force=false]         — herpush (recovery)
 * @param {string}  [opts.onlyBolOrderId='']   — beperken tot 1 specifieke bol-order
 */
export async function pushBolOrdersToSrs({ dryRun = false, maxPerRun = 50, force = false, onlyBolOrderId = '' } = {}) {
  const [bolData, pushedState, productsCache, cancelState] = await Promise.all([
    readBolOrders().catch(() => null),
    readPushedState(),
    readProductsCache().catch(() => null),
    readBolCancellationsState().catch(() => ({ cancelled: {} }))
  ]);

  if (!bolData) return { success: false, message: 'Geen Bol-orders-cache (draai eerst /api/cron/bol-orders).' };
  if (!productsCache) return { success: false, message: 'Geen Shopify products-cache (draai /api/cron/shopify-products-refresh).' };

  const orders = Array.isArray(bolData.orders) ? bolData.orders : [];
  const pushedMap = { ...(pushedState.pushed || {}) };
  const cancelledMap = (cancelState && cancelState.cancelled) || {};

  let sessionId = null;
  if (!dryRun) {
    try {
      sessionId = await getCachedWeborderSession();
    } catch (e) {
      return { success: false, message: `SRS-login mislukt: ${e.message || e}` };
    }
  }

  let pushed = 0, skippedAlready = 0, failed = 0, skippedNoItems = 0, skippedCancelled = 0;
  const results = [];
  let processed = 0;

  const filterId = clean(onlyBolOrderId);
  for (const order of orders) {
    if (processed >= maxPerRun) break;
    const bolOrderId = clean(order.orderId || order.id);
    if (!bolOrderId) { skippedAlready += 1; continue; }
    if (filterId && bolOrderId !== filterId) continue; /* alleen die ene */
    if (!force && pushedMap[bolOrderId]) { skippedAlready += 1; continue; }
    /* Geannuleerde orders niet pushen naar SRS. */
    if (cancelledMap[bolOrderId]) { skippedCancelled += 1; continue; }

    processed += 1;
    const placedAt = clean(order.datum || order.orderPlacedDateTime || '');

    /* Detail-call voor echte klant/adres/prijzen */
    const detail = await fetchBolOrderDetail(bolOrderId);
    const detailOk = detail && !detail._error;
    if (!detailOk) {
      failed += 1;
      const errMsg = `Bol detail-call faalde: ${detail?._error || 'onbekend'}`;
      /* Ook detail-fails registreren zodat ze zichtbaar zijn in de pipeline-status
         + badge, i.p.v. geruisloos te verdwijnen. */
      if (!dryRun) await recordBolSrsFailure(bolOrderId, { error: errMsg }).catch(() => {});
      results.push({ bolOrderId, success: false, error: errMsg });
      continue;
    }

    /* Bouw products-XML met SRS-SKUs */
    const { xml: productsXmlStr, missing } = productsXml(detail.orderItems || [], productsCache);
    if (!productsXmlStr) {
      skippedNoItems += 1;
      const missingEans = missing.map((m) => clean(m.ean)).filter(Boolean).join(', ');
      const errMsg = `Geen SRS-SKU gevonden voor EAN(s): ${missingEans || 'onbekend'}. Koppel deze producten in Shopify (barcode = bol-EAN, SKU = SRS-artikelnummer) zodat de order naar SRS kan.`;
      /* Registreren zodat deze "vergeten" orders zichtbaar zijn (pipeline-status,
         badge én alert-mail) i.p.v. elke run geruisloos overgeslagen te worden. */
      if (!dryRun) await recordBolSrsFailure(bolOrderId, { error: errMsg }).catch(() => {});
      results.push({ bolOrderId, success: false, error: errMsg, missing });
      continue;
    }

    /* Totaal-bedrag uit detail.orderItems */
    let total = 0;
    for (const di of (detail.orderItems || [])) {
      const up = num(di.unitPrice);
      const qty = Math.max(1, num(di.quantity || 1));
      total += up * qty;
    }

    /* Reserveer ordernummer (BOL-NNNN). In dry-run NIET reserveren — anders
       schiet de teller op zonder dat we werkelijk pushen. */
    let orderId;
    if (dryRun) {
      orderId = '(BOL-XXXX-preview)';
    } else {
      try {
        orderId = await reserveNextBolOrderId({ bolOrderId, actor: 'cron' });
      } catch (e) {
        failed += 1;
        results.push({ bolOrderId, success: false, error: `Ordernummer-reserve mislukt: ${e.message || e}` });
        continue;
      }
    }

    const orderXml = buildBolWeborderXml({
      orderId,
      bolOrderId,
      detail,
      productsXmlStr,
      total,
      placedAt
    });

    if (dryRun) {
      pushed += 1;
      results.push({
        bolOrderId,
        dryRun: true,
        success: true,
        previewOrderId: orderId,
        previewTotal: total,
        productsCount: (detail.orderItems || []).length,
        missingItems: missing.length,
        /* Volledige XML in dry-run zodat we precies kunnen zien wat naar SRS gaat. */
        orderXml,
        orderXmlLength: orderXml.length
      });
      continue;
    }

    /* Echte push */
    try {
      await placeWeborderSoap(sessionId, orderXml);
      pushed += 1;
      pushedMap[bolOrderId] = {
        srsOrderId: orderId,
        bolOrderId,
        at: new Date().toISOString(),
        total,
        itemCount: (detail.orderItems || []).length
      };
      /* Clear eventuele eerdere failure voor deze order. */
      await clearBolSrsFailure(bolOrderId).catch(() => {});
      results.push({
        bolOrderId,
        success: true,
        srsOrderId: orderId,
        total,
        itemCount: (detail.orderItems || []).length
      });
    } catch (e) {
      /* Sessie kapot? invalidate + retry 1× */
      if (/session/i.test(e.message || '')) {
        invalidateSrsWeborderSession();
        try {
          const fresh = await getCachedWeborderSession();
          await placeWeborderSoap(fresh, orderXml);
          pushed += 1;
          pushedMap[bolOrderId] = {
            srsOrderId: orderId, bolOrderId,
            at: new Date().toISOString(), total,
            itemCount: (detail.orderItems || []).length
          };
          await clearBolSrsFailure(bolOrderId).catch(() => {});
          results.push({ bolOrderId, success: true, srsOrderId: orderId, total, itemCount: (detail.orderItems || []).length, retried: true });
          continue;
        } catch (e2) {
          failed += 1;
          await recordBolSrsFailure(bolOrderId, { error: `SRS push (na sessie-reset) faalde: ${e2.message}`, srsOrderId: orderId }).catch(() => {});
          results.push({ bolOrderId, success: false, error: `SRS push (na sessie-reset) faalde: ${e2.message}`, srsOrderId: orderId });
          continue;
        }
      }
      failed += 1;
      await recordBolSrsFailure(bolOrderId, { error: e.message || 'SRS push faalde', srsOrderId: orderId }).catch(() => {});
      results.push({ bolOrderId, success: false, error: e.message || 'SRS push faalde', srsOrderId: orderId });
    }
  }

  if (!dryRun && pushed > 0) {
    await writePushedState({ ...pushedState, pushed: pushedMap });
  }

  return {
    success: true,
    dryRun,
    summary: {
      totalBolOrders: orders.length,
      processed,
      pushed,
      skippedAlready,
      skippedNoItems,
      skippedCancelled,
      failed,
      remainingUnpushed: Math.max(0, orders.length - Object.keys(pushedMap).length)
    },
    results
  };
}

export async function readBolSrsPushedState() {
  return readPushedState();
}
