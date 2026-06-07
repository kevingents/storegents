/**
 * GET /api/admin/dhl-test
 *
 * Verbindingstest voor de DHL Parcel API: authenticeert met de Vercel-creds
 * (DHL_API_KEY + DHL_USERID) en geeft de gekoppelde account-nummers + token-
 * geldigheid terug. Auth: admin-token.
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { probeDhl } from '../../lib/dhl-parcel-client.js';

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const result = await probeDhl();
  return res.status(200).json({ success: result.ok, ...result });
}
