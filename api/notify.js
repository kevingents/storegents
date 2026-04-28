import {
  setCors,
  handleError,
  getOrderById,
  getFulfillmentOrders,
  isPickupFulfillmentOrder,
  gid,
  shopifyGraphql,
  addOrderTags
} from './_shopify.js';

const PREPARED_FOR_PICKUP_MUTATION = `
  mutation fulfillmentOrderLineItemsPreparedForPickup($input: FulfillmentOrderLineItemsPreparedForPickupInput!) {
    fulfillmentOrderLineItemsPreparedForPickup(input: $input) {
      userErrors {
        field
        message
      }
    }
  }
`;

export default async function handler(req, res) {
  setCors(res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Methode niet toegestaan' });
  }

  const orderId = String(req.body?.orderId || '').trim();

  if (!orderId) {
    return res.status(400).json({ error: 'Order ID ontbreekt' });
  }

  try {
    const order = await getOrderById(orderId);
    const fulfillmentOrders = await getFulfillmentOrders(orderId);

    const pickupFulfillmentOrders = fulfillmentOrders.filter((fulfillmentOrder) => {
      if (fulfillmentOrder.status === 'closed') return false;
      return isPickupFulfillmentOrder(fulfillmentOrder);
    });

    if (!pickupFulfillmentOrders.length) {
      return res.status(400).json({
        error: 'Geen open pickup fulfillment order gevonden voor deze order',
        fulfillmentOrders
      });
    }

    const lineItemsByFulfillmentOrder = pickupFulfillmentOrders.map((fulfillmentOrder) => ({
      fulfillmentOrderId: gid('FulfillmentOrder', fulfillmentOrder.id)
    }));

    const graphqlResult = await shopifyGraphql(PREPARED_FOR_PICKUP_MUTATION, {
      input: {
        lineItemsByFulfillmentOrder
      }
    });

    const userErrors =
      graphqlResult.data?.fulfillmentOrderLineItemsPreparedForPickup?.userErrors || [];

    if (userErrors.length) {
      return res.status(400).json({
        error: 'Shopify kon de order niet op klaar voor afhalen zetten',
        details: userErrors
      });
    }

    await addOrderTags(order, ['pickup_ready']);

    return res.status(200).json({
      success: true,
      message: 'Klant is via Shopify geïnformeerd dat de order klaarstaat'
    });
  } catch (error) {
    return handleError(res, error, 'Klant kon niet geïnformeerd worden');
  }
}
