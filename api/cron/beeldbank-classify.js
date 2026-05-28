/**
 * Cron: GET /api/cron/beeldbank-classify
 * Schedule: '30 6 * * *'
 *
 * Classificeert dagelijks een begrensde batch nog-niet-beoordeelde producten
 * voor het beeldbank-filter "Met model (sfeerbeeld)". Bounded zodat het binnen
 * de functielimiet blijft; nieuwe producten worden zo over enkele dagen ingelopen.
 * Handmatig: ?adminToken=… of x-admin-token header.
 */

import { classifyBatch } from '../../lib/beeldbank-vision.js';

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
    const r = await classifyBatch({ limit: 20 });
    return res.status(200).json({
      success: true,
      processed: r.processed,
      classified: r.classified,
      remaining: r.remaining,
      withModel: r.withModel,
      updatedAt: r.updatedAt
    });
  } catch (e) {
    console.error('[cron/beeldbank-classify]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
