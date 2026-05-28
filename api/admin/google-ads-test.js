/**
 * GET /api/admin/google-ads-test
 *
 * Diagnose van de Google Ads-koppeling: ververst het OAuth-token, rapporteert
 * de werkelijk verleende scopes en (indien developer token aanwezig) test de
 * Ads-API met listAccessibleCustomers. Schrijft niets weg.
 *
 * Auth: admin-token vereist.
 */

import { probeGoogleAds } from '../../lib/google-ads-client.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 30;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    const result = await probeGoogleAds();
    return res.status(200).json({ success: true, ...result });
  } catch (e) {
    console.error('[admin/google-ads-test]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
