/**
 * Cron: GET /api/cron/spotler-audience-sync
 * Schedule: '50 5 * * *'
 *
 * Synct opt-in GENTS-klanten naar de Spotler temp-lijst — maar ALLEEN als de
 * audience-sync is aangezet (config.enabled). Anders no-op. Handmatig:
 * ?adminToken=… of x-admin-token header.
 */

import { getAudienceConfig, runAudienceSync } from '../../lib/spotler-audience.js';
import { trackedCron } from '../../lib/cron-auto-track.js';

export const maxDuration = 60;

function isAuthorized(req) {
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  if (ua.includes('vercel-cron')) return true;
  if (req.headers['x-vercel-cron']) return true;
  const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
  const token = String(req.headers['x-admin-token'] || req.query?.adminToken || '').trim();
  return Boolean(adminToken && token && token === adminToken);
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    const cfg = await getAudienceConfig();
    if (!cfg.enabled) {
      return res.status(200).json({ success: true, skipped: true, reason: 'audience-sync staat uit' });
    }
    const result = await runAudienceSync({ dryRun: false });
    return res.status(200).json({ success: true, ...result });
  } catch (e) {
    console.error('[cron/spotler-audience-sync]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}

export default trackedCron('spotler-audience-sync', handler);
