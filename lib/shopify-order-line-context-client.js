function envFirst(names = []) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return String(value).trim();
  }
  return '';
}

function normalizeShopDomain(value) {
  return String(value || '').trim().replace(/^https?:\/\//, '').replace(/\/admin.*$/i, '').replace(/\/$/, '');
}

function getShopifyConfig() {
  const shop = normalizeShopDomain(envFirst(['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_STORE_DOMAIN', 'SHOPIFY_STORE_URL', 'SHOPIFY_SHOP', 'SHOP_DOMAIN']));
  const token = envFirst(['SHOPIFY_ADMIN_ACCESS_TOKEN', 'SHOPIFY_ACCESS_TOKEN', 'SHOPIFY_ADMIN_TOKEN']);
  const apiVersion = envFirst(['SHOPIFY_API_VERSION']) || '2024-10';
  if (!shop || !token) throw new Error('Shopify config ontbreekt.');
  return { shop, token, apiVersion };
}

async function shopifyRequest(path, options = {}) {
  const { shop, token, apiVersion } = getShopifyConfig();
  const cleanPath = String(path || '').startsWith('/') ? String(path) : `/${path}`;
  const response = await fetch(`https://${shop}/admin/api/${apiVersion}${cleanPath}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_error) { data = { message: text }; }
  if (!response.ok) throw new Error(data?.errors || data?.error || data?.message || `Shopify fout ${response.status}`);
  return data;
}

function norm(value) {
  return String(value || '').trim().toLowerCase();
}

function digits(value) {
  return String(value || '').replace(/\D+/g, '');
}

function moneyNumber(value) {
  const number = Number(value || 0);
  return Math.round(number * 100) / 100;
}

function normalizeOrderName(value) {
  const raw = String(value || '').trim().replace(/^#/, '');
  return raw ? `#${raw}` : '';
}

function collectLineValues(line = {}) {
  const values = [line.sku, line.title, line.variant_title, line.name, line.vendor, line.product_id, line.variant_id, line.barcode];
  if (Array.isArray(line.properties)) line.properties.forEach((property) => values.push(property.name, property.value));
  return values.map(norm).filter(Boolean);
}

function itemNeedles(item = {}) {
  return [item.sku, item.barcode, item.title, item.articleNumber, item.articleId, item.orderLineNr, item.variantId, item.productId]
    .map(norm)
    .filter(Boolean);
}

function lineMatches(line = {}, item = {}) {
  const needles = itemNeedles(item);
  const values = collectLineValues(line);
  const lineSku = norm(line.sku);
  if (!needles.length) return false;
  if (lineSku && needles.includes(lineSku)) return true;
  if (needles.some((needle) => values.includes(needle))) return true;
  const digitNeedles = needles.map(digits).filter((value) => value.length >= 6);
  const digitValues = values.map(digits).filter((value) => value.length >= 6);
  return digitNeedles.some((needle) => digitValues.some((value) => value === needle || value.includes(needle) || needle.includes(value)));
}

function lineAmount(line = {}, quantity = 1) {
  const qty = Math.max(1, Number(quantity || 1));
  const unit = moneyNumber(line.discounted_price || line.price || line.original_price || line.pre_tax_price || 0);
  return moneyNumber(unit * qty);
}

async function findShopifyOrderByName(orderNr) {
  const name = normalizeOrderName(orderNr);
  const encoded = encodeURIComponent(name.replace(/^#/, ''));
  const direct = await shopifyRequest(`/orders.json?status=any&name=${encoded}&limit=5`);
  let order = (direct.orders || []).find((item) => String(item.name || '').replace(/^#/, '') === name.replace(/^#/, ''));
  if (!order) {
    const fallback = await shopifyRequest(`/orders.json?status=any&query=${encodeURIComponent(name)}&limit=10`);
    order = (fallback.orders || []).find((item) => String(item.name || '').replace(/^#/, '') === name.replace(/^#/, ''));
  }
  if (!order) throw new Error(`Shopify order ${name} niet gevonden.`);
  return order;
}

async function fulfillmentLocationForLine(order, lineItemId) {
  try {
    const data = await shopifyRequest(`/orders/${order.id}/fulfillment_orders.json`);
    for (const fulfillmentOrder of data.fulfillment_orders || []) {
      const match = (fulfillmentOrder.line_items || []).find((item) => String(item.line_item_id) === String(lineItemId));
      if (match) {
        const name = fulfillmentOrder.assigned_location?.name || fulfillmentOrder.destination?.name || '';
        if (name) return name;
      }
    }
  } catch (_error) {}

  for (const fulfillment of order.fulfillments || []) {
    const match = (fulfillment.line_items || []).find((item) => String(item.id) === String(lineItemId));
    if (match && fulfillment.location_id) {
      try {
        const location = await shopifyRequest(`/locations/${fulfillment.location_id}.json`);
        if (location.location?.name) return location.location.name;
      } catch (_error) {}
    }
  }

  return '';
}

export async function getShopifyOrderLineContext({ orderNr, item = {}, quantity = 1 } = {}) {
  const order = await findShopifyOrderByName(orderNr);
  const matchedLine = (order.line_items || []).find((line) => lineMatches(line, item));
  if (!matchedLine) return null;

  const fulfillmentLocation = await fulfillmentLocationForLine(order, matchedLine.id);
  return {
    orderId: order.id,
    orderName: order.name,
    customerName: [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ').trim() || order.customer?.default_address?.name || '',
    customerEmail: order.email || order.contact_email || order.customer?.email || '',
    lineItemId: matchedLine.id,
    sku: matchedLine.sku || '',
    title: matchedLine.title || matchedLine.name || '',
    quantity: Number(quantity || 1),
    amount: lineAmount(matchedLine, quantity),
    fulfillmentLocation,
    store: fulfillmentLocation || ''
  };
}
