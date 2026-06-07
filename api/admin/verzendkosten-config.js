/**
 * GET  /api/admin/verzendkosten-config  → huidige config + code-defaults
 * POST /api/admin/verzendkosten-config  → sla (gedeeltelijke) update op
 *
 * Kosten-aannames voor de netto-POAS: verzendkost/zending, picking/order,
 * klant-verzendtarief + gratis-drempel, optioneel transactie-% (PSP). Config in
 * de tool (blob), bewerkbaar via het Instellingen-menu. Auth: admin-token.
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import {
  getVerzendkostenConfig,
  saveVerzendkostenConfig,
  DEFAULT_VERZENDKOSTEN_CONFIG
} from '../../lib/verzendkosten-config-store.js';

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const config = await saveVerzendkostenConfig(body);
      return res.status(200).json({ success: true, config, defaults: DEFAULT_VERZENDKOSTEN_CONFIG });
    }
    const config = await getVerzendkostenConfig();
    return res.status(200).json({ success: true, config, defaults: DEFAULT_VERZENDKOSTEN_CONFIG });
  } catch (e) {
    console.error('[admin/verzendkosten-config]', e);
    return res.status(200).json({ success: false, message: e.message || 'Config laden/opslaan mislukt.' });
  }
}
