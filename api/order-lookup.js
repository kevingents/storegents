const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';
const MAX_QUERY_RESULTS = Number(process.env.MAX_QUERY_RESULTS || 25);

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function getShopifyConfig() {
  let shop = process.env.SHOPIFY_STORE_URL;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!shop || !token) {
    return {
      error: {
        error: 'Shopify configuratie ontbreekt',
        missing: {
          SHOPIFY_STORE_URL: !shop,
          SHOPIFY_ACCESS_TOKEN: !token
        }
      }
    };
  }

  shop = shop.replace('https://', '').replace('http://', '').replace(/\/$/, '');
  return { shop, token };
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/\s/g, '').trim();
}

function numericIdFromGid(gid) {
  return String(gid || '').split('/').pop();
}

function isEmail(value) {
  return String(value || '').includes('@');
}

async function shopifyFetch(shop, token, path, options = {}) {
  const response = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}${path}`, {
    ...options,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    data = { raw: text };
  }

  return { response, data };
}

async function shopifyGraphql(shop, token, query, variables) {
  const response = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });

  const data = await response.json();

  if (!response.ok) {
    const error = new Error('Shopify GraphQL request mislukt');
    error.status = response.status;
    error.details = data;
    throw error;
  }

  if (data.errors && data.errors.length) {
    const error = new Error(data.errors.map((item) => item.message).join(', '));
    error.status = 500;
    error.details = data.errors;
    throw error;
  }

  return data.data;
}

async function getProductImage(shop, token, productId, variantId) {
  if (!productId) return '';

  try {
    const { response, data } = await shopifyFetch(shop, token, `/products/${productId}.json`);
    if (!response.ok || !data.product) return '';

    const product = data.product;

    if (variantId && product.images && product.images.length) {
      const variantImage = product.images.find((image) => {
        return image.variant_ids && image.variant_ids.includes(Number(variantId));
      });

      if (variantImage && variantImage.src) return variantImage.src;
    }

    return product.image?.src || '';
  } catch (error) {
    return '';
  }
}

async function getLocationName(shop, token, locationId) {
  if (!locationId) return '-';

  try {
    const { response, data } = await shopifyFetch(shop, token, `/locations/${locationId}.json`);
    if (response.ok && data.location && data.location.name) return data.location.name;
    return `Locatie ID ${locationId}`;
  } catch (error) {
    return `Locatie ID ${locationId}`;
  }
}

function orderMatchesCheck(shopifyOrder, check) {
  if (!check) return true;

  const normalizedCheck = normalize(check);
  const email = normalize(shopifyOrder.email);
  const contactEmail = normalize(shopifyOrder.contact_email);
  const customerEmail = normalize(shopifyOrder.customer?.email);
  const shippingZip = normalize(shopifyOrder.shipping_address?.zip);
  const billingZip = normalize(shopifyOrder.billing_address?.zip);

  return (
    normalizedCheck === email ||
    normalizedCheck === contactEmail ||
    normalizedCheck === customerEmail ||
    normalizedCheck === shippingZip ||
    normalizedCheck === billingZip
  );
}

function orderMatchesPostcode(shopifyOrder, postcode) {
  const normalizedPostcode = normalize(postcode);
  const shippingZip = normalize(shopifyOrder.shipping_address?.zip);
  const billingZip = normalize(shopifyOrder.billing_address?.zip);
  return normalizedPostcode === shippingZip || normalizedPostcode === billingZip;
}

async function findOrderByOrderNumber(shop, token, orderValue) {
  let orderNumber = String(orderValue || '').trim();
  if (!orderNumber) return null;
  if (!orderNumber.startsWith('#')) orderNumber = `#${orderNumber}`;

  const { response, data } = await shopifyFetch(
    shop,
    token,
    `/orders.json?status=any&name=${encodeURIComponent(orderNumber)}`
  );

  if (!response.ok) {
    const error = new Error('Shopify order lookup mislukt');
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return data.orders && data.orders.length ? data.orders[0] : null;
}

async function findOrdersByEmailFast(shop, token, email) {
  const graphQuery = `
    query FindOrdersByEmail($query: String!, $first: Int!) {
      orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            createdAt
            email
            displayFinancialStatus
            displayFulfillmentStatus
            totalPriceSet { shopMoney { amount currencyCode } }
            shippingAddress { name zip }
            billingAddress { name zip }
            customer { firstName lastName email }
            lineItems(first: 10) {
              edges { node { id name quantity sku variantTitle } }
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphql(shop, token, graphQuery, {
    query: `email:${email}`,
    first: MAX_QUERY_RESULTS
  });

  return (data.orders?.edges || []).map((edge) => edge.node);
}

async function findOrdersByPostcodeFallback(shop, token, postcode) {
  const { response, data } = await shopifyFetch(
    shop,
    token,
    `/orders.json?status=any&limit=250&order=created_at desc`
  );

  if (!response.ok) {
    const error = new Error('Shopify order lookup mislukt');
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return (data.orders || []).filter((order) => orderMatchesPostcode(order, postcode)).slice(0, MAX_QUERY_RESULTS);
}

function formatGraphqlOrderSummary(order) {
  const customerName =
    `${order.customer?.firstName || ''} ${order.customer?.lastName || ''}`.trim() ||
    order.shippingAddress?.name ||
    order.billingAddress?.name ||
    '-';

  return {
    id: numericIdFromGid(order.id),
    gid: order.id,
    name: order.name,
    customer: customerName,
    customerEmail: order.email || order.customer?.email || '',
    customerZip: order.shippingAddress?.zip || order.billingAddress?.zip || '',
    financialStatus: order.displayFinancialStatus || '-',
    fulfillmentStatus: order.displayFulfillmentStatus || '-',
    orderedAt: order.createdAt,
    createdAt: order.createdAt,
    totalPrice: order.totalPriceSet?.shopMoney?.amount || '',
    currency: order.totalPriceSet?.shopMoney?.currencyCode || '',
    items: (order.lineItems?.edges || []).map((edge) => ({
      id: numericIdFromGid(edge.node.id),
      lineItemId: numericIdFromGid(edge.node.id),
      quantity: edge.node.quantity,
      refundableQuantity: edge.node.quantity,
      fulfilledQuantity: 0,
      refundedQuantity: 0,
      returnBlocked: true,
      returnBlockedReason: 'Open eerst de orderdetails. Niet-verzonden regels mogen niet retour.',
      name: edge.node.name,
      sku: edge.node.sku || '',
      variant: edge.node.variantTitle || '',
      image: '',
      location: '-',
      fulfillmentStatus: '-'
    }))
  };
}

function buildRefundMaps(foundOrder) {
  const refundedByLineItem = new Map();
  const lastRefundByLineItem = new Map();
  let totalRefunded = 0;
  let lastRefundAt = '';

  for (const refund of foundOrder.refunds || []) {
    if (refund.created_at && (!lastRefundAt || new Date(refund.created_at) > new Date(lastRefundAt))) {
      lastRefundAt = refund.created_at;
    }

    for (const transaction of refund.transactions || []) {
      if (String(transaction.kind || '').toLowerCase() === 'refund' && String(transaction.status || '').toLowerCase() !== 'failure') {
        totalRefunded += Number(transaction.amount || 0);
      }
    }

    for (const refundLineItem of refund.refund_line_items || []) {
      const lineItemId = String(refundLineItem.line_item_id || refundLineItem.line_item?.id || '');
      const quantity = Number(refundLineItem.quantity || 0);
      const subtotal = Number(refundLineItem.subtotal || 0);

      if (!lineItemId) continue;

      refundedByLineItem.set(lineItemId, (refundedByLineItem.get(lineItemId) || 0) + quantity);
      lastRefundByLineItem.set(lineItemId, {
        refundedAt: refund.created_at || '',
        refundId: refund.id || '',
        quantity,
        amount: subtotal,
        note: refund.note || ''
      });
    }
  }

  return { refundedByLineItem, lastRefundByLineItem, totalRefunded, lastRefundAt };
}

async function formatRestOrderForFrontend(shop, token, foundOrder) {
  const fulfillments = foundOrder.fulfillments || [];
  const firstFulfillment = fulfillments[0] || null;
  const refundInfo = buildRefundMaps(foundOrder);

  const trackingNumber = firstFulfillment?.tracking_number || firstFulfillment?.tracking_numbers?.[0] || '';
  const trackingUrl = firstFulfillment?.tracking_url || firstFulfillment?.tracking_urls?.[0] || '';
  const locationId = firstFulfillment?.location_id || foundOrder.location_id || '';
  const locationName = await getLocationName(shop, token, locationId);

  const items = await Promise.all((foundOrder.line_items || []).map(async (item) => {
    const matchingFulfillment = fulfillments.find((fulfillment) => {
      return (fulfillment.line_items || []).some((fulfilledItem) => String(fulfilledItem.id) === String(item.id));
    });

    const itemLocationId = matchingFulfillment?.location_id || locationId || '';
    const itemLocationName = itemLocationId && itemLocationId !== locationId
      ? await getLocationName(shop, token, itemLocationId)
      : locationName;

    const image = await getProductImage(shop, token, item.product_id, item.variant_id);
    const quantity = Number(item.quantity || 0);
    const fulfilledQuantity = Number(item.fulfilled_quantity || 0);
    const refundedQuantity = Number(refundInfo.refundedByLineItem.get(String(item.id)) || 0);
    const refundableQuantity = Math.max(Math.min(quantity, fulfilledQuantity) - refundedQuantity, 0);
    const fulfillmentStatus = matchingFulfillment || fulfilledQuantity > 0 ? 'Verzonden' : 'Nog niet verzonden';
    const returnBlocked = fulfillmentStatus === 'Nog niet verzonden' || refundableQuantity <= 0;

    return {
      id: item.id,
      lineItemId: item.id,
      quantity,
      fulfilledQuantity,
      refundedQuantity,
      refundableQuantity,
      name: item.name,
      sku: item.sku || '',
      variant: item.variant_title || '',
      price: item.price || '',
      image,
      location: itemLocationName,
      fulfillmentStatus,
      returnBlocked,
      returnBlockedReason: fulfillmentStatus === 'Nog niet verzonden'
        ? 'Deze regel is nog niet verzonden en mag niet worden geretourneerd.'
        : refundableQuantity <= 0
          ? 'Deze regel is al volledig terugbetaald of niet meer retourbaar.'
          : '',
      refund: refundInfo.lastRefundByLineItem.get(String(item.id)) || null
    };
  }));

  const customerName =
    `${foundOrder.customer?.first_name || ''} ${foundOrder.customer?.last_name || ''}`.trim() ||
    foundOrder.shipping_address?.name ||
    foundOrder.billing_address?.name ||
    '-';

  return {
    id: foundOrder.id,
    name: foundOrder.name,
    orderNumber: foundOrder.order_number,
    customer: customerName,
    customerEmail: foundOrder.email || foundOrder.contact_email || foundOrder.customer?.email || '',
    customerZip: foundOrder.shipping_address?.zip || foundOrder.billing_address?.zip || '',
    financialStatus: foundOrder.financial_status || '-',
    fulfillmentStatus: foundOrder.fulfillment_status || 'Nog niet verzonden',
    location: locationName,
    warehouse: locationName,
    orderedAt: foundOrder.created_at,
    createdAt: foundOrder.created_at,
    shippedAt: firstFulfillment?.created_at || '',
    fulfilledAt: firstFulfillment?.created_at || '',
    tracking: trackingNumber,
    trackingUrl,
    totalPrice: foundOrder.total_price || '',
    currency: foundOrder.currency || '',
    refundedTotal: refundInfo.totalRefunded,
    lastRefundAt: refundInfo.lastRefundAt,
    isRefunded: refundInfo.totalRefunded > 0,
    items
  };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const order = String(req.query.order || '').trim();
  const check = String(req.query.check || '').trim();
  const query = String(req.query.query || '').trim();
  const searchValue = order || query || check;

  if (!searchValue) return res.status(400).json({ error: 'Vul een ordernummer, e-mail of postcode in' });

  const config = getShopifyConfig();
  if (config.error) return res.status(500).json(config.error);
  const { shop, token } = config;

  try {
    if (order) {
      const foundOrder = await findOrderByOrderNumber(shop, token, order);
      if (foundOrder && check && !orderMatchesCheck(foundOrder, check)) return res.status(403).json({ error: 'Controle komt niet overeen' });
      if (!foundOrder) return res.status(404).json({ error: 'Geen order gevonden', searchedFor: searchValue });
      const formattedOrder = await formatRestOrderForFrontend(shop, token, foundOrder);
      return res.status(200).json({ order: formattedOrder });
    }

    if (isEmail(query || check)) {
      const foundOrders = await findOrdersByEmailFast(shop, token, query || check);
      if (!foundOrders.length) return res.status(404).json({ error: 'Geen order gevonden', searchedFor: searchValue });
      return res.status(200).json({ orders: foundOrders.map(formatGraphqlOrderSummary), count: foundOrders.length, limitedTo: MAX_QUERY_RESULTS, mode: 'email-fast' });
    }

    const foundOrders = await findOrdersByPostcodeFallback(shop, token, query || check);
    if (!foundOrders.length) {
      return res.status(404).json({
        error: 'Geen order gevonden',
        searchedFor: searchValue,
        note: 'Postcode zoekt alleen in de laatste 250 orders. Gebruik ordernummer of e-mail voor sneller en breder zoeken.'
      });
    }

    const formattedOrders = await Promise.all(foundOrders.map((shopifyOrder) => formatRestOrderForFrontend(shop, token, shopifyOrder)));
    return res.status(200).json({ orders: formattedOrders, count: formattedOrders.length, limitedTo: MAX_QUERY_RESULTS, mode: 'postcode-fallback' });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Order kon niet worden opgezocht', details: error.details || undefined });
  }
}
