import { trackedCron } from '../../lib/cron-auto-track.js';

/**
 * Cron: ververs de cache van de zware klanten-overzichten.
 *
 * store-customer-overview (~40s) en top-customers (~25s) doen elk een live
 * Shopify-orders-scan. Deze cron roept ze met ?refresh=1 aan → ze berekenen vers
 * én schrijven de report-cache. De portal-pagina's lezen daarna de cache → instant.
 *
 * Schedule (lib/cron-jobs.js): elk uur tijdens kantooruren.
 */

export const config = { maxDuration: 90 };

async function refresh(base, token, path) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/${path}`, { headers: { 'x-admin-token': token } });
    return { path, status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    return { path, error: e.message, ms: Date.now() - t0 };
  }
}

async function handler(req, res) {
  /* Auth: Vercel-cron Bearer (CRON_SECRET) of handmatige trigger met die secret.
     Zonder secret: legacy-gedrag (geen gate). */
  const secret = String(process.env.CRON_SECRET || '').trim();
  const incoming = String(req.headers.authorization || req.query.secret || '')
    .replace(/^Bearer\s+/i, '').trim();
  if (secret && incoming !== secret) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  const base = (process.env.CRON_DISPATCH_BASE_URL || 'https://storegents.vercel.app').replace(/\/$/, '');
  const token = String(process.env.ADMIN_TOKEN || '').trim();
  if (!token) return res.status(500).json({ success: false, message: 'ADMIN_TOKEN ontbreekt.' });

  const targets = [
    'api/admin/store-customer-overview?period=month&refresh=1',
    'api/admin/top-customers?period=month&metric=spend&refresh=1',
  ];

  const results = await Promise.all(targets.map((t) => refresh(base, token, t)));
  return res.status(200).json({ success: true, refreshedAt: new Date().toISOString(), results });
}

export default trackedCron('customer-overview-refresh', handler);
