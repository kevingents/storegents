export default async function handler(req, res) {
  const data = req.body;

  const type = data["contact[Formulier]"] || "";

  let email = "klantenservice@gents.nl";

  if (type.includes("Support")) email = "maarten@gents.nl";
  else if (type.includes("Verzendlabel")) email = "ying@gents.nl";
  else if (type.includes("Voorraad")) email = "rick@gents.nl";
  else if (type.includes("Retour")) email = "fosse@gents.nl";
  else if (type.includes("Administratie")) email = "administratie@gents.nl";
  else if (type.includes("Facilitair")) email = "h.bakx@gents.nl";

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: "GENTS <info@gents.nl>",
      to: email,
      subject: `Nieuwe aanvraag: ${type}`,
      html: `<pre>${JSON.stringify(data, null, 2)}</pre>`
    })
  });

  if (type.includes("Retour") && data["contact[email]"]) {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: "GENTS <info@gents.nl>",
        to: data["contact[email]"],
        subject: "Retour ontvangen",
        html: `<p>Je retour is ontvangen en wordt verwerkt.</p>`
      })
    });
  }

  res.status(200).json({ success: true });
}
