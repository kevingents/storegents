export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { order, check } = req.query;

  if (!order) {
    return res.status(400).json({ error: 'Ordernummer ontbreekt' });
  }

  const shop = process.env.SHOPIFY_STORE_URL;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;

  if (!shop || !token) {
    return res.status(500).json({ error: 'Shopify configuratie ontbreekt' });
  }

  try {
    const searchUrl =
      `https://${shop}/admin/api/2024-10/orders.json` +
      `?status=any&name=${encodeURIComponent(order)}`;

    const orderResponse = await fetch(searchUrl, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      }
    });

    const orderData = await orderResponse.json();

    if (!orderResponse.ok) {
      return res.status(orderResponse.status).json({
        error: 'Shopify order lookup mislukt',
        details: orderData
      });
    }

    const shopifyOrder = orderData.orders && orderData.orders[0];

    if (!shopifyOrder) {
      return res.status(404).json({ error: 'Geen order gevonden' });
    }

    const customerEmail = shopifyOrder.email || '';
    const customerZip =
      shopifyOrder.shipping_address?.zip ||
      shopifyOrder.billing_address?.zip ||
      '';

    if (check) {
      const normalizedCheck = String(check).toLowerCase().replace(/\s/g, '');
      const normalizedEmail = String(customerEmail).toLowerCase().replace(/\s/g, '');
      const normalizedZip = String(customerZip).toLowerCase().replace(/\s/g, '');

      const matchesEmail = normalizedEmail && normalizedEmail === normalizedCheck;
      const matchesZip = normalizedZip && normalizedZip === normalizedCheck;

      if (!matchesEmail && !matchesZip) {
        return res.status(403).json({ error: 'Controle komt niet overeen' });
      }
    }

    const fulfillment = shopifyOrder.fulfillments && shopifyOrder.fulfillments[0];

    const locationName =
      fulfillment?.location_id
        ? `Locatie ID ${fulfillment.location_id}`
        : shopifyOrder.location_id
          ? `Locatie ID ${shopifyOrder.location_id}`
          : '-';

    const items = (shopifyOrder.line_items || []).map((item) => {
      const matchingFulfillmentLineItem = fulfillment?.line_items?.find(
        (fulfilledItem) => fulfilledItem.id === item.id
      );

      return {
        quantity: item.quantity,
        name: item.name,
        sku: item.sku,
        variant: item.variant_title,
        image: item.image?.src || item.product?.image?.src || '',
        location: locationName,
        fulfillmentStatus: matchingFulfillmentLineItem ? 'Verzonden' : 'Nog niet verzonden'
      };
    });

    const trackingNumber =
      fulfillment?.tracking_number ||
      fulfillment?.tracking_numbers?.[0] ||
      '';

    const trackingUrl =
      fulfillment?.tracking_url ||
      fulfillment?.tracking_urls?.[0] ||
      '';

    return res.status(200).json({
      order: {
        id: shopifyOrder.id,
        name: shopifyOrder.name,
        customer:
          `${shopifyOrder.customer?.first_name || ''} ${shopifyOrder.customer?.last_name || ''}`.trim() ||
          shopifyOrder.shipping_address?.name ||
          '-',
        customerEmail: customerEmail,
        financialStatus: shopifyOrder.financial_status || '-',
        fulfillmentStatus: shopifyOrder.fulfillment_status || 'Nog niet verzonden',
        location: locationName,
        warehouse: locationName,
        orderedAt: shopifyOrder.created_at,
        createdAt: shopifyOrder.created_at,
        shippedAt: fulfillment?.created_at || '',
        fulfilledAt: fulfillment?.created_at || '',
        tracking: trackingNumber,
        trackingUrl: trackingUrl,
        items: items
      }
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Order kon niet worden opgezocht',
      message: error.message
    });
  }
}
