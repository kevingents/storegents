import { Resend } from 'resend';
import { createMailLog } from './mail-log-store.js';

function getClient() {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY ontbreekt in Vercel Environment Variables.');
  return new Resend(key);
}

export async function sendGentsMail({ to, subject, html, text, type = 'algemeen', store = '', meta = {} }) {
  const from = process.env.RESEND_FROM_EMAIL;
  if (!from) throw new Error('RESEND_FROM_EMAIL ontbreekt in Vercel Environment Variables.');
  if (!to) throw new Error('Ontvanger ontbreekt.');

  let log = null;
  try {
    const result = await getClient().emails.send({ from, to, subject, html, text });
    log = await createMailLog({
      type,
      store,
      to,
      subject,
      status: 'sent',
      providerId: result?.data?.id || result?.id || '',
      meta
    });
    return { success: true, result, log };
  } catch (error) {
    log = await createMailLog({
      type,
      store,
      to,
      subject,
      status: 'error',
      error: error.message || 'Mail kon niet worden verzonden.',
      meta
    });
    throw error;
  }
}
