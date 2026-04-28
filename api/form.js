export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Methode niet toegestaan"
    });
  }

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({
      error: "Resend configuratie ontbreekt"
    });
  }

  const data = req.body || {};

  if (data["contact[website]"]) {
    return res.status(200).json({
      success: true
    });
  }

  const type = data["contact[Formulier]"] || "";

  let email = "klantenservice@gents.nl";

  if (type.includes("Support")) email = "maarten@gents.nl";
  else if (type.includes("Verzendlabel")) email = "ying@gents.nl";
  else if (type.includes("Voorraad")) email = "rick@gents.nl";
  else if (type.includes("Retour")) email = "fosse@gents.nl";
  else if (type.includes("Administratie")) email = "administratie@gents.nl";
  else if (type.includes("Facilitair")) email = "h.bakx@gents.nl";
  else if (type.includes("Negatieve review")) email = "klantenservice@gents.nl";
  else if (type.includes("Tip of idee")) email = "klantenservice@gents.nl";

  function formatFieldName(key) {
    return String(key)
      .replace("contact[", "")
      .replace("]", "");
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function buildHtmlTable(payload) {
    const rows = Object.entries(payload)
      .filter(([key]) => key !== "contact[website]")
      .map(([key, value]) => {
        return `
          <tr>
            <td style="padding:10px 12px;border-bottom:1px solid #e6e9ed;font-weight:600;width:220px;">
              ${escapeHtml(formatFieldName(key))}
            </td>
            <td style="padding:10px 12px;border-bottom:1px solid #e6e9ed;">
              ${escapeHtml(value)}
            </td>
          </tr>
        `;
      })
      .join("");

    return `
      <div style="font-family:Arial,sans-serif;color:#0a1f33;">
        <h2 style="margin:0 0 12px;">Nieuwe aanvraag via winkelportaal</h2>
        <p style="margin:0 0 18px;color:#3a4a5a;">
          Type formulier: <strong>${escapeHtml(type || "Onbekend")}</strong>
        </p>

        <table style="border-collapse:collapse;width:100%;border:1px solid #e6e9ed;">
          ${rows}
        </table>

        <p style="margin-top:20px;color:#3a4a5a;font-size:13px;">
          Deze aanvraag is automatisch verstuurd vanuit het GENTS winkelportaal.
        </p>
      </div>
    `;
  }

  async function sendMail({ to, subject, html }) {
    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: "GENTS <info@gents.nl>",
        to,
        subject,
        html
      })
    });

    const resendText = await resendResponse.text();

    let resendData;

    try {
      resendData = JSON.parse(resendText);
    } catch (error) {
      resendData = {
        raw: resendText
      };
    }

    if (!resendResponse.ok) {
      throw new Error(
        resendData.message ||
        resendData.error ||
        "E-mail kon niet worden verstuurd"
      );
    }

    return resendData;
  }

  try {
    await sendMail({
      to: email,
      subject: `Nieuwe aanvraag: ${type || "Winkelportaal"}`,
      html: buildHtmlTable(data)
    });

    if (type.includes("Retour") && data["contact[email]"]) {
      await sendMail({
        to: data["contact[email]"],
        subject: "Retour ontvangen",
        html: `
          <div style="font-family:Arial,sans-serif;color:#0a1f33;">
            <h2 style="margin:0 0 12px;">Retour ontvangen</h2>
            <p>Je retour is ontvangen en wordt verwerkt.</p>
            <p>Wij controleren de retour en nemen contact op als er nog vragen zijn.</p>
            <p style="margin-top:20px;color:#3a4a5a;font-size:13px;">
              Met vriendelijke groet,<br>
              GENTS
            </p>
          </div>
        `
      });
    }

    return res.status(200).json({
      success: true
    });
  } catch (error) {
    return res.status(500).json({
      error: "Mail kon niet worden verstuurd",
      details: error.message
    });
  }
}
