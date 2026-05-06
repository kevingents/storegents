function envFirst(names = []) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return String(value).trim();
  }
  return '';
}

function getShopifyConfig() {
  const shop = envFirst([
    'SHOPIFY_SHOP_DOMAIN',
    'SHOPIFY_STORE_DOMAIN',
    'SHOPIFY_SHOP',
    'SHOP_DOMAIN'
  ]).replace(/^https?:\/\//, '').replace(/\/$/, '');

  const token = envFirst([
    'SHOPIFY_ADMIN_ACCESS_TOKEN',
    'SHOPIFY_ACCESS_TOKEN',
    'SHOPIFY_ADMIN_TOKEN'
  ]);

  const apiVersion = envFirst(['SHOPIFY_API_VERSION']) || '2024-10';

  if (!shop || !token) {
    throw new Error('Shopify config ontbreekt. Zet SHOPIFY_SHOP_DOMAIN en SHOPIFY_ADMIN_ACCESS_TOKEN in Vercel.');
  }

  return { shop, token, apiVersion };
}

async function shopifyRequest(path, options = {}) {
  const { shop, token, apiVersion } = getShopifyConfig();
  const cleanPath = String(path || '').startsWith('/') ? String(path) : `/${path}`;
  const url = `https://${shop}/admin/api/${apiVersion}${cleanPath}`;

  const response = await fetch(url, {
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

  try {
    data = text ? JSON.parse(text) : {};
  } catch (_error) {
    data = { message: text };
  }

  if (!response.ok) {
    const error = new Error(data?.errors || data?.error || data?.message || `Shopify fout ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

function normalizeOrderName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.startsWith('#') ? raw : `#${raw}`;
}

function lineMatches(line = {}, item = {}) {
  const sku = String(item.sku || item.barcode || '').trim().toLowerCase();
  const title = String(item.title || '').trim().toLowerCase();

  return Boolean(
    sku && String(line.sku || '').trim().toLowerCase() === sku ||
    title && String(line.title || '').trim().toLowerCase() === title
  );
}

function refundedQuantityForLine(order = {}, lineItemId) {
  let quantity = 0;

  for (const refund of order.refunds || []) {
    for (const refundLine of refund.refund_line_items || []) {
      if (String(refundLine.line_item_id) === String(lineItemId)) {
        quantity += Number(refundLine.quantity || 0);
      }
    }
  }

  return quantity;
}

export async function findShopifyOrderByName(orderNr) {
  const name = normalizeOrderName(orderNr);
  const encoded = encodeURIComponent(name.replace(/^#/, ''));

  const direct = await shopifyRequest(`/orders.json?status=any&name=${encoded}&limit=5`);
  let order = (direct.orders || []).find((item) => String(item.name || '').replace(/^#/, '') === name.replace(/^#/, ''));

  if (!order) {
    const fallback = await shopifyRequest(`/orders.json?status=any&query=${encodeURIComponent(name)}&limit=10`);
    order = (fallback.orders || []).find((item) => String(item.name || '').replace(/^#/, '') === name.replace(/^#/, ''));
  }

  if (!order) {
    throw new Error(`Shopify order ${name} niet gevonden.`);
  }

  return order;
}

export async function refundUnavailableOrderLine({
  orderNr,
  item = {},
  quantity = 1,
  employeeName = 'Administratie',
  note = ''
} = {}) {
  const order = await findShopifyOrderByName(orderNr);
  const matchedLine = (order.line_items || []).find((line) => lineMatches(line, item));

  if (!matchedLine) {
    throw new Error(`Geen Shopify orderregel gevonden voor ${item.sku || item.barcode || item.title || 'artikel'}.`);
  }

  const alreadyRefunded = refundedQuantityForLine(order, matchedLine.id);
  const availableToRefund = Math.max(0, Number(matchedLine.quantity || 0) - alreadyRefunded);
  const refundQuantity = Math.min(Math.max(1, Number(quantity || 1)), availableToRefund);

  if (refundQuantity <= 0) {
    return {
      success: true,
      alreadyRefunded: true,
      status: 'already_refunded',
      orderId: order.id,
      orderName: order.name,
      lineItemId: matchedLine.id,
      message: 'Deze Shopify orderregel lijkt al volledig terugbetaald.'
    };
  }

  const refundLineItems = [{
    line_item_id: matchedLine.id,
    quantity: refundQuantity,
    restock_type: 'no_restock'
  }];

  const calculated = await shopifyRequest(`/orders/${order.id}/refunds/calculate.json`, {
    method: 'POST',
    body: JSON.stringify({
      refund: {
        shipping: { full_refund: false },
        refund_line_items: refundLineItems
      }
    })
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
    return {
      success: true,
      alreadyRefunded: true,
      status: 'already_refunded_or_no_transaction',
      orderId: order.id,
      orderName: order.name,
      lineItemId: matchedLine.id,
      message: 'Shopify berekende geen terugbetaalbare transactie. Controleer of deze regel al terugbetaald is.'
    };
  }

  const createRefundPayload = {
    refund: {
      currency: calculatedRefund.currency || order.currency,
      notify: true,
      note: [
        'Niet leverbaar verwerkt via winkelportaal.',
        `Medewerker: ${employeeName}.`,
        `Order: ${order.name}.`,
        `Artikel: ${matchedLine.title}.`,
        `SKU: ${matchedLine.sku || '-'}.`,
        'Voorraad is niet teruggeboekt.',
        note
      ].filter(Boolean).join(' '),
      shipping: { full_refund: false },
      refund_line_items: refundLineItems,
      transactions
    }
  };

  const created = await shopifyRequest(`/orders/${order.id}/refunds.json`, {
    method: 'POST',
    body: JSON.stringify(createRefundPayload)
  });

  return {
    success: true,
    status: 'refunded',
    orderId: order.id,
    orderName: order.name,
    lineItemId: matchedLine.id,
    sku: matchedLine.sku,
    quantity: refundQuantity,
    refund: created.refund || created
  };
}
