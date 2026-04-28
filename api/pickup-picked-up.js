const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
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

function parseTags(tags) {
  return String(tags || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function mergeTags(existingTags, newTags) {
  const set = new Set(parseTags(existingTags));

  newTags.forEach((tag) => {
    if (tag) set.add(tag);
  });

  return Array.from(set).join(', ');
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { orderId } = req.body || {};

  if (!orderId) {
    return res.status(400).json({ error: 'Order ID ontbreekt' });
  }

  const config = getShopifyConfig();

  if (config.error) {
    return res.status(500).json(config.error);
  }

  const { shop, token } = config;

  try {
    const { response: orderResponse, data: orderData } = await shopifyFetch(
      shop,
      token,
      `/orders/${orderId}.json`
    );

    if (!orderResponse.ok || !orderData.order) {
      return res.status(orderResponse.status).json({
        error: 'Order ophalen mislukt',
        details: orderData
      });
    }

    const order = orderData.order;

    const updatedTags = mergeTags(order.tags, [
      'pickup_picked_up'
    ]);

    const { response: updateResponse, data: updateData } = await shopifyFetch(
      shop,
      token,
      `/orders/${orderId}.json`,
      {
        method: 'PUT',
        body: JSON.stringify({
          order: {
            id: Number(orderId),
            tags: updatedTags
          }
        })
      }
    );

    if (!updateResponse.ok) {
      return res.status(updateResponse.status).json({
        error: 'Order op afgehaald zetten mislukt',
        details: updateData
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Order gemarkeerd als afgehaald',
      order: {
        id: orderId,
        name: updateData.order?.name || order.name,
        tags: updateData.order?.tags || updatedTags
      }
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Order kon niet op afgehaald worden gezet',
      message: error.message
    });
  }
}
