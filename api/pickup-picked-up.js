const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function cleanShopUrl(url) {
  return String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function shopifyUrl(path) {
  return `https://${cleanShopUrl(SHOPIFY_STORE_URL)}/admin/api/${SHOPIFY_API_VERSION}${path}`;
}

function gid(type, id) {
  const value = String(id || '').replace(`gid://shopify/${type}/`, '');
  return `gid://shopify/${type}/${value}`;
}

function parseBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (error) { return {}; }
  }
  return req.body || {};
}

function readableError(data) {
  if (!data) return 'Onbekende Shopify fout';
  if (typeof data === 'string') return data;
  if (Array.isArray(data.errors)) return data.errors.map((item) => item.message || JSON.stringify(item)).join(', ');
  if (data.errors) return typeof data.errors === 'string' ? data.errors : JSON.stringify(data.errors);
  if (data.error) return typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
  if (data.message) return data.message;
  return JSON.stringify(data);
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
  try { data = text ? JSON.parse(text) : {}; } catch (error) { data = { raw: text }; }
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
  const data = await shopifyRequest(`/orders/${String(orderId).replace('gid://shopify/Order/', '')}.json?status=any`, { method: 'GET' });
  return data.order;
}

async function getFulfillmentOrders(orderId) {
  const data = await shopifyRequest(`/orders/${String(orderId).replace('gid://shopify/Order/', '')}/fulfillment_orders.json`, { method: 'GET' });
  return data.fulfillment_orders || [];
}

function isPickupFulfillmentOrder(fulfillmentOrder) {
  const text = [
    fulfillmentOrder.delivery_method?.method_type,
    fulfillmentOrder.delivery_method?.method_name,
    fulfillmentOrder.delivery_method?.presented_name,
    fulfillmentOrder.delivery_method?.service_code,
    fulfillmentOrder.status,
    fulfillmentOrder.request_status
  ].join(' ').toLowerCase();
  return text.includes('pickup') || text.includes('pick up') || text.includes('pickup') || text.includes('afhalen') || text.includes('ophalen') || text.includes('ophaal');
}

async function addOrderTags(order, tagsToAdd) {
  const current = String(order.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean);
  const tags = Array.from(new Set([...current, ...tagsToAdd]));
  return shopifyRequest(`/orders/${order.id}.json`, {
    method: 'PUT',
    body: JSON.stringify({ order: { id: order.id, tags: tags.join(', ') } })
  });
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

  if (!SHOPIFY_ACCESS_TOKEN || !SHOPIFY_STORE_URL) {
    return res.status(500).json({ success: false, error: 'Shopify configuratie ontbreekt' });
  }

  const body = parseBody(req);
  const orderId = String(body.orderId || body.id || '').trim();
  if (!orderId) return res.status(400).json({ success: false, error: 'Order ID ontbreekt' });

  try {
    const order = await getOrder(orderId);
    if (!order) return res.status(404).json({ success: false, error: 'Order niet gevonden' });

    const fulfillmentOrders = await getFulfillmentOrders(orderId);
    const openPickupFulfillmentOrders = fulfillmentOrders.filter((fulfillmentOrder) => {
      if (String(fulfillmentOrder.status || '').toLowerCase() === 'closed') return false;
      return isPickupFulfillmentOrder(fulfillmentOrder);
    });

    let fulfillmentResult = null;
    if (openPickupFulfillmentOrders.length) {
      const lineItemsByFulfillmentOrder = openPickupFulfillmentOrders.map((fulfillmentOrder) => ({
        fulfillmentOrderId: gid('FulfillmentOrder', fulfillmentOrder.id)
      }));

      const graphqlResult = await shopifyGraphql(FULFILLMENT_CREATE_MUTATION, {
        fulfillment: { lineItemsByFulfillmentOrder, notifyCustomer: false }
      });
      const result = graphqlResult.fulfillmentCreate;
      const userErrors = result?.userErrors || [];
      if (userErrors.length) {
        return res.status(400).json({ success: false, error: 'Shopify kon de order niet fulfilen / op afgehaald zetten', details: userErrors });
      }
      fulfillmentResult = result?.fulfillment || null;
    }

    await addOrderTags(order, ['pickup_opgehaald']);
    return res.status(200).json({ success: true, message: 'Order is op afgehaald gezet', fulfillment: fulfillmentResult });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, error: 'Order kon niet op afgehaald worden gezet', message: error.message, details: error.data || null });
  }
}
