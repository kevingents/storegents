import { getFulfillments, receiveFulfillments, isSrsOpenStatus } from '../lib/srs-weborders-message-client.js';

const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
}

function cleanShopUrl(url) {
  return String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function shopifyUrl(path) {
  return `https://${cleanShopUrl(SHOPIFY_STORE_URL)}/admin/api/${SHOPIFY_API_VERSION}${path}`;
}

function gid(type, id) {
  const value = String(id || '');
  return value.startsWith('gid://') ? value : `gid://shopify/${type}/${value}`;
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

function readableError(data) {
  if (!data) return 'Onbekende Shopify fout';
  if (typeof data === 'string') return data;
  if (Array.isArray(data.errors)) return data.errors.map((item) => item.message || JSON.stringify(item)).join(', ');
  if (data.errors) return typeof data.errors === 'string' ? data.errors : JSON.stringify(data.errors);
  if (data.error) return typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
  if (data.raw) return String(data.raw).slice(0, 300);
  return 'Onbekende Shopify fout';
}

async function shopifyRequest(path, options = {}) {
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

  if (!response.ok) {
    const error = new Error(readableError(data));
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

async function shopifyGraphql(query, variables) {
  const data = await shopifyRequest('/graphql.json', {
    method: 'POST',
    body: JSON.stringify({ query, variables })
  });

  if (data.errors && data.errors.length) {
    const error = new Error(readableError(data));
    error.data = data;
    throw error;
  }

  return data.data;
}

async function getOrder(orderId) {
  const cleanId = String(orderId || '').replace('gid://shopify/Order/', '').replace(/^#/, '');
  const data = await shopifyRequest(`/orders/${cleanId}.json?status=any`, { method: 'GET' });
  return data.order;
}

async function getFulfillmentOrders(orderId) {
  const cleanId = String(orderId || '').replace('gid://shopify/Order/', '').replace(/^#/, '');
  const data = await shopifyRequest(`/orders/${cleanId}/fulfillment_orders.json`, { method: 'GET' });
  return data.fulfillment_orders || [];
}

function isPickupFulfillmentOrder(fo) {
  const methodType = String(fo.delivery_method?.method_type || '').toLowerCase();
  if (['pick_up', 'pickup', 'pick-up', 'pick up'].includes(methodType)) return true;

  const text = [
    fo.delivery_method?.method_name,
    fo.delivery_method?.presented_name,
    fo.delivery_method?.service_code,
    fo.assigned_location?.name
  ].join(' ').toLowerCase();

  return text.includes('pickup') || text.includes('pick up') || text.includes('pick_up') || text.includes('afhalen') || text.includes('ophalen') || text.includes('ophaal');
}

function isOpenFulfillmentOrder(fo) {
  const status = String(fo.status || '').toLowerCase();
  return !['closed', 'cancelled', 'canceled', 'fulfilled', 'incomplete'].includes(status);
}

async function addOrderTags(order, tagsToAdd) {
  const current = String(order.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean);
  const tags = Array.from(new Set([...current, ...tagsToAdd]));
  return shopifyRequest(`/orders/${order.id}.json`, {
    method: 'PUT',
    body: JSON.stringify({ order: { id: order.id, tags: tags.join(', ') } })
  });
}

function groupFulfillmentOrdersByLocation(fulfillmentOrders) {
  const groups = new Map();
  for (const fo of fulfillmentOrders) {
    const locationId = String(fo.assigned_location_id || fo.assigned_location?.location_id || fo.assigned_location?.id || 'unknown');
    if (!groups.has(locationId)) groups.set(locationId, []);
    groups.get(locationId).push(fo);
  }
  return Array.from(groups.values());
}

function hasValidAdminToken(req, body) {
  if (!ADMIN_TOKEN) return true;
  const incomingToken = String(req.headers['x-admin-token'] || req.headers['X-Admin-Token'] || body.adminToken || '').trim();
  return incomingToken === ADMIN_TOKEN;
}

function cleanOrderNr(value) {
  return String(value || '').replace(/^#/, '').trim();
}

async function completePickupInSrs({ order, body }) {
  const orderNr = cleanOrderNr(body.srsOrderNr || body.weborderNumber || body.weborder || order.name || order.order_number || '');
  if (!orderNr) {
    return { skipped: true, success: false, message: 'SRS OrderNr ontbreekt. Shopify is verwerkt; SRS afhandeling overgeslagen.' };
  }

  try {
    const result = await getFulfillments({ orderNr });
    const all = result.fulfillments || [];
    const open = all.filter((item) => isSrsOpenStatus(item.status));

    if (!open.length) {
      return {
        skipped: true,
        success: false,
        orderNr,
        fulfillments: all,
        message: 'Geen open SRS leveropdracht gevonden. Mogelijk al processed/geannuleerd/niet leverbaar.'
      };
    }

    const grouped = new Map();
    for (const item of open) {
      const branchId = String(item.branchId || item.fulfillmentBranchId || item.fulfilmentBranchId || '').trim();
      if (!branchId) continue;
      if (!grouped.has(branchId)) grouped.set(branchId, []);
      grouped.get(branchId).push(item);
    }

    if (!grouped.size) {
      return {
        skipped: true,
        success: false,
        orderNr,
        fulfillments: open,
        message: 'SRS BranchId ontbreekt op open leveropdrachten. Controleer SRS configuratie.'
      };
    }

    const results = [];
    for (const [branchId, items] of grouped.entries()) {
      results.push(await receiveFulfillments({
        orderNr,
        branchId,
        personnelId: body.personnelNumber || body.employeeNumber || '',
        items: items.map((item) => ({
          fulfillmentId: item.fulfillmentId,
          orderLineNr: item.orderLineNr,
          sku: item.sku,
          branchId
        }))
      }));
    }

    const success = results.every((item) => item.success);
    return {
      skipped: false,
      success,
      orderNr,
      results,
      message: success ? 'Order is in SRS via ReceiveFulfillment afgehandeld.' : 'SRS ReceiveFulfillment is niet volledig completed.'
    };
  } catch (error) {
    return {
      skipped: false,
      success: false,
      orderNr,
      message: error.message || 'SRS ReceiveFulfillment mislukt.'
    };
  }
}

const FULFILLMENT_CREATE_MUTATION = `
  mutation fulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id status }
      userErrors { field message }
    }
  }
`;

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Methode niet toegestaan' });

  const body = parseBody(req);
  if (!hasValidAdminToken(req, body)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  if (!SHOPIFY_ACCESS_TOKEN || !SHOPIFY_STORE_URL) return res.status(500).json({ success: false, error: 'Shopify configuratie ontbreekt' });

  const orderId = String(body.orderId || body.id || '').trim();
  if (!orderId) return res.status(400).json({ success: false, error: 'Order ID ontbreekt' });

  try {
    const order = await getOrder(orderId);
    if (!order) return res.status(404).json({ success: false, error: 'Order niet gevonden' });

    const fulfillmentOrders = await getFulfillmentOrders(order.id);
    const openPickupFulfillmentOrders = fulfillmentOrders.filter((fo) => isOpenFulfillmentOrder(fo) && isPickupFulfillmentOrder(fo));

    if (!openPickupFulfillmentOrders.length) {
      await addOrderTags(order, ['pickup_gecontroleerd_geen_open_pickup']);
      return res.status(200).json({
        success: true,
        alreadyClosed: true,
        message: 'Geen open pickup fulfillment order gevonden. Waarschijnlijk is de order al afgehandeld of niet als pickup fulfillment aangemaakt. Controle-tag toegevoegd.',
        fulfillment: null,
        srs: { skipped: true, success: false, message: 'SRS niet aangeroepen omdat Shopify geen open pickup fulfillment order had.' }
      });
    }

    const fulfillmentResults = [];
    for (const group of groupFulfillmentOrdersByLocation(openPickupFulfillmentOrders)) {
      const lineItemsByFulfillmentOrder = group.map((fo) => ({ fulfillmentOrderId: gid('FulfillmentOrder', fo.id) }));
      const graphqlResult = await shopifyGraphql(FULFILLMENT_CREATE_MUTATION, { fulfillment: { lineItemsByFulfillmentOrder, notifyCustomer: false } });
      const result = graphqlResult.fulfillmentCreate;
      const userErrors = result?.userErrors || [];
      if (userErrors.length) return res.status(400).json({ success: false, error: 'Shopify kon de order niet fulfillen / op afgehaald zetten', details: userErrors });
      if (result?.fulfillment) fulfillmentResults.push(result.fulfillment);
    }

    const srsResult = await completePickupInSrs({ order, body });
    const tags = ['pickup_opgehaald'];
    if (srsResult.success) tags.push('srs_receive_fulfillment_verwerkt');
    else tags.push('srs_receive_fulfillment_controleren');
    await addOrderTags(order, tags);

    return res.status(200).json({
      success: true,
      message: srsResult.success ? 'Order is opgehaald gemarkeerd in Shopify en afgehandeld in SRS.' : 'Order is opgehaald gemarkeerd in Shopify. SRS afhandeling moet nog gecontroleerd worden.',
      fulfillment: fulfillmentResults,
      srs: srsResult
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, error: 'Order kon niet op opgehaald worden gezet', message: error.message, details: error.data || null });
  }
}
