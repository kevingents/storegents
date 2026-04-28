const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL || "GENTS Winkelportaal <info@gents.nl>";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
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

function getRecipient(data) {
  const type = getField(data, "contact[Formulier]");
  const onderwerp = getField(data, "contact[Onderwerp]");

  if (type.includes("Verzendlabel")) return "ying@gents.nl";
  if (type.includes("Retour")) return "fosse@gents.nl";
  if (type.includes("Negatieve review")) return "klantenservice@gents.nl";
  if (type.includes("Tip")) return "klantenservice@gents.nl";

  if (type.includes("Support")) {
    if (
      onderwerp.includes("Facilitair") ||
      onderwerp.includes("Verlichting") ||
      onderwerp.includes("Verwarming") ||
      onderwerp.includes("Winkelinrichting") ||
      onderwerp.includes("Schoonmaak") ||
      onderwerp.includes("Beveiliging") ||
      onderwerp.includes("Schade") ||
      onderwerp.includes("Leverancier")
    ) {
      return "h.bakx@gents.nl";
    }

    return "maarten@gents.nl";
  }

  if (type.includes("Administratie")) return "administratie@gents.nl";

  return "klantenservice@gents.nl";
}

function getSubject(data) {
  const type = getField(data, "contact[Formulier]") || "Nieuwe aanvraag";
  const winkel =
    getField(data, "contact[Winkel]") ||
    getField(data, "contact[Winkelnaam]") ||
    "";
  const medewerker = getField(data, "contact[Medewerker]") || "";

  return [type, winkel, medewerker].filter(Boolean).join(" - ");
}

function buildHtml(data) {
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
          <td style="padding:10px 12px;border-bottom:1px solid #e6e9ed;color:#3a4a5a;width:220px;">
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
      <h2 style="font-weight:400;margin:0 0 16px;">Nieuwe aanvraag via winkelportaal</h2>
      <table style="border-collapse:collapse;width:100%;max-width:760px;border:1px solid #e6e9ed;">
        ${rows}
      </table>
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

    return res.status(200).json({
      success: true,
      message: "Aanvraag verzonden",
      to: recipient,
      resendId: internalMail.id || null
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
