import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import {
  getShipCutoffConfig,
  saveShipCutoffConfig,
  DEFAULT_CUTOFF_CONFIG
} from '../../lib/order-cutoff-config-store.js';
import { runSelfChecks, computeShipDeadline } from '../../lib/ship-deadline.js';

/**
 * GET  /api/admin/order-cutoff-config            → huidige config + defaults
 * GET  /api/admin/order-cutoff-config?selfCheck=1 → + edge-case self-checks
 * POST /api/admin/order-cutoff-config            → sla winkel/online cutoff op
 *
 * Body (POST), alle velden optioneel:
 *   { winkel: { shipByWorkingDays, cutoffHour, cutoffMinute },
 *     online: { ... } }
 *
 * Verzend-deadline (per kanaal): orders ná de cutoff (default 14:00, NL-tijd)
 * tellen als de volgende werkdag besteld; weekend → maandag. shipByWorkingDays=1
 * = verzonden vóór einde van de effectieve order-werkdag.
 */

function pickChannel(input = {}) {
  const out = {};
  if (input.shipByWorkingDays !== undefined) out.shipByWorkingDays = Number(input.shipByWorkingDays);
  if (input.cutoffHour !== undefined) out.cutoffHour = Number(input.cutoffHour);
  if (input.cutoffMinute !== undefined) out.cutoffMinute = Number(input.cutoffMinute);
  return out;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const config = await getShipCutoffConfig();
      const payload = { success: true, config, defaults: DEFAULT_CUTOFF_CONFIG };

      if (['1', 'true', 'yes'].includes(String(req.query.selfCheck || '').toLowerCase())) {
        payload.selfCheck = runSelfChecks();
      }
      /* Optioneel: bereken de deadline voor een meegegeven order-timestamp +
         kanaal (handig voor een live preview in de settings-UI). */
      const previewAt = String(req.query.previewAt || '').trim();
      if (previewAt) {
        const channel = String(req.query.channel || 'winkel').toLowerCase().includes('online') ? 'online' : 'winkel';
        payload.preview = {
          channel,
          orderedAt: previewAt,
          deadline: computeShipDeadline(previewAt, config[channel])
        };
      }
      return res.status(200).json(payload);
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const partial = {};
      if (body.winkel) partial.winkel = pickChannel(body.winkel);
      if (body.online) partial.online = pickChannel(body.online);
      if (!partial.winkel && !partial.online) {
        return res.status(400).json({ success: false, message: 'Geen winkel- of online-config meegegeven.' });
      }
      const saved = await saveShipCutoffConfig(partial);
      return res.status(200).json({ success: true, config: saved });
    }

    return res.status(405).json({ success: false, message: 'Alleen GET of POST.' });
  } catch (error) {
    console.error('[admin/order-cutoff-config]', error);
    return res.status(500).json({ success: false, message: error.message || 'Cutoff-config kon niet worden verwerkt.' });
  }
}
