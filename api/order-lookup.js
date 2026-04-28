export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  return res.status(200).json({
    orders: [
      {
        id: "1001",
        name: "#1001",
        email: "test@gents.nl",
        customer: "Test klant",
        status: "Klaar"
      }
    ]
  });
}
