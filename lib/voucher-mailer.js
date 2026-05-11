import { Resend } from 'resend';
import bwipjs from 'bwip-js';

const resend = new Resend(process.env.RESEND_API_KEY);
const GENTS_LOGO_URL = 'https://gents.nl/cdn/shop/files/GENTS-logo-wit.png?v=1768290851&width=220';
const VOUCHER_EXCHANGE_URL = 'https://gents.nl/pages/voucher-omwisselen';
const STORE_LOCATOR_URL = 'https://gents.nl/pages/winkels';
const PRIMARY = '#0a1f33';
const SECONDARY = '#3a4a5a';
const BACKGROUND = '#f5f5f2';
const BORDER = '#e6e9ed';
const SOFT = '#f8fafc';

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
    height: 18,
    includetext: false,
    backgroundcolor: 'FFFFFF'
  });

  return `data:image/png;base64,${png.toString('base64')}`;
}

function button({ href, label, variant = 'dark' }) {
  const isDark = variant === 'dark';
  return `
    <a href="${href}" style="display:inline-block;border-radius:999px;padding:15px 22px;font-size:14px;line-height:1;font-weight:700;text-decoration:none;background:${isDark ? PRIMARY : '#ffffff'};color:${isDark ? '#ffffff' : PRIMARY};border:1px solid ${isDark ? PRIMARY : BORDER};">
      ${escapeHtml(label)}
    </a>`;
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
  ctaText = 'Voucher ontvangen',
  reminderText = ''
}) {
  const safeCode = escapeHtml(voucherCode);
  const amountLabel = formatAmount(amount, currency);
  const onlineText = shopifyEnabled
    ? 'Deze voucher is ook geschikt voor online gebruik.'
    : 'Wil je de voucher online gebruiken? Zet hem dan eerst om naar een digitale giftcard.';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${BACKGROUND};color:${PRIMARY};font-family:Montserrat,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
    ${escapeHtml(preheader || '')}
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BACKGROUND};padding:34px 14px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:720px;background:#ffffff;border:1px solid ${BORDER};border-radius:30px;overflow:hidden;box-shadow:0 18px 45px rgba(10,31,51,.08);">
          <tr>
            <td style="background:${PRIMARY};padding:28px 34px 30px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="left" style="vertical-align:middle;">
                    <img src="${GENTS_LOGO_URL}" width="112" alt="GENTS" style="display:block;border:0;max-width:112px;height:auto;">
                  </td>
                  <td align="right" style="vertical-align:middle;color:#cbd5df;font-size:12px;letter-spacing:.16em;text-transform:uppercase;font-weight:700;">
                    ${escapeHtml(ctaText)}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:40px 34px 20px;">
              <h1 style="margin:0;color:${PRIMARY};font-size:42px;line-height:1.08;font-weight:400;letter-spacing:-.045em;">${escapeHtml(title)}</h1>
              <p style="margin:20px 0 0;color:${SECONDARY};font-size:17px;line-height:1.7;">Beste ${escapeHtml(customerName || 'klant')},</p>
              <p style="margin:8px 0 0;color:${SECONDARY};font-size:17px;line-height:1.7;">${intro}</p>
              ${reminderText ? `<p style="margin:16px 0 0;color:${PRIMARY};font-size:17px;line-height:1.65;"><strong>${escapeHtml(reminderText)}</strong></p>` : ''}
            </td>
          </tr>

          <tr>
            <td style="padding:12px 34px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SOFT};border:1px solid ${BORDER};border-radius:26px;overflow:hidden;">
                <tr>
                  <td style="padding:28px 28px 24px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding:0 0 22px;">
                          <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${SECONDARY};font-weight:700;margin-bottom:8px;">Waarde</div>
                          <div style="font-size:46px;line-height:1;color:${PRIMARY};font-weight:400;letter-spacing:-.04em;">${amountLabel}</div>
                        </td>
                      </tr>
                    </table>

                    <div style="background:#ffffff;border:1px solid ${BORDER};border-radius:22px;padding:22px;">
                      <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${SECONDARY};font-weight:700;margin-bottom:9px;">Vouchercode</div>
                      <div style="font-size:30px;line-height:1.15;letter-spacing:.06em;color:${PRIMARY};font-weight:700;word-break:break-all;">${safeCode}</div>
                      <div style="height:18px;"></div>
                      <div style="background:#ffffff;border:1px solid ${BORDER};border-radius:16px;padding:14px;display:block;max-width:100%;">
                        <img src="${barcodeDataUrl}" alt="Barcode Code 128 voor voucher ${safeCode}" width="430" style="display:block;border:0;width:100%;max-width:430px;height:auto;margin:0 auto;">
                      </div>
                      <div style="margin-top:10px;color:${SECONDARY};font-size:12px;line-height:1.5;text-align:center;">Laat deze Code 128 barcode scannen aan de kassa</div>
                    </div>

                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;">
                      <tr>
                        <td width="50%" style="padding:16px;background:#ffffff;border:1px solid ${BORDER};border-radius:18px;">
                          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:${SECONDARY};font-weight:700;">Geldig vanaf</div>
                          <div style="font-size:17px;font-weight:700;color:${PRIMARY};margin-top:5px;">${escapeHtml(validFrom || '-')}</div>
                        </td>
                        <td width="12" style="font-size:1px;line-height:1px;">&nbsp;</td>
                        <td width="50%" style="padding:16px;background:#ffffff;border:1px solid ${BORDER};border-radius:18px;">
                          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:${SECONDARY};font-weight:700;">Geldig t/m</div>
                          <div style="font-size:17px;font-weight:700;color:${PRIMARY};margin-top:5px;">${escapeHtml(validTo || '-')}</div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:26px 34px 10px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid ${BORDER};border-radius:24px;">
                <tr>
                  <td style="padding:24px;">
                    <h2 style="margin:0 0 10px;color:${PRIMARY};font-size:24px;line-height:1.15;font-weight:400;letter-spacing:-.03em;">Gebruik je voucher</h2>
                    <p style="margin:0;color:${SECONDARY};font-size:15px;line-height:1.65;">Je kunt de barcode in de winkel laten scannen. ${onlineText}</p>
                    <div style="height:18px;"></div>
                    ${button({ href: VOUCHER_EXCHANGE_URL, label: 'Voucher online gebruiken' })}
                    <span style="display:inline-block;width:8px;height:8px;">&nbsp;</span>
                    ${button({ href: STORE_LOCATOR_URL, label: 'Bekijk winkels', variant: 'light' })}
                  </td>
                </tr>
              </table>

              ${note ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;background:${SOFT};border:1px solid ${BORDER};border-radius:20px;"><tr><td style="padding:18px 20px;color:${SECONDARY};font-size:14px;line-height:1.6;"><strong style="color:${PRIMARY};">Opmerking:</strong> ${escapeHtml(note)}</td></tr></table>` : ''}
            </td>
          </tr>

          <tr>
            <td style="padding:22px 34px 34px;">
              <div style="border-top:1px solid ${BORDER};padding-top:20px;color:${SECONDARY};font-size:14px;line-height:1.6;">
                Met vriendelijke groet,<br>
                <strong style="color:${PRIMARY};">GENTS</strong>
              </div>
            </td>
          </tr>
        </table>

        <div style="max-width:720px;margin:16px auto 0;color:#7a8793;font-size:12px;line-height:1.5;text-align:center;">
          Deze e-mail is automatisch verstuurd door GENTS. Bewaar deze e-mail goed zolang je voucher geldig is.
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
