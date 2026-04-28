const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';
const MAX_ORDER_SEARCH_PAGES = Number(process.env.MAX_ORDER_SEARCH_PAGES || 20);

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
    .replace(/\s/g, '')
    .trim();
}

function parseNextPageInfo(linkHeader) {
  if (!linkHeader) return '';

  const links = linkHeader.split(',');

  const nextLink = links.find((link) => {
    return link.includes('rel="next"');
  });

  if (!nextLink) return '';

  const match = nextLink.match(/<([^>]+)>/);

  if (!match || !match[1]) return '';

  try {
    const url = new URL(match[1]);
    return url.searchParams.get('page_info') || '';
  } catch (error) {
    return '';
  }
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

async function getProductImage(shop, token, productId, variantId) {
  if (!productId) return '';

  try {
    const { response, data } = await shopifyFetch(
      shop,
      token,
      `/products/${productId}.json`
    );

    if (!response.ok || !data.product) return '';

    const product = data.product;

    if (variantId && product.images && product.images.length) {
      const variantImage = product.images.find((image) => {
        return image.variant_ids && image.variant_ids.includes(Number(variantId));
      });

      if (variantImage && variantImage.src) {
        return variantImage.src;
      }
    }

    return product.image?.src || '';
  } catch (error) {
    return '';
  }
}

async function getLocationName(shop, token, locationId) {
  if (!locationId) return '-';

  try {
    const { response, data } = await shopifyFetch(
      shop,
      token,
      `/locations/${locationId}.json`
    );

    if (response.ok && data.location && data.location.name) {
      return data.location.name;
    }

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
  const shippingZip = normalize(shopifyOrder.shipping_address?.zip);
  const billingZip = normalize(shopifyOrder.billing_address?.zip);

  return (
    normalizedCheck === email ||
    normalizedCheck === contactEmail ||
    normalizedCheck === shippingZip ||
    normalizedCheck === billingZip
  );
}

function orderMatchesSearch(shopifyOrder, search) {
  if (!search) return true;

  const normalizedSearch = normalize(search);

  const name = normalize(shopifyOrder.name);
  const orderNumber = normalize(String(shopifyOrder.order_number || ''));
  const numericName = normalize(String(shopifyOrder.name || '').replace('#', ''));

  const email = normalize(shopifyOrder.email);
  const contactEmail = normalize(shopifyOrder.contact_email);

  const customerEmail = normalize(shopifyOrder.customer?.email);

  const shippingZip = normalize(shopifyOrder.shipping_address?.zip);
  const billingZip = normalize(shopifyOrder.billing_address?.zip);

  return (
    name === normalizedSearch ||
    orderNumber === normalizedSearch ||
    numericName === normalizedSearch ||
    email === normalizedSearch ||
    contactEmail === normalizedSearch ||
    customerEmail === normalizedSearch ||
    shippingZip === normalizedSearch ||
    billingZip === normalizedSearch
  );
}

async function findOrderByOrderNumber(shop, token, orderValue) {
  let orderNumber = String(orderValue || '').trim();

  if (!orderNumber) return null;

  if (!orderNumber.startsWith('#')) {
    orderNumber = `#${orderNumber}`;
  }

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

async function findOrderByEmailOrPostcode(shop, token, searchValue) {
  let pageInfo = '';
  let page = 0;

  while (page < MAX_ORDER_SEARCH_PAGES) {
    page += 1;

    const path = pageInfo
      ? `/orders.json?limit=250&page_info=${encodeURIComponent(pageInfo)}`
      : `/orders.json?status=any&limit=250&order=created_at desc`;

    const { response, data } = await shopifyFetch(shop, token, path);

    if (!response.ok) {
      const error = new Error('Shopify order lookup mislukt');
      error.status = response.status;
      error.details = data;
      throw error;
    }

    const foundOrder = (data.orders || []).find((shopifyOrder) => {
      return orderMatchesSearch(shopifyOrder, searchValue);
    });

    if (foundOrder) {
      return foundOrder;
    }

    pageInfo = parseNextPageInfo(response.headers.get('link'));

    if (!pageInfo) {
      break;
    }
  }

  return null;
}

async function formatOrderForFrontend(shop, token, foundOrder) {
  const fulfillments = foundOrder.fulfillments || [];
  const firstFulfillment = fulfillments[0] || null;

  const trackingNumber =
    firstFulfillment?.tracking_number ||
    firstFulfillment?.tracking_numbers?.[0] ||
    '';

  const trackingUrl =
    firstFulfillment?.tracking_url ||
    firstFulfillment?.tracking_urls?.[0] ||
    '';

  const locationId =
    firstFulfillment?.location_id ||
    foundOrder.location_id ||
    '';

  const locationName = await getLocationName(shop, token, locationId);

  const items = await Promise.all(
    (foundOrder.line_items || []).map(async (item) => {
      const matchingFulfillment = fulfillments.find((fulfillment) => {
        return (fulfillment.line_items || []).some((fulfilledItem) => {
          return fulfilledItem.id === item.id;
        });
      });

      const itemLocationId =
        matchingFulfillment?.location_id ||
        locationId ||
        '';

      const itemLocationName =
        itemLocationId && itemLocationId !== locationId
          ? await getLocationName(shop, token, itemLocationId)
          : locationName;

      const image = await getProductImage(shop, token, item.product_id, item.variant_id);

      const refundedQuantity = Number(item.refunded_quantity || 0);
      const quantity = Number(item.quantity || 0);
      const refundableQuantity = Math.max(quantity - refundedQuantity, 0);

      return {
        id: item.id,
        lineItemId: item.id,
        quantity: item.quantity,
        refundableQuantity: refundableQuantity || item.quantity,
        name: item.name,
        sku: item.sku || '',
        variant: item.variant_title || '',
        price: item.price || '',
        image: image,
        location: itemLocationName,
        fulfillmentStatus: matchingFulfillment ? 'Verzonden' : 'Nog niet verzonden'
      };
    })
  );

  const customerName =
    `${foundOrder.customer?.first_name || ''} ${foundOrder.customer?.last_name || ''}`.trim() ||
    foundOrder.shipping_address?.name ||
    foundOrder.billing_address?.name ||
    '-';

  return {
    id: foundOrder.id,
    name: foundOrder.name,
    customer: customerName,
    customerEmail:
      foundOrder.email ||
      foundOrder.contact_email ||
      foundOrder.customer?.email ||
      '',
    customerZip:
      foundOrder.shipping_address?.zip ||
      foundOrder.billing_address?.zip ||
      '',
    financialStatus: foundOrder.financial_status || '-',
    fulfillmentStatus: foundOrder.fulfillment_status || 'Nog niet verzonden',
    location: locationName,
    warehouse: locationName,
    orderedAt: foundOrder.created_at,
    createdAt: foundOrder.created_at,
    shippedAt: firstFulfillment?.created_at || '',
    fulfilledAt: firstFulfillment?.created_at || '',
    tracking: trackingNumber,
    trackingUrl: trackingUrl,
    items: items
  };
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  const order = String(req.query.order || '').trim();
  const check = String(req.query.check || '').trim();
  const query = String(req.query.query || '').trim();

  const searchValue = order || query || check;

  if (!searchValue) {
    return res.status(400).json({
      error: 'Vul een ordernummer, e-mail of postcode in'
    });
  }

  const config = getShopifyConfig();

  if (config.error) {
    return res.status(500).json(config.error);
  }

  const { shop, token } = config;

  try {
    let foundOrder = null;

    if (order) {
      foundOrder = await findOrderByOrderNumber(shop, token, order);

      if (foundOrder && check && !orderMatchesCheck(foundOrder, check)) {
        return res.status(403).json({
          error: 'Controle komt niet overeen'
        });
      }
    } else {
      foundOrder = await findOrderByEmailOrPostcode(shop, token, query || check);
    }

    if (!foundOrder) {
      return res.status(404).json({
        error: 'Geen order gevonden',
        searchedFor: searchValue,
        note: `Er is gezocht in maximaal ${MAX_ORDER_SEARCH_PAGES * 250} orders. Verhoog MAX_ORDER_SEARCH_PAGES als je verder terug wilt zoeken.`
      });
    }

    const formattedOrder = await formatOrderForFrontend(shop, token, foundOrder);

    return res.status(200).json({
      order: formattedOrder
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      error: error.message || 'Order kon niet worden opgezocht',
      details: error.details || undefined
    });
  }
}
