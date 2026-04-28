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

async function shopifyGraphql(shop, token, query, variables) {
  const response = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query,
      variables
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }

  if (data.errors && data.errors.length) {
    throw new Error(data.errors.map((error) => error.message).join(', '));
  }

  return data.data;
}

function parseTags(tags) {
  if (Array.isArray(tags)) return tags;

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

  return Array.from(set);
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
    const numericOrderId = String(orderId).replace('gid://shopify/Order/', '');
    const orderGid = `gid://shopify/Order/${numericOrderId}`;

    const orderQuery = `
      query GetOrderForPickup($id: ID!) {
        order(id: $id) {
          id
          name
          tags
          fulfillmentOrders(first: 10) {
            nodes {
              id
              status
              deliveryMethod {
                methodType
              }
              lineItems(first: 50) {
                nodes {
                  id
                  remainingQuantity
                  totalQuantity
                  lineItem {
                    name
                    sku
                  }
                }
              }
            }
          }
        }
      }
    `;

    const orderData = await shopifyGraphql(shop, token, orderQuery, {
      id: orderGid
    });

    const order = orderData.order;

    if (!order) {
      return res.status(404).json({
        error: 'Order niet gevonden'
      });
    }

    const pickupFulfillmentOrders = (order.fulfillmentOrders?.nodes || []).filter((fulfillmentOrder) => {
      return fulfillmentOrder.deliveryMethod?.methodType === 'PICK_UP';
    });

    if (!pickupFulfillmentOrders.length) {
      return res.status(400).json({
        error: 'Geen pickup fulfillment order gevonden voor deze order'
      });
    }

    const lineItemsByFulfillmentOrder = pickupFulfillmentOrders
      .map((fulfillmentOrder) => {
        const fulfillmentOrderLineItems = (fulfillmentOrder.lineItems?.nodes || [])
          .filter((lineItem) => Number(lineItem.remainingQuantity || 0) > 0)
          .map((lineItem) => ({
            id: lineItem.id,
            quantity: Number(lineItem.remainingQuantity || lineItem.totalQuantity || 1)
          }));

        return {
          fulfillmentOrderId: fulfillmentOrder.id,
          fulfillmentOrderLineItems
        };
      })
      .filter((entry) => entry.fulfillmentOrderLineItems.length);

    if (!lineItemsByFulfillmentOrder.length) {
      return res.status(400).json({
        error: 'Geen openstaande pickup artikelen gevonden'
      });
    }

    const readyForPickupMutation = `
      mutation MarkReadyForPickup($input: FulfillmentOrderLineItemsPreparedForPickupInput!) {
        fulfillmentOrderLineItemsPreparedForPickup(input: $input) {
          userErrors {
            field
            message
          }
        }
      }
    `;

    const readyForPickupData = await shopifyGraphql(shop, token, readyForPickupMutation, {
      input: {
        lineItemsByFulfillmentOrder
      }
    });

    const userErrors =
      readyForPickupData.fulfillmentOrderLineItemsPreparedForPickup?.userErrors || [];

    if (userErrors.length) {
      return res.status(400).json({
        error: 'Shopify kon de order niet op klaar voor ophalen zetten',
        details: userErrors
      });
    }

    const updatedTags = mergeTags(order.tags, [
      'pickup_ready',
      'pickup_notified'
    ]);

    const updateTagsMutation = `
      mutation UpdateOrderTags($input: OrderInput!) {
        orderUpdate(input: $input) {
          order {
            id
            name
            tags
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const updateTagsData = await shopifyGraphql(shop, token, updateTagsMutation, {
      input: {
        id: orderGid,
        tags: updatedTags
      }
    });

    const tagErrors = updateTagsData.orderUpdate?.userErrors || [];

    if (tagErrors.length) {
      return res.status(200).json({
        success: true,
        warning: 'Klant is geïnformeerd, maar tags konden niet worden bijgewerkt',
        details: tagErrors
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Order is op klaar voor ophalen gezet. Shopify heeft de pickup-notificatie naar de klant verstuurd.',
      order: {
        id: numericOrderId,
        name: order.name,
        tags: updateTagsData.orderUpdate?.order?.tags || updatedTags
      }
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Klant informeren mislukt',
      message: error.message
    });
  }
}
