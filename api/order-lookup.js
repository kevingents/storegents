export default async function handler(req, res) {
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
