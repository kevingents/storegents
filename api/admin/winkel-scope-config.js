/**
 * GET  /api/admin/winkel-scope-config  → alle winkels + welke meetellen
 * POST /api/admin/winkel-scope-config  → sla overrides op { excluded, included }
 *
 * Centrale winkel-scope: welke winkels tellen mee in rapportages & functies.
 * Config in de tool (blob), bewerkbaar via het Instellingen-menu. Auth: admin-token.
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { getWinkelScopeConfig, saveWinkelScopeConfig } from '../../lib/winkel-scope-config-store.js';

function serialize(cfg) {
  return {
    rows: cfg.rows,
    inScopeStores: [...cfg.inScopeStores],
    excluded: cfg.excluded,
    included: cfg.included,
    updatedAt: cfg.updatedAt
  };
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const cfg = await saveWinkelScopeConfig({ excluded: body.excluded || [], included: body.included || [] });
      return res.status(200).json({ success: true, ...serialize(cfg) });
    }
    const cfg = await getWinkelScopeConfig();
    return res.status(200).json({ success: true, ...serialize(cfg) });
  } catch (e) {
    console.error('[admin/winkel-scope-config]', e);
    return res.status(200).json({ success: false, message: e.message || 'Winkel-scope laden/opslaan mislukt.' });
  }
}
