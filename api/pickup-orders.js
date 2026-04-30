const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
}

function cleanShopUrl(url) {
  return String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function shopifyUrl(path) {
  return `https://${cleanShopUrl(SHOPIFY_STORE_URL)}/admin/api/${SHOPIFY_API_VERSION}${path}`;
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

  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
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

function isPickupFulfillmentOrder(fulfillmentOrder) {
  const methodType = String(fulfillmentOrder.delivery_method?.method_type || '').toLowerCase();

  // Shopify gebruikt meestal pick_up voor store pickup.
  if (methodType === 'pick_up') return true;

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
  return !['closed', 'cancelled', 'fulfilled'].includes(status);
}

async function getFulfillmentOrders(orderId) {
  const cleanId = String(orderId || '').replace('gid://shopify/Order/', '');
  const data = await shopifyRequest(`/orders/${cleanId}/fulfillment_orders.json`, { method: 'GET' });
  return data.fulfillment_orders || [];
}

function hasValidAdminToken(req) {
  if (!ADMIN_TOKEN) return true;
  const incomingToken = String(req.headers['x-admin-token'] || req.headers['X-Admin-Token'] || '').trim();
  return incomingToken === ADMIN_TOKEN;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      error: 'Methode niet toegestaan'
    });
  }

  if (!hasValidAdminToken(req)) {
    return res.status(401).json({
      success: false,
      message: 'Niet bevoegd.'
    });
  }

  if (!SHOPIFY_ACCESS_TOKEN || !SHOPIFY_STORE_URL) {
    return res.status(500).json({
      success: false,
      error: 'Shopify configuratie ontbreekt'
    });
  }

  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 100);
    const status = String(req.query.status || 'open').trim();
    const fulfillmentStatus = String(req.query.fulfillment_status || 'unfulfilled').trim();

    const ordersData = await shopifyRequest(
      `/orders.json?status=${encodeURIComponent(status)}&fulfillment_status=${encodeURIComponent(fulfillmentStatus)}&limit=${limit}&order=created_at%20desc`,
      { method: 'GET' }
    );

    const orders = ordersData.orders || [];
    const pickupOrders = [];

    for (const order of orders) {
      const fulfillmentOrders = await getFulfillmentOrders(order.id);

      const pickupFulfillmentOrders = fulfillmentOrders.filter((fulfillmentOrder) => {
        return isOpenFulfillmentOrder(fulfillmentOrder) && isPickupFulfillmentOrder(fulfillmentOrder);
      });

      if (pickupFulfillmentOrders.length) {
        pickupOrders.push({
          id: order.id,
          admin_graphql_api_id: order.admin_graphql_api_id,
          name: order.name,
          order_number: order.order_number,
          email: order.email,
          phone: order.phone,
          created_at: order.created_at,
          processed_at: order.processed_at,
          financial_status: order.financial_status,
          fulfillment_status: order.fulfillment_status,
          tags: order.tags,
          total_price: order.total_price,
          currency: order.currency,
          customer: order.customer
            ? {
                first_name: order.customer.first_name,
                last_name: order.customer.last_name,
                email: order.customer.email,
                phone: order.customer.phone
              }
            : null,
          line_items: (order.line_items || []).map((lineItem) => ({
            id: lineItem.id,
            title: lineItem.title,
            variant_title: lineItem.variant_title,
            sku: lineItem.sku,
            quantity: lineItem.quantity,
            fulfillment_status: lineItem.fulfillment_status
          })),
          fulfillment_orders: pickupFulfillmentOrders.map((fulfillmentOrder) => ({
            id: fulfillmentOrder.id,
            status: fulfillmentOrder.status,
            request_status: fulfillmentOrder.request_status,
            assigned_location: fulfillmentOrder.assigned_location,
            delivery_method: fulfillmentOrder.delivery_method
          }))
        });
      }
    }

    return res.status(200).json({
      success: true,
      count: pickupOrders.length,
      orders: pickupOrders
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: 'Pickup orders konden niet worden opgehaald',
      message: error.message,
      details: error.data || null
    });
  }
}
