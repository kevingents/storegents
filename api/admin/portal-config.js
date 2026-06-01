/**
 * /api/admin/portal-config
 *
 * Centrale portal-instellingen die in de tool zelf (Instellingen-menu) ingesteld
 * worden i.p.v. Vercel env-vars. GET leest, POST bewaart (deel-)config.
 *
 * GET  → { config, env } (env toont welke env-fallbacks gezet zijn, alleen booleans/
 *         maskering, nooit secret-waarden).
 * POST { inkoop?, hr?, notify? } → opslaan, returnt nieuwe config.
 *
 * Auth: admin-token vereist.
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { readPortalConfig, savePortalConfig } from '../../lib/portal-config-store.js';

export const maxDuration = 20;

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
}
function actorOf(req) {
  return String(req.headers['x-gents-actor'] || parseBody(req).actor || '').trim() || 'admin';
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'POST') {
      const body = parseBody(req);
      const config = await savePortalConfig({ inkoop: body.inkoop, hr: body.hr, notify: body.notify }, actorOf(req));
      return res.status(200).json({ success: true, config });
    }
    const config = await readPortalConfig();
    /* Toon (zonder secrets) welke env-fallbacks aanwezig zijn, zodat de UI kan
       laten zien "staat ook in Vercel". */
    const env = {
      srsConfigurationId: Boolean(String(process.env.SRS_PO_CONFIGURATION_ID || '').trim()),
      srsOrderType: Boolean(String(process.env.SRS_PO_ORDER_TYPE || '').trim()),
      werktijdenExcludeDepts: String(process.env.WERKTIJDEN_EXCLUDE_DEPTS || '').trim(),
      werktijdenOfficeDepts: String(process.env.WERKTIJDEN_OFFICE_DEPTS || '').trim()
    };
    return res.status(200).json({ success: true, config, env });
  } catch (e) {
    console.error('[admin/portal-config]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
