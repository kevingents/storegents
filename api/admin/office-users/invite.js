import { handleCors, setCorsHeaders } from '../../../lib/cors.js';
import { requireSystemAdmin } from '../../../lib/permission-guards.js';
import {
  upsertOfficeUser,
  setInviteTokenForUser,
  findOfficeUserByEmail
} from '../../../lib/office-users-store.js';
import { appendAuditEntry } from '../../../lib/permissions-audit-store.js';
import { sendMail, baseMailHtml } from '../../../lib/gents-mailer.js';

/**
 * POST /api/admin/office-users/invite
 *
 * Body: { email, name?, phone?, department?, resend? }
 *
 * Werkwijze:
 *   1. Als email nog niet bestaat → upsert nieuwe office-user (active=true)
 *   2. Genereer invite-token (32 bytes hex, 7 dagen geldig)
 *   3. Verstuur mail met link /api/auth/set-password?token=XXX
 *
 * Response: { success, user, inviteUrl, sentTo, alreadyExisted }
 */

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

function clean(v) { return String(v || '').trim(); }

function buildBaseUrl(req) {
  /* Probeer expliciete env override eerst (zodat invites in productie altijd naar live-domain wijzen ook bij preview/branch deploys) */
  const explicit = clean(process.env.PORTAL_BASE_URL || process.env.PUBLIC_BASE_URL);
  if (explicit) return explicit.replace(/\/$/, '');
  const proto = clean(req.headers['x-forwarded-proto']) || 'https';
  const host = clean(req.headers['x-forwarded-host'] || req.headers.host);
  return `${proto}://${host}`;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (requireSystemAdmin(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });

  const body = parseBody(req);
  const email = clean(body.email).toLowerCase();
  const name = clean(body.name);
  const phone = clean(body.phone);
  const department = clean(body.department);
  const resend = body.resend === true || String(body.resend) === 'true';
  const actor = clean(req.headers['x-actor'] || body.actor || 'admin') || 'admin';

  if (!email) return res.status(400).json({ success: false, message: 'email is verplicht.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ success: false, message: 'Ongeldig e-mailadres.' });

  try {
    /* Stap 1: zorg dat user bestaat */
    let existing = await findOfficeUserByEmail(email);
    let alreadyExisted = Boolean(existing);
    if (!existing) {
      if (!name) return res.status(400).json({ success: false, message: 'Voor nieuwe gebruikers is naam verplicht.' });
      existing = await upsertOfficeUser({ email, name, phone, department, active: true }, actor);
      await appendAuditEntry({
        actor,
        action: 'upsert-office-user',
        targetUserId: existing.userId,
        targetName: existing.name,
        after: existing,
        note: 'Aangemaakt via invite-flow'
      });
    } else if (!alreadyExisted && (name || phone || department)) {
      /* update metadata bij bestaande user als er nieuwe data is */
      existing = await upsertOfficeUser({ ...existing, email, name: name || existing.name, phone: phone || existing.phone, department: department || existing.department }, actor);
    }

    /* Stap 2: genereer token */
    const inviteData = await setInviteTokenForUser(existing.userId);
    const baseUrl = buildBaseUrl(req);
    const inviteUrl = `${baseUrl}/api/auth/set-password?token=${encodeURIComponent(inviteData.token)}`;
    const expiresStr = new Date(inviteData.expiresAt).toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short' });

    /* Stap 3: verstuur mail */
    const subject = resend
      ? 'Herinnering: stel je wachtwoord in voor het GENTS Portaal'
      : 'Welkom bij het GENTS Portaal — stel je wachtwoord in';
    const html = baseMailHtml({
      title: resend ? 'Herinnering: stel je wachtwoord in' : 'Welkom bij het GENTS Portaal',
      intro: resend
        ? `Hallo ${existing.name || 'collega'}, je hebt nog geen wachtwoord ingesteld. Klik hieronder om dit alsnog te doen.`
        : `Hallo ${existing.name || 'collega'}, er is een account voor je aangemaakt door ${actor}. Klik hieronder om je wachtwoord in te stellen.`,
      bodyHtml: `
        <p style="margin:0 0 18px;font-size:15px;line-height:1.55">Stel binnen <strong>${expiresStr}</strong> je eigen wachtwoord in via onderstaande link:</p>
        <p style="margin:0 0 24px">
          <a href="${inviteUrl}" style="display:inline-block;padding:14px 24px;background:#0a1f33;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:600;font-size:15px">Wachtwoord instellen →</a>
        </p>
        <p style="margin:0 0 8px;font-size:12px;color:#3a4a5a">Werkt de knop niet? Kopieer deze link in je browser:</p>
        <p style="margin:0;word-break:break-all;font-family:monospace;font-size:12px;color:#0a1f33;padding:10px;background:#f5f5f2;border-radius:8px;">${inviteUrl}</p>
        <p style="margin:24px 0 0;font-size:13px;color:#3a4a5a">Heb je deze mail niet aangevraagd? Negeer 'm — je account wordt pas actief zodra je een wachtwoord instelt.</p>
      `,
      footer: 'Deze uitnodiging is automatisch verstuurd vanuit het GENTS Portaal. Reageren kan via support@gents.nl.'
    });

    let sentTo = email;
    let mailWarning = null;
    try {
      await sendMail({ to: email, subject, html });
    } catch (mailErr) {
      /* Mail-fout niet hard laten falen — admin kan invite-URL handmatig kopiëren */
      console.warn('[office-users/invite] mail send failed:', mailErr.message);
      mailWarning = `Mail kon niet verstuurd worden: ${mailErr.message}. Kopieer onderstaande invite-URL en stuur 'm zelf naar de gebruiker.`;
    }

    await appendAuditEntry({
      actor,
      action: resend ? 'resend-invite' : 'send-invite',
      targetUserId: existing.userId,
      targetName: existing.name,
      note: `Invite-token verstuurd naar ${email} (geldig tot ${inviteData.expiresAt})`
    });

    return res.status(200).json({
      success: true,
      user: existing,
      inviteUrl,
      expiresAt: inviteData.expiresAt,
      sentTo,
      alreadyExisted,
      mailWarning
    });
  } catch (error) {
    console.error('[admin/office-users/invite] error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Invite-flow mislukt.'
    });
  }
}
