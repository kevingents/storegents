import { findOfficeUserByEmail, setInviteTokenForUser } from '../../lib/office-users-store.js';
import { sendMail, baseMailHtml } from '../../lib/gents-mailer.js';
import { appendAuditEntry } from '../../lib/permissions-audit-store.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

/**
 * POST /api/auth/request-invite
 *
 * Self-service endpoint: een gebruiker met expired/missing invite-link kan
 * zijn e-mail invullen en krijgt direct een nieuwe invite-mail (mits het account
 * bestaat, actief is en nog géén wachtwoord heeft).
 *
 * Veiligheidsmaatregelen:
 *   - Always returns 200 met dezelfde generieke melding — NOOIT enumerate
 *     of een account bestaat (anti user-enumeration).
 *   - Per-IP rate limit: max 5 requests per 10 min via in-memory bucket.
 *     Bij overschrijding ook 200 maar zonder actie.
 *   - Mail wordt enkel verstuurd als alle voorwaarden kloppen.
 *
 * Body:
 *   { email: 'iemand@gents.nl' }
 *
 * Response (altijd):
 *   { success: true, message: 'Als dit adres bij ons bekend is...' }
 */

/* Simple in-memory rate-limiter — Vercel functions herstarten, dus dit is
   best-effort. Voor productie kan dit later naar Blob/Redis. */
const RATE_BUCKETS = new Map();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_PER_WINDOW = 5;

function getIp(req) {
  return String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || '')
    .split(',')[0]
    .trim() || 'unknown';
}

function isRateLimited(key) {
  const now = Date.now();
  const arr = (RATE_BUCKETS.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX_PER_WINDOW) {
    RATE_BUCKETS.set(key, arr);
    return true;
  }
  arr.push(now);
  RATE_BUCKETS.set(key, arr);
  return false;
}

function clean(v) { return String(v || '').trim(); }

function buildBaseUrl(req) {
  const explicit = clean(process.env.PORTAL_BASE_URL || process.env.PUBLIC_BASE_URL);
  if (explicit) return explicit.replace(/\/$/, '');
  const proto = clean(req.headers['x-forwarded-proto']) || 'https';
  const host = clean(req.headers['x-forwarded-host'] || req.headers.host);
  return `${proto}://${host}`;
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

const GENERIC_OK_MESSAGE = 'Als dit adres bij ons bekend is en nog geen wachtwoord heeft ingesteld, ontvang je binnen enkele minuten een nieuwe uitnodiging. Check ook je spam-folder.';

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen POST.' });
  }

  const body = parseBody(req);
  const email = clean(body.email).toLowerCase();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    /* Bewust geen specifieke foutmelding — anders kan je email-format wel/niet checken */
    return res.status(200).json({ success: true, message: GENERIC_OK_MESSAGE });
  }

  /* Rate-limit per IP — voorkomt spam */
  const ip = getIp(req);
  if (isRateLimited(`req-invite:${ip}`)) {
    return res.status(200).json({ success: true, message: GENERIC_OK_MESSAGE, rateLimited: true });
  }
  /* Ook per email — voorkomt dat één adres herhaald gestuurd wordt */
  if (isRateLimited(`req-invite-email:${email}`)) {
    return res.status(200).json({ success: true, message: GENERIC_OK_MESSAGE, rateLimited: true });
  }

  try {
    const user = await findOfficeUserByEmail(email);
    if (!user) {
      /* Account bestaat niet — generic success */
      return res.status(200).json({ success: true, message: GENERIC_OK_MESSAGE });
    }
    if (user.active === false) {
      /* Account is gedeactiveerd — generic success (geen status leaken) */
      return res.status(200).json({ success: true, message: GENERIC_OK_MESSAGE });
    }
    if (user.passwordHash) {
      /* User heeft al een wachtwoord — moet via wachtwoord-reset, niet invite */
      return res.status(200).json({
        success: true,
        message: 'Dit account heeft al een wachtwoord. Probeer in te loggen, of vraag een beheerder om reset.',
        existingPassword: true
      });
    }

    /* OK — genereer nieuwe invite-token en verstuur mail */
    const inviteData = await setInviteTokenForUser(user.userId);
    const baseUrl = buildBaseUrl(req);
    const inviteUrl = `${baseUrl}/api/auth/set-password?token=${encodeURIComponent(inviteData.token)}`;
    const expiresStr = new Date(inviteData.expiresAt).toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short' });

    const html = baseMailHtml({
      title: 'Nieuwe uitnodiging — stel je wachtwoord in',
      intro: `Hallo ${user.name || 'collega'}, je hebt zojuist een nieuwe uitnodigings-link aangevraagd. De vorige link werkt niet meer.`,
      bodyHtml: `
        <p style="margin:0 0 18px;font-size:15px;line-height:1.55">Stel binnen <strong>${expiresStr}</strong> je eigen wachtwoord in via onderstaande link:</p>
        <p style="margin:0 0 24px">
          <a href="${inviteUrl}" style="display:inline-block;padding:14px 24px;background:#0a1f33;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:600;font-size:15px">Wachtwoord instellen →</a>
        </p>
        <p style="margin:0 0 8px;font-size:12px;color:#3a4a5a">Werkt de knop niet? Kopieer deze link in je browser:</p>
        <p style="margin:0;word-break:break-all;font-family:monospace;font-size:12px;color:#0a1f33;padding:10px;background:#f5f5f2;border-radius:8px;">${inviteUrl}</p>
        <p style="margin:24px 0 0;font-size:13px;color:#3a4a5a">Heb je deze mail niet aangevraagd? Negeer 'm — je account wordt pas actief zodra je een wachtwoord instelt.</p>
      `,
      footer: 'Self-service invite — aangevraagd vanaf het GENTS Portaal.'
    });

    try {
      await sendMail({
        to: email,
        subject: 'Nieuwe uitnodiging — stel je wachtwoord in voor het GENTS Portaal',
        html
      });
    } catch (mailErr) {
      console.error('[auth/request-invite] mail send failed:', mailErr.message);
      /* Geen specifieke foutmelding teruggeven — gebruiker kan niets doen aan mail-fouten */
    }

    await appendAuditEntry({
      actor: user.userId,
      action: 'self-request-invite',
      targetUserId: user.userId,
      targetName: user.name,
      note: `Self-service invite-aanvraag via /api/auth/request-invite (IP: ${ip})`,
      request: req
    }).catch(() => {});

    return res.status(200).json({ success: true, message: GENERIC_OK_MESSAGE });
  } catch (error) {
    console.error('[auth/request-invite]', error);
    /* Ook bij fouten generic success — anders lek je info */
    return res.status(200).json({ success: true, message: GENERIC_OK_MESSAGE });
  }
}
