/**
 * /api/admin/pushowl
 *
 * Web-push-marketing via PushOwl (Shopify push-app).
 *   GET                    → { configured, subscriberCount, campaigns (log), remote }
 *   POST ?action=send      { title, body, url, image, segmentTag } → campagne versturen
 *
 * Auth: admin-token vereist. Secret: PUSHOWL_API_KEY (Vercel env).
 */

import { sendMarketingPush, getSubscriberCount, listPushCampaigns, pushowlConfigured } from '../../lib/pushowl-client.js';
import { listLoggedCampaigns, logCampaign } from '../../lib/pushowl-campaigns-store.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 30;

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  const configured = pushowlConfigured();

  try {
    if (req.method === 'GET') {
      if (!configured) {
        return res.status(200).json({ success: true, configured: false, message: 'PushOwl niet gekoppeld (PUSHOWL_API_KEY ontbreekt in Vercel).', campaigns: await listLoggedCampaigns() });
      }
      const [subscriberCount, remote, campaigns] = await Promise.all([
        getSubscriberCount(),
        listPushCampaigns(),
        listLoggedCampaigns()
      ]);
      return res.status(200).json({ success: true, configured: true, subscriberCount, remote, campaigns });
    }

    const action = String(req.query?.action || '').trim();
    const body = parseBody(req);

    if (action === 'send') {
      if (!configured) return res.status(400).json({ success: false, message: 'PushOwl niet gekoppeld.' });
      const title = String(body.title || '').trim();
      const text = String(body.body || '').trim();
      if (!title || !text) return res.status(400).json({ success: false, message: 'Titel en tekst zijn verplicht.' });
      const subscriberCount = await getSubscriberCount();
      const r = await sendMarketingPush({ title, body: text, url: body.url, image: body.image, segmentTag: body.segmentTag });
      await logCampaign({ title, body: text, url: body.url, image: body.image, segmentTag: body.segmentTag, subscriberCount, ok: r.sent, campaignId: r.campaignId, error: r.sent ? '' : r.reason });
      if (!r.sent) return res.status(400).json({ success: false, message: r.reason || 'Versturen mislukt.' });
      return res.status(200).json({ success: true, sent: true, campaignId: r.campaignId || null });
    }

    return res.status(400).json({ success: false, message: 'Onbekende actie.' });
  } catch (e) {
    console.error('[admin/pushowl]', e);
    return res.status(500).json({ success: false, message: e.message || 'PushOwl-actie mislukt.' });
  }
}
