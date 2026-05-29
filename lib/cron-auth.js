/**
 * lib/cron-auth.js
 *
 * Centrale autorisatie voor cron-endpoints.
 *
 * Vercel voegt bij ELKE cron-invocatie automatisch de header
 *     Authorization: Bearer <CRON_SECRET>
 * toe, mits de CRON_SECRET env-var is ingesteld. Dat is het BETROUWBARE
 * signaal dat een request echt van de Vercel-scheduler komt.
 *
 * De oude check `user-agent: vercel-cron` / `x-vercel-cron`-header is door
 * externe bellers te spoofen (iedereen kan die header/UA zetten) en is dus
 * GEEN veilige autorisatie. We vertrouwen die headers daarom nog uitsluitend
 * als laatste redmiddel wanneer er géén CRON_SECRET is ingesteld — zodat de
 * crons blijven draaien — mét een waarschuwing om CRON_SECRET te zetten.
 *
 * Toegestane wegen:
 *   1. Geldig CRON_SECRET via Bearer-header of ?secret= / ?cronSecret=   (cron)
 *   2. Geldig ADMIN_TOKEN via x-admin-token of ?adminToken=/?admin_token= (operator)
 *   3. Legacy vercel-cron UA/header — ALLEEN als er geen CRON_SECRET is.
 */

export function isCronAuthorized(req) {
  const headers = req?.headers || {};
  const query = req?.query || {};
  const cronSecret = String(process.env.CRON_SECRET || '').trim();

  /* 1. Vercel-cron bearer (of cron-secret bij handmatige trigger) */
  if (cronSecret) {
    const bearer = String(headers.authorization || headers.Authorization || '')
      .replace(/^Bearer\s+/i, '')
      .trim();
    const querySecret = String(query.secret || query.cronSecret || '').trim();
    if (bearer === cronSecret || querySecret === cronSecret) return true;
  }

  /* 2. Handmatige trigger via admin-token */
  const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
  const provided = String(
    headers['x-admin-token'] ||
    query.adminToken ||
    query.admin_token ||
    ''
  ).trim();
  if (adminToken && provided && provided === adminToken) return true;

  /* 3. Legacy fallback — alleen vertrouwen als er GEEN CRON_SECRET is, want
        anders is de vercel-cron UA/header een spoofbaar (en dus onveilig) signaal. */
  if (!cronSecret) {
    const ua = String(headers['user-agent'] || '').toLowerCase();
    if (ua.includes('vercel-cron') || headers['x-vercel-cron']) {
      console.warn('[cron-auth] CRON_SECRET niet ingesteld — terugval op spoofbare vercel-cron UA. Zet CRON_SECRET in Vercel om dit te beveiligen.');
      return true;
    }
  }

  return false;
}
