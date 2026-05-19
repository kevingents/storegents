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

/**
 * Canonical key voor order-name lookup: strip leading '#' en lowercase.
 * Voorkomt mismatches als SRS '33609' levert en Shopify '#33609' (of vice versa)
 * door beide kanten te normaliseren.
 */
function canonicalOrderKey(value) {
  return String(value || '').trim().replace(/^#+/, '').toLowerCase();
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
    /* Query Shopify met BEIDE varianten: met en zonder '#' prefix. Shopify
       order.name kan per merchant-config met of zonder '#' beginnen, dus
       sturen we beide om geen orders te missen. */
    const variants = chunk.flatMap((n) => {
      const stripped = canonicalOrderKey(n);
      return [`name:${JSON.stringify('#' + stripped)}`, `name:${JSON.stringify(stripped)}`];
    });
    const q = variants.join(' OR ');
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
              shippingLines(first: 5) { edges { node { title code source } } }
              fulfillmentOrders(first: 5) { edges { node { assignedLocation { name } } } }
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
        /* Pickup-point info — Shopify Local Pickup zet de pickup-locatie in
           shippingLine.title ("Pickup at GENTS Tilburg") en/of in
           fulfillmentOrders[].assignedLocation.name. */
        const shippingLines = (node.shippingLines?.edges || []).map((e) => e.node).filter(Boolean);
        const fulfillmentLocations = (node.fulfillmentOrders?.edges || [])
          .map((e) => e.node?.assignedLocation?.name)
          .filter(Boolean);
        const pickupShippingLine = shippingLines.find((sl) =>
          /pickup|afhalen|afhaal/i.test(String(sl?.title || '') + ' ' + String(sl?.code || ''))
        );
        /* Prioriteer fulfillmentOrders.assignedLocation (geeft pure locatienaam
           als "GENTS Tilburg") boven parsing van shippingLine.title (kan
           woorden als "Pickup at" of "Afhalen in" bevatten). */
        const pickupLocation = fulfillmentLocations[0]
          || (pickupShippingLine?.title || '').replace(/^.*?(pickup\s+(at|in)|afhalen\s+(in|bij)|afhaal[^a-z0-9]*)/i, '').trim()
          || '';

        /* Key op canonical form (zonder '#') zodat lookup robuust is. */
        map.set(canonicalOrderKey(node.name), {
          orderName: node.name,
          orderNameDisplay: node.name.startsWith('#') ? node.name : '#' + node.name,
          shippingMethod: pickupShippingLine?.title || shippingLines[0]?.title || '',
          isPickup: Boolean(pickupShippingLine),
          pickupLocation,
          assignedLocation: fulfillmentLocations[0] || '',
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
    const lookupKey = canonicalOrderKey(item.orderNr || item.shopifyOrderName || item.orderName);
    const enrichment = ordersMap.get(lookupKey);
    if (!enrichment) {
      /* Debug-trace zodat we mismatches kunnen herleiden zonder full log-spam */
      if (lookupKey && process.env.NODE_ENV !== 'production') {
        console.warn('[shopify-order-enrich] geen Shopify-match voor SRS orderNr:', lookupKey, '— map keys:', [...ordersMap.keys()].slice(0, 5));
      }
      return item;
    }

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
      shopifyOrderCreatedAt: enrichment.createdAt || '',
      shopifyOrderName: enrichment.orderNameDisplay || enrichment.orderName || '',
      /* Pickup info — handig wanneer SRS-fulfilling store ≠ Shopify-pickup point */
      shippingMethod: enrichment.shippingMethod || '',
      isPickup: Boolean(enrichment.isPickup),
      pickupLocation: enrichment.pickupLocation || '',
      assignedLocation: enrichment.assignedLocation || ''
    };
  });
}
