const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

/*
  SRS afhandelen is bewust optioneel/best-effort.
  Zet SRS_PICKUP_COMPLETE_URL in Vercel als jullie backend endpoint voor SRS afhandelen klaarstaat.
  Deze endpoint moet de Shopify order/weborder in SRS op afgehandeld zetten.
*/
const SRS_PICKUP_COMPLETE_URL = process.env.SRS_PICKUP_COMPLETE_URL || '';
const SRS_PICKUP_COMPLETE_SECRET = process.env.SRS_PICKUP_COMPLETE_SECRET || process.env.CRON_SECRET || '';

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
  const cleanId = String(orderId || '').replace('gid://shopify/Order/', '');
  const data = await shopifyRequest(`/orders/${cleanId}.json?status=any`, { method: 'GET' });
  return data.order;
}

async function getFulfillmentOrders(orderId) {
  const cleanId = String(orderId || '').replace('gid://shopify/Order/', '');
  const data = await shopifyRequest(`/orders/${cleanId}/fulfillment_orders.json`, { method: 'GET' });
  return data.fulfillment_orders || [];
}

function isPickupFulfillmentOrder(fulfillmentOrder) {
  const methodType = String(fulfillmentOrder.delivery_method?.method_type || '').toLowerCase();

  if (['pick_up', 'pickup', 'pick-up', 'pick up'].includes(methodType)) return true;

  const text = [
    fulfillmentOrder.delivery_method?.method_name,
    fulfillmentOrder.delivery_method?.presented_name,
    fulfillmentOrder.delivery_method?.service_code,
    fulfillmentOrder.assigned_location?.name
  ].join(' ').toLowerCase();

  return (
    text.includes('pickup') ||
    text.includes('pick up') ||
    text.includes('pick_up') ||
    text.includes('afhalen') ||
    text.includes('ophalen') ||
    text.includes('ophaal')
  );
}

function isOpenFulfillmentOrder(fulfillmentOrder) {
  const status = String(fulfillmentOrder.status || '').toLowerCase();
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

  for (const fulfillmentOrder of fulfillmentOrders) {
    const locationId = String(
      fulfillmentOrder.assigned_location_id ||
      fulfillmentOrder.assigned_location?.location_id ||
      fulfillmentOrder.assigned_location?.id ||
      'unknown'
    );

    if (!groups.has(locationId)) groups.set(locationId, []);
    groups.get(locationId).push(fulfillmentOrder);
  }

  return Array.from(groups.values());
}

function hasValidAdminToken(req) {
  if (!ADMIN_TOKEN) return true;
  const incomingToken = String(req.headers['x-admin-token'] || req.headers['X-Admin-Token'] || '').trim();
  return incomingToken === ADMIN_TOKEN;
}

async function completePickupInSrs({ order, body }) {
  if (!SRS_PICKUP_COMPLETE_URL) {
    return {
      skipped: true,
      success: false,
      message: 'SRS_PICKUP_COMPLETE_URL ontbreekt. Shopify is verwerkt, SRS moet nog gekoppeld worden.'
    };
  }

  const payload = {
    shopifyOrderId: String(order.id || ''),
    shopifyOrderName: order.name || '',
    weborderNumber: body.weborderNumber || body.weborder || order.name || '',
    store: body.store || '',
    employeeName: body.employeeName || '',
    pickedUpAt: new Date().toISOString(),
    source: 'winkelportaal_pickup'
  };

  const response = await fetch(SRS_PICKUP_COMPLETE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(SRS_PICKUP_COMPLETE_SECRET ? { Authorization: `Bearer ${SRS_PICKUP_COMPLETE_SECRET}` } : {})
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (error) { data = { raw: text }; }

  if (!response.ok || data.success === false) {
    return {
      skipped: false,
      success: false,
      status: response.status,
      message: data.message || data.error || text || 'SRS afhandeling mislukt',
      data
    };
  }

  return {
    skipped: false,
    success: true,
    message: data.message || 'Order is in SRS afgehandeld',
    data
  };
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

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Methode niet toegestaan' });
  }

  if (!hasValidAdminToken(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  if (!SHOPIFY_ACCESS_TOKEN || !SHOPIFY_STORE_URL) {
    return res.status(500).json({ success: false, error: 'Shopify configuratie ontbreekt' });
  }

  const body = parseBody(req);
  const orderId = String(body.orderId || body.id || '').trim();

  if (!orderId) {
    return res.status(400).json({ success: false, error: 'Order ID ontbreekt' });
  }

  try {
    const order = await getOrder(orderId);

    if (!order) {
      return res.status(404).json({ success: false, error: 'Order niet gevonden' });
    }

    const fulfillmentOrders = await getFulfillmentOrders(orderId);
    const openPickupFulfillmentOrders = fulfillmentOrders.filter((fulfillmentOrder) => (
      isOpenFulfillmentOrder(fulfillmentOrder) && isPickupFulfillmentOrder(fulfillmentOrder)
    ));

    if (!openPickupFulfillmentOrders.length) {
      await addOrderTags(order, ['pickup_gecontroleerd_geen_open_pickup']);

      return res.status(200).json({
        success: true,
        message: 'Geen open pickup fulfillment order gevonden. Tag is toegevoegd ter controle.',
        fulfillment: null,
        srs: { skipped: true, success: false, message: 'SRS niet aangeroepen omdat Shopify geen open pickup fulfillment order had.' }
      });
    }

    const fulfillmentResults = [];
    const fulfillmentOrderGroups = groupFulfillmentOrdersByLocation(openPickupFulfillmentOrders);

    for (const fulfillmentOrderGroup of fulfillmentOrderGroups) {
      const lineItemsByFulfillmentOrder = fulfillmentOrderGroup.map((fulfillmentOrder) => ({
        fulfillmentOrderId: gid('FulfillmentOrder', fulfillmentOrder.id)
      }));

      const graphqlResult = await shopifyGraphql(FULFILLMENT_CREATE_MUTATION, {
        fulfillment: {
          lineItemsByFulfillmentOrder,
          notifyCustomer: false
        }
      });

      const result = graphqlResult.fulfillmentCreate;
      const userErrors = result?.userErrors || [];

      if (userErrors.length) {
        return res.status(400).json({
          success: false,
          error: 'Shopify kon de order niet fulfilen / op afgehaald zetten',
          details: userErrors
        });
      }

      if (result?.fulfillment) fulfillmentResults.push(result.fulfillment);
    }

    const srsResult = await completePickupInSrs({ order, body });

    const tags = ['pickup_opgehaald'];
    if (srsResult.success) tags.push('srs_afgehandeld');
    else tags.push('srs_afhandeling_controleren');

    await addOrderTags(order, tags);

    return res.status(200).json({
      success: true,
      message: srsResult.success
        ? 'Order is opgehaald gemarkeerd in Shopify en afgehandeld in SRS.'
        : 'Order is opgehaald gemarkeerd in Shopify. SRS afhandeling moet nog gecontroleerd worden.',
      fulfillment: fulfillmentResults,
      srs: srsResult
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: 'Order kon niet op afgehaald worden gezet',
      message: error.message,
      details: error.data || null
    });
  }
}
