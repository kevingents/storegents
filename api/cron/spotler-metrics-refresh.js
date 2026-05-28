/**
 * Cron: GET /api/cron/spotler-metrics-refresh
 * Schedule: '45 5 * * *'
 *
 * Vernieuwt de gecachte Spotler e-mailmarketing-metrics (mailings + stats).
 * Handmatig: ?adminToken=… of x-admin-token header.
 */

import { refreshSpotlerMetrics } from '../../lib/spotler-metrics.js';

export const maxDuration = 60;

function isAuthorized(req) {
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  if (ua.includes('vercel-cron')) return true;
  if (req.headers['x-vercel-cron']) return true;
  const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
  const token = String(req.headers['x-admin-token'] || req.query?.adminToken || '').trim();
  return Boolean(adminToken && token && token === adminToken);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    const d = await refreshSpotlerMetrics();
    return res.status(200).json({
      success: true,
      connected: d.connected,
      mailings: d.rows ? d.rows.length : 0,
      refreshedAt: d.refreshedAt
    });
  } catch (e) {
    console.error('[cron/spotler-metrics-refresh]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
