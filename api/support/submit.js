import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { sendMail, baseMailHtml } from '../../lib/gents-mailer.js';

function parseBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

function getSupportEmail() {
  return String(process.env.SUPPORT_EMAIL || process.env.ADMIN_EMAIL || '').trim();
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen POST is toegestaan.' });
  }

  try {
    const body = parseBody(req);

    const store = String(body.store || body['contact[Winkel]'] || '').trim();
    const employee = String(body.employee || body['contact[Medewerker]'] || '').trim();
    const subject = String(body.subject || body['contact[Onderwerp]'] || '').trim();
    const description = String(body.description || body['contact[Omschrijving]'] || '').trim();

    if (!employee) return res.status(400).json({ success: false, message: 'Naam medewerker ontbreekt.' });
    if (!subject) return res.status(400).json({ success: false, message: 'Onderwerp ontbreekt.' });
    if (!description) return res.status(400).json({ success: false, message: 'Omschrijving ontbreekt.' });

    const to = getSupportEmail();
    if (!to) {
      return res.status(500).json({ success: false, message: 'SUPPORT_EMAIL is niet geconfigureerd in Vercel.' });
    }

    const html = baseMailHtml({
      title: `Support: ${subject}`,
      intro: `Nieuwe supportmelding via het GENTS Winkelportaal.`,
      bodyHtml: `
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
          <tr><td style="padding:8px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#3a4a5a;width:140px;font-weight:700;">Winkel</td><td style="padding:8px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#0a1f33;">${store || '(niet opgegeven)'}</td></tr>
          <tr><td style="padding:8px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#3a4a5a;font-weight:700;">Medewerker</td><td style="padding:8px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#0a1f33;">${employee}</td></tr>
          <tr><td style="padding:8px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#3a4a5a;font-weight:700;">Onderwerp</td><td style="padding:8px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#0a1f33;">${subject}</td></tr>
          <tr><td style="padding:8px 0;font-size:14px;color:#3a4a5a;font-weight:700;vertical-align:top;">Omschrijving</td><td style="padding:8px 0;font-size:14px;color:#0a1f33;white-space:pre-line;">${description}</td></tr>
        </table>`,
      footer: 'Automatisch verstuurd vanuit het GENTS Winkelportaal — supportformulier.'
    });

    await sendMail({
      to,
      subject: `[Support] ${subject} — ${store || employee}`,
      html,
      text: `Winkel: ${store}\nMedewerker: ${employee}\nOnderwerp: ${subject}\n\n${description}`
    });

    return res.status(200).json({ success: true, message: 'Supportmelding verstuurd.' });
  } catch (error) {
    console.error('Support submit fout:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Supportmelding kon niet worden verstuurd.'
    });
  }
}
