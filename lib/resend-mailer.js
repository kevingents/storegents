import { Resend } from 'resend';
import { createMailLog } from './mail-log-store.js';

function getClient() {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY ontbreekt in Vercel Environment Variables.');
  return new Resend(key);
}

export async function sendGentsMail({ to, subject, html, text, type = 'algemeen', store = '', meta = {}, from: fromOverride = '', replyTo = '', headers = null, tags = null }) {
  /* Afzender mag per mail overschreven worden (bv. per-winkel: denhaag@mail.gents.nl). */
  const from = String(fromOverride || '').trim() || process.env.RESEND_FROM_EMAIL;
  if (!from) throw new Error('RESEND_FROM_EMAIL ontbreekt in Vercel Environment Variables.');
  if (!to) throw new Error('Ontvanger ontbreekt.');

  let log = null;
  try {
    const payload = { from, to, subject, html, text };
    if (replyTo) payload.replyTo = replyTo;
    if (headers && typeof headers === 'object') payload.headers = headers;
    if (Array.isArray(tags) && tags.length) payload.tags = tags;
    const result = await getClient().emails.send(payload);
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

/**
 * Declaratie-notificatie met bijlage. BEST-EFFORT: gooit nooit, zodat het
 * opslaan van een declaratie (api/invoice-upload.js) nooit faalt door een
 * mail-probleem. Recipient via env DECLARATIONS_EMAIL — niet ingesteld of geen
 * Resend-config → mail wordt netjes overgeslagen (declaratie is dan al opgeslagen
 * en zichtbaar in het declaratie-overzicht).
 *
 * Tekstvelden (store/employeeName/…) komen reeds HTML-escaped binnen; fileName
 * is raw en wordt hier ge-escaped.
 */
export async function sendDeclarationEmail({ declaration = {}, store = '', employeeName = '', responsible = '', purpose = '', notes = '', signed = '', fileName = '', fileContent = null } = {}) {
  const to = String(process.env.DECLARATIONS_EMAIL || '').trim();
  const from = process.env.RESEND_FROM_EMAIL;
  const subject = `Nieuwe declaratie${store ? ' — ' + store : ''}${employeeName ? ' · ' + employeeName : ''}`;
  if (!to || !from || !process.env.RESEND_API_KEY) {
    return { success: false, skipped: true, reason: 'DECLARATIONS_EMAIL/RESEND niet geconfigureerd' };
  }
  const escTxt = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const row = (l, v) => v ? `<tr><td style="padding:3px 12px 3px 0;color:#667">${l}</td><td style="color:#111">${v}</td></tr>` : '';
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111">
    <h2 style="margin:0 0 12px;font-size:18px">Nieuwe declaratie</h2>
    <table style="border-collapse:collapse">
      ${row('Winkel', store)}${row('Medewerker', employeeName)}${row('Verantwoordelijke', responsible)}${row('Doel', purpose)}${row('Ondertekend door', signed)}${row('Notities', notes)}${declaration && declaration.id ? row('Referentie', escTxt(declaration.id)) : ''}
    </table>
    ${fileName ? `<p style="margin-top:14px;color:#667">Bijlage: <strong style="color:#111">${escTxt(fileName)}</strong></p>` : ''}
  </div>`;
  const payload = { from, to, subject, html };
  if (fileContent && fileName) {
    payload.attachments = [{ filename: fileName, content: Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(String(fileContent)) }];
  }
  try {
    const result = await getClient().emails.send(payload);
    await createMailLog({ type: 'declaratie', store, to, subject, status: 'sent', providerId: result?.data?.id || result?.id || '', meta: { declarationId: declaration?.id || '' } }).catch(() => {});
    return { success: true, result };
  } catch (error) {
    await createMailLog({ type: 'declaratie', store, to, subject, status: 'error', error: error.message || 'mail-fout', meta: { declarationId: declaration?.id || '' } }).catch(() => {});
    return { success: false, error: error.message };
  }
}
