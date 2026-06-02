/**
 * PushOwl REST API client (Shopify push-app).
 *
 * Vereist env-var: PUSHOWL_API_KEY
 * Beschikbaar via PushOwl Dashboard → Settings → API/Integrations.
 *
 * Docs: https://docs.pushowl.com/
 *
 * Gebruik:
 *   await sendPushToTag('store_GENTS_Delft', { title, body, url });
 *   await sendPushToAllStaff({ title, body, url });
 */

const PUSHOWL_BASE = process.env.PUSHOWL_API_BASE || 'https://app.pushowl.com/api/v2';

function getApiKey() {
  return String(process.env.PUSHOWL_API_KEY || '').trim();
}

function isConfigured() {
  return Boolean(getApiKey());
}

async function pushowlFetch(path, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('PUSHOWL_API_KEY niet ingesteld in Vercel env.');

  const url = `${PUSHOWL_BASE}${path}`;
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'Authorization': `Token ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) {
    const err = new Error(data.message || data.error || `PushOwl HTTP ${response.status}`);
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * Stuur een push notificatie naar subscribers met specifieke tag.
 * Tag-conventie voor staff: 'staff_<storeSlug>' (bv 'staff_gents_delft').
 */
export async function sendPushToTag(tag, { title, body, url, image, icon } = {}) {
  if (!isConfigured()) return { sent: false, reason: 'pushowl-not-configured' };
  if (!title || !body) throw new Error('title en body zijn verplicht');

  /* Endpoint kan verschillen per PushOwl plan / versie.
     v2: POST /campaigns/  met segment criteria */
  const payload = {
    type: 'instant',
    title: String(title).slice(0, 80),
    message: String(body).slice(0, 500),
    target_url: url || 'https://gents.nl/pages/winkel-portaal',
    image_url: image || undefined,
    icon_url: icon || undefined,
    segment: {
      include_tags: [tag]
    }
  };

  try {
    const result = await pushowlFetch('/campaigns/', { method: 'POST', body: payload });
    return { sent: true, campaignId: result.id || result.campaign_id, raw: result };
  } catch (error) {
    console.error('[pushowl] send fail:', error);
    return { sent: false, reason: error.message, status: error.status };
  }
}

export async function sendPushToStores(stores = [], notification = {}) {
  if (!isConfigured()) return { sent: false, reason: 'pushowl-not-configured', perStore: [] };
  const targets = stores && stores.length && !stores.includes('*')
    ? stores
    : ['all_staff']; /* Wildcard → algemeen staff segment */

  const results = await Promise.all(targets.map(async (store) => {
    const tag = store === 'all_staff'
      ? 'all_staff'
      : `staff_${String(store).toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')}`;
    const r = await sendPushToTag(tag, notification);
    return { store, tag, ...r };
  }));

  const sentCount = results.filter(r => r.sent).length;
  return { sent: sentCount > 0, sentCount, perStore: results };
}

export async function getSubscriberCount() {
  if (!isConfigured()) return null;
  try {
    const r = await pushowlFetch('/store/subscribers/');
    return r.count || r.total || r.subscriber_count || null;
  } catch (_) { return null; }
}

/**
 * Marketing-web-push-campagne naar KLANT-abonnees (i.t.t. de staff-helpers).
 * segmentTag leeg = alle abonnees; anders alleen subscribers met die tag.
 */
export async function sendMarketingPush({ title, body, url, image, segmentTag } = {}) {
  if (!isConfigured()) return { sent: false, reason: 'pushowl-not-configured' };
  if (!title || !body) throw new Error('Titel en tekst zijn verplicht.');
  const payload = {
    type: 'instant',
    title: String(title).slice(0, 80),
    message: String(body).slice(0, 500),
    target_url: url || 'https://gents.nl',
    image_url: image || undefined
  };
  /* Tag → segment; geen tag → alle abonnees (segment weggelaten). */
  if (segmentTag) payload.segment = { include_tags: [String(segmentTag)] };
  try {
    const result = await pushowlFetch('/campaigns/', { method: 'POST', body: payload });
    return { sent: true, campaignId: result.id || result.campaign_id, raw: result };
  } catch (error) {
    console.error('[pushowl] marketing send fail:', error);
    return { sent: false, reason: error.message, status: error.status, data: error.data };
  }
}

/** Recente campagnes uit PushOwl (best-effort; null als niet beschikbaar). */
export async function listPushCampaigns() {
  if (!isConfigured()) return null;
  try {
    const r = await pushowlFetch('/campaigns/');
    const arr = Array.isArray(r) ? r : (r.results || r.campaigns || r.data || []);
    return Array.isArray(arr) ? arr.slice(0, 25) : null;
  } catch (_) { return null; }
}

export function pushowlConfigured() {
  return isConfigured();
}
