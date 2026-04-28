export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  const data = req.body;
  const type = data["contact[Formulier]"] || "";

  let email = "klantenservice@gents.nl";

  if (type.includes("Support")) email = "maarten@gents.nl";
  else if (type.includes("Verzendlabel")) email = "ying@gents.nl";
  else if (type.includes("Voorraad")) email = "rick@gents.nl";
  else if (type.includes("Retour")) email = "fosse@gents.nl";
  else if (type.includes("Administratie")) email = "administratie@gents.nl";
  else if (type.includes("Facilitair")) email = "h.bakx@gents.nl";

  await sendMail(email, `Nieuwe aanvraag: ${type}`, JSON.stringify(data, null, 2));

  if (type.includes("Retour") && data["contact[email]"]) {
    await sendMail(
      data["contact[email]"],
      "Retour ontvangen",
      "We hebben je retour ontvangen en gaan deze verwerken."
    );
  }

  return res.status(200).json({ success
