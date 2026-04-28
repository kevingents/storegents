const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';

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

  shop = shop
    .replace('https://', '')
    .replace('http://', '')
    .replace(/\/$/, '');

  return { shop, token };
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function tagList(order) {
  return String(order.tags || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function hasTag(order, tag) {
  return tagList(order).includes(tag);
}

function getPickupStatus(order) {
  if (hasTag(order, 'pickup_picked_up')) return 'opgehaald';
  if (hasTag(order, 'pickup_notified') || normalize(order.fulfillment_status).includes('ready')) return 'niet_opgehaald';
  return 'nog_klaar_te_zetten';
}

function statusLabel(value) {
  if (value === 'opgehaald') return 'Opgehaald';
  if (value === 'niet_opgehaald') return 'Niet opgehaald';
  return 'Nog klaar te zetten';
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

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { store, status } = req.query;

  if (!store) {
    return res.status(400).json({ error: 'Winkel ontbreekt' });
  }

  const config = getShopifyConfig();

  if (config.error) {
    return res.status(500).json(config.error);
  }

  const { shop, token } = config;

  try {
    const { response, data } = await shopifyFetch(
      shop,
      token,
      `/orders.json?status=open&limit=250&order=created_at desc`
    );

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'Shopify ophaalorders ophalen mislukt',
        details: data
      });
    }

    const selectedStore = normalize(store);

    const orders = (data.orders || [])
      .filter((order) => {
        const shippingTitle = normalize(order.shipping_lines?.[0]?.title);
        const note = normalize(order.note);
        const tags = normalize(order.tags);
        const attributes = (order.note_attributes || [])
          .map((attr) => `${attr.name}: ${attr.value}`)
          .join(' ')
          .toLowerCase();

        const pickupMatch =
          shippingTitle.includes('pickup') ||
          shippingTitle.includes('ophalen') ||
          shippingTitle.includes('afhalen') ||
          shippingTitle.includes('pickup in store') ||
          tags.includes('pickup') ||
          tags.includes('ophaal') ||
          note.includes('pickup') ||
          note.includes('ophalen') ||
          note.includes('afhalen') ||
          attributes.includes('pickup') ||
          attributes.includes('ophalen') ||
          attributes.includes('afhalen');

        const storeMatch =
          shippingTitle.includes(selectedStore) ||
          note.includes(selectedStore) ||
          tags.includes(selectedStore) ||
          attributes.includes(selectedStore);

        return pickupMatch && storeMatch;
      })
      .map((order) => {
        const pickupStatus = getPickupStatus(order);

        const customerName =
          `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim() ||
          order.shipping_address?.name ||
          order.billing_address?.name ||
          '-';

        return {
          id: order.id,
          name: order.name,
          customer: customerName,
          email: order.email || '',
          phone: order.phone || order.shipping_address?.phone || '',
          createdAt: order.created_at,
          financialStatus: order.financial_status || '-',
          fulfillmentStatus: order.fulfillment_status || 'Nog niet verzonden',
          pickupStatus,
          pickupStatusLabel: statusLabel(pickupStatus),
          tags: tagList(order),
          note: order.note || '',
          items: (order.line_items || []).map((item) => ({
            id: item.id,
            lineItemId: item.id,
            quantity: item.quantity,
            name: item.name,
            sku: item.sku || '',
            variant: item.variant_title || ''
          }))
        };
      })
      .filter((order) => {
        if (!status || status === 'all') return true;
        return order.pickupStatus === status;
      })
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    return res.status(200).json({
      store,
      count: orders.length,
      orders
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Ophaalorders konden niet worden geladen',
      message: error.message
    });
  }
}
