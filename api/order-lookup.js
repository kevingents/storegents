export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { orderNumber } = req.query;

  if (!orderNumber) {
    return res.status(400).json({ error: "Geen ordernummer" });
  }

  try {
    const response = await fetch(
      `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders.json?name=${orderNumber}`,
      {
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
          "Content-Type": "application/json",
        },
      }
    );

    const data = await response.json();

    if (!data.orders || data.orders.length === 0) {
      return res.status(404).json({ error: "Order niet gevonden" });
    }

    const order = data.orders[0];

    return res.status(200).json({
      order: {
        name: order.name,
        customer: order.customer?.first_name || "",
        customerEmail: order.email,
        financialStatus: order.financial_status,
        fulfillmentStatus: order.fulfillment_status,
        items: order.line_items.map(item => ({
          name: item.title,
          quantity: item.quantity
        }))
      }
    });

  } catch (error) {
    return res.status(500).json({ error: "Server error" });
  }
}
