export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  return res.status(200).json({
    order: {
      name: req.query.order || "#TEST",
      customer: "Test klant",
      financialStatus: "PAID",
      fulfillmentStatus: "UNFULFILLED",
      tracking: "Nog geen tracking",
      items: [
        { name: "Test product", quantity: 1 }
      ]
    }
  });
}
