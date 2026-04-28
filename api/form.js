const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL || "GENTS Winkelportaal <onboarding@resend.dev>";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getField(data, key) {
  return String(data[key] || "").trim();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function normalize(value) {
  return String(value || "").toLowerCase().trim();
}

function getRecipient(data) {
  const type = normalize(getField(data, "contact[Formulier]"));
  const onderwerp = normalize(getField(data, "contact[Onderwerp]"));
  const categorie = normalize(getField(data, "contact[Categorie]"));
  const reden = normalize(getField(data, "contact[Reden label]"));

  /*
    Vaste routes
    Pas de e-mailadressen hieronder aan als iemand anders eigenaar is.
  */

  // Verzendlabels
  if (
    type.includes("verzendlabel") ||
    type.includes("label aanvragen") ||
    reden.includes("uitwisseling") ||
    reden.includes("reparatie")
  ) {
    return "ying@gents.nl";
  }

  // Voorraad
  if (
    type.includes("voorraad") ||
    type.includes("voorraadcorrectie") ||
    onderwerp.includes("voorraad") ||
    categorie.includes("voorraad")
  ) {
    return "rick@gents.nl";
  }

  // Retouren via formulier
  if (
    type.includes("retour") ||
    type.includes("webshop retour")
  ) {
    return "fosse@gents.nl";
  }

  // Facilitair / onderhoud / winkelzaken
  if (
    type.includes("facilitair") ||
    onderwerp.includes("facilitair") ||
    onderwerp.includes("verlichting") ||
    onderwerp.includes("verwarming") ||
    onderwerp.includes("airco") ||
    onderwerp.includes("winkelinrichting") ||
    onderwerp.includes("schoonmaak") ||
    onderwerp.includes("beveiliging") ||
    onderwerp.includes("alarm") ||
    onderwerp.includes("schade") ||
    onderwerp.includes("leverancier") ||
    onderwerp.includes("onderhoud")
  ) {
    return "h.bakx@gents.nl";
  }

  // Support / systemen / internet / ERP
  if (
    type.includes("support") ||
    onderwerp.includes("internet") ||
    onderwerp.includes("wifi") ||
    onderwerp.includes("erp") ||
    onderwerp.includes("orderstatus") ||
    onderwerp.includes("kassa") ||
    onderwerp.includes("pin")
  ) {
    return "maarten@gents.nl";
  }

  // Administratie
  if (
    type.includes("administratie") ||
    onderwerp.includes("administratie") ||
    categorie.includes("administratie")
  ) {
    return "administratie@gents.nl";
  }

  // Negatieve reviews / klachten
  if (
    type.includes("negatieve review") ||
    type.includes("review") ||
    onderwerp.includes("klacht") ||
    categorie.includes("klantbeleving")
  ) {
    return "klantenservice@gents.nl";
  }

  // Tips & ideeën
  if (
    type.includes("tip") ||
    type.includes("idee") ||
    categorie.includes("winkelproces") ||
    categorie.includes("collectie") ||
    categorie.includes("product") ||
    categorie.includes("marketing")
  ) {
    return "klantenservice@gents.nl";
  }

  // Fallback
  return "klantenservice@gents.nl";
}

function getSubject(data) {
  const type = getField(data, "contact[Formulier]") || "Nieuwe aanvraag";
  const winkel =
    getField(data, "contact[Winkel]") ||
    getField(data, "contact[Winkelnaam]") ||
    "";
  const medewerker = getField(data, "contact[Medewerker]") || "";
  const bonnummer = getField(data, "contact[Bonnummer]") || "";
  const ordernummer =
    getField(data, "contact[Ordernummer webshop]") ||
    getField(data, "contact[Ordernummer of bonnummer]") ||
    "";

  return [type, winkel, medewerker, bonnummer || ordernummer]
    .filter(Boolean)
    .join(" - ");
}

function buildHtml(data) {
  const type = getField(data, "contact[Formulier]");
  const winkel =
    getField(data, "contact[Winkel]") ||
    getField(data, "contact[Winkelnaam]") ||
    "-";

  const rows = Object.entries(data)
    .filter(([key, value]) => {
      if (key === "contact[website]") return false;
      return String(value || "").trim() !== "";
    })
    .map(([key, value]) => {
      const cleanKey = key
        .replace("contact[", "")
        .replace("]", "");

      return `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #e6e9ed;color:#3a4a5a;width:240px;font-weight:600;">
            ${escapeHtml(cleanKey)}
          </td>
          <td style="padding:10px 12px;border-bottom:1px solid #e6e9ed;color:#0a1f33;">
            ${escapeHtml(value)}
          </td>
        </tr>
      `;
    })
    .join("");

  return `
    <div style="font-family:Arial,sans-serif;color:#0a1f33;line-height:1.5;">
      <h2 style="font-weight:400;margin:0 0 8px;">Nieuwe aanvraag via winkelportaal</h2>
      <p style="margin:0 0 18px;color:#3a4a5a;">
        <strong>Formulier:</strong> ${escapeHtml(type)}<br>
        <strong>Winkel:</strong> ${escapeHtml(winkel)}
      </p>

      <table style="border-collapse:collapse;width:100%;max-width:820px;border:1px solid #e6e9ed;">
        ${rows}
      </table>
    </div>
  `;
}

function buildCustomerReturnHtml(data) {
  const ordernummer = getField(data, "contact[Ordernummer webshop]");

  return `
    <div style="font-family:Arial,sans-serif;color:#0a1f33;line-height:1.6;">
      <h2 style="font-weight:400;margin:0 0 12px;">Retour ontvangen</h2>
      <p>We hebben je retour in de winkel ontvangen.</p>
      ${
        ordernummer
          ? `<p><strong>Ordernummer:</strong> ${escapeHtml(ordernummer)}</p>`
          : ""
      }
      <p>De retour wordt gecontroleerd en verder verwerkt.</p>
      <p>Met vriendelijke groet,<br>GENTS</p>
    </div>
  `;
}

async function sendResendEmail({ to, subject, html, replyTo }) {
  const payload = {
    from: RESEND_FROM_EMAIL,
    to: Array.isArray(to) ? to : [to],
    subject,
    html
  };

  if (replyTo && isValidEmail(replyTo)) {
    payload.reply_to = replyTo;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();

  let result;
  try {
    result = text ? JSON.parse(text) : {};
  } catch (error) {
    result = { raw: text };
  }

  if (!response.ok) {
    const error = new Error("Mail kon niet worden verstuurd");
    error.status = response.status;
    error.details = result;
    throw error;
  }

  return result;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Methode niet toegestaan"
    });
  }

  if (!RESEND_API_KEY) {
    return res.status(500).json({
      error: "RESEND_API_KEY ontbreekt in Vercel environment variables"
    });
  }

  const data = req.body || {};

  // Honeypot tegen spam
  if (data["contact[website]"]) {
    return res.status(200).json({
      success: true,
      ignored: true
    });
  }

  const type = getField(data, "contact[Formulier]");

  if (!type) {
    return res.status(400).json({
      error: "Formuliertype ontbreekt"
    });
  }

  const recipient = getRecipient(data);
  const subject = getSubject(data);
  const html = buildHtml(data);

  const replyTo =
    getField(data, "contact[email]") ||
    getField(data, "contact[E-mail]") ||
    getField(data, "contact[Klant e-mail]") ||
    "";

  try {
    const internalMail = await sendResendEmail({
      to: recipient,
      subject,
      html,
      replyTo
    });

    // Klantbevestiging alleen bij webshop retour via formulier
    const customerEmail =
      getField(data, "contact[email]") ||
      getField(data, "contact[Klant e-mail]");

    let customerMail = null;

    if (
      normalize(type).includes("retour") &&
      customerEmail &&
      isValidEmail(customerEmail)
    ) {
      customerMail = await sendResendEmail({
        to: customerEmail,
        subject: "Retour ontvangen",
        html: buildCustomerReturnHtml(data)
      });
    }

    return res.status(200).json({
      success: true,
      message: "Aanvraag verzonden",
      to: recipient,
      resendId: internalMail.id || null,
      customerMailId: customerMail?.id || null
    });
  } catch (error) {
    console.error("Resend fout:", error.details || error.message);

    return res.status(error.status || 500).json({
      error: "Mail kon niet worden verstuurd",
      details: error.details || error.message,
      from: RESEND_FROM_EMAIL,
      to: recipient
    });
  }
}
