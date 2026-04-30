const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";

const STORE_LOCATIONS = {
  "GENTS Antwerpen": "110837039477",
  "GENTS Den Bosch": "110659666293",
  "GENTS Zwolle": "107189305717",
  "GENTS Magazijn": "105594290549",
  "GENTS Rotterdam": "101068144957",
  "GENTS Utrecht": "99265446205",
  "GENTS Showroom": "97707753789",
  "GENTS Zoetermeer": "97250378045",
  "GENTS Tilburg": "97250345277",
  "GENTS Nijmegen": "97250312509",
  "GENTS Amsterdam": "97250279741",
  "GENTS Maastricht": "97250246973",
  "GENTS Leiden": "97250214205",
  "GENTS Hilversum": "97250181437",
  "GENTS Groningen": "97250148669",
  "GENTS Delft": "97250115901",
  "GENTS Enschede": "97250083133",
  "GENTS Breda": "97250050365",
  "GENTS Arnhem": "97250017597",
  "GENTS Amersfoort": "97249984829",
  "GENTS Almere": "97249919293"
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const memoryCache = globalThis.__GENTS_PICKUP_CACHE__ || new Map();
globalThis.__GENTS_PICKUP_CACHE__ = memoryCache;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanShopUrl(url) {
  return String(url || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

function shopifyUrl(path) {
  const shop = cleanShopUrl(SHOPIFY_STORE_URL);
  return `https://${shop}/admin/api/${SHOPIFY_API_VERSION}${path}`;
}

function getDateMinIso(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

function getNextPageUrl(linkHeader) {
  if (!linkHeader) return null;

  const links = linkHeader.split(",");

  for (const link of links) {
    if (link.includes('rel="next"')) {
      const match = link.match(/<([^>]+)>/);
      return match ? match[1] : null;
    }
  }

  return null;
}

async function shopifyGetUrl(url, attempt = 0) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      "Content-Type": "application/json"
    }
  });

  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    data = { raw: text };
  }

  const rateLimited =
    response.status === 429 ||
    String(data.errors || data.error || data.raw || "")
      .toLowerCase()
      .includes("exceeded 20 calls per second");

  if (rateLimited && attempt < 5) {
    const retryAfter = Number(response.headers.get("retry-after") || 0);
    const delay = retryAfter ? retryAfter * 1000 : 1200 + attempt * 800;

    await sleep(delay);
    return shopifyGetUrl(url, attempt + 1);
  }

  if (!response.ok) {
    const err = new Error("Shopify API fout");
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return {
    data,
    nextPageUrl: getNextPageUrl(response.headers.get("link"))
  };
}

async function shopifyGet(path) {
  return shopifyGetUrl(shopifyUrl(path));
}

async function getOrdersFromPeriod(days) {
  const createdAtMin = encodeURIComponent(getDateMinIso(days));

  let nextUrl = shopifyUrl(
    `/orders.json?status=any&limit=250&order=created_at desc&created_at_min=${createdAtMin}&fields=id,name,email,customer,created_at,financial_status,fulfillment_status,tags,note,note_attributes,shipping_lines,shipping_address,line_items,fulfillments`
  );

  const allOrders = [];
  let pageCount = 0;

  while (nextUrl && pageCount < 8) {
    const { data, nextPageUrl } = await shopifyGetUrl(nextUrl);
    allOrders.push(...(data.orders || []));

    nextUrl = nextPageUrl;
    pageCount += 1;
  }

  return {
    orders: allOrders,
    pageCount
  };
}

async function getFulfillmentOrders(orderId) {
  try {
    const { data } = await shopifyGet(`/orders/${orderId}/fulfillment_orders.json`);
    return data.fulfillment_orders || [];
  } catch (error) {
    return [];
  }
}

async function mapLimit(items, limit, mapper) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker()
  );

  await Promise.all(workers);
  return results;
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function getAssignedLocationIds(fulfillmentOrders) {
  return (fulfillmentOrders || [])
    .map((fo) => {
      return (
        fo.assigned_location_id ||
        fo.assigned_location?.location_id ||
        fo.assigned_location?.id
      );
    })
    .filter(Boolean)
    .map(String);
}

function isPickupFulfillmentOrder(fo) {
  const text = [
    fo.delivery_method?.method_type,
    fo.delivery_method?.method_name,
    fo.delivery_method?.presented_name,
    fo.delivery_method?.service_code,
    fo.status,
    fo.request_status
  ]
    .join(" ")
    .toLowerCase();

  return (
    text.includes("pickup") ||
    text.includes("pick up") ||
    text.includes("local") ||
    text.includes("afhalen") ||
    text.includes("ophalen") ||
    text.includes("ophaal")
  );
}

function orderHasPickupText(order) {
  const noteAttributes = Array.isArray(order.note_attributes)
    ? order.note_attributes.map((item) => `${item.name || ""} ${item.value || ""}`)
    : [];

  const shippingLines = Array.isArray(order.shipping_lines)
    ? order.shipping_lines.map((item) => `${item.title || ""} ${item.code || ""} ${item.source || ""}`)
    : [];

  const text = [
    order.tags,
    order.note,
    order.shipping_address?.address1,
    order.shipping_address?.address2,
    ...noteAttributes,
    ...shippingLines
  ]
    .join(" ")
    .toLowerCase();

  return (
    text.includes("pickup") ||
    text.includes("pick up") ||
    text.includes("afhalen") ||
    text.includes("ophalen") ||
    text.includes("ophaal") ||
    text.includes("pickup in store")
  );
}

function getPickupStatus(order, fulfillmentOrders) {
  const tags = normalize(order.tags);

  if (
    tags.includes("pickup_opgehaald") ||
    tags.includes("pickup_picked_up") ||
    tags.includes("opgehaald")
  ) {
    return {
      pickupStatus: "opgehaald",
      pickupStatusLabel: "Opgehaald"
    };
  }

  if (
    tags.includes("pickup_ready") ||
    tags.includes("pickup_notified") ||
    tags.includes("klaar_voor_afhalen") ||
    tags.includes("klaar voor afhalen") ||
    tags.includes("ready for pickup")
  ) {
    return {
      pickupStatus: "niet_opgehaald",
      pickupStatusLabel: "Klant geïnformeerd"
    };
  }

  const fulfillmentText = (fulfillmentOrders || [])
    .map((fo) => `${fo.status || ""} ${fo.request_status || ""}`)
    .join(" ")
    .toLowerCase();

  if (fulfillmentText.includes("closed") || order.fulfillment_status === "fulfilled") {
    return {
      pickupStatus: "opgehaald",
      pickupStatusLabel: "Opgehaald"
    };
  }

  return {
    pickupStatus: "nog_klaar_te_zetten",
    pickupStatusLabel: "Nieuwe ophaalorder"
  };
}

function mapCustomer(order) {
  const customerName = order.customer
    ? `${order.customer.first_name || ""} ${order.customer.last_name || ""}`.trim()
    : "";

  return {
    customer: customerName || order.email || "-",
    email: order.email || order.customer?.email || ""
  };
}

function mapOrder(order, fulfillmentOrders) {
  const customer = mapCustomer(order);
  const pickup = getPickupStatus(order, fulfillmentOrders);
  const assignedLocationIds = getAssignedLocationIds(fulfillmentOrders);

  return {
    id: order.id,
    orderId: order.id,
    name: order.name,
    orderNumber: String(order.name || "").replace("#", ""),
    customer: customer.customer,
    email: customer.email,
    createdAt: order.created_at,
    financialStatus: order.financial_status,
    fulfillmentStatus: order.fulfillment_status || "open",
    assignedLocationIds,
    pickupStatus: pickup.pickupStatus,
    pickupStatusLabel: pickup.pickupStatusLabel,
    tags: order.tags || "",
    isPickup: true,
    items: (order.line_items || []).map((item) => ({
      id: item.id,
      lineItemId: item.id,
      name: item.name || item.title,
      sku: item.sku || "",
      variant: item.variant_title || "",
      quantity: item.quantity
    }))
  };
}

function getCacheKey({ store, statusFilter, days, strictPickupOnly, debug }) {
  return JSON.stringify({
    store,
    statusFilter,
    days,
    strictPickupOnly,
    debug
  });
}

function getCached(key) {
  const cached = memoryCache.get(key);

  if (!cached) return null;

  if (Date.now() - cached.createdAt > CACHE_TTL_MS) {
    memoryCache.delete(key);
    return null;
  }

  return {
    ...cached.data,
    cached: true,
    cacheAgeSeconds: Math.round((Date.now() - cached.createdAt) / 1000)
  };
}

function setCached(key, data) {
  memoryCache.set(key, {
    createdAt: Date.now(),
    data
  });
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      error: "Methode niet toegestaan"
    });
  }

  if (!SHOPIFY_ACCESS_TOKEN || !SHOPIFY_STORE_URL) {
    return res.status(500).json({
      success: false,
      error: "Shopify configuratie ontbreekt",
      expectedEnv: ["SHOPIFY_ACCESS_TOKEN", "SHOPIFY_STORE_URL"]
    });
  }

  const store = String(req.query.store || "").trim();

  const statusFilter = String(
    req.query.status || "nog_klaar_te_zetten"
  ).trim();

  const debug = String(req.query.debug || "") === "1";
  const strictPickupOnly = String(req.query.strictPickupOnly || "") === "1";
  const days = Math.min(Math.max(Number(req.query.days || 14), 1), 60);
  const forceRefresh = String(req.query.refresh || "") === "1";

  if (!store) {
    return res.status(400).json({
      success: false,
      error: "Winkel ontbreekt"
    });
  }

  const wantedLocationId = STORE_LOCATIONS[store];

  if (!wantedLocationId && store !== "GENTS Brandstores") {
    return res.status(400).json({
      success: false,
      error: "Onbekende Shopify locatie",
      store
    });
  }

  const cacheKey = getCacheKey({
    store,
    statusFilter,
    days,
    strictPickupOnly,
    debug
  });

  if (!forceRefresh) {
    const cached = getCached(cacheKey);
    if (cached) {
      return res.status(200).json(cached);
    }
  }

  try {
    const startedAt = Date.now();

    const { orders, pageCount } = await getOrdersFromPeriod(days);

    const enrichedOrders = await mapLimit(orders, 2, async (order) => {
      const fulfillmentOrders = await getFulfillmentOrders(order.id);

      return {
        order,
        fulfillmentOrders
      };
    });

    const results = [];
    const debugRows = [];

    for (const item of enrichedOrders) {
      const order = item.order;
      const fulfillmentOrders = item.fulfillmentOrders;
      const assignedLocationIds = getAssignedLocationIds(fulfillmentOrders);

      const matchesLocation =
        store === "GENTS Brandstores" ||
        assignedLocationIds.includes(String(wantedLocationId));

      const pickupByFulfillmentOrder = fulfillmentOrders.some(isPickupFulfillmentOrder);
      const pickupByText = orderHasPickupText(order);
      const isPickup = pickupByFulfillmentOrder || pickupByText;

      if (debug) {
        debugRows.push({
          order: order.name,
          orderId: order.id,
          createdAt: order.created_at,
          assignedLocationIds,
          wantedLocationId,
          matchesLocation,
          pickupByFulfillmentOrder,
          pickupByText,
          fulfillmentStatus: order.fulfillment_status,
          tags: order.tags,
          fulfillmentOrders: fulfillmentOrders.map((fo) => ({
            id: fo.id,
            status: fo.status,
            request_status: fo.request_status,
            assigned_location_id: fo.assigned_location_id,
            delivery_method: fo.delivery_method
          }))
        });
      }

      if (!matchesLocation) continue;
      if (strictPickupOnly && !isPickup) continue;

      const mapped = mapOrder(order, fulfillmentOrders);

      if (statusFilter !== "all" && mapped.pickupStatus !== statusFilter) {
        continue;
      }

      results.push(mapped);
    }

    const data = {
      success: true,
      store,
      wantedLocationId: wantedLocationId || null,
      status: statusFilter,
      range: `last_${days}_days`,
      days,
      pagesScanned: pageCount,
      scanned: orders.length,
      count: results.length,
      totalOpen: results.length,
      cached: false,
      durationMs: Date.now() - startedAt,
      orders: results,
      debug: debug ? debugRows : undefined
    };

    setCached(cacheKey, data);

    return res.status(200).json(data);
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: "Ophaalorders konden niet worden geladen",
      details: error.message,
      shopify: error.data || null
    });
  }
}
