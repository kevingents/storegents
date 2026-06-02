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

/* Per-post insights: zo veel mogelijk metrics. Metric-namen wisselen per
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
   want de IG-API limiteert per request). */
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

  /* Volgersgroei + bereik per dag over de gekozen periode (best-effort — vereist
     instagram_manage_insights). >30d wordt in stukken van 30 dagen opgehaald. */
  const dayN = Math.min(90, Math.max(1, days));
  out.days = dayN;
  const until = Math.floor(Date.now() / 1000);
  const since = until - dayN * 86400;
  try {
    const byMetric = await insightsRange(id, token, 'follower_count,reach', since, until);
    out.followerGrowth = byMetric.follower_count || [];
    out.reachDaily = byMetric.reach || [];
    out.followerGrowthTotal = (byMetric.follower_count || []).reduce((s, v) => s + v.value, 0);
    out.reachTotal = (byMetric.reach || []).reduce((s, v) => s + v.value, 0);
    out.insightsOk = true;
    /* Groeiprognose: gemiddelde nieuwe volgers/dag → realistische projectie. */
    const span = (byMetric.follower_count || []).length || dayN;
    const avgDaily = span > 0 ? out.followerGrowthTotal / span : 0;
    const followers = out.profile && out.profile.followers != null ? out.profile.followers : null;
    out.prognosis = {
      perDagGem: round1(avgDaily),
      perMaand: Math.round(avgDaily * 30),
      per3Maand: Math.round(avgDaily * 90),
      basisDagen: span,
      volgersOver3Maand: followers != null ? Math.round(followers + avgDaily * 90) : null
    };
  } catch (e) {
    out.insightsOk = false;
    out.insightsError = `Groei/bereik niet beschikbaar — voeg de scope instagram_manage_insights toe aan het token (${e.message}).`;
  }
  out.benchmark = { engGood: BM.engGood, engOk: BM.engOk, reachGood: BM.reachGood, reachOk: BM.reachOk };

  /* Per-post insights + fashion-benchmark — alleen als de scope werkt. */
  if (out.insightsOk && Array.isArray(out.posts) && out.posts.length) {
    const followers = out.profile && out.profile.followers != null ? out.profile.followers : null;
    await mapPool(out.posts, 5, async (po) => {
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
    const eng = out.posts.map((p) => p.engagementPct).filter((v) => v != null);
    out.avgEngagementPct = eng.length ? round1(eng.reduce((s, v) => s + v, 0) / eng.length) : null;
    const reached = out.posts.map((p) => p.reach).filter((v) => v != null);
    out.postsReachAvg = reached.length ? Math.round(reached.reduce((s, v) => s + v, 0) / reached.length) : null;
  }

  /* Facebook-pagina-volgers (bonus) */
  try {
    const pa = await graph('me/accounts', { fields: 'name,followers_count,fan_count,instagram_business_account', access_token: token });
    const pg = (pa.data || []).find((p) => p.instagram_business_account && p.instagram_business_account.id === id) || (pa.data || [])[0];
    if (pg) out.facebook = { page: pg.name || null, followers: pg.followers_count ?? pg.fan_count ?? null };
  } catch (_) { /* optioneel */ }

  return out;
}
