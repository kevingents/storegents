export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const rawOrder = req.query.order || req.query.orderNumber;

  if (!rawOrder) {
    return res.status(400).json({ error: "Geen ordernummer meegegeven" });
  }

  const orderNumber = rawOrder.startsWith("#") ? rawOrder : `#${rawOrder}`;

  const query = `
    query {
      orders(first: 1, query: "name:${orderNumber}") {
        edges {
          node {
            name
            email
            displayFinancialStatus
            displayFulfillmentStatus
            customer {
              firstName
              lastName
              email
            }
            shippingAddress {
              zip
            }
            lineItems(first: 20) {
              edges {
                node {
                  title
                  quantity
                  sku
                }
              }
            }
            fulfillments {
              trackingInfo {
                number
                url
              }
            }
          }
        }
      }
    }
  `;

  const shopifyRes = await fetch(
    `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-04/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query })
    }
  );

  const json = await shopifyRes.json();
  const edge = json?.data?.orders?.edges?.[0];

  if (!edge) {
    return res.status(404).json({ error: "Order niet gevonden", searched: orderNumber });
  }

  const order = edge.node;

  return res.status(200).json({
    order: {
      name: order.name,
      customer: `${order.customer?.firstName || ""} ${order.customer?.lastName || ""}`.trim(),
      customerEmail: order.email || order.customer?.email || "",
      financialStatus: order.displayFinancialStatus,
      fulfillmentStatus: order.displayFulfillmentStatus,
      tracking: order.fulfillments?.[0]?.trackingInfo?.[0]?.number || "Nog geen tracking",
      trackingUrl: order.fulfillments?.[0]?.trackingInfo?.[0]?.url || "",
      items: order.lineItems.edges.map(item => ({
        name: item.node.title,
        quantity: item.node.quantity,
        sku: item.node.sku
      }))
    }
  });
}
