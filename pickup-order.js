export default async function handler(req, res) {
  res.status(200).json({
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
