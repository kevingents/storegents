import { Resend } from 'resend';

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'ja'].includes(String(value).toLowerCase());
}

function getResendClient() {
  const key = process.env.RESEND_API_KEY || '';
  if (!key) throw new Error('RESEND_API_KEY ontbreekt.');
  return new Resend(key);
}

function cancellationMailHtml(cancellation) {
  const orderName = `#${String(cancellation.orderNr || '').replace(/^#/, '')}`;
  const typeText = cancellation.type === 'full' ? 'je bestelling' : 'een onderdeel van je bestelling';
  return `
    <div style="font-family:Arial,sans-serif;color:#0a1f33;line-height:1.5">
      <h2>Update over je bestelling ${orderName}</h2>
      <p>Beste ${cancellation.customerName || 'klant'},</p>
      <p>Helaas kunnen wij ${typeText} niet leveren. De reden is: <strong>${cancellation.reason || 'niet leverbaar'}</strong>.</p>
      <p>Als er een terugbetaling nodig is, verwerken wij deze via de oorspronkelijke betaalmethode.</p>
      <p>Onze excuses voor het ongemak.</p>
      <p>Met vriendelijke groet,<br>GENTS</p>
    </div>`;
}

export async function sendCancellationMail({ cancellation }) {
  const liveEnabled = boolEnv('CUSTOMER_CANCEL_MAIL_LIVE_ENABLED', false);

  if (!cancellation.customerEmail) {
    return { success: true, skipped: true, message: 'Geen klant e-mail beschikbaar.' };
  }

  if (!liveEnabled) {
    return {
      success: true,
      dryRun: true,
      message: 'Dry-run: klantmail niet verzonden. Zet CUSTOMER_CANCEL_MAIL_LIVE_ENABLED=true om live mail toe te staan.'
    };
  }

  const resend = getResendClient();
  const from = process.env.CUSTOMER_CANCEL_MAIL_FROM || 'GENTS <noreply@gents.nl>';
  const replyTo = process.env.CUSTOMER_CANCEL_MAIL_REPLY_TO || process.env.CUSTOMER_SERVICE_EMAIL || '';
  const orderName = `#${String(cancellation.orderNr || '').replace(/^#/, '')}`;

  const result = await resend.emails.send({
    from,
    to: cancellation.customerEmail,
    replyTo: replyTo || undefined,
    subject: `Update over je bestelling ${orderName}`,
    html: cancellationMailHtml(cancellation)
  });

  return { success: true, provider: 'resend', id: result?.data?.id || result?.id || '', raw: result };
}
