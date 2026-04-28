import {
  setCors,
  handleError,
  getOrdersByName,
  getRecentOrders,
  orderMatchesQuery,
  mapOrder,
  getProductImage,
  mapLineItems
} from './_shopify.js';

async function withProductImages(order) {
  const productIds = Array.from(new Set((order.line_items || []).map((item) => item.product_id).filter(Boolean)));
  const imageByProductId = {};

  await Promise.all(
    productIds.map(async (productId) => {
      imageByProductId[productId] = await getProductImage(productId);
    })
  );

  return mapOrder(order, {
    items: mapLineItems(order, imageByProductId)
  });
}

function mapOrderSummary(order) {
  const mapped = mapOrder(order);

  return {
    id: mapped.id,
    name: mapped.name,
    customer: mapped.customer,
    customerEmail: mapped.customerEmail,
    customerZip: mapped.customerZip,
    orderedAt: mapped.orderedAt,
    createdAt: mapped.createdAt,
    financialStatus: mapped.financialStatus,
    fulfillmentStatus: mapped.fulfillmentStatus,
    totalPrice: mapped.totalPrice,
    currency: mapped.currency
  };
}

export default async function handler(req, res) {
  setCors(res, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Methode niet toegestaan' });
  }

  const orderParam = String(req.query.order || '').trim();
  const queryParam = String(req.query.query || req.query.check || '').trim();

  if (!orderParam && !queryParam) {
    return res.status(400).json({
      error: 'Vul een ordernummer, e-mail of postcode in'
    });
  }

  try {
    if (orderParam) {
      const cleanOrder = orderParam.replace('#', '');
      const orders = await getOrdersByName(cleanOrder);

      if (!orders.length) {
        return res.status(404).json({
          error: 'Geen order gevonden',
          searchedFor: orderParam
        });
      }

      const order = await withProductImages(orders[0]);

      if (queryParam) {
        const matchesCheck = orderMatchesQuery(orders[0], queryParam);

        if (!matchesCheck) {
          return res.status(404).json({
            error: 'Order gevonden, maar klantcontrole klopt niet',
            searchedFor: queryParam
          });
        }
      }

      return res.status(200).json({ order });
    }

    const recentOrders = await getRecentOrders(250);
    const matches = recentOrders.filter((order) => orderMatchesQuery(order, queryParam));

    if (!matches.length) {
      return res.status(404).json({
        error: 'Geen order gevonden',
        searchedFor: queryParam
      });
    }

    if (matches.length === 1) {
      const order = await withProductImages(matches[0]);
      return res.status(200).json({ order });
    }

    return res.status(200).json({
      count: matches.length,
      orders: matches.map(mapOrderSummary)
    });
  } catch (error) {
    return handleError(res, error, 'Order kon niet worden opgezocht');
  }
}
