/**
 * /api/admin/bol-settings
 *
 * GET  → huidige bol-marketplace-instellingen (marge, verzendkosten, toggles).
 * POST → sla (deel van) de instellingen op.
 *
 * Auth: admin-token vereist.
 */

import { getBolSettings, saveBolSettings } from '../../lib/bol-settings-store.js';
import { isBolConfigured } from '../../lib/bol-client.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 30;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      return res.status(200).json({ success: true, bolGekoppeld: isBolConfigured(), settings: await getBolSettings() });
    }
    if (req.method === 'POST') {
      const settings = await saveBolSettings(req.body || {});
      return res.status(200).json({ success: true, settings });
    }
    return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });
  } catch (error) {
    console.error('[admin/bol-settings]', error);
    return res.status(500).json({ success: false, message: error.message || 'bol-instellingen mislukt.' });
  }
}
