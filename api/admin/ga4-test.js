/**
 * GET /api/admin/ga4-test
 *
 * Verbindingstest voor de Google Analytics (GA4) Data API: valideert OAuth-token,
 * de analytics.readonly-scope, GA4_PROPERTY_ID en doet één mini-runReport.
 * Gooit nooit — toont per onderdeel wat werkt en wat ontbreekt.
 *
 * Auth: admin-token (header x-admin-token).
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { probeGa4 } from '../../lib/ga4-client.js';

export const maxDuration = 30;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    const report = await probeGa4();
    return res.status(200).json({ success: true, ...report });
  } catch (e) {
    return res.status(200).json({ success: false, message: e.message || 'GA4-diagnose mislukt.' });
  }
}
