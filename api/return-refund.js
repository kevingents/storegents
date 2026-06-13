import { createSrsReturn } from '../lib/srs-client.js';
import { getSrsBranchId } from '../lib/srs-branches.js';
import { createSrsReturnLog } from '../lib/srs-return-log-store.js';
import { getFulfillments, isSrsReturnableStatus } from '../lib/srs-weborders-message-client.js';
import { peekIdempotency, markIdempotencyDone } from '../lib/idempotency-store.js';

const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';

const SHOPIFY_RETURN_CREATE_ENABLED = String(process.env.SHOPIFY_RETURN_CREATE_ENABLED || 'true').toLowerCase() !== 'false';
const SHOPIFY_RETURN_CREATE_REQUIRED = String(process.env.SHOPIFY_RETURN_CREATE_REQUIRED || 'true').toLowerCase() !== 'false';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, x-admin-token, x-admin-pin, authorization'
  );
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanShopUrl(url) {
  return String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function shopifyUrl(path) {
  return `https://${cleanShopUrl(SHOPIFY_STORE_URL)}/admin/api/${SHOPIFY_API_VERSION}${path}`;
}

function shopifyGid(type, id) {
  const value = String(id || '');
  return value.startsWith('gid://') ? value : `gid://shopify/${type}/${value}`;
}

function numericIdFromGid(value) {
  return String(value || '').split('/').pop();
}

function readableShopifyError(data) {
  if (!data) return 'Onbekende Shopify fout';
  if (typeof data === 'string') return data;

  if (Array.isArray(data.errors)) {
    return data.errors.map((item) => item.message || JSON.stringify(item)).join(', ');
  }

  if (data.errors) {
    return typeof data.errors === 'string' ? data.errors : JSON.stringify(data.errors);
  }

  if (data.error) {
    return typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
  }

  if (data.message) return data.message;
  if (data.raw) return String(data.raw).slice(0, 400);

  return JSON.stringify(data);
}

async function shopifyRequest(path, options = {}, attempt = 0) {
  const response = await fetch(shopifyUrl(path), {
    ...options,
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch (_error) {
    data = { raw: text };
  }

  const rateLimited =
    response.status === 429 ||
    String(data.errors || data.error || data.raw || '').toLowerCase().includes('exceeded 20 calls per second');

  if (rateLimited && attempt < 5) {
    const retryAfter = Number(response.headers.get('retry-after') || 0);
    await sleep(retryAfter ? retryAfter * 1000 : 1200 + attempt * 800);
    return shopifyRequest(path, options, attempt + 1);
  }

  if (!response.ok) {
    const error = new Error(readableShopifyError(data));
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

async function shopifyGraphql(query, variables = {}) {
  const response = await fetch(shopifyUrl('/graphql.json'), {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch (_error) {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(readableShopifyError(data));
    error.status = response.status;
    error.data = data;
    throw error;
  }

  if (data.errors && data.errors.length) {
    const error = new Error(data.errors.map((item) => item.message).join(', '));
    error.status = 500;
    error.data = data.errors;
    throw error;
  }

  return data.data;
}

async function getOrderById(orderId) {
  const cleanId = String(orderId || '')
    .replace('gid://shopify/Order/', '')
    .replace(/^#/, '')
    .trim();

  const data = await shopifyRequest(`/orders/${cleanId}.json?status=any`, {
    method: 'GET'
  });

  return data.order;
}

async function getOrderFulfillments(orderId) {
  const cleanId = String(orderId || '')
    .replace('gid://shopify/Order/', '')
    .replace(/^#/, '')
    .trim();

  const data = await shopifyRequest(`/orders/${cleanId}/fulfillments.json`, {
    method: 'GET'
  });

  return data.fulfillments || [];
}

function fulfilledQuantitiesFromFulfillments(fulfillments) {
  const map = new Map();

  for (const fulfillment of fulfillments || []) {
    const status = String(fulfillment.status || '').toLowerCase();
    if (['cancelled', 'canceled', 'failure'].includes(status)) continue;

    for (const lineItem of fulfillment.line_items || []) {
      const id = String(lineItem.id || '');
      if (!id) continue;
      map.set(id, (map.get(id) || 0) + Number(lineItem.quantity || 0));
    }
  }

  return map;
}

function getSafeFulfilledQuantity(orderLineItem, fulfilledMap, order) {
  const lineItemId = String(orderLineItem.id || '');
  const fromLineItem = Number(orderLineItem.fulfilled_quantity || 0);
  const fromFulfillments = Number(fulfilledMap.get(lineItemId) || 0);

  if (fromLineItem > 0) return fromLineItem;
  if (fromFulfillments > 0) return fromFulfillments;

  const orderFulfillmentStatus = String(order.fulfillment_status || '').toLowerCase();
  if (['fulfilled', 'partial'].includes(orderFulfillmentStatus)) {
    return Number(orderLineItem.quantity || 0);
  }

  return 0;
}

async function addOrderTags(order, tagsToAdd) {
  const existingTags = String(order.tags || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);

  const tags = Array.from(new Set([...existingTags, ...tagsToAdd]));

  return shopifyRequest(`/orders/${order.id}.json`, {
    method: 'PUT',
    body: JSON.stringify({
      order: {
        id: order.id,
        tags: tags.join(', ')
      }
    })
  });
}

function normalizeBody(req) {
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch (_error) {
      return {};
    }
  }

  return req.body || {};
}

function normalizeSelectedItems(items) {
  if (!Array.isArray(items)) return [];

  return items
    .map((item) => ({
      lineItemId: String(item.lineItemId || item.id || '').trim(),
      quantity: Number(item.quantity || 0),
      fulfillmentId: String(item.fulfillmentId || '').trim(),
      orderLineNr: String(item.orderLineNr || item.orderLineNumber || '').trim(),
      sku: String(item.sku || item.barcode || '').trim(),
      title: String(item.title || item.name || '').trim(),
      amount: Number(item.amount || 0)
    }))
    .filter((item) => item.lineItemId && item.quantity > 0);
}

function refundedQuantitiesByLineItem(order) {
  const map = new Map();

  for (const refund of order.refunds || []) {
    for (const refundLineItem of refund.refund_line_items || []) {
      const id = String(refundLineItem.line_item_id || refundLineItem.line_item?.id || '');
      if (!id) continue;
      map.set(id, (map.get(id) || 0) + Number(refundLineItem.quantity || 0));
    }
  }

  return map;
}

function isComplaintReason(reason) {
  return ['klacht', 'klachten', 'beschadigd', 'defect'].includes(String(reason || '').toLowerCase().trim());
}

function getSrsOrderNr(body, order) {
  return String(
    body.srsOrderNr ||
    body.orderNr ||
    body.orderName ||
    body.orderNumber ||
    order?.name ||
    order?.order_number ||
    ''
  )
    .replace(/^#/, '')
    .trim();
}

function getDiscountedUnitPrice(lineItem) {
  const quantity = Math.max(Number(lineItem.quantity || 1), 1);
  const gross = Number(lineItem.price || 0) * quantity;
  const discount = Number(lineItem.total_discount || 0);
  const netTotal = Math.max(gross - discount, 0);
  return netTotal / quantity;
}

function matchSrsFulfillment({ selectedItem, orderLineItem, srsFulfillments }) {
  const fulfillmentId = String(selectedItem.fulfillmentId || '').trim();
  if (fulfillmentId) {
    const found = srsFulfillments.find((item) => String(item.fulfillmentId || '').trim() === fulfillmentId);
    if (found) return found;
  }

  const orderLineNr = String(selectedItem.orderLineNr || '').trim();
  if (orderLineNr) {
    const found = srsFulfillments.find((item) => String(item.orderLineNr || '').trim() === orderLineNr);
    if (found) return found;
  }

  const sku = String(selectedItem.sku || orderLineItem?.sku || '').trim().toLowerCase();
  if (sku) {
    return srsFulfillments.find((item) => String(item.sku || '').trim().toLowerCase() === sku) || null;
  }

  return null;
}

function buildSrsItems({ selectedItems, refundLineItems, orderLineItems, srsFulfillments }) {
  return refundLineItems.map((refundLineItem) => {
    const lineItem = orderLineItems.find((item) => String(item.id) === String(refundLineItem.line_item_id));
    const selected = selectedItems.find((item) => String(item.lineItemId) === String(refundLineItem.line_item_id));
    const srsFulfillment = matchSrsFulfillment({
      selectedItem: selected || {},
      orderLineItem: lineItem,
      srsFulfillments
    });

    const sku = selected?.sku || lineItem?.sku || srsFulfillment?.sku || '';

    return {
      fulfillmentId: selected?.fulfillmentId || srsFulfillment?.fulfillmentId || '',
      orderLineNr: selected?.orderLineNr || srsFulfillment?.orderLineNr || '',
      sku,
      barcode: sku,
      quantity: refundLineItem.quantity,
      pieces: refundLineItem.quantity,
      price: getDiscountedUnitPrice(lineItem || {})
    };
  });
}

function returnedItemNoteLines({ refundLineItems, orderLineItems }) {
  return refundLineItems.map((refundLineItem) => {
    const lineItem = orderLineItems.find((item) => String(item.id) === String(refundLineItem.line_item_id));
    const title = lineItem?.name || 'Onbekend artikel';
    const sku = lineItem?.sku || '';
    const quantity = Number(refundLineItem.quantity || 0);
    const unitPrice = getDiscountedUnitPrice(lineItem || {});
    const total = quantity * unitPrice;

    return [
      `- ${title}`,
      sku ? `SKU ${sku}` : '',
      `aantal ${quantity}`,
      `EUR ${total.toFixed(2)}`
    ]
      .filter(Boolean)
      .join(' | ');
  });
}

async function safeCreateSrsReturnLog(input) {
  try {
    return await createSrsReturnLog(input);
  } catch (error) {
    console.error('SRS retourlog schrijven mislukt:', error);
    return null;
  }
}

async function getReturnableFulfillmentLineItems(orderId) {
  const orderGid = shopifyGid('Order', orderId);

  const query = `
    query GetReturnableFulfillmentLineItems($id: ID!) {
      order(id: $id) {
        id
        name
        fulfillments(first: 50) {
          id
          status
          fulfillmentLineItems(first: 100) {
            edges {
              node {
                id
                quantity
                lineItem {
                  id
                  sku
                  name
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphql(query, { id: orderGid });
  const order = data.order;

  if (!order) {
    throw new Error('Shopify order kon niet via GraphQL worden opgehaald voor returnCreate.');
  }

  const rows = [];

  for (const fulfillment of order.fulfillments || []) {
    const status = String(fulfillment.status || '').toLowerCase();
    if (['cancelled', 'canceled', 'failure'].includes(status)) continue;

    for (const edge of fulfillment.fulfillmentLineItems?.edges || []) {
      const node = edge.node || {};
      const lineItem = node.lineItem || {};
      const lineItemId = numericIdFromGid(lineItem.id);

      rows.push({
        fulfillmentId: fulfillment.id,
        fulfillmentLineItemId: node.id,
        quantity: Number(node.quantity || 0),
        lineItemGid: lineItem.id || '',
        lineItemId,
        sku: String(lineItem.sku || '').trim(),
        name: lineItem.name || ''
      });
    }
  }

  return rows;
}

function mapSelectedItemsToReturnLineItems({ selectedItems, refundLineItems, fulfillmentLineItems, orderLineItems, reason }) {
  const returnLineItems = [];
  const errors = [];

  for (const refundLineItem of refundLineItems) {
    const selected = selectedItems.find((item) => String(item.lineItemId) === String(refundLineItem.line_item_id));
    const orderLineItem = orderLineItems.find((item) => String(item.id) === String(refundLineItem.line_item_id));
    const requestedQuantity = Number(refundLineItem.quantity || 0);
    const selectedSku = String(selected?.sku || orderLineItem?.sku || '').trim().toLowerCase();

    const candidates = fulfillmentLineItems.filter((item) => {
      const sameLineItem = String(item.lineItemId || '') === String(refundLineItem.line_item_id);
      const sameSku = selectedSku && String(item.sku || '').trim().toLowerCase() === selectedSku;
      return sameLineItem || sameSku;
    });

    if (!candidates.length) {
      errors.push(`Geen Shopify fulfillmentLineItem gevonden voor ${orderLineItem?.name || selected?.title || refundLineItem.line_item_id}.`);
      continue;
    }

    let remaining = requestedQuantity;
    for (const candidate of candidates) {
      if (remaining <= 0) break;
      const available = Number(candidate.quantity || 0);
      if (available <= 0) continue;
      const quantity = Math.min(remaining, available);

      returnLineItems.push({
        fulfillmentLineItemId: candidate.fulfillmentLineItemId,
        quantity,
        returnReason: 'OTHER',
        returnReasonNote: reason || 'Retour via winkelportaal'
      });

      remaining -= quantity;
    }

    if (remaining > 0) {
      errors.push(`${orderLineItem?.name || selected?.title || refundLineItem.line_item_id} heeft onvoldoende fulfillmentLineItem quantity voor Shopify Return.`);
    }
  }

  return { returnLineItems, errors };
}

async function createShopifyReturn({ orderId, selectedItems, refundLineItems, orderLineItems, reason, note }) {
  if (!SHOPIFY_RETURN_CREATE_ENABLED) {
    return {
      skipped: true,
      success: false,
      message: 'Shopify returnCreate staat uit via SHOPIFY_RETURN_CREATE_ENABLED=false.'
    };
  }

  const fulfillmentLineItems = await getReturnableFulfillmentLineItems(orderId);
  const mapped = mapSelectedItemsToReturnLineItems({
    selectedItems,
    refundLineItems,
    fulfillmentLineItems,
    orderLineItems,
    reason
  });

  if (mapped.errors.length) {
    const error = new Error(mapped.errors.join(' '));
    error.code = 'RETURN_LINE_ITEM_MAPPING_FAILED';
    error.details = mapped.errors;
    throw error;
  }

  if (!mapped.returnLineItems.length) {
    const error = new Error('Geen Shopify return line items gevonden.');
    error.code = 'NO_RETURN_LINE_ITEMS';
    throw error;
  }

  const mutation = `
    mutation CreateReturn($returnInput: ReturnInput!) {
      returnCreate(returnInput: $returnInput) {
        return {
          id
          status
          name
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    returnInput: {
      orderId: shopifyGid('Order', orderId),
      returnLineItems: mapped.returnLineItems,
      notifyCustomer: true,
      requestedAt: new Date().toISOString()
    }
  };

  const data = await shopifyGraphql(mutation, variables);
  const result = data.returnCreate;
  const userErrors = result?.userErrors || [];

  if (userErrors.length) {
    const error = new Error(userErrors.map((item) => item.message).join(', '));
    error.code = 'SHOPIFY_RETURN_CREATE_FAILED';
    error.details = userErrors;
    throw error;
  }

  return {
    success: true,
    return: result.return,
    returnLineItems: mapped.returnLineItems
  };
}


async function closeShopifyReturn(returnId) {
  if (!returnId) {
    return {
      success: false,
      skipped: true,
      message: 'Geen Shopify Return ID ontvangen om te sluiten.'
    };
  }

  const mutation = `
    mutation CloseReturn($id: ID!) {
      returnClose(id: $id) {
        return {
          id
          status
          closedAt
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const data = await shopifyGraphql(mutation, { id: returnId });
  const result = data.returnClose;
  const userErrors = result?.userErrors || [];

  if (userErrors.length) {
    const error = new Error(userErrors.map((item) => item.message).join(', '));
    error.code = 'SHOPIFY_RETURN_CLOSE_FAILED';
    error.details = userErrors;
    throw error;
  }

  return {
    success: true,
    return: result.return
  };
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Methode niet toegestaan' });
  }

  if (!SHOPIFY_ACCESS_TOKEN || !SHOPIFY_STORE_URL) {
    return res.status(500).json({
      success: false,
      error: 'Shopify configuratie ontbreekt',
      details: 'Controleer SHOPIFY_ACCESS_TOKEN en SHOPIFY_STORE_URL in Vercel.'
    });
  }

  const body = normalizeBody(req);

  /* Idempotency: voorkomt dubbele refund bij dubbel-klik / hapering / retry.
     Client genereert een UUID; backend cached de eerste success-response. */
  const idempotencyKey = String(
    body.idempotencyKey ||
    req.headers['x-idempotency-key'] ||
    req.headers['idempotency-key'] ||
    ''
  ).trim();

  if (idempotencyKey) {
    try {
      const cached = await peekIdempotency('refund', idempotencyKey);
      if (cached) {
        console.log('[refund] idempotency replay', idempotencyKey.slice(0, 12));
        return res.status(cached.status).json({ ...cached.body, replayed: true });
      }
    } catch (error) {
      console.warn('[refund] idempotency peek fail:', error.message);
      /* Bij peek-fout: gewoon doorgaan met normale flow. */
    }
  }

  const orderId = String(body.orderId || body.id || '').trim();
  const employeeName = String(body.employeeName || body.medewerker || '').trim();
  const reason = String(body.reason || body.reden || '').trim();
  const complaintText = String(body.complaintText || body.complaint || '').trim();
  const note = String(body.note || '').trim();
  const store = String(body.store || '').trim();
  const confirmed = body.confirm === true || body.confirmed === true || body.confirmation === true;
  const reasonChecked = body.reasonChecked === true || body.reason_checked === true;
  const crossSellMade = body.crossSellMade === true || body.cross_sell_made === true;
  const crossSellAmount = Number(body.crossSellAmount ?? body.cross_sell_amount ?? 0) || 0;
  /* Ruil: klant nam een ander artikel mee i.p.v. geld terug. Optioneel het
     vervangende artikel + waarde. Voor de ruil-vs-retour-cijfers per winkel. */
  const exchange = body.exchange === true || body.ruil === true;
  const exchangeItem = String(body.exchangeItem || body.ruilArtikel || '').trim();
  const exchangeAmount = Number(body.exchangeAmount ?? body.ruil_bedrag ?? 0) || 0;
  const selectedItems = normalizeSelectedItems(body.items || body.selectedItems || body.refundItems);

  /* SRS-restock: of het artikel teruggeboekt mag worden op het meldende filiaal.
     LET OP: Shopify-voorraad wordt NOOIT aangepast — er loopt een stock-sync
     vanuit SRS naar Shopify, dus dubbele bevoorrading wordt voorkomen door
     hardcoded `restock_type: 'no_restock'` op het Shopify refund. */
  const srsRestock = body.srsRestock === undefined ? true : Boolean(body.srsRestock);
  /* Verzendkosten meecrediteren ja/nee */
  const includeShipping = Boolean(body.includeShipping || body.refundShipping);
  const shippingAmount = Number(body.shippingAmount || 0);

  if (!confirmed) return res.status(400).json({ success: false, error: 'Bevestiging ontbreekt. De medewerker moet bevestigen dat de klant terugbetaald mag worden.' });
  if (!reasonChecked) return res.status(400).json({ success: false, error: 'Bevestig dat de retourreden klopt met de fysieke staat van het artikel.' });
  if (!store) return res.status(400).json({ success: false, error: 'Winkel ontbreekt. De retour moet geboekt worden op het filiaal dat de retour meldt.' });
  if (!orderId) return res.status(400).json({ success: false, error: 'Order ID ontbreekt' });
  if (!employeeName) return res.status(400).json({ success: false, error: 'Naam medewerker ontbreekt' });
  if (!reason) return res.status(400).json({ success: false, error: 'Retourreden ontbreekt' });
  if (isComplaintReason(reason) && !complaintText) return res.status(400).json({ success: false, error: 'Klachtomschrijving is verplicht bij retourreden Klacht / beschadigd / defect.' });
  if (!selectedItems.length) return res.status(400).json({ success: false, error: 'Selecteer minimaal een product' });
  if (crossSellMade && !(crossSellAmount > 0)) return res.status(400).json({ success: false, error: 'Vul het cross-sell bedrag in (> 0) als de klant iets anders heeft gekocht.' });

  let order = null;
  let srsBranchId = '';
  let srsOrderNr = '';
  let srsItems = [];

  try {
    order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, error: 'Order niet gevonden' });

    srsOrderNr = getSrsOrderNr(body, order);
    srsBranchId = getSrsBranchId(store);

    if (!srsOrderNr) {
      return res.status(400).json({
        success: false,
        error: 'SRS OrderNr ontbreekt. Geef srsOrderNr/orderNr mee of zorg dat Shopify order.name gelijk is aan het SRS webordernummer.'
      });
    }

    const srsFulfillmentResult = await getFulfillments({ orderNr: srsOrderNr });
    const srsFulfillments = srsFulfillmentResult.fulfillments || [];
    const orderLineItems = order.line_items || [];
    const fulfillments = await getOrderFulfillments(orderId);
    const fulfilledMap = fulfilledQuantitiesFromFulfillments(fulfillments);
    const refundedMap = refundedQuantitiesByLineItem(order);
    const blockedItems = [];

    const refundLineItems = selectedItems
      .map((selectedItem) => {
        const orderLineItem = orderLineItems.find((lineItem) => String(lineItem.id) === String(selectedItem.lineItemId));
        if (!orderLineItem) {
          blockedItems.push(`Geselecteerde retourregel kon niet aan Shopify orderregel worden gekoppeld: ${selectedItem.title || selectedItem.lineItemId}`);
          return null;
        }

        const selectedSku = String(selectedItem.sku || '').trim();
        const shopifySku = String(orderLineItem.sku || '').trim();
        if (selectedSku && shopifySku && selectedSku !== shopifySku) {
          blockedItems.push(`Veiligheidscontrole mislukt: geselecteerde SKU ${selectedSku} hoort niet bij Shopify regel ${orderLineItem.name} (${shopifySku}).`);
          return null;
        }

        const srsFulfillment = matchSrsFulfillment({ selectedItem, orderLineItem, srsFulfillments });
        if (!srsFulfillment) {
          blockedItems.push(`${orderLineItem.name} kon niet aan een SRS leveropdracht worden gekoppeld`);
          return null;
        }

        if (!isSrsReturnableStatus(srsFulfillment.status)) {
          blockedItems.push(`${orderLineItem.name} heeft SRS status ${srsFulfillment.status || 'onbekend'}; retour mag alleen bij processed`);
          return null;
        }

        const fulfilledQuantity = getSafeFulfilledQuantity(orderLineItem, fulfilledMap, order);
        const alreadyRefundedQuantity = Number(refundedMap.get(String(orderLineItem.id)) || 0);
        const maxReturnableQuantity = Math.max(fulfilledQuantity - alreadyRefundedQuantity, 0);

        if (fulfilledQuantity <= 0) {
          blockedItems.push(`${orderLineItem.name} is nog niet verzonden`);
          return null;
        }

        if (maxReturnableQuantity <= 0) {
          blockedItems.push(`${orderLineItem.name} is al volledig terugbetaald of niet retourbaar`);
          return null;
        }

        const quantity = Math.min(Number(selectedItem.quantity || 1), maxReturnableQuantity);
        return { line_item_id: Number(selectedItem.lineItemId), quantity, restock_type: 'no_restock' };
      })
      .filter(Boolean);

    if (blockedItems.length) {
      return res.status(400).json({
        success: false,
        error: 'Niet alle geselecteerde producten mogen retour.',
        details: blockedItems,
        rule: 'Retour mag alleen als Shopify fulfilled is en SRS fulfillment status processed is.'
      });
    }

    if (!refundLineItems.length) return res.status(400).json({ success: false, error: 'Geen geldige producten gevonden voor deze order' });

    srsItems = buildSrsItems({ selectedItems, refundLineItems, orderLineItems, srsFulfillments });
    const missingIdentifiers = srsItems.filter((item) => !item.sku && !item.barcode && !item.fulfillmentId && !item.orderLineNr);
    if (missingIdentifiers.length) return res.status(400).json({ success: false, error: 'Niet alle retourregels hebben een SKU/barcode, FulfillmentId of OrderLineNr voor SRS.' });

    const returnedItemLines = returnedItemNoteLines({ refundLineItems, orderLineItems });
    const returnNoteParts = [
      'Retour via winkelportaal.',
      `Medewerker: ${employeeName}.`,
      `Winkel: ${store}.`,
      `SRS OrderNr: ${srsOrderNr}.`,
      `Reden: ${reason}.`,
      returnedItemLines.length ? `Geretourneerde artikelen:\n${returnedItemLines.join('\n')}` : '',
      complaintText ? `Klacht: ${complaintText}.` : '',
      note ? `Opmerking: ${note}.` : ''
    ].filter(Boolean);

    let shopifyReturnResult = null;
    let shopifyReturnCloseResult = null;
    if (SHOPIFY_RETURN_CREATE_ENABLED) {
      try {
        shopifyReturnResult = await createShopifyReturn({
          orderId,
          selectedItems,
          refundLineItems,
          orderLineItems,
          reason,
          note: returnNoteParts.join('\n')
        });
      } catch (returnError) {
        if (SHOPIFY_RETURN_CREATE_REQUIRED) {
          return res.status(400).json({
            success: false,
            error: 'Shopify Return kon niet worden aangemaakt. Er is nog geen terugbetaling uitgevoerd.',
            message: returnError.message,
            details: returnError.details || null,
            hint: 'Controleer of write_returns/read_returns scopes actief zijn en of de geselecteerde orderregels fulfillmentLineItems hebben.'
          });
        }

        shopifyReturnResult = {
          success: false,
          skipped: true,
          fallback: true,
          error: returnError.message,
          details: returnError.details || null
        };
      }
    }

    /* Bouw refund body — refund_line_items + optionele shipping refund.
       restock_type blijft hardcoded 'no_restock' want SRS → Shopify stock-sync
       doet de webshop-bevoorrading. NIET dubbel bevoorraden. */
    const refundBodyForCalc = {
      currency: order.currency,
      refund_line_items: refundLineItems
    };
    if (includeShipping && shippingAmount > 0) {
      refundBodyForCalc.shipping = { amount: shippingAmount.toFixed(2) };
    } else if (includeShipping) {
      refundBodyForCalc.shipping = { full_refund: true };
    }

    const calculated = await shopifyRequest(`/orders/${orderId}/refunds/calculate.json`, {
      method: 'POST',
      body: JSON.stringify({ refund: refundBodyForCalc })
    });

    const calculatedRefund = calculated.refund || {};
    const transactions = (calculatedRefund.transactions || [])
      .filter((transaction) => Number(transaction.amount || 0) > 0)
      .map((transaction) => ({
        parent_id: transaction.parent_id,
        amount: transaction.amount,
        kind: 'refund',
        gateway: transaction.gateway
      }));

    if (!transactions.length) {
      return res.status(400).json({
        success: false,
        error: 'Geen terugbetaalbare transactie gevonden. Deze order is mogelijk al terugbetaald of heeft geen betaalbare transactie meer.'
      });
    }

    const noteParts = [
      `Retour verwerkt via winkelportaal door ${employeeName}.`,
      `Winkel: ${store}.`,
      `SRS BranchId: ${srsBranchId}.`,
      `SRS OrderNr: ${srsOrderNr}.`,
      `Reden: ${reason}.`,
      shopifyReturnResult?.success ? `Shopify Return: ${shopifyReturnResult.return?.name || shopifyReturnResult.return?.id || 'aangemaakt'}.` : '',
      returnedItemLines.length ? `Geretourneerde artikelen:\n${returnedItemLines.join('\n')}` : '',
      complaintText ? `Klacht: ${complaintText}.` : '',
      note ? `Opmerking: ${note}.` : '',
      'Shopify voorraad niet herbevoorraad; SRS Return boekt voorraad op het meldende filiaal.'
    ].filter(Boolean);

    const refundBodyForCreate = {
      currency: order.currency,
      notify: true,
      note: noteParts.join('\n'),
      refund_line_items: refundLineItems,
      transactions
    };
    if (includeShipping && shippingAmount > 0) {
      refundBodyForCreate.shipping = { amount: shippingAmount.toFixed(2) };
    } else if (includeShipping) {
      refundBodyForCreate.shipping = { full_refund: true };
    }

    const created = await shopifyRequest(`/orders/${orderId}/refunds.json`, {
      method: 'POST',
      body: JSON.stringify({ refund: refundBodyForCreate })
    });

    if (shopifyReturnResult?.success && shopifyReturnResult.return?.id) {
      try {
        shopifyReturnCloseResult = await closeShopifyReturn(shopifyReturnResult.return.id);
      } catch (closeError) {
        console.error('Shopify Return sluiten mislukt:', closeError);
        shopifyReturnCloseResult = {
          success: false,
          error: closeError.message || String(closeError),
          details: closeError.details || closeError.data || null
        };
      }
    }

    let srsResult = null;
    let srsLog = null;

    /* Als srsRestock=false (artikel onverkoopbaar / klacht-vernietiging),
       skippen we de SRS retour-call. Voorraad wordt dan NIET teruggeboekt op
       het filiaal. Wordt apart gelogd voor zichtbaarheid in admin. */
    if (!srsRestock) {
      srsLog = await safeCreateSrsReturnLog({
        store,
        employeeName,
        orderNr: srsOrderNr,
        shopifyOrderId: String(order.id),
        branchId: srsBranchId,
        status: 'skipped',
        success: true,
        srsTransactionId: '',
        items: srsItems,
        message: 'SRS retour-boeking overgeslagen — artikel niet terug in voorraad (bv. klacht/defect).',
        reasonChecked,
        crossSellMade,
        crossSellAmount,
        exchange,
        exchangeItem,
        exchangeAmount,
        customerEmail: String(order.email || order.contact_email || order.customer?.email || ''),
        customerName: String(order.customer?.first_name || '') + ' ' + String(order.customer?.last_name || ''),
        customerId: String(order.customer?.id || ''),
        reason,
        refundAmount: srsItems.reduce((sum, it) => sum + Number(it.price || 0) * Number(it.pieces || 1), 0)
      });

      await addOrderTags(order, [
        'winkelportaal_retour',
        'retour_veilig_gecontroleerd',
        shopifyReturnResult?.success ? 'shopify_return_aangemaakt' : 'shopify_return_controleren',
        'srs_retour_overgeslagen_onverkoopbaar'
      ]);

      const responseBody = {
        success: true,
        message: 'Retour verwerkt. Shopify-refund aangemaakt; SRS-voorraad NIET teruggeboekt (artikel onverkoopbaar).',
        shopifyRefund: created.refund || created,
        shopifyReturn: shopifyReturnResult,
        shopifyReturnClose: shopifyReturnCloseResult,
        srsReturn: { skipped: true, reason: 'srsRestock=false', status: 'skipped' },
        srsLog,
        shippingRefunded: includeShipping
      };
      if (idempotencyKey) await markIdempotencyDone('refund', idempotencyKey, 200, responseBody);
      return res.status(200).json(responseBody);
    }

    try {
      srsResult = await createSrsReturn({
        orderNr: srsOrderNr,
        branchId: srsBranchId,
        items: srsItems,
        dateTime: new Date().toISOString().slice(0, 19)
      });

      srsLog = await safeCreateSrsReturnLog({
        store,
        employeeName,
        orderNr: srsOrderNr,
        shopifyOrderId: String(order.id),
        branchId: srsBranchId,
        status: srsResult.status,
        success: srsResult.success,
        srsTransactionId: srsResult.transactionId,
        items: srsItems,
        message: srsResult.success ? 'Retour verwerkt in SRS op het meldende filiaal.' : 'SRS retour gaf geen completed status.',
        reasonChecked,
        crossSellMade,
        crossSellAmount,
        exchange,
        exchangeItem,
        exchangeAmount,
        customerEmail: String(order.email || order.contact_email || order.customer?.email || ''),
        customerName: String(order.customer?.first_name || '') + ' ' + String(order.customer?.last_name || ''),
        customerId: String(order.customer?.id || ''),
        reason,
        refundAmount: srsItems.reduce((sum, it) => sum + Number(it.price || 0) * Number(it.pieces || 1), 0)
      });

      await addOrderTags(order, [
        'winkelportaal_retour',
        'retour_veilig_gecontroleerd',
        shopifyReturnResult?.success ? 'shopify_return_aangemaakt' : 'shopify_return_controleren',
        srsResult.success ? 'srs_retour_verwerkt' : 'srs_retour_controleren'
      ]);
    } catch (srsError) {
      console.error('SRS retour verwerken mislukt:', srsError);
      srsLog = await safeCreateSrsReturnLog({
        store,
        employeeName,
        orderNr: srsOrderNr,
        shopifyOrderId: String(order.id),
        branchId: srsBranchId,
        status: 'failed',
        success: false,
        items: srsItems,
        message: srsError.message || 'SRS retour verwerken mislukt.',
        reasonChecked,
        crossSellMade,
        crossSellAmount,
        exchange,
        exchangeItem,
        exchangeAmount,
        customerEmail: String(order.email || order.contact_email || order.customer?.email || ''),
        customerName: String(order.customer?.first_name || '') + ' ' + String(order.customer?.last_name || ''),
        customerId: String(order.customer?.id || ''),
        reason,
        refundAmount: srsItems.reduce((sum, it) => sum + Number(it.price || 0) * Number(it.pieces || 1), 0)
      });

      await addOrderTags(order, [
        'winkelportaal_retour',
        'retour_veilig_gecontroleerd',
        shopifyReturnResult?.success ? 'shopify_return_aangemaakt' : 'shopify_return_controleren',
        'srs_retour_mislukt'
      ]);

      const partialBody = {
        success: true,
        partial: true,
        warning: 'Shopify refund is uitgevoerd, maar SRS retour is mislukt. Controleer SRS handmatig.',
        shopifyRefund: created.refund || created,
        shopifyReturn: shopifyReturnResult,
        shopifyReturnClose: shopifyReturnCloseResult,
        srsReturn: null,
        srsLog,
        srsError: srsError.message || String(srsError)
      };
      /* Partial wordt wel idempotent gemaakt: dubbele aanroep mag niet alsnog
         een 2e Shopify-refund triggeren. SRS opnieuw proberen doet de
         medewerker handmatig in SRS, niet via dit endpoint. */
      if (idempotencyKey) await markIdempotencyDone('refund', idempotencyKey, 200, partialBody);
      return res.status(200).json(partialBody);
    }

    const successBody = {
      success: true,
      message: 'Retour en terugbetaling verwerkt.',
      shopifyRefund: created.refund || created,
      shopifyReturn: shopifyReturnResult,
      shopifyReturnClose: shopifyReturnCloseResult,
      srsReturn: srsResult,
      srsLog
    };
    if (idempotencyKey) await markIdempotencyDone('refund', idempotencyKey, 200, successBody);
    return res.status(200).json(successBody);
  } catch (error) {
    console.error('Retour/terugbetaling verwerken mislukt:', error);
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Retour/terugbetaling kon niet worden verwerkt.',
      details: error.details || error.data || null
    });
  }
}
