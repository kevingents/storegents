const SHOPIFY_ACCESS_TOKEN =
  process.env.SHOPIFY_ACCESS_TOKEN ||
  process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ||
  process.env.SHOPIFY_ADMIN_TOKEN ||
  '';

const SHOPIFY_STORE_URL =
  process.env.SHOPIFY_STORE_URL ||
  process.env.SHOPIFY_SHOP ||
  '';

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';

const CACHE_TTL_MS = 15 * 60 * 1000;
const memoryCache = new Map();

function setCors(res, methods = 'GET, OPTIONS') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
}

function cleanShopUrl(url) {
  return String(url || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
}

function shopifyGraphqlUrl() {
  return `https://${cleanShopUrl(SHOPIFY_STORE_URL)}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function gidToLegacyId(gid) {
  const match = String(gid || '').match(/\/(\d+)$/);
  return match ? match[1] : String(gid || '');
}

function getCache(key) {
  const item = memoryCache.get(key);
  if (!item) return null;

  if (Date.now() - item.createdAt > CACHE_TTL_MS) {
    memoryCache.delete(key);
    return null;
  }

  return item.value;
}

function setCache(key, value) {
  memoryCache.set(key, {
    createdAt: Date.now(),
    value
  });
}

async function shopifyGraphql(query, variables = {}) {
  if (!SHOPIFY_ACCESS_TOKEN || !SHOPIFY_STORE_URL) {
    throw new Error('Shopify environment variables ontbreken. Controleer SHOPIFY_STORE_URL en SHOPIFY_ACCESS_TOKEN.');
  }

  const response = await fetch(shopifyGraphqlUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });

  const text = await response.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    data = { errors: [{ message: text || error.message }] };
  }

  if (!response.ok) {
    throw new Error(data?.errors?.[0]?.message || `Shopify GraphQL fout ${response.status}`);
  }

  if (data.errors?.length) {
    throw new Error(data.errors.map((error) => error.message).join(', '));
  }

  return data.data;
}

const LOCATIONS_QUERY = `
  query LocationsForPickup($first: Int!) {
    locations(first: $first) {
      edges {
        node {
          id
          name
          legacyResourceId
          isActive
        }
      }
    }
  }
`;

const ORDERS_QUERY = `
  query PickupOrders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          legacyResourceId
          name
          createdAt
          email
          tags
          displayFinancialStatus
          displayFulfillmentStatus
          customer {
            displayName
            email
            phone
          }
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          fulfillmentOrders(first: 20) {
            edges {
              node {
                id
                status
                deliveryMethod {
                  methodType
                  presentedName
                }
                assignedLocation {
                  name
                  location {
                    id
                    name
                    legacyResourceId
                  }
                }
                lineItems(first: 50) {
                  edges {
                    node {
                      id
                      totalQuantity
                      remainingQuantity
                      lineItem {
                        id
                        title
                        sku
                        quantity
                        variantTitle
                        image {
                          url
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

function pickupStatusFromOrder(order, pickupFulfillmentOrders) {
  const tags = (order.tags || []).map((tag) => normalize(tag));
  const fulfillmentStatus = normalize(order.displayFulfillmentStatus);

  if (tags.includes('pickup opgehaald') || tags.includes('pickup_picked_up')) {
    return {
      pickupStatus: 'opgehaald',
      pickupStatusLabel: 'Opgehaald'
    };
  }

  if (fulfillmentStatus === 'fulfilled' || fulfillmentStatus === 'afgehandeld') {
    return {
      pickupStatus: 'opgehaald',
      pickupStatusLabel: 'Opgehaald'
    };
  }

  const readyTag =
    tags.includes('pickup ready') ||
    tags.includes('pickup_ready') ||
    tags.includes('pickup notified') ||
    tags.includes('pickup_notified');

  if (readyTag) {
    return {
      pickupStatus: 'klaar_voor_ophalen',
      pickupStatusLabel: 'Klaar voor ophalen'
    };
  }

  const hasOpenPickupFo = pickupFulfillmentOrders.some((fo) => {
    const status = normalize(fo.status);
    return !['closed', 'cancelled', 'canceled', 'incomplete'].includes(status);
  });

  if (hasOpenPickupFo) {
    return {
      pickupStatus: 'nog_klaar_te_zetten',
      pickupStatusLabel: 'Nog klaar te zetten'
    };
  }

  return {
    pickupStatus: 'onbekend',
    pickupStatusLabel: 'Onbekend'
  };
}

function isPickupFulfillmentOrder(fulfillmentOrder) {
  const methodType = normalize(fulfillmentOrder?.deliveryMethod?.methodType);

  return (
    methodType === 'pick up' ||
    methodType === 'pickup' ||
    methodType === 'pick_up' ||
    methodType === 'pick-up'
  );
}

function fulfillmentOrderLocationName(fulfillmentOrder) {
  return (
    fulfillmentOrder?.assignedLocation?.location?.name ||
    fulfillmentOrder?.assignedLocation?.name ||
    ''
  );
}

function fulfillmentOrderLocationId(fulfillmentOrder) {
  return String(
    fulfillmentOrder?.assignedLocation?.location?.legacyResourceId ||
      gidToLegacyId(fulfillmentOrder?.assignedLocation?.location?.id) ||
      ''
  );
}

function orderToPickupResult(order, pickupFulfillmentOrders, wantedLocationIds) {
  const statusInfo = pickupStatusFromOrder(order, pickupFulfillmentOrders);

  const items = [];

  pickupFulfillmentOrders.forEach((fo) => {
    const lineItems = fo.lineItems?.edges || [];

    lineItems.forEach((edge) => {
      const node = edge.node || {};
      const lineItem = node.lineItem || {};
      const quantity = Number(node.remainingQuantity ?? node.totalQuantity ?? lineItem.quantity ?? 0);

      if (quantity <= 0) return;

      items.push({
        id: gidToLegacyId(lineItem.id || node.id),
        fulfillmentOrderLineItemId: node.id,
        name: lineItem.title || '-',
        title: lineItem.title || '-',
        variant: lineItem.variantTitle || '',
        sku: lineItem.sku || '',
        quantity,
        image: lineItem.image?.url || ''
      });
    });
  });

  const locationNames = Array.from(
    new Set(pickupFulfillmentOrders.map(fulfillmentOrderLocationName).filter(Boolean))
  );

  const locationIds = Array.from(
    new Set(pickupFulfillmentOrders.map(fulfillmentOrderLocationId).filter(Boolean))
  );

  return {
    id: gidToLegacyId(order.legacyResourceId || order.id),
    orderId: gidToLegacyId(order.legacyResourceId || order.id),
    adminGraphqlId: order.id,
    name: order.name,
    createdAt: order.createdAt,
    customer: order.customer?.displayName || '-',
    email: order.customer?.email || order.email || '',
    phone: order.customer?.phone || '',
    financialStatus: order.displayFinancialStatus || '',
    fulfillmentStatus: order.displayFulfillmentStatus || '',
    pickupStatus: statusInfo.pickupStatus,
    pickupStatusLabel: statusInfo.pickupStatusLabel,
    locationNames,
    locationIds,
    wantedLocationIds,
    totalPrice: order.totalPriceSet?.shopMoney?.amount || '0',
    currency: order.totalPriceSet?.shopMoney?.currencyCode || 'EUR',
    items
  };
}

async function getWantedLocationIds(storeName) {
  const wantedStore = normalize(storeName);

  if (!wantedStore) return [];

  const data = await shopifyGraphql(LOCATIONS_QUERY, { first: 100 });
  const locations = (data.locations?.edges || [])
    .map((edge) => edge.node)
    .filter((location) => location?.isActive !== false);

  const exact = locations.filter((location) => normalize(location.name) === wantedStore);

  const partial = locations.filter((location) => {
    const locationName = normalize(location.name);
    return locationName.includes(wantedStore) || wantedStore.includes(locationName);
  });

  const matches = exact.length ? exact : partial;

  return matches
    .map((location) => String(location.legacyResourceId || gidToLegacyId(location.id)))
    .filter(Boolean);
}

function matchesRequestedStatus(order, status) {
  if (!status || status === 'all') return true;

  if (status === 'open') {
    return !['opgehaald'].includes(order.pickupStatus);
  }

  return order.pickupStatus === status;
}

export default async function handler(req, res) {
  setCors(res, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Methode niet toegestaan' });
  }

  const startedAt = Date.now();

  try {
    const store = String(req.query.store || '').trim();
    const status = String(req.query.status || 'nog_klaar_te_zetten').trim();
    const days = Math.min(Math.max(Number(req.query.days || 14), 1), 60);
    const refresh = String(req.query.refresh || '') === '1';
    const debug = String(req.query.debug || '') === '1';

    if (!store) {
      return res.status(400).json({
        success: false,
        error: 'Winkel ontbreekt'
      });
    }

    const cacheKey = JSON.stringify({
      store: normalize(store),
      status,
      days,
      debug
    });

    if (!refresh) {
      const cached = getCache(cacheKey);

      if (cached) {
        return res.status(200).json({
          ...cached,
          cached: true,
          cacheTtlSeconds: Math.round(CACHE_TTL_MS / 1000)
        });
      }
    }

    const wantedLocationIds = await getWantedLocationIds(store);

    if (!wantedLocationIds.length) {
      return res.status(200).json({
        success: true,
        store,
        wantedLocationIds: [],
        status,
        days,
        pagesScanned: 0,
        scanned: 0,
        count: 0,
        totalOpen: 0,
        durationMs: Date.now() - startedAt,
        cached: false,
        cacheTtlSeconds: Math.round(CACHE_TTL_MS / 1000),
        message: 'Geen Shopify locatie gevonden voor deze winkel.',
        orders: []
      });
    }

    const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const query = `created_at:>=${fromDate} status:open`;
    const pageSize = 50;
    const maxPages = Number(req.query.maxPages || 8);

    let after = null;
    let hasNextPage = true;
    let pagesScanned = 0;
    let scanned = 0;
    const results = [];
    const debugRows = [];

    while (hasNextPage && pagesScanned < maxPages) {
      const data = await shopifyGraphql(ORDERS_QUERY, {
        first: pageSize,
        after,
        query
      });

      const connection = data.orders;
      const edges = connection?.edges || [];

      pagesScanned += 1;
      scanned += edges.length;

      for (const edge of edges) {
        const order = edge.node;
        const fulfillmentOrders = (order.fulfillmentOrders?.edges || []).map((foEdge) => foEdge.node);

        const pickupFulfillmentOrders = fulfillmentOrders.filter(isPickupFulfillmentOrder);

        const pickupAtRequestedStore = pickupFulfillmentOrders.filter((fo) => {
          const locationId = fulfillmentOrderLocationId(fo);
          return wantedLocationIds.includes(locationId);
        });

        if (debug) {
          debugRows.push({
            order: order.name,
            fulfillmentStatus: order.displayFulfillmentStatus,
            tags: order.tags || [],
            fulfillmentOrders: fulfillmentOrders.map((fo) => ({
              status: fo.status,
              methodType: fo.deliveryMethod?.methodType || '',
              presentedName: fo.deliveryMethod?.presentedName || '',
              locationName: fulfillmentOrderLocationName(fo),
              locationId: fulfillmentOrderLocationId(fo),
              isPickup: isPickupFulfillmentOrder(fo),
              matchesLocation: wantedLocationIds.includes(fulfillmentOrderLocationId(fo))
            }))
          });
        }

        if (!pickupAtRequestedStore.length) continue;

        const mapped = orderToPickupResult(order, pickupAtRequestedStore, wantedLocationIds);

        if (!matchesRequestedStatus(mapped, status)) continue;

        results.push(mapped);
      }

      hasNextPage = !!connection?.pageInfo?.hasNextPage;
      after = connection?.pageInfo?.endCursor || null;
    }

    const totalOpen = results.filter((order) => order.pickupStatus !== 'opgehaald').length;

    const payload = {
      success: true,
      store,
      wantedLocationIds,
      status,
      days,
      pagesScanned,
      scanned,
      count: results.length,
      totalOpen,
      durationMs: Date.now() - startedAt,
      cached: false,
      cacheTtlSeconds: Math.round(CACHE_TTL_MS / 1000),
      orders: results
    };

    if (debug) {
      payload.debug = debugRows.slice(0, 50);
    }

    setCache(cacheKey, payload);

    return res.status(200).json(payload);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Ophaalorders konden niet worden opgehaald'
    });
  }
}
