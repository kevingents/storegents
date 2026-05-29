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
import { trackedCron } from '../../lib/cron-auto-track.js';
import { isCronAuthorized } from '../../lib/cron-auth.js';

export const maxDuration = 60;

function isAuthorized(req) {
  return isCronAuthorized(req);
}

async function handler(req, res) {
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

export default trackedCron('beeldbank-classify', handler);
