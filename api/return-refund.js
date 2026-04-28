const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
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

function readableShopifyError(data) {
  if (!data) return "Onbekende Shopify fout";

  if (typeof data === "string") return data;

  if (data.errors) {
    if (typeof data.errors === "string") return data.errors;
    return JSON.stringify(data.errors);
  }

  if (data.error) {
    if (typeof data.error === "string") return data.error;
    return JSON.stringify(data.error);
  }

  if (data.message) return data.message;

  return JSON.stringify(data);
}

async function shopifyRequest(path, options = {}, attempt = 0) {
  const response = await fetch(shopifyUrl(path), {
    ...options,
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      "Content-Type": "application/json",
      ...(options.headers || {})
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
    return shopifyRequest(path, options, attempt + 1);
  }

  if (!response.ok) {
    const error = new Error(readableShopifyError(data));
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

async function getOrderById(orderId) {
  const data = await shopifyRequest(`/orders/${orderId}.json?status=any`, {
    method: "GET"
  });

  return data.order;
}

async function addOrderTag(order, tagToAdd) {
  const existingTags = String(order.tags || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  const tags = Array.from(new Set([...existingTags, tagToAdd]));

  return shopifyRequest(`/orders/${order.id}.json`, {
    method: "PUT",
    body: JSON.stringify({
      order: {
        id: order.id,
        tags: tags.join(", ")
      }
    })
  });
}

function normalizeBody(req) {
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch (error) {
      return {};
    }
  }

  return req.body || {};
}

function normalizeSelectedItems(items) {
  if (!Array.isArray(items)) return [];

  return items
    .map((item) => ({
      lineItemId: String(item.lineItemId || item.id || "").trim(),
      quantity: Number(item.quantity || 0)
    }))
    .filter((item) => item.lineItemId && item.quantity > 0);
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Methode niet toegestaan"
    });
  }

  if (!SHOPIFY_ACCESS_TOKEN || !SHOPIFY_STORE_URL) {
    return res.status(500).json({
      error: "Shopify configuratie ontbreekt",
      details: "Controleer SHOPIFY_ACCESS_TOKEN en SHOPIFY_STORE_URL in Vercel."
    });
  }

  const body = normalizeBody(req);

  const orderId = String(body.orderId || body.id || "").trim();
  const employeeName = String(body.employeeName || body.medewerker || "").trim();
  const reason = String(body.reason || body.reden || "").trim();
  const note = String(body.note || "").trim();
  const store = String(body.store || "").trim();

  const confirmed =
    body.confirm === true ||
    body.confirmed === true ||
    body.confirmation === true;

  const selectedItems = normalizeSelectedItems(
    body.items || body.selectedItems || body.refundItems
  );

  if (!confirmed) {
    return res.status(400).json({
      error: "Bevestiging ontbreekt. De medewerker moet bevestigen dat de klant terugbetaald mag worden."
    });
  }

  if (!orderId) {
    return res.status(400).json({
      error: "Order ID ontbreekt"
    });
  }

  if (!employeeName) {
    return res.status(400).json({
      error: "Naam medewerker ontbreekt"
    });
  }

  if (!reason) {
    return res.status(400).json({
      error: "Retourreden ontbreekt"
    });
  }

  if (!selectedItems.length) {
    return res.status(400).json({
      error: "Selecteer minimaal één product"
    });
  }

  try {
    const order = await getOrderById(orderId);

    if (!order) {
      return res.status(404).json({
        error: "Order niet gevonden"
      });
    }

    const orderLineItems = order.line_items || [];

    const refundLineItems = selectedItems
      .map((selectedItem) => {
        const orderLineItem = orderLineItems.find((lineItem) => {
          return String(lineItem.id) === String(selectedItem.lineItemId);
        });

        if (!orderLineItem) return null;

        const maxQuantity = Number(orderLineItem.quantity || 1);
        const quantity = Math.min(Number(selectedItem.quantity || 1), maxQuantity);

        return {
          line_item_id: Number(selectedItem.lineItemId),
          quantity,
          restock_type: "no_restock"
        };
      })
      .filter(Boolean);

    if (!refundLineItems.length) {
      return res.status(400).json({
        error: "Geen geldige producten gevonden voor deze order"
      });
    }

    const calculatePayload = {
      refund: {
        currency: order.currency,
        refund_line_items: refundLineItems
      }
    };

    const calculated = await shopifyRequest(`/orders/${orderId}/refunds/calculate.json`, {
      method: "POST",
      body: JSON.stringify(calculatePayload)
    });

    const calculatedRefund = calculated.refund || {};

    const transactions = (calculatedRefund.transactions || [])
      .filter((transaction) => Number(transaction.amount || 0) > 0)
      .map((transaction) => ({
        parent_id: transaction.parent_id,
        amount: transaction.amount,
        kind: "refund",
        gateway: transaction.gateway
      }));

    if (!transactions.length) {
      return res.status(400).json({
        error: "Geen terugbetaalbare transactie gevonden. Deze order is mogelijk al terugbetaald of heeft geen betaalbare transactie meer."
      });
    }

    const refundPayload = {
      refund: {
        currency: order.currency,
        notify: true,
        note:
          `Retour verwerkt via winkelportaal door ${employeeName}. ` +
          `Winkel: ${store || "-"}. ` +
          `Reden: ${reason}.` +
          `${note ? ` Opmerking: ${note}` : ""}`,
        refund_line_items: refundLineItems,
        transactions
      }
    };

    const created = await shopifyRequest(`/orders/${orderId}/refunds.json`, {
      method: "POST",
      body: JSON.stringify(refundPayload)
    });

    try {
      await addOrderTag(order, "winkelportaal_retour");
    } catch (tagError) {
      console.error("Tag toevoegen mislukt:", tagError);
    }

    return res.status(200).json({
      success: true,
      message: "Terugbetaling verwerkt via Shopify",
      refund: created.refund
    });
  } catch (error) {
    console.error("Return refund error:", {
      message: error.message,
      status: error.status,
      data: error.data
    });

    return res.status(error.status || 500).json({
      error: error.message || "Terugbetaling kon niet worden verwerkt",
      details: error.data || null
    });
  }
}
