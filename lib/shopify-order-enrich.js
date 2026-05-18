/**
 * Verrijk SRS open-weborder regels met Shopify data: productnaam, klantnaam,
 * klant-email, variant (maat/kleur), foto's. Eén GraphQL-batch voor alle
 * unieke order-namen (ipv N losse REST calls).
 *
 * Gebruik:
 *   const enriched = await enrichOpenWebOrders(items);
 *   // items hebben nu naast SRS-velden ook customerName, productTitle, image, etc.
 */

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';

function cleanShop(url) {
  return String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function normalizeOrderName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.startsWith('#') ? raw : `#${raw}`;
}

function normSku(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Haalt een batch Shopify orders op via GraphQL met OR-query op order.name.
 * Geeft een Map terug van orderName → { customer, lineItems[] }.
 */
async function fetchShopifyOrdersBatch(orderNames) {
  const shop = cleanShop(process.env.SHOPIFY_STORE_URL);
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!shop || !token || !orderNames.length) return new Map();

  /* Bouw query string. Shopify limiteert query lengte; chunk in batches van 25. */
  const map = new Map();
  const chunks = [];
  for (let i = 0; i < orderNames.length; i += 25) chunks.push(orderNames.slice(i, i + 25));

  for (const chunk of chunks) {
    const q = chunk.map((n) => `name:${JSON.stringify(n)}`).join(' OR ');
    const query = `
      query OpenOrdersBatch($q: String!) {
        orders(first: ${Math.min(chunk.length, 25)}, query: $q) {
          edges {
            node {
              id
              name
              email
              phone
              displayFinancialStatus
              displayFulfillmentStatus
              createdAt
              customer {
                id
                firstName
                lastName
                email
              }
              shippingAddress { name phone zip city }
              billingAddress { name phone zip city }
              lineItems(first: 30) {
                edges {
                  node {
                    sku
                    name
                    title
                    quantity
                    variantTitle
                    image { url }
                    variant {
                      id
                      title
                      sku
                      barcode
                      selectedOptions { name value }
                      image { url }
                      product { title featuredImage { url } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    try {
      const response = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query, variables: { q } })
      });
      if (!response.ok) continue;
      const data = await response.json();
      const orders = data?.data?.orders?.edges || [];
      for (const edge of orders) {
        const node = edge.node;
        if (!node?.name) continue;
        const lineItems = (node.lineItems?.edges || []).map((e) => e.node);
        const customerName = node.customer
          ? [node.customer.firstName, node.customer.lastName].filter(Boolean).join(' ').trim()
          : (node.shippingAddress?.name || node.billingAddress?.name || '');
        map.set(node.name, {
          orderName: node.name,
          customer: {
            name: customerName,
            firstName: node.customer?.firstName || '',
            lastName: node.customer?.lastName || '',
            email: node.email || node.customer?.email || '',
            phone: node.phone || node.shippingAddress?.phone || node.billingAddress?.phone || '',
            shopifyCustomerId: node.customer?.id ? String(node.customer.id).split('/').pop() : ''
          },
          fulfillmentStatus: node.displayFulfillmentStatus || '',
          financialStatus: node.displayFinancialStatus || '',
          createdAt: node.createdAt || '',
          lineItems: lineItems.map((li) => ({
            name: li.name || li.title || '',
            title: li.title || li.name || '',
            sku: li.sku || li.variant?.sku || '',
            barcode: li.variant?.barcode || '',
            quantity: Number(li.quantity || 1),
            variantTitle: li.variantTitle || li.variant?.title || '',
            image: li.image?.url || li.variant?.image?.url || li.variant?.product?.featuredImage?.url || '',
            options: (li.variant?.selectedOptions || []).reduce((acc, opt) => {
              acc[String(opt.name || '').toLowerCase()] = opt.value;
              return acc;
            }, {})
          }))
        });
      }
    } catch (error) {
      console.warn('[shopify-order-enrich] batch fail:', error.message);
      /* Stil falen: orders zonder enrichment komen wel terug, alleen zonder Shopify-context. */
    }
  }
  return map;
}

/**
 * Hoofd-helper: neem SRS-items, verrijk met Shopify data.
 *
 * @param {Array<object>} items SRS-open-weborder regels (genormaliseerd via weborder-request-store)
 * @returns {Promise<Array<object>>} dezelfde items + Shopify-velden gemerged
 */
export async function enrichOpenWebOrders(items = []) {
  if (!Array.isArray(items) || !items.length) return items || [];

  /* Verzamel unieke order-namen (max 100 om Shopify-quota te respecteren) */
  const seen = new Set();
  const orderNames = [];
  for (const item of items) {
    const name = normalizeOrderName(item.orderNr || item.shopifyOrderName || item.orderName);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    orderNames.push(name);
    if (orderNames.length >= 100) break;
  }

  if (!orderNames.length) return items;

  const ordersMap = await fetchShopifyOrdersBatch(orderNames);

  return items.map((item) => {
    const orderName = normalizeOrderName(item.orderNr || item.shopifyOrderName || item.orderName);
    const enrichment = ordersMap.get(orderName);
    if (!enrichment) return item;

    /* Match line-item op SKU / barcode */
    const itemSku = normSku(item.sku || item.barcode || item.articleCode);
    const matchedLine = enrichment.lineItems.find((li) =>
      normSku(li.sku) === itemSku ||
      normSku(li.barcode) === itemSku
    ) || enrichment.lineItems[0] || null;

    return {
      ...item,
      /* Klant info */
      customerName: item.customerName || enrichment.customer.name || '',
      customerEmail: item.customerEmail || item.email || enrichment.customer.email || '',
      email: item.email || enrichment.customer.email || '',
      customerPhone: item.customerPhone || enrichment.customer.phone || '',
      phone: item.phone || enrichment.customer.phone || '',
      shopifyCustomerId: enrichment.customer.shopifyCustomerId || '',
      /* Product info */
      productTitle: item.productTitle || matchedLine?.title || matchedLine?.name || '',
      description: item.description || matchedLine?.title || matchedLine?.name || '',
      productImage: item.productImage || item.image || matchedLine?.image || '',
      image: item.image || matchedLine?.image || '',
      variantTitle: item.variantTitle || matchedLine?.variantTitle || '',
      size: item.size || matchedLine?.options?.maat || matchedLine?.options?.size || matchedLine?.options?.['size'] || '',
      color: item.color || matchedLine?.options?.kleur || matchedLine?.options?.color || matchedLine?.options?.['colour'] || '',
      /* Order context */
      shopifyFulfillmentStatus: enrichment.fulfillmentStatus || '',
      shopifyFinancialStatus: enrichment.financialStatus || '',
      shopifyOrderCreatedAt: enrichment.createdAt || ''
    };
  });
}
