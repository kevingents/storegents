import {
  setCors,
  handleError,
  STORE_LOCATIONS,
  getRecentOrders,
  getFulfillmentOrders,
  getPickupStatus,
  getAssignedLocationIds,
  isPickupFulfillmentOrder,
  mapOrder,
  mapLineItems
} from './_shopify.js';

function getWantedLocationIds(store) {
  if (store === 'GENTS Brandstores') {
    return Object.values(STORE_LOCATIONS);
  }

  const id = STORE_LOCATIONS[store];
  return id ? [id] : [];
}

function orderHasPickupText(order) {
  const text = [
    order.tags,
    order.note,
    order.shipping_address?.address1,
    order.shipping_address?.address2,
    ...(Array.isArray(order.note_attributes)
      ? order.note_attributes.map((item) => `${item.name || ''} ${item.value || ''}`)
      : []),
    ...(Array.isArray(order.shipping_lines)
      ? order.shipping_lines.map((item) => `${item.title || ''} ${item.code || ''} ${item.source || ''}`)
      : [])
  ].join(' ').toLowerCase();

  return (
    text.includes('pickup') ||
    text.includes('pick up') ||
    text.includes('afhalen') ||
    text.includes('ophalen') ||
    text.includes('ophaal')
  );
}

function mapPickupOrder(order, fulfillmentOrders) {
  const pickup = getPickupStatus(order, fulfillmentOrders);
  const assignedLocationIds = getAssignedLocationIds(fulfillmentOrders);

  return mapOrder(order, {
    assignedLocationIds,
    pickupStatus: pickup.pickupStatus,
    pickupStatusLabel: pickup.pickupStatusLabel,
    items: mapLineItems(order)
  });
}

export default async function handler(req, res) {
  setCors(res, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Methode niet toegestaan' });
  }

  const store = String(req.query.store || '').trim();
  const statusFilter = String(req.query.status || 'all').trim();

  if (!store) {
    return res.status(400).json({ error: 'Winkel ontbreekt' });
  }

  const wantedLocationIds = getWantedLocationIds(store);

  if (!wantedLocationIds.length && store !== 'GENTS Brandstores') {
    return res.status(400).json({
      error: 'Onbekende Shopify locatie',
      store
    });
  }

  try {
    const recentOrders = await getRecentOrders(250);
    const mapped = [];

    for (const order of recentOrders) {
      const fulfillmentOrders = await getFulfillmentOrders(order.id);
      const assignedLocationIds = getAssignedLocationIds(fulfillmentOrders);

      const matchesLocation =
        store === 'GENTS Brandstores' ||
        assignedLocationIds.some((id) => wantedLocationIds.includes(String(id)));

      if (!matchesLocation) continue;

      const hasPickupFulfillment = fulfillmentOrders.some(isPickupFulfillmentOrder);

      if (!hasPickupFulfillment && !orderHasPickupText(order)) {
        continue;
      }

      const pickupOrder = mapPickupOrder(order, fulfillmentOrders);

      if (statusFilter && statusFilter !== 'all' && pickupOrder.pickupStatus !== statusFilter) {
        continue;
      }

      mapped.push(pickupOrder);
    }

    return res.status(200).json({
      store,
      locationIds: wantedLocationIds,
      status: statusFilter,
      count: mapped.length,
      orders: mapped
    });
  } catch (error) {
    return handleError(res, error, 'Ophaalorders konden niet worden geladen');
  }
}
