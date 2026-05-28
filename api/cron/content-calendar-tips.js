/**
 * Cron: GET /api/cron/content-calendar-tips
 * Schedule: '15 6 * * *'
 *
 * Vernieuwt de content-kalender-tips (weer verandert dagelijks). Handmatig:
 * ?adminToken=… of x-admin-token header.
 */

import { refreshContentCalendar } from '../../lib/content-calendar.js';

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
    const d = await refreshContentCalendar();
    return res.status(200).json({ success: true, tips: d.tips ? d.tips.length : 0, weatherDays: d.weather ? d.weather.length : 0, aiPlan: Boolean(d.aiPlan), generatedAt: d.generatedAt });
  } catch (e) {
    console.error('[cron/content-calendar-tips]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
