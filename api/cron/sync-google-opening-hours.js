import { getConfiguredGoogleStoreLocations, syncGoogleOpeningHoursToShopify } from '../../lib/google-shopify-opening-hours.js';
import { trackedCron } from '../../lib/cron-auto-track.js';
import { withCronLog } from '../../lib/gents-cron-log-store.js';

async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ success: false, message: 'Alleen GET of POST is toegestaan.' });
  }

  const cronSecret = process.env.CRON_SECRET || '';
  const adminToken = String(process.env.ADMIN_TOKEN || '12345').trim();
  const header = req.headers.authorization || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  const givenAdmin = String(req.headers['x-admin-token'] || req.query.adminToken || '').trim();
  const isCronAuthorized =
    (!cronSecret || token === cronSecret || req.query.secret === cronSecret) ||
    (adminToken && givenAdmin && adminToken === givenAdmin);

  if (!isCronAuthorized) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  const dryRun = String(req.query.dryRun || req.body?.dryRun || '') === 'true';

  try {
    const syncResult = await withCronLog(
      { job: 'sync-google-opening-hours', source: 'cron', meta: { dryRun } },
      async () => {
        const locations = getConfiguredGoogleStoreLocations();
        const results = [];
        const errors = [];

        for (const location of locations) {
          try {
            const r = await syncGoogleOpeningHoursToShopify(location, { dryRun });
            results.push(r);
          } catch (err) {
            errors.push({ store: location.store || 'onbekend', message: err.message || String(err) });
          }
        }

        return {
          success: errors.length === 0,
          dryRun,
          synced: results.length,
          failed: errors.length,
          results,
          errors
        };
      }
    );

    return res.status(syncResult.failed > 0 ? 207 : 200).json(syncResult);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Synchroniseren mislukt.' });
  }
}

export default trackedCron('sync-google-opening-hours', handler);
