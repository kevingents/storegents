import { Resend } from 'resend';
import bwipjs from 'bwip-js';

const resend = new Resend(process.env.RESEND_API_KEY);
const GENTS_LOGO_URL = 'https://gents.nl/cdn/shop/files/GENTS-logo-wit.png?v=1768290851&width=220';
const VOUCHER_EXCHANGE_URL = 'https://gents.nl/pages/voucher-omwisselen';
const STORE_LOCATOR_URL = 'https://gents.nl/pages/winkels';

function formatAmount(amount, currency = 'EUR') {
  return Number(amount || 0).toLocaleString('nl-NL', {
    style: 'currency',
    currency
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function createCode128DataUrl(value) {
  const png = await bwipjs.toBuffer({
    bcid: 'code128',
    text: String(value || ''),
    scale: 3,
    height: 16,
    includetext: false,
    backgroundcolor: 'FFFFFF'
  });

  return `data:image/png;base64,${png.toString('base64')}`;
}

function baseEmailTemplate({
  preheader,
  title,
  intro,
  customerName,
  voucherCode,
  amount,
  currency = 'EUR',
  validFrom,
  validTo,
  shopifyEnabled,
  note,
  barcodeDataUrl,
  ctaText = 'Gebruik je voucher',
  reminderText = ''
}) {
  const safeCode = escapeHtml(voucherCode);
  const amountLabel = formatAmount(amount, currency);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f2;color:#0a1f33;font-family:Montserrat,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
    ${escapeHtml(preheader || '')}
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f2;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:720px;background:#ffffff;border:1px solid #e6e9ed;border-radius:28px;overflow:hidden;">
          <tr>
            <td style="background:#0a1f33;color:#ffffff;padding:26px 34px;">
              <img src="${GENTS_LOGO_URL}" width="110" alt="GENTS" style="display:block;border:0;max-width:110px;height:auto;">
              <div style="margin-top:12px;color:#cbd5df;font-size:14px;">Voucher</div>
            </td>
          </tr>

          <tr>
            <td style="padding:38px 34px 18px;">
              <div style="font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#3a4a5a;font-weight:700;margin-bottom:12px;">${escapeHtml(ctaText)}</div>
              <h1 style="margin:0;color:#0a1f33;font-size:42px;line-height:1.08;font-weight:400;letter-spacing:-.04em;">${escapeHtml(title)}</h1>
              <p style="margin:18px 0 0;color:#3a4a5a;font-size:17px;line-height:1.65;">Beste ${escapeHtml(customerName || 'klant')},</p>
              <p style="margin:8px 0 0;color:#3a4a5a;font-size:17px;line-height:1.65;">${intro}</p>
              ${reminderText ? `<p style="margin:16px 0 0;color:#0a1f33;font-size:17px;line-height:1.65;"><strong>${escapeHtml(reminderText)}</strong></p>` : ''}
            </td>
          </tr>

          <tr>
            <td style="padding:14px 34px 8px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e6e9ed;border-radius:24px;">
                <tr>
                  <td style="padding:28px;vertical-align:top;">
                    <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#3a4a5a;font-weight:700;margin-bottom:10px;">Vouchercode</div>
                    <div style="font-size:30px;line-height:1.15;letter-spacing:.06em;color:#0a1f33;font-weight:700;word-break:break-all;">${safeCode}</div>
                    <div style="height:18px;"></div>
                    <div style="background:#ffffff;border:1px solid #e6e9ed;border-radius:18px;padding:14px;display:inline-block;max-width:100%;">
                      <img src="${barcodeDataUrl}" alt="Barcode Code 128 voor voucher ${safeCode}" width="360" style="display:block;border:0;max-width:100%;height:auto;">
                    </div>
                    <div style="margin-top:10px;color:#3a4a5a;font-size:12px;line-height:1.4;">Barcode Code 128 voor aan de kassa</div>
                    <div style="height:20px;"></div>
                    <table role="presentation" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding:0 26px 10px 0;">
                          <div style="font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:#3a4a5a;font-weight:700;">Waarde</div>
                          <div style="font-size:24px;font-weight:700;color:#0a1f33;margin-top:5px;">${amountLabel}</div>
                        </td>
                        <td style="padding:0 0 10px 0;">
                          <div style="font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:#3a4a5a;font-weight:700;">Geldig t/m</div>
                          <div style="font-size:20px;font-weight:700;color:#0a1f33;margin-top:5px;">${escapeHtml(validTo || '-')}</div>
                        </td>
                      </tr>
                    </table>
                    <p style="margin:8px 0 0;color:#3a4a5a;font-size:15px;line-height:1.55;">Geldig vanaf ${escapeHtml(validFrom || '-')}.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:18px 34px 34px;">
              <p style="margin:0;color:#3a4a5a;font-size:15px;line-height:1.65;">Je kunt deze barcode in de winkel laten scannen aan de kassa.${shopifyEnabled ? ` Wil je de voucher digitaal gebruiken? Zet hem dan om via <a href="${VOUCHER_EXCHANGE_URL}" style="color:#0a1f33;font-weight:700;text-decoration:underline;">gents.nl/pages/voucher-omwisselen</a>.` : ''}</p>
              <p style="margin:14px 0 0;color:#3a4a5a;font-size:15px;line-height:1.65;">Bekijk onze winkels via <a href="${STORE_LOCATOR_URL}" style="color:#0a1f33;font-weight:700;text-decoration:underline;">de winkellocator</a>.</p>
              ${note ? `<p style="margin:14px 0 0;color:#3a4a5a;font-size:15px;line-height:1.65;"><strong>Opmerking:</strong> ${escapeHtml(note)}</p>` : ''}
              <div style="height:22px;"></div>
              <div style="border-top:1px solid #e6e9ed;padding-top:18px;color:#3a4a5a;font-size:14px;line-height:1.55;">
                Met vriendelijke groet,<br>
                <strong style="color:#0a1f33;">GENTS</strong>
              </div>
            </td>
          </tr>
        </table>

        <div style="max-width:720px;margin:16px auto 0;color:#7a8793;font-size:12px;line-height:1.5;text-align:center;">
          Deze e-mail is automatisch verstuurd door GENTS.
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendVoucherEmail({
  to,
  customerName,
  voucherCode,
  amount,
  currency = 'EUR',
  validFrom,
  validTo,
  shopifyEnabled,
  note
}) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY ontbreekt in Vercel Environment Variables.');
  }

  if (!to) {
    throw new Error('Klant e-mail ontbreekt.');
  }

  const barcodeDataUrl = await createCode128DataUrl(voucherCode);

  return resend.emails.send({
    from: process.env.MAIL_FROM || process.env.RESEND_FROM_EMAIL || 'GENTS <no-reply@gents.nl>',
    to: [to],
    subject: `Je GENTS voucher ${voucherCode}`,
    html: baseEmailTemplate({
      preheader: `Je GENTS voucher van ${formatAmount(amount, currency)} is klaar.`,
      title: 'Je GENTS voucher staat klaar',
      intro: 'Hierbij ontvang je je persoonlijke GENTS voucher. Bewaar deze e-mail goed en laat de barcode of vouchercode scannen in de winkel.',
      customerName,
      voucherCode,
      amount,
      currency,
      validFrom,
      validTo,
      shopifyEnabled,
      note,
      barcodeDataUrl,
      ctaText: 'Voucher ontvangen'
    })
  });
}

export async function sendVoucherReminderEmail({
  to,
  customerName,
  voucherCode,
  amount,
  currency = 'EUR',
  validFrom,
  validTo,
  shopifyEnabled,
  note,
  reminderType
}) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY ontbreekt in Vercel Environment Variables.');
  }

  if (!to) {
    throw new Error('Klant e-mail ontbreekt.');
  }

  const barcodeDataUrl = await createCode128DataUrl(voucherCode);
  const isExpiryReminder = reminderType === 'expiry_7_days';

  return resend.emails.send({
    from: process.env.MAIL_FROM || process.env.RESEND_FROM_EMAIL || 'GENTS <no-reply@gents.nl>',
    to: [to],
    subject: isExpiryReminder
      ? `Je GENTS voucher verloopt bijna`
      : `Je GENTS voucher staat nog voor je klaar`,
    html: baseEmailTemplate({
      preheader: isExpiryReminder
        ? `Je GENTS voucher verloopt bijna.`
        : `Je GENTS voucher is nog niet gebruikt.`,
      title: isExpiryReminder
        ? 'Je voucher verloopt bijna'
        : 'Je voucher staat nog klaar',
      intro: isExpiryReminder
        ? 'Je GENTS voucher is nog niet gebruikt en verloopt binnenkort. Gebruik hem op tijd in de winkel of zet hem om voor online gebruik.'
        : 'Je GENTS voucher is nog niet gebruikt. We herinneren je er graag aan dat deze nog voor je klaarstaat.',
      customerName,
      voucherCode,
      amount,
      currency,
      validFrom,
      validTo,
      shopifyEnabled,
      note,
      barcodeDataUrl,
      ctaText: isExpiryReminder ? 'Laatste herinnering' : 'Herinnering',
      reminderText: isExpiryReminder
        ? `Geldig t/m ${validTo}.`
        : 'Je kunt de voucher nog gebruiken.'
    })
  });
}
