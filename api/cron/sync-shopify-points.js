import pointsSyncHandler from '../admin/points/sync-shopify-metafields.js';
import { trackedCron } from '../../lib/cron-auto-track.js';

async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ success: false, message: 'Alleen GET of POST is toegestaan.' });
  }

  const cronSecret = process.env.CRON_SECRET || '';
  const header = req.headers.authorization || '';
  const token = header.replace(/^Bearer\s+/i, '');
  const isCronAuthorized = !cronSecret || token === cronSecret || req.query.secret === cronSecret;

  if (!isCronAuthorized) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  req.headers['x-admin-token'] = process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()));

  if (req.method === 'GET') {
    req.method = 'POST';
    req.body = { dryRun: String(req.query.dryRun || '') === 'true' };
  }

  return pointsSyncHandler(req, res);
}

export default trackedCron('sync-shopify-points', handler);
