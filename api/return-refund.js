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

function parseItems(body) {
  const rawItems = body.items || body.selectedItems || body.refundItems || [];

  return rawItems
    .map((item) => ({
      lineItemId: item.lineItemId || item.id,
      quantity: Number(item.quantity || 1)
    }))
    .filter((item) => item.lineItemId && item.quantity > 0);
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
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  const body = req.body || {};

  const orderId = body.orderId || body.id;
  const employeeName = String(body.employeeName || body.medewerker || '').trim();
  const reason = String(body.reason || body.reden || '').trim();
  const confirm = body.confirm === true || body.confirm === 'true';
  const notifyCustomer = body.notifyCustomer !== false;
  const restockType = body.restockType || process.env.REFUND_RESTOCK_TYPE || 'no_restock';

  const items = parseItems(body);

  if (!orderId) {
    return res.status(400).json({
      error: 'Order ID ontbreekt'
    });
  }

  if (!employeeName) {
    return res.status(400).json({
      error: 'Naam medewerker is verplicht'
    });
  }

  if (!reason) {
    return res.status(400).json({
      error: 'Retourreden is verplicht'
    });
  }

  if (!items.length) {
    return res.status(400).json({
      error: 'Selecteer minimaal één product voor retour'
    });
  }

  if (!confirm) {
    return res.status(400).json({
      error: 'Bevestiging ontbreekt. De medewerker moet bevestigen dat de klant terugbetaald mag worden.'
    });
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

    if (order.financial_status === 'refunded') {
      return res.status(400).json({
        error: 'Deze order is al volledig terugbetaald'
      });
    }

    const orderLineItemsById = new Map(
      (order.line_items || []).map((lineItem) => [String(lineItem.id), lineItem])
    );

    const refundLineItems = [];

    for (const selectedItem of items) {
      const lineItem = orderLineItemsById.get(String(selectedItem.lineItemId));

      if (!lineItem) {
        return res.status(400).json({
          error: `Line item niet gevonden: ${selectedItem.lineItemId}`
        });
      }

      const maxQuantity =
        Number(lineItem.quantity || 0) - Number(lineItem.refunded_quantity || 0);

      if (selectedItem.quantity > maxQuantity && maxQuantity > 0) {
        return res.status(400).json({
          error: `Teveel retour voor ${lineItem.name}. Maximaal retour: ${maxQuantity}`
        });
      }

      const refundLineItem = {
        line_item_id: Number(lineItem.id),
        quantity: selectedItem.quantity,
        restock_type: restockType
      };

      if (body.locationId && restockType === 'return') {
        refundLineItem.location_id = Number(body.locationId);
      }

      refundLineItems.push(refundLineItem);
    }

    const calculatePayload = {
      refund: {
        shipping: {
          full_refund: false
        },
        refund_line_items: refundLineItems
      }
    };

    const { response: calculateResponse, data: calculateData } = await shopifyFetch(
      shop,
      token,
      `/orders/${orderId}/refunds/calculate.json`,
      {
        method: 'POST',
        body: JSON.stringify(calculatePayload)
      }
    );

    if (!calculateResponse.ok || !calculateData.refund) {
      return res.status(calculateResponse.status).json({
        error: 'Refund berekenen mislukt',
        details: calculateData
      });
    }

    const calculatedRefund = calculateData.refund;

    const transactions = (calculatedRefund.transactions || [])
      .filter((transaction) => Number(transaction.amount || 0) > 0)
      .map((transaction) => ({
        parent_id: transaction.parent_id,
        amount: transaction.amount,
        kind: 'refund',
        gateway: transaction.gateway
      }));

    if (!transactions.length) {
      return res.status(400).json({
        error: 'Shopify heeft geen refund transactie berekend. Controleer of de order betaald is en of de producten nog terugbetaald kunnen worden.',
        details: calculatedRefund
      });
    }

    const note = [
      `Retour via winkelportaal`,
      `Medewerker: ${employeeName}`,
      `Reden: ${reason}`,
      body.store ? `Winkel: ${body.store}` : '',
      body.note ? `Opmerking: ${body.note}` : ''
    ].filter(Boolean).join('\n');

    const createRefundPayload = {
      refund: {
        currency: calculatedRefund.currency || order.currency,
        notify: notifyCustomer,
        note,
        shipping: {
          full_refund: false
        },
        refund_line_items: refundLineItems,
        transactions
      }
    };

    const { response: refundResponse, data: refundData } = await shopifyFetch(
      shop,
      token,
      `/orders/${orderId}/refunds.json`,
      {
        method: 'POST',
        body: JSON.stringify(createRefundPayload)
      }
    );

    if (!refundResponse.ok || !refundData.refund) {
      return res.status(refundResponse.status).json({
        error: 'Terugbetaling mislukt',
        details: refundData
      });
    }

    const updatedTags = mergeTags(order.tags, [
      'winkelportaal_retour',
      'winkelportaal_refund'
    ]);

    await shopifyFetch(
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

    return res.status(200).json({
      success: true,
      message: 'Klant is terugbetaald via Shopify',
      refund: {
        id: refundData.refund.id,
        createdAt: refundData.refund.created_at,
        totalRefunded: refundData.refund.transactions?.reduce((sum, transaction) => {
          return sum + Number(transaction.amount || 0);
        }, 0)
      },
      order: {
        id: order.id,
        name: order.name
      }
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Retour / terugbetaling kon niet worden verwerkt',
      message: error.message
    });
  }
}
