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

const FULFILLMENT_CREATE_MUTATION = `
  mutation fulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
      }
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

    const openPickupFulfillmentOrders = fulfillmentOrders.filter((fulfillmentOrder) => {
      if (fulfillmentOrder.status === 'closed') return false;
      return isPickupFulfillmentOrder(fulfillmentOrder);
    });

    let fulfillmentResult = null;

    if (openPickupFulfillmentOrders.length) {
      const lineItemsByFulfillmentOrder = openPickupFulfillmentOrders.map((fulfillmentOrder) => ({
        fulfillmentOrderId: gid('FulfillmentOrder', fulfillmentOrder.id)
      }));

      const graphqlResult = await shopifyGraphql(FULFILLMENT_CREATE_MUTATION, {
        fulfillment: {
          lineItemsByFulfillmentOrder,
          notifyCustomer: false
        }
      });

      const result = graphqlResult.data?.fulfillmentCreate;
      const userErrors = result?.userErrors || [];

      if (userErrors.length) {
        return res.status(400).json({
          error: 'Shopify kon de order niet fulfilen / op afgehaald zetten',
          details: userErrors
        });
      }

      fulfillmentResult = result?.fulfillment || null;
    }

    await addOrderTags(order, ['pickup_opgehaald']);

    return res.status(200).json({
      success: true,
      message: 'Order is op afgehaald gezet',
      fulfillment: fulfillmentResult
    });
  } catch (error) {
    return handleError(res, error, 'Order kon niet op afgehaald worden gezet');
  }
}
