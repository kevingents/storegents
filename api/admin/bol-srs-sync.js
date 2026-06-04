/**
 * Admin endpoint voor Bol → SRS push (vervangt Shopify push).
 *
 *   GET  /api/admin/bol-srs-sync                  → pushed-state + counter-info
 *   GET  /api/admin/bol-srs-sync?dryRun=1         → preview
 *   POST /api/admin/bol-srs-sync?max=10           → echte push
 *   POST /api/admin/bol-srs-sync?force=1          → herpush al-gepushte orders
 */

import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { pushBolOrdersToSrs, readBolSrsPushedState } from '../../lib/bol-srs-push.js';
import { readBolOrderCounter } from '../../lib/bol-order-counter.js';

export const maxDuration = 180;

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (requireAdmin(req, res)) return;

  const dryRun = String(req.query?.dryRun || '') === '1';
  const force = String(req.query?.force || '') === '1';
  const maxPerRun = Number(req.query?.max || 50);

  if (req.method === 'GET' && !dryRun) {
    const [state, counter] = await Promise.all([readBolSrsPushedState(), readBolOrderCounter()]);
    return res.status(200).json({
      success: true,
      pushedCount: Object.keys(state.pushed || {}).length,
      updatedAt: state.updatedAt,
      runCount: state.runCount || 0,
      counter,
      pushed: state.pushed || {},
      recent: Object.entries(state.pushed || {})
        .map(([bolOrderId, info]) => ({ bolOrderId, ...info }))
        .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
        .slice(0, 50)
    });
  }

  try {
    const result = await pushBolOrdersToSrs({ dryRun, maxPerRun, force });
    return res.status(200).json(result);
  } catch (e) {
    console.error('[admin/bol-srs-sync]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
