import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendDeclarationEmail({
  declaration,
  store,
  employeeName,
  responsible,
  purpose,
  notes,
  signed,
  fileName,
  fileContent
}) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY ontbreekt in Vercel Environment Variables.');
  }

  return resend.emails.send({
    from: process.env.MAIL_FROM || 'Winkel Dashboard <no-reply@gents.nl>',
    to: ['administratie@gents.nl'],
    subject: `Nieuwe declaratie - ${purpose} - ${store}`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #0a1f33; line-height: 1.5;">
        <h2>Nieuwe declaratie ingediend</h2>
        <p>Er is een nieuwe declaratie ingediend via het winkelportaal.</p>

        <table cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
          <tr><td><strong>Declaratie ID</strong></td><td>${declaration.id}</td></tr>
          <tr><td><strong>Winkel</strong></td><td>${store}</td></tr>
          <tr><td><strong>Naam medewerker</strong></td><td>${employeeName}</td></tr>
          <tr><td><strong>Naam verantwoordelijke</strong></td><td>${responsible}</td></tr>
          <tr><td><strong>Categorie</strong></td><td>${purpose}</td></tr>
          <tr><td><strong>Status</strong></td><td>${declaration.status || '-'}</td></tr>
          <tr><td><strong>Betaaldatum</strong></td><td>${declaration.paidAt || '-'}</td></tr>
          <tr><td><strong>Hoe betaald</strong></td><td>${declaration.paymentMethod || '-'}</td></tr>
          <tr><td><strong>Document ondertekend</strong></td><td>${signed}</td></tr>
          <tr><td><strong>Toelichting</strong></td><td>${notes || '-'}</td></tr>
        </table>

        <p>De factuur is als bijlage toegevoegd.</p>
      </div>
    `,
    attachments: [
      {
        filename: fileName,
        content: fileContent
      }
    ]
  });
}
