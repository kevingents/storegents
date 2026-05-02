import { createSrsReturn } from '../lib/srs-client.js';
import { getSrsBranchId } from '../lib/srs-branches.js';
import { createSrsReturnLog } from '../lib/srs-return-log-store.js';
import { getFulfillments, isSrsReturnableStatus } from '../lib/srs-weborders-message-client.js';

const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function cleanShopUrl(url) { return String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, ''); }
function shopifyUrl(path) { return `https://${cleanShopUrl(SHOPIFY_STORE_URL)}/admin/api/${SHOPIFY_API_VERSION}${path}`; }

function readableShopifyError(data) {
  if (!data) return 'Onbekende Shopify fout';
  if (typeof data === 'string') return data;
  if (data.errors) return typeof data.errors === 'string' ? data.errors : JSON.stringify(data.errors);
  if (data.error) return typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
  if (data.message) return data.message;
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
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  const rateLimited = response.status === 429 || String(data.errors || data.error || data.raw || '').toLowerCase().includes('exceeded 20 calls per second');
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

async function getOrderById(orderId) {
  const data = await shopifyRequest(`/orders/${orderId}.json?status=any`, { method: 'GET' });
  return data.order;
}

async function getOrderFulfillments(orderId) {
  const data = await shopifyRequest(`/orders/${orderId}/fulfillments.json`, { method: 'GET' });
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
  if (['fulfilled', 'partial'].includes(orderFulfillmentStatus)) return Number(orderLineItem.quantity || 0);
  return 0;
}

async function addOrderTags(order, tagsToAdd) {
  const existingTags = String(order.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean);
  const tags = Array.from(new Set([...existingTags, ...tagsToAdd]));
  return shopifyRequest(`/orders/${order.id}.json`, { method: 'PUT', body: JSON.stringify({ order: { id: order.id, tags: tags.join(', ') } }) });
}

function normalizeBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

function normalizeSelectedItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    lineItemId: String(item.lineItemId || item.id || '').trim(),
    quantity: Number(item.quantity || 0),
    fulfillmentId: String(item.fulfillmentId || '').trim(),
    orderLineNr: String(item.orderLineNr || item.orderLineNumber || '').trim(),
    sku: String(item.sku || item.barcode || '').trim()
  })).filter((item) => item.lineItemId && item.quantity > 0);
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
  return String(body.srsOrderNr || body.orderNr || body.orderName || body.orderNumber || order?.name || order?.order_number || '').replace(/^#/, '').trim();
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
    const srsFulfillment = matchSrsFulfillment({ selectedItem: selected || {}, orderLineItem: lineItem, srsFulfillments });
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

async function safeCreateSrsReturnLog(input) {
  try { return await createSrsReturnLog(input); } catch (error) { console.error('SRS retourlog schrijven mislukt:', error); return null; }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Methode niet toegestaan' });

  if (!SHOPIFY_ACCESS_TOKEN || !SHOPIFY_STORE_URL) {
    return res.status(500).json({ success: false, error: 'Shopify configuratie ontbreekt', details: 'Controleer SHOPIFY_ACCESS_TOKEN en SHOPIFY_STORE_URL in Vercel.' });
  }

  const body = normalizeBody(req);
  const orderId = String(body.orderId || body.id || '').trim();
  const employeeName = String(body.employeeName || body.medewerker || '').trim();
  const reason = String(body.reason || body.reden || '').trim();
  const complaintText = String(body.complaintText || body.complaint || '').trim();
  const note = String(body.note || '').trim();
  const store = String(body.store || '').trim();
  const confirmed = body.confirm === true || body.confirmed === true || body.confirmation === true;
  const selectedItems = normalizeSelectedItems(body.items || body.selectedItems || body.refundItems);

  if (!confirmed) return res.status(400).json({ success: false, error: 'Bevestiging ontbreekt. De medewerker moet bevestigen dat de klant terugbetaald mag worden.' });
  if (!store) return res.status(400).json({ success: false, error: 'Winkel ontbreekt. De retour moet geboekt worden op het filiaal dat de retour meldt.' });
  if (!orderId) return res.status(400).json({ success: false, error: 'Order ID ontbreekt' });
  if (!employeeName) return res.status(400).json({ success: false, error: 'Naam medewerker ontbreekt' });
  if (!reason) return res.status(400).json({ success: false, error: 'Retourreden ontbreekt' });
  if (isComplaintReason(reason) && !complaintText) return res.status(400).json({ success: false, error: 'Klachtomschrijving is verplicht bij retourreden Klacht / beschadigd / defect.' });
  if (!selectedItems.length) return res.status(400).json({ success: false, error: 'Selecteer minimaal één product' });

  let order = null;
  let srsBranchId = '';
  let srsOrderNr = '';
  let srsItems = [];

  try {
    order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, error: 'Order niet gevonden' });

    srsOrderNr = getSrsOrderNr(body, order);
    srsBranchId = getSrsBranchId(store);
    if (!srsOrderNr) return res.status(400).json({ success: false, error: 'SRS OrderNr ontbreekt. Geef srsOrderNr/orderNr mee of zorg dat Shopify order.name gelijk is aan het SRS webordernummer.' });

    const srsFulfillmentResult = await getFulfillments({ orderNr: srsOrderNr });
    const srsFulfillments = srsFulfillmentResult.fulfillments || [];
    const orderLineItems = order.line_items || [];
    const fulfillments = await getOrderFulfillments(orderId);
    const fulfilledMap = fulfilledQuantitiesFromFulfillments(fulfillments);
    const refundedMap = refundedQuantitiesByLineItem(order);
    const blockedItems = [];

    const refundLineItems = selectedItems.map((selectedItem) => {
      const orderLineItem = orderLineItems.find((lineItem) => String(lineItem.id) === String(selectedItem.lineItemId));
      if (!orderLineItem) return null;

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
      if (fulfilledQuantity <= 0) { blockedItems.push(`${orderLineItem.name} is nog niet verzonden`); return null; }
      if (maxReturnableQuantity <= 0) { blockedItems.push(`${orderLineItem.name} is al volledig terugbetaald of niet retourbaar`); return null; }

      const quantity = Math.min(Number(selectedItem.quantity || 1), maxReturnableQuantity);
      return { line_item_id: Number(selectedItem.lineItemId), quantity, restock_type: 'no_restock' };
    }).filter(Boolean);

    if (blockedItems.length) return res.status(400).json({ success: false, error: 'Niet alle geselecteerde producten mogen retour.', details: blockedItems, rule: 'Retour mag alleen als Shopify fulfilled is én SRS fulfillment status processed is.' });
    if (!refundLineItems.length) return res.status(400).json({ success: false, error: 'Geen geldige producten gevonden voor deze order' });

    srsItems = buildSrsItems({ selectedItems, refundLineItems, orderLineItems, srsFulfillments });
    const missingIdentifiers = srsItems.filter((item) => !item.sku && !item.barcode && !item.fulfillmentId && !item.orderLineNr);
    if (missingIdentifiers.length) return res.status(400).json({ success: false, error: 'Niet alle retourregels hebben een SKU/barcode, FulfillmentId of OrderLineNr voor SRS.' });

    const calculated = await shopifyRequest(`/orders/${orderId}/refunds/calculate.json`, { method: 'POST', body: JSON.stringify({ refund: { currency: order.currency, refund_line_items: refundLineItems } }) });
    const calculatedRefund = calculated.refund || {};
    const transactions = (calculatedRefund.transactions || []).filter((transaction) => Number(transaction.amount || 0) > 0).map((transaction) => ({ parent_id: transaction.parent_id, amount: transaction.amount, kind: 'refund', gateway: transaction.gateway }));
    if (!transactions.length) return res.status(400).json({ success: false, error: 'Geen terugbetaalbare transactie gevonden. Deze order is mogelijk al terugbetaald of heeft geen betaalbare transactie meer.' });

    const noteParts = [
      `Retour verwerkt via winkelportaal door ${employeeName}.`,
      `Winkel: ${store}.`,
      `SRS BranchId: ${srsBranchId}.`,
      `SRS OrderNr: ${srsOrderNr}.`,
      `Reden: ${reason}.`,
      complaintText ? `Klacht: ${complaintText}.` : '',
      note ? `Opmerking: ${note}.` : '',
      'Shopify voorraad niet herbevoorraad; SRS Return boekt voorraad op het meldende filiaal.'
    ].filter(Boolean);

    const created = await shopifyRequest(`/orders/${orderId}/refunds.json`, { method: 'POST', body: JSON.stringify({ refund: { currency: order.currency, notify: true, note: noteParts.join(' '), refund_line_items: refundLineItems, transactions } }) });

    let srsResult = null;
    let srsLog = null;
    try {
      srsResult = await createSrsReturn({ orderNr: srsOrderNr, branchId: srsBranchId, items: srsItems, dateTime: new Date().toISOString().slice(0, 19) });
      srsLog = await safeCreateSrsReturnLog({ store, employeeName, orderNr: srsOrderNr, shopifyOrderId: String(order.id), branchId: srsBranchId, status: srsResult.status, success: srsResult.success, srsTransactionId: srsResult.transactionId, items: srsItems, message: srsResult.success ? 'Retour verwerkt in SRS op het meldende filiaal.' : 'SRS retour gaf geen completed status.' });
      await addOrderTags(order, ['winkelportaal_retour', 'retour_veilig_gecontroleerd', srsResult.success ? 'srs_retour_verwerkt' : 'srs_retour_controleren']);
    } catch (srsError) {
      console.error('SRS retour verwerken mislukt:', srsError);
      srsLog = await safeCreateSrsReturnLog({ store, employeeName, orderNr: srsOrderNr, shopifyOrderId: String(order.id), branchId: srsBranchId, status: 'failed', success: false, items: srsItems, error: srsError.message || 'SRS retour mislukt.' });
      try { await addOrderTags(order, ['winkelportaal_retour', 'retour_veilig_gecontroleerd', 'srs_retour_controleren']); } catch {}
      return res.status(200).json({ success: true, warning: true, message: 'Shopify terugbetaling is verwerkt, maar SRS retour moet handmatig gecontroleerd worden.', refund: created.refund, srs: { success: false, orderNr: srsOrderNr, branchId: srsBranchId, error: srsError.message || 'SRS retour mislukt.', log: srsLog } });
    }

    return res.status(200).json({ success: true, message: srsResult?.success ? 'Terugbetaling verwerkt en retour in SRS geboekt op het meldende filiaal.' : 'Terugbetaling verwerkt. SRS retour is verzonden, maar status is niet completed.', refund: created.refund, srs: { success: Boolean(srsResult?.success), status: srsResult?.status || 'unknown', transactionId: srsResult?.transactionId || '', orderNr: srsOrderNr, branchId: srsBranchId, log: srsLog } });
  } catch (error) {
    console.error('Return refund error:', { message: error.message, status: error.status, data: error.data });
    if (order && srsOrderNr && srsBranchId) await safeCreateSrsReturnLog({ store, employeeName, orderNr: srsOrderNr, shopifyOrderId: String(order.id), branchId: srsBranchId, status: 'failed_before_refund_complete', success: false, items: srsItems, error: error.message || 'Retour/terugbetaling mislukt.' });
    return res.status(error.status || 500).json({ success: false, error: error.message || 'Terugbetaling kon niet worden verwerkt', details: error.data || null });
  }
}
