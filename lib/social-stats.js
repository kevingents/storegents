/**
 * lib/social-stats.js
 *
 * Social-media-statistieken van het eigen Instagram-businessaccount (en de
 * gekoppelde Facebook-pagina): profiel (volgers, #posts), volgersgroei + bereik
 * per dag, en de recente posts met likes/comments. Read-only.
 *
 * Hergebruikt het Meta System-User-token (getInstagramToken) + INSTAGRAM_BUSINESS_ID.
 * Profiel + posts werken met `instagram_basic`. De groei-/bereik-inzichten
 * vereisen extra de scope `instagram_manage_insights` — ontbreekt die, dan komt
 * de rest gewoon door en tonen we een nette melding.
 */

import { getInstagramToken } from './gala-instagram.js';

const clean = (v) => String(v == null ? '' : v).trim();
const ver = () => clean(process.env.META_ADS_API_VERSION) || 'v21.0';
const igId = () => clean(process.env.INSTAGRAM_BUSINESS_ID || process.env.IG_BUSINESS_ID);

async function graph(path, params, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const qs = new URLSearchParams(params);
    const r = await fetch(`https://graph.facebook.com/${ver()}/${path}?${qs.toString()}`, { signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) { const e = new Error((j.error && j.error.message) || `HTTP ${r.status}`); e.code = j.error && j.error.code; throw e; }
    return j;
  } finally { clearTimeout(t); }
}

/**
 * @param {{days?:number}} opts  aantal dagen voor groei/bereik (max 30).
 */
export async function getSocialStats({ days = 30 } = {}) {
  const token = getInstagramToken();
  const id = igId();
  if (!token || !id) {
    return { configured: false, error: !token ? 'Geen Meta-token (META_ADS_ACCESS_TOKEN).' : 'INSTAGRAM_BUSINESS_ID ontbreekt in Vercel.' };
  }
  const out = { configured: true, refreshedAt: new Date().toISOString() };

  /* Profiel */
  try {
    const p = await graph(id, { fields: 'username,name,followers_count,media_count,profile_picture_url,biography,website', access_token: token });
    out.profile = {
      username: p.username || null, name: p.name || null,
      followers: p.followers_count ?? null, mediaCount: p.media_count ?? null,
      avatar: p.profile_picture_url || null, bio: p.biography || null, website: p.website || null
    };
  } catch (e) { return { configured: true, error: `Profiel ophalen mislukte: ${e.message}` }; }

  /* Recente posts */
  try {
    const m = await graph(`${id}/media`, { fields: 'id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count', limit: '12', access_token: token });
    out.posts = (m.data || []).map((x) => ({
      id: x.id,
      caption: clean(x.caption).slice(0, 180),
      type: x.media_product_type || x.media_type || null,
      permalink: x.permalink || null,
      thumb: x.thumbnail_url || x.media_url || null,
      at: x.timestamp || null,
      likes: x.like_count ?? null,
      comments: x.comments_count ?? null
    }));
  } catch (e) { out.postsError = e.message; out.posts = []; }

  /* Volgersgroei + bereik per dag (best-effort — vereist instagram_manage_insights) */
  const until = Math.floor(Date.now() / 1000);
  const since = until - Math.min(30, Math.max(1, days)) * 86400;
  try {
    const ins = await graph(`${id}/insights`, { metric: 'follower_count,reach', period: 'day', since: String(since), until: String(until), access_token: token });
    const byMetric = {};
    for (const it of (ins.data || [])) byMetric[it.name] = (it.values || []).map((v) => ({ day: clean(v.end_time).slice(0, 10), value: Number(v.value || 0) }));
    out.followerGrowth = byMetric.follower_count || [];
    out.reachDaily = byMetric.reach || [];
    out.followerGrowthTotal = (byMetric.follower_count || []).reduce((s, v) => s + v.value, 0);
    out.reachTotal = (byMetric.reach || []).reduce((s, v) => s + v.value, 0);
    out.insightsOk = true;
  } catch (e) {
    out.insightsOk = false;
    out.insightsError = `Groei/bereik niet beschikbaar — voeg de scope instagram_manage_insights toe aan het token (${e.message}).`;
  }

  /* Facebook-pagina-volgers (bonus) */
  try {
    const pa = await graph('me/accounts', { fields: 'name,followers_count,fan_count,instagram_business_account', access_token: token });
    const pg = (pa.data || []).find((p) => p.instagram_business_account && p.instagram_business_account.id === id) || (pa.data || [])[0];
    if (pg) out.facebook = { page: pg.name || null, followers: pg.followers_count ?? pg.fan_count ?? null };
  } catch (_) { /* optioneel */ }

  return out;
}
