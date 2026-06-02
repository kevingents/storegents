/**
 * lib/social-stats.js
 *
 * Social-media-statistieken, gesplitst per platform:
 *   - Instagram-businessaccount: profiel, volgersgroei, bereik, posts.
 *   - Facebook-pagina: volgers, paginabereik, engagement, groei, posts.
 * Plus een gecombineerde postenlijst (beide kanalen door elkaar, getagd met
 * `platform`). Read-only.
 *
 * Hergebruikt het Meta System-User-token (getInstagramToken) + INSTAGRAM_BUSINESS_ID.
 * Profiel + posts werken met `instagram_basic`. De groei-/bereik-inzichten van
 * Instagram vereisen `instagram_manage_insights`; die van Facebook vereisen
 * `read_insights` + `pages_read_engagement`. Ontbreken die, dan komt de rest
 * gewoon door met een nette melding.
 */

import { getInstagramToken } from './gala-instagram.js';
import { getPinterestStats } from './pinterest-stats.js';

const clean = (v) => String(v == null ? '' : v).trim();
const ver = () => clean(process.env.META_ADS_API_VERSION) || 'v21.0';
const igId = () => clean(process.env.INSTAGRAM_BUSINESS_ID || process.env.IG_BUSINESS_ID);
const sumVals = (arr) => (arr || []).reduce((s, v) => s + (Number(v.value) || 0), 0);

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

/* Bounded-concurrency map (per-post insights = 1 call/post). */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}

/* Per-IG-post insights: zo veel mogelijk metrics. Metric-namen wisselen per
   mediatype/API-versie, dus we proberen van breed naar smal. */
async function mediaInsights(mediaId, token) {
  const pick = (j) => {
    const o = {};
    for (const it of (j.data || [])) o[it.name] = Number((it.values && it.values[0] && it.values[0].value) || 0);
    return o;
  };
  const sets = [
    'reach,total_interactions,saved,shares,views,profile_visits',
    'reach,total_interactions,saved,shares,views',
    'reach,total_interactions,saved,shares',
    'reach,total_interactions,saved',
    'reach,total_interactions'
  ];
  for (const metric of sets) {
    try { return pick(await graph(`${mediaId}/insights`, { metric, access_token: token }, 12000)); } catch { /* kleinere set proberen */ }
  }
  return null;
}

/* Dag-insights over een willekeurige periode (>30d → in stukken van 30 dagen,
   want de API limiteert per request). Werkt voor zowel IG- als FB-page-metrics. */
async function insightsRange(id, token, metric, sinceTs, untilTs) {
  const out = {};
  let s = sinceTs;
  while (s < untilTs) {
    const e = Math.min(s + 30 * 86400, untilTs);
    const ins = await graph(`${id}/insights`, { metric, period: 'day', since: String(s), until: String(e), access_token: token });
    for (const it of (ins.data || [])) {
      out[it.name] = (out[it.name] || []).concat((it.values || []).map((v) => ({ day: clean(v.end_time).slice(0, 10), value: Number(v.value || 0) })));
    }
    s = e;
  }
  for (const k of Object.keys(out)) { const seen = new Set(); out[k] = out[k].filter((x) => (seen.has(x.day) ? false : (seen.add(x.day), true))); }
  return out;
}

/* Fashion-benchmark (instelbaar via env). engagement = interacties/bereik %;
   bereik = bereik als % van volgers. */
const BM = {
  engGood: Number(process.env.SOCIAL_ENG_GOOD_PCT || 5),
  engOk: Number(process.env.SOCIAL_ENG_OK_PCT || 2),
  reachGood: Number(process.env.SOCIAL_REACH_GOOD_PCT || 30),
  reachOk: Number(process.env.SOCIAL_REACH_OK_PCT || 12)
};
const verdict = (v, good, ok) => (v == null ? null : (v >= good ? 'goed' : (v >= ok ? 'gemiddeld' : 'laag')));
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

function prognose(followerGrowthTotal, span, days, followers) {
  const basis = span > 0 ? span : days;
  const avg = basis > 0 ? followerGrowthTotal / basis : 0;
  return {
    perDagGem: round1(avg),
    perMaand: Math.round(avg * 30),
    per3Maand: Math.round(avg * 90),
    basisDagen: basis,
    volgersOver3Maand: followers != null ? Math.round(followers + avg * 90) : null
  };
}

/* ─────────────────────────── Instagram ─────────────────────────── */
async function instagramStats(id, token, days, until, since) {
  const ig = { platform: 'instagram', configured: true };
  /* Profiel */
  const p = await graph(id, { fields: 'username,name,followers_count,media_count,profile_picture_url,biography,website', access_token: token });
  ig.username = p.username || null;
  ig.name = p.name || null;
  ig.followers = p.followers_count ?? null;
  ig.mediaCount = p.media_count ?? null;
  ig.postCount = p.media_count ?? null;
  ig.avatar = p.profile_picture_url || null;
  ig.bio = p.biography || null;
  ig.website = p.website || null;

  /* Recente posts */
  let posts = [];
  try {
    const m = await graph(`${id}/media`, { fields: 'id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count', limit: '12', access_token: token });
    posts = (m.data || []).map((x) => ({
      id: x.id, platform: 'instagram',
      caption: clean(x.caption).slice(0, 180),
      type: x.media_product_type || x.media_type || null,
      permalink: x.permalink || null,
      thumb: x.thumbnail_url || x.media_url || null,
      at: x.timestamp || null,
      likes: x.like_count ?? null,
      comments: x.comments_count ?? null
    }));
  } catch (e) { ig.postsError = e.message; }

  /* Volgersgroei + bereik per dag. */
  try {
    const byMetric = await insightsRange(id, token, 'follower_count,reach', since, until);
    ig.followerGrowth = byMetric.follower_count || [];
    ig.reachDaily = byMetric.reach || [];
    ig.followerGrowthTotal = sumVals(ig.followerGrowth);
    ig.reachTotal = sumVals(ig.reachDaily);
    ig.insightsOk = true;
    ig.prognosis = prognose(ig.followerGrowthTotal, ig.followerGrowth.length, days, ig.followers);
  } catch (e) {
    ig.insightsOk = false;
    ig.insightsError = `Groei/bereik niet beschikbaar — voeg de scope instagram_manage_insights toe aan het token (${e.message}).`;
  }

  /* Per-post insights + fashion-benchmark. */
  if (ig.insightsOk && posts.length) {
    const followers = ig.followers != null ? ig.followers : null;
    await mapPool(posts, 5, async (po) => {
      const ins = await mediaInsights(po.id, token);
      if (!ins) return;
      po.metrics = ins;
      po.reach = ins.reach ?? null;
      po.interactions = ins.total_interactions ?? null;
      po.saved = ins.saved ?? null;
      po.shares = ins.shares ?? null;
      po.views = ins.views ?? null;
      po.profileVisits = ins.profile_visits ?? null;
      po.engagementPct = (ins.reach > 0 && ins.total_interactions != null) ? round1((ins.total_interactions / ins.reach) * 100) : null;
      po.reachPct = (followers > 0 && ins.reach != null) ? round1((ins.reach / followers) * 100) : null;
      po.engVerdict = verdict(po.engagementPct, BM.engGood, BM.engOk);
      po.reachVerdict = verdict(po.reachPct, BM.reachGood, BM.reachOk);
    });
    const eng = posts.map((p) => p.engagementPct).filter((v) => v != null);
    ig.avgEngagementPct = eng.length ? round1(eng.reduce((s, v) => s + v, 0) / eng.length) : null;
    const reached = posts.map((p) => p.reach).filter((v) => v != null);
    ig.postsReachAvg = reached.length ? Math.round(reached.reduce((s, v) => s + v, 0) / reached.length) : null;
  }
  ig.posts = posts;
  return ig;
}

/* ─────────────────────────── Facebook ─────────────────────────── */
async function facebookStats(page, days, until, since) {
  const fb = { platform: 'facebook', configured: true };
  fb.name = page.name || null;
  fb.pageId = page.id || null;
  fb.avatar = (page.picture && page.picture.data && page.picture.data.url) || null;
  fb.followers = (page.followers_count != null ? page.followers_count : (page.fan_count != null ? page.fan_count : null));
  fb.fanCount = page.fan_count != null ? page.fan_count : null;
  /* Pagina-token: page insights vereisen het pagina-token (niet het user-token). */
  const token = page.access_token || getInstagramToken();

  /* Pagina-insights: bereik, engagement, nieuwe volgers per dag. */
  try {
    const m = await insightsRange(page.id, token, 'page_impressions_unique,page_post_engagements,page_daily_follows_unique', since, until);
    fb.reachDaily = m.page_impressions_unique || [];
    fb.engagementDaily = m.page_post_engagements || [];
    fb.followerGrowth = m.page_daily_follows_unique || [];
    fb.reachTotal = sumVals(fb.reachDaily);
    fb.engagementTotal = sumVals(fb.engagementDaily);
    fb.followerGrowthTotal = sumVals(fb.followerGrowth);
    fb.insightsOk = true;
    fb.prognosis = prognose(fb.followerGrowthTotal, fb.followerGrowth.length, days, fb.followers);
  } catch (e) {
    fb.insightsOk = false;
    fb.insightsError = `FB-inzichten niet beschikbaar — token mist mogelijk read_insights / pages_read_engagement (${e.message}).`;
  }

  /* Recente pagina-posts. */
  let posts = [];
  try {
    const pr = await graph(`${page.id}/published_posts`, {
      fields: 'message,created_time,permalink_url,full_picture,shares,reactions.summary(true),comments.summary(true)',
      limit: '8', access_token: token
    });
    posts = (pr.data || []).map((x) => ({
      id: x.id, platform: 'facebook',
      caption: clean(x.message).slice(0, 180),
      type: 'FEED',
      permalink: x.permalink_url || null,
      thumb: x.full_picture || null,
      at: x.created_time || null,
      likes: (x.reactions && x.reactions.summary) ? (x.reactions.summary.total_count ?? null) : null,
      comments: (x.comments && x.comments.summary) ? (x.comments.summary.total_count ?? null) : null,
      shares: (x.shares && x.shares.count != null) ? x.shares.count : null
    }));
  } catch (e) { fb.postsError = e.message; }

  /* Per-post bereik (best-effort) + benchmark. */
  if (fb.insightsOk && posts.length) {
    const followers = fb.followers != null ? fb.followers : null;
    await mapPool(posts, 4, async (po) => {
      try {
        const ins = await graph(`${po.id}/insights`, { metric: 'post_impressions_unique', access_token: token }, 10000);
        const v = (ins.data && ins.data[0] && ins.data[0].values && ins.data[0].values[0]) ? Number(ins.data[0].values[0].value || 0) : null;
        po.reach = v;
      } catch { po.reach = null; }
      const inter = (po.likes || 0) + (po.comments || 0) + (po.shares || 0);
      po.interactions = inter;
      po.engagementPct = (po.reach > 0) ? round1((inter / po.reach) * 100) : null;
      po.reachPct = (followers > 0 && po.reach != null) ? round1((po.reach / followers) * 100) : null;
      po.engVerdict = verdict(po.engagementPct, BM.engGood, BM.engOk);
      po.reachVerdict = verdict(po.reachPct, BM.reachGood, BM.reachOk);
    });
    const eng = posts.map((p) => p.engagementPct).filter((v) => v != null);
    fb.avgEngagementPct = eng.length ? round1(eng.reduce((s, v) => s + v, 0) / eng.length) : null;
    const reached = posts.map((p) => p.reach).filter((v) => v != null);
    fb.postsReachAvg = reached.length ? Math.round(reached.reduce((s, v) => s + v, 0) / reached.length) : null;
  }
  fb.posts = posts;
  fb.postCount = posts.length || null;
  return fb;
}

/**
 * @param {{days?:number}} opts  aantal dagen voor groei/bereik (7/30/90).
 */
export async function getSocialStats({ days = 30 } = {}) {
  const token = getInstagramToken();
  const id = igId();
  if (!token || !id) {
    return { configured: false, error: !token ? 'Geen Meta-token (META_ADS_ACCESS_TOKEN).' : 'INSTAGRAM_BUSINESS_ID ontbreekt in Vercel.' };
  }
  const dayN = Math.min(90, Math.max(1, days));
  const until = Math.floor(Date.now() / 1000);
  const since = until - dayN * 86400;
  const out = { configured: true, refreshedAt: new Date().toISOString(), days: dayN };

  /* Instagram (verplicht — profiel-fout = harde fout). */
  let ig;
  try { ig = await instagramStats(id, token, dayN, until, since); }
  catch (e) { return { configured: true, error: `Profiel ophalen mislukte: ${e.message}` }; }

  /* Facebook-pagina (optioneel). */
  let fb = { platform: 'facebook', configured: false, posts: [] };
  try {
    const pa = await graph('me/accounts', { fields: 'name,id,access_token,followers_count,fan_count,picture,instagram_business_account', access_token: token });
    const page = (pa.data || []).find((p) => p.instagram_business_account && String(p.instagram_business_account.id) === String(id)) || (pa.data || [])[0] || null;
    if (page) fb = await facebookStats(page, dayN, until, since);
    else fb.error = 'Geen Facebook-pagina toegankelijk voor dit token.';
  } catch (e) { fb.error = `Facebook-stats mislukten: ${e.message}`; }

  /* Pinterest (optioneel — eigen API/token). */
  let pin = { platform: 'pinterest', configured: false, posts: [] };
  try { pin = await getPinterestStats({ days: dayN }); }
  catch (e) { pin = { platform: 'pinterest', configured: false, error: e.message, posts: [] }; }

  /* Gecombineerde postenlijst (alle kanalen door elkaar, op datum). */
  const merged = [].concat(ig.posts || [], fb.posts || [], pin.posts || [])
    .filter((p) => p.at)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 16);

  out.platforms = { instagram: ig, facebook: fb, pinterest: pin };
  out.posts = merged.length ? merged : (ig.posts || []);
  out.benchmark = { engGood: BM.engGood, engOk: BM.engOk, reachGood: BM.reachGood, reachOk: BM.reachOk };

  /* Legacy mirrors (oudere frontend / cache) = Instagram. */
  out.profile = { username: ig.username, name: ig.name, followers: ig.followers, mediaCount: ig.mediaCount, avatar: ig.avatar, bio: ig.bio, website: ig.website };
  out.followerGrowth = ig.followerGrowth || [];
  out.reachDaily = ig.reachDaily || [];
  out.followerGrowthTotal = ig.followerGrowthTotal;
  out.reachTotal = ig.reachTotal;
  out.insightsOk = ig.insightsOk;
  out.insightsError = ig.insightsError;
  out.prognosis = ig.prognosis;
  out.avgEngagementPct = ig.avgEngagementPct;
  out.postsReachAvg = ig.postsReachAvg;
  out.facebook = fb.configured ? { page: fb.name, followers: fb.followers } : null;

  return out;
}
