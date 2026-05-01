const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';

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
  const value = String(id || '').replace(`gid://shopify/${type}/`, '');
  return `gid://shopify/${type}/${value}`;
}

function parseBody(req) {
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body || {};
}

function readableError(data) {
  if (!data) return 'Onbekende Shopify fout';
  if (typeof data === 'string') return data;
  if (Array.isArray(data.errors)) {
    return data.errors.map((item) => item.message || JSON.stringify(item)).join(', ');
  }
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

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

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

  if (data.errors?.length) {
    const error = new Error(data.errors.map((item) => item.message).join(', '));
    error.data = data;
    throw error;
  }

  return data.data;
}

async function getRestOrder(orderId) {
  const cleanId = String(orderId || '').replace('gid://shopify/Order/', '');
  const data = await shopifyRequest(`/orders/${cleanId}.json?status=any`, { method: 'GET' });
  return data.order;
}

async function addOrderTags(order, tagsToAdd) {
  const current = String(order.tags || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);

  const tags = Array.from(new Set([...current, ...tagsToAdd]));

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

const READY_FOR_PICKUP_QUERY = `
  query GetOrderForPickup($id: ID!) {
    order(id: $id) {
      id
      name
      displayFulfillmentStatus
      fulfillmentOrders(first: 20) {
        nodes {
          id
          status
          requestStatus
          deliveryMethod {
            methodType
            presentedName
          }
          assignedLocation {
            name
            location {
              id
              name
              legacyResourceId
            }
          }
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
      userErrors {
        field
        message
        code
      }
    }
  }
`;

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isOpenPickupFulfillmentOrder(fulfillmentOrder) {
  if (!fulfillmentOrder) return false;

  const status = normalize(fulfillmentOrder.status);
  const requestStatus = normalize(fulfillmentOrder.requestStatus);
  const methodType = normalize(fulfillmentOrder.deliveryMethod?.methodType);

  if (['closed', 'cancelled', 'canceled', 'incomplete'].includes(status)) return false;
  if (['cancellation requested', 'cancellationrequest'].includes(requestStatus)) return false;

  return ['pick up', 'pickup', 'pick_up', 'pick-up'].includes(methodType);
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
      details: 'Controleer SHOPIFY_ACCESS_TOKEN en SHOPIFY_STORE_URL.'
    });
  }

  const body = parseBody(req);
  const orderId = String(body.orderId || body.id || '').trim();

  if (!orderId) {
    return res.status(400).json({ success: false, error: 'Order ID ontbreekt' });
  }

  try {
    const numericOrderId = orderId.replace('gid://shopify/Order/', '');
    const orderGid = gid('Order', numericOrderId);

    const data = await shopifyGraphql(READY_FOR_PICKUP_QUERY, { id: orderGid });
    const orderNode = data.order;

    if (!orderNode) {
      return res.status(404).json({ success: false, error: 'Order niet gevonden' });
    }

    const fulfillmentOrders = orderNode.fulfillmentOrders?.nodes || [];
    const pickupFulfillmentOrders = fulfillmentOrders.filter(isOpenPickupFulfillmentOrder);

    if (!pickupFulfillmentOrders.length) {
      return res.status(400).json({
        success: false,
        error: 'Geen open pickup fulfillment order gevonden voor deze order.',
        debug: {
          orderName: orderNode.name,
          displayFulfillmentStatus: orderNode.displayFulfillmentStatus,
          fulfillmentOrders: fulfillmentOrders.map((fo) => ({
            id: fo.id,
            status: fo.status,
            requestStatus: fo.requestStatus,
            methodType: fo.deliveryMethod?.methodType,
            presentedName: fo.deliveryMethod?.presentedName,
            location: fo.assignedLocation?.location?.name || fo.assignedLocation?.name || ''
          }))
        }
      });
    }

    const lineItemsByFulfillmentOrder = pickupFulfillmentOrders.map((fulfillmentOrder) => ({
      fulfillmentOrderId: fulfillmentOrder.id
    }));

    const mutationResult = await shopifyGraphql(PREPARED_FOR_PICKUP_MUTATION, {
      input: { lineItemsByFulfillmentOrder }
    });

    const userErrors =
      mutationResult.fulfillmentOrderLineItemsPreparedForPickup?.userErrors || [];

    if (userErrors.length) {
      return res.status(400).json({
        success: false,
        error: userErrors.map((item) => item.message).join(', ') || 'Shopify kon de standaard pickup-mail niet versturen.',
        details: userErrors,
        debug: {
          orderName: orderNode.name,
          lineItemsByFulfillmentOrder
        }
      });
    }

    try {
      const restOrder = await getRestOrder(numericOrderId);
      await addOrderTags(restOrder, ['pickup_ready', 'pickup_notified']);
    } catch (tagError) {
      console.error('Pickup tags toevoegen mislukt:', tagError);
    }

    return res.status(200).json({
      success: true,
      message: `Shopify standaardmail is verstuurd voor ${orderNode.name}. De order staat klaar voor afhalen.`,
      orderName: orderNode.name
    });
  } catch (error) {
    console.error('Notify pickup error:', {
      message: error.message,
      status: error.status,
      data: error.data
    });

    return res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Klant kon niet geinformeerd worden',
      message: error.message,
      details: error.data || null
    });
  }
}
