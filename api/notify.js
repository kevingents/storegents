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

async function addOrderTags(order, tagsToAdd) {
  const current = String(order.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean);
  const tags = Array.from(new Set([...current, ...tagsToAdd]));
  return shopifyRequest(`/orders/${order.id}.json`, {
    method: 'PUT',
    body: JSON.stringify({ order: { id: order.id, tags: tags.join(', ') } })
  });
}

const READY_FOR_PICKUP_QUERY = `
  query GetOrderForPickup($id: ID!) {
    order(id: $id) {
      id
      name
      fulfillmentOrders(first: 10) {
        nodes {
          id
          status
          deliveryMethod { methodType }
          lineItems(first: 50) {
            nodes {
              id
              remainingQuantity
              totalQuantity
            }
          }
        }
      }
    }
  }
`;

const PREPARED_FOR_PICKUP_MUTATION = `
  mutation MarkReadyForPickup($input: FulfillmentOrderLineItemsPreparedForPickupInput!) {
    fulfillmentOrderLineItemsPreparedForPickup(input: $input) {
      userErrors { field message }
    }
  }
`;

function isOpenPickupFulfillmentOrder(fulfillmentOrder) {
  if (!fulfillmentOrder || String(fulfillmentOrder.status || '').toLowerCase() === 'closed') return false;
  return fulfillmentOrder.deliveryMethod?.methodType === 'PICK_UP';
}

function buildLineItemsByFulfillmentOrder(fulfillmentOrders) {
  return fulfillmentOrders.map((fulfillmentOrder) => {
    const lineItems = (fulfillmentOrder.lineItems?.nodes || [])
      .filter((lineItem) => Number(lineItem.remainingQuantity || 0) > 0)
      .map((lineItem) => ({ id: lineItem.id, quantity: Number(lineItem.remainingQuantity || lineItem.totalQuantity || 1) }));

    return {
      fulfillmentOrderId: fulfillmentOrder.id,
      fulfillmentOrderLineItems: lineItems
    };
  }).filter((entry) => entry.fulfillmentOrderLineItems.length);
}

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
    const numericOrderId = orderId.replace('gid://shopify/Order/', '');
    const orderGid = gid('Order', numericOrderId);
    const data = await shopifyGraphql(READY_FOR_PICKUP_QUERY, { id: orderGid });
    const orderNode = data.order;
    if (!orderNode) return res.status(404).json({ success: false, error: 'Order niet gevonden' });

    const pickupFulfillmentOrders = (orderNode.fulfillmentOrders?.nodes || []).filter(isOpenPickupFulfillmentOrder);
    if (!pickupFulfillmentOrders.length) {
      return res.status(400).json({ success: false, error: 'Geen open pickup fulfillment order gevonden voor deze order' });
    }

    const lineItemsByFulfillmentOrder = buildLineItemsByFulfillmentOrder(pickupFulfillmentOrders);
    if (!lineItemsByFulfillmentOrder.length) {
      return res.status(400).json({ success: false, error: 'Geen openstaande pickup artikelen gevonden' });
    }

    const mutationResult = await shopifyGraphql(PREPARED_FOR_PICKUP_MUTATION, {
      input: { lineItemsByFulfillmentOrder }
    });
    const userErrors = mutationResult.fulfillmentOrderLineItemsPreparedForPickup?.userErrors || [];
    if (userErrors.length) {
      return res.status(400).json({ success: false, error: 'Shopify kon de order niet op klaar voor afhalen zetten', details: userErrors });
    }

    const restOrder = await getOrder(numericOrderId);
    await addOrderTags(restOrder, ['pickup_ready', 'pickup_notified']);

    return res.status(200).json({ success: true, message: 'Klant is via Shopify geinformeerd dat de order klaarstaat' });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, error: 'Klant kon niet geinformeerd worden', message: error.message, details: error.data || null });
  }
}
