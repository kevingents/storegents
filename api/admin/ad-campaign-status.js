import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { setMetaCampaignStatus } from '../../lib/meta-ads-create.js';

/**
 * POST /api/admin/ad-campaign-status
 * body: { platform:'meta', id:'<campaignId>', action:'pause'|'activate' }
 *
 * Pauzeert of activeert een lopende advertentiecampagne vanuit de portal.
 * Alleen Meta wordt ondersteund (write via ads_management). Google Ads is
 * read-only — daarvoor verwijzen we naar Google Ads zelf.
 *
 * Veilig: reversibel (pause ↔ activate), en zonder actief budget kost activeren
 * niets. Vereist op het Meta-token de scope ads_management.
 */

export const maxDuration = 30;

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });
  if (requireAdmin(req, res)) return;

  const b = parseBody(req);
  const platform = String(b.platform || '').toLowerCase().trim();
  const id = String(b.id || b.campaignId || '').trim();
  const action = String(b.action || b.status || '').toLowerCase().trim();
  const status = ['pause', 'paused', 'pauzeren'].includes(action) ? 'PAUSED'
    : ['activate', 'active', 'enable', 'enabled', 'activeren'].includes(action) ? 'ACTIVE'
    : '';

  if (!id) return res.status(400).json({ success: false, message: 'Campagne-id ontbreekt.' });
  if (!status) return res.status(400).json({ success: false, message: 'Actie moet "pause" of "activate" zijn.' });

  try {
    if (platform === 'meta') {
      const r = await setMetaCampaignStatus(id, status);
      return res.status(200).json({
        success: r.ok,
        platform, id, status,
        message: r.ok
          ? (status === 'PAUSED' ? 'Campagne gepauzeerd.' : 'Campagne geactiveerd.')
          : (r.error || 'Status wijzigen mislukte.'),
        hint: r.hint || null
      });
    }
    if (platform === 'google') {
      return res.status(200).json({
        success: false, platform, id,
        message: 'Google Ads-campagnes pauzeren kan nog niet vanuit de portal — beheer dit in Google Ads.',
        hint: 'Voor Google is een schrijf-koppeling (campaign mutate) nodig die nu niet is ingesteld.'
      });
    }
    return res.status(400).json({ success: false, message: `Onbekend platform: ${platform || '(leeg)'}.` });
  } catch (error) {
    console.error('[admin/ad-campaign-status]', error);
    return res.status(200).json({ success: false, message: error.message || 'Status wijzigen mislukte.' });
  }
}
