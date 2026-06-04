import { Resend } from 'resend';
import { getMailFrom, getReplyTo } from './gents-mail-config.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function arrayify(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value).split(/[,;]/).map((item) => item.trim()).filter(Boolean);
}

export function baseMailHtml({ title, intro, bodyHtml, footer }) {
  return `
  <div style="margin:0;padding:0;background:#f5f5f2;font-family:Arial,Helvetica,sans-serif;color:#0a1f33;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f5f2;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="680" cellspacing="0" cellpadding="0" style="width:680px;max-width:calc(100vw - 32px);background:#ffffff;border:1px solid #e1e6eb;border-radius:24px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 20px;border-bottom:1px solid #e1e6eb;">
                <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#3a4a5a;font-weight:700;">GENTS Winkelportaal</div>
                <h1 style="margin:8px 0 0;font-size:28px;line-height:1.1;font-weight:400;letter-spacing:-.03em;color:#0a1f33;">${escapeHtml(title)}</h1>
                ${intro ? `<p style="margin:12px 0 0;color:#3a4a5a;font-size:15px;line-height:1.55;">${escapeHtml(intro)}</p>` : ''}
              </td>
            </tr>
            <tr>
              <td style="padding:26px 32px;">
                ${bodyHtml || ''}
              </td>
            </tr>
            <tr>
              <td style="padding:18px 32px;border-top:1px solid #e1e6eb;color:#3a4a5a;font-size:13px;line-height:1.5;">
                ${footer ? escapeHtml(footer) : 'Deze e-mail is automatisch verstuurd door het GENTS Winkelportaal.'}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </div>`;
}

export async function sendMail({ to, cc, bcc, subject, html, text, from, replyTo, headers }) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY ontbreekt in Vercel Environment Variables.');
  }

  const recipients = arrayify(to);
  if (!recipients.length) {
    throw new Error('Geen ontvanger ingesteld voor deze e-mail.');
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  /* Per-mail from + replyTo override (welkom-mail, automations met persoonlijke
     afzender), met fallback op de globale defaults uit gents-mail-config.js. */
  const fromHeader = String(from || '').trim() || getMailFrom();
  const replyHeader = String(replyTo || '').trim() || getReplyTo();

  const payload = {
    from: fromHeader,
    to: recipients,
    cc: arrayify(cc),
    bcc: arrayify(bcc),
    replyTo: replyHeader,
    subject,
    html,
    text
  };
  /* Optionele custom headers (bv. X-Welkom-Mail tags voor logging/filtering). */
  if (headers && typeof headers === 'object' && Object.keys(headers).length) {
    payload.headers = headers;
  }

  const result = await resend.emails.send(payload);

  if (result.error) {
    throw new Error(result.error.message || 'Resend fout bij versturen.');
  }

  return {
    resendId: result.data?.id || '',
    id: result.data?.id || '',
    to: recipients,
    subject,
    from: fromHeader
  };
}

export function rowsTable(rows, columns) {
  const header = columns.map((column) => `<th style="padding:10px;border-bottom:1px solid #e1e6eb;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#3a4a5a;">${escapeHtml(column.label)}</th>`).join('');
  const body = rows.map((row) => `<tr>${columns.map((column) => `<td style="padding:10px;border-bottom:1px solid #eef2f7;font-size:14px;color:#0a1f33;vertical-align:top;">${escapeHtml(column.value(row))}</td>`).join('')}</tr>`).join('');
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #e1e6eb;border-radius:14px;overflow:hidden;">${header ? `<thead><tr>${header}</tr></thead>` : ''}<tbody>${body}</tbody></table>`;
}
