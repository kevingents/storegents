import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

function formatAmount(amount, currency = 'EUR') {
  return Number(amount || 0).toLocaleString('nl-NL', { style: 'currency', currency });
}

export async function sendVoucherEmail({ to, customerName, voucherCode, amount, currency = 'EUR', validFrom, validTo, shopifyEnabled, note }) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY ontbreekt.');
  if (!to) throw new Error('Klant e-mail ontbreekt.');

  return resend.emails.send({
    from: process.env.MAIL_FROM || 'GENTS <no-reply@gents.nl>',
    to: [to],
    subject: `Je GENTS voucher ${voucherCode}`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #0a1f33; line-height: 1.55; max-width: 640px;">
        <h1 style="font-weight: 400;">Je GENTS voucher</h1>
        <p>Beste ${customerName || 'klant'},</p>
        <p>Hierbij ontvang je je GENTS voucher.</p>
        <div style="border: 1px solid #e6e9ed; border-radius: 18px; padding: 22px; background: #f8fafc; margin: 22px 0;">
          <p style="margin: 0 0 8px; color: #3a4a5a; font-size: 12px; text-transform: uppercase; letter-spacing: .12em;">Vouchercode</p>
          <p style="font-size: 30px; letter-spacing: .08em; margin: 0;"><strong>${voucherCode}</strong></p>
          <p style="font-size: 18px; margin: 14px 0 0;">Waarde: <strong>${formatAmount(amount, currency)}</strong></p>
          <p style="margin: 8px 0 0;">Geldig van ${validFrom || '-'} t/m ${validTo || '-'}</p>
        </div>
        <p>Je kunt deze code in de winkel laten scannen aan de kassa.${shopifyEnabled ? ' De code is ook beschikbaar gemaakt voor online gebruik in Shopify.' : ''}</p>
        ${note ? `<p><strong>Opmerking:</strong> ${note}</p>` : ''}
        <p>Met vriendelijke groet,<br>GENTS</p>
      </div>
    `
  });
}
