export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  const { order, check } = req.query;

  if (!order) {
    return res.status(400).json({
      error: 'Ordernummer ontbreekt'
    });
  }

  let shop = process.env.SHOPIFY_STORE_URL;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!shop || !token) {
    return res.status(500).json({
      error: 'Shopify configuratie ontbreekt',
      missing: {
        SHOPIFY_STORE_URL: !shop,
        SHOPIFY_ACCESS_TOKEN: !token
      }
    });
  }

  shop = shop
    .replace('https://', '')
    .replace('http://', '')
    .replace(/\/$/, '');

  try {
    const searchUrl =
      `https://${shop}/admin/api/2024-10/orders.json` +
      `?status=any&name=${encodeURIComponent(order)}`;

    const orderResponse = await fetch(searchUrl, {
      method: 'GET',
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
      return res.status(404).json({
        error: 'Geen order gevonden'
      });
    }

    const customerEmail = shopifyOrder.email || '';
    const customerZip =
      shopifyOrder.shipping_address?.zip ||
      shopifyOrder.billing_address?.zip ||
      '';

    if (check && String(check).trim() !== '') {
      const normalizedCheck = String(check).toLowerCase().replace(/\s/g, '');
      const normalizedEmail = String(customerEmail).toLowerCase().replace(/\s/g, '');
      const normalizedZip = String(customerZip).toLowerCase().replace(/\s/g, '');

      const matchesEmail = normalizedEmail && normalizedEmail === normalizedCheck;
      const matchesZip = normalizedZip && normalizedZip === normalizedCheck;

      if (!matchesEmail && !matchesZip) {
        return res.status(403).json({
          error: 'Controle komt niet overeen'
        });
      }
    }

    const fulfillments = shopifyOrder.fulfillments || [];
    const firstFulfillment = fulfillments[0] || null;

    const trackingNumber =
      firstFulfillment?.tracking_number ||
      firstFulfillment?.tracking_numbers?.[0] ||
      '';

    const trackingUrl =
      firstFulfillment?.tracking_url ||
      firstFulfillment?.tracking_urls?.[0] ||
      '';

    const locationId =
      firstFulfillment?.location_id ||
      shopifyOrder.location_id ||
      '';

    let locationName = locationId ? `Locatie ID ${locationId}` : '-';

    if (locationId) {
      try {
        const locationResponse = await fetch(
          `https://${shop}/admin/api/2024-10/locations/${locationId}.json`,
          {
            method: 'GET',
            headers: {
              'X-Shopify-Access-Token': token,
              'Content-Type': 'application/json'
            }
          }
        );

        const locationData = await locationResponse.json();

        if (locationResponse.ok && locationData.location?.name) {
          locationName = locationData.location.name;
        }
      } catch (locationError) {
        locationName = `Locatie ID ${locationId}`;
      }
    }

    async function getProductImage(productId, variantId) {
      if (!productId) return '';

      try {
        const productResponse = await fetch(
          `https://${shop}/admin/api/2024-10/products/${productId}.json`,
          {
            method: 'GET',
            headers: {
              'X-Shopify-Access-Token': token,
              'Content-Type': 'application/json'
            }
          }
        );

        const productData = await productResponse.json();

        if (!productResponse.ok || !productData.product) {
          return '';
        }

        const product = productData.product;

        if (variantId && product.images && product.images.length) {
          const variantImage = product.images.find((image) => {
            return image.variant_ids && image.variant_ids.includes(variantId);
          });

          if (variantImage?.src) {
            return variantImage.src;
          }
        }

        return product.image?.src || '';
      } catch (error) {
        return '';
      }
    }

    const items = await Promise.all(
      (shopifyOrder.line_items || []).map(async (item) => {
        const matchingFulfillment = fulfillments.find((fulfillment) => {
          return (fulfillment.line_items || []).some((fulfilledItem) => {
            return fulfilledItem.id === item.id;
          });
        });

        const itemLocationId =
          matchingFulfillment?.location_id ||
          locationId ||
          '';

        let itemLocationName = locationName;

        if (itemLocationId && itemLocationId !== locationId) {
          try {
            const itemLocationResponse = await fetch(
              `https://${shop}/admin/api/2024-10/locations/${itemLocationId}.json`,
              {
                method: 'GET',
                headers: {
                  'X-Shopify-Access-Token': token,
                  'Content-Type': 'application/json'
                }
              }
            );

            const itemLocationData = await itemLocationResponse.json();

            if (itemLocationResponse.ok && itemLocationData.location?.name) {
              itemLocationName = itemLocationData.location.name;
            }
          } catch (error) {
            itemLocationName = `Locatie ID ${itemLocationId}`;
          }
        }

        const image = await getProductImage(item.product_id, item.variant_id);

        return {
          quantity: item.quantity,
          name: item.name,
          sku: item.sku || '',
          variant: item.variant_title || '',
          image: image,
          location: itemLocationName,
          fulfillmentStatus: matchingFulfillment ? 'Verzonden' : 'Nog niet verzonden'
        };
      })
    );

    const customerName =
      `${shopifyOrder.customer?.first_name || ''} ${shopifyOrder.customer?.last_name || ''}`.trim() ||
      shopifyOrder.shipping_address?.name ||
      shopifyOrder.billing_address?.name ||
      '-';

    return res.status(200).json({
      order: {
        id: shopifyOrder.id,
        name: shopifyOrder.name,
        customer: customerName,
        customerEmail: customerEmail,
        financialStatus: shopifyOrder.financial_status || '-',
        fulfillmentStatus: shopifyOrder.fulfillment_status || 'Nog niet verzonden',
        location: locationName,
        warehouse: locationName,
        orderedAt: shopifyOrder.created_at,
        createdAt: shopifyOrder.created_at,
        shippedAt: firstFulfillment?.created_at || '',
        fulfilledAt: firstFulfillment?.created_at || '',
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
