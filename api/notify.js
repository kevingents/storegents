export default async function handler(req, res) {
  const { email, orderId } = req.body;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: "GENTS <info@gents.nl>",
      to: email,
      subject: "Je bestelling ligt klaar",
      html: `<p>Order ${orderId} ligt klaar om op te halen.</p>`
    })
  });

  res.status(200).json({ success: true });
}
