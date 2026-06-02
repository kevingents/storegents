/**
 * lib/pinterest-stats.js
 *
 * Pinterest-statistieken voor het Social-dashboard (read-only): profiel
 * (volgers, pins, maandweergaven), dagelijkse vertoningen/betrokkenheid, en de
 * recente pins met per-pin bereik/opslaan/klikken + fashion-benchmark.
 *
 * Vereist PINTEREST_ACCESS_TOKEN (scopes user_accounts:read, pins:read,
 * boards:read). Faalt graceful: zonder token → configured:false.
 */

import { pinFetch, pinterestConfigured } from './pinterest-client.js';

const clean = (v) => String(v == null ? '' : v).trim();
const sumVals = (arr) => (arr || []).reduce((s, v) => s + (Number(v.value) || 0), 0);
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

const BM = {
  engGood: Number(process.env.SOCIAL_ENG_GOOD_PCT || 5),
  engOk: Number(process.env.SOCIAL_ENG_OK_PCT || 2),
  reachGood: Number(process.env.SOCIAL_REACH_GOOD_PCT || 30),
  reachOk: Number(process.env.SOCIAL_REACH_OK_PCT || 12)
};
const verdict = (v, good, ok) => (v == null ? null : (v >= good ? 'goed' : (v >= ok ? 'gemiddeld' : 'laag')));

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}

function dateRange(days) {
  const ymd = (d) => d.toISOString().slice(0, 10);
  const end = new Date();
  const start = new Date(end.getTime() - Math.min(90, Math.max(1, days)) * 86400000);
  return { start: ymd(start), end: ymd(end) };
}

function pinImage(p) {
  const im = p.media && p.media.images;
  if (!im) return null;
  for (const k of ['600x', '564x', '400x300', '236x', '150x150']) if (im[k] && im[k].url) return im[k].url;
  const keys = Object.keys(im);
  return (keys[0] && im[keys[0]] && im[keys[0]].url) || null;
}

export async function getPinterestStats({ days = 30 } = {}) {
  if (!pinterestConfigured()) return { platform: 'pinterest', configured: false, error: 'PINTEREST_ACCESS_TOKEN ontbreekt in Vercel.', posts: [] };
  const out = { platform: 'pinterest', configured: true };

  /* Account/profiel. */
  try {
    const a = await pinFetch('user_account');
    out.username = a.username || null;
    out.name = a.business_name || a.username || null;
    out.avatar = a.profile_image || null;
    out.followers = a.follower_count ?? null;
    out.following = a.following_count ?? null;
    out.pinCount = a.pin_count ?? null;
    out.postCount = a.pin_count ?? null;
    out.boardCount = a.board_count ?? null;
    out.monthlyViews = a.monthly_views ?? null;
  } catch (e) {
    return { platform: 'pinterest', configured: true, error: `Pinterest-account ophalen mislukte: ${e.message}`, posts: [] };
  }

  const { start, end } = dateRange(days);

  /* Account-analytics: vertoningen + betrokkenheid per dag. */
  try {
    const an = await pinFetch('user_account/analytics', {
      start_date: start, end_date: end, granularity: 'DAY',
      metric_types: 'IMPRESSION,ENGAGEMENT,SAVE,PIN_CLICK,OUTBOUND_CLICK'
    });
    const daily = (an.all && an.all.daily_metrics) || [];
    const rows = daily.filter((d) => d && d.metrics);
    out.reachDaily = rows.map((d) => ({ day: d.date, value: Number(d.metrics.IMPRESSION || 0) }));
    out.engagementDaily = rows.map((d) => ({ day: d.date, value: Number(d.metrics.ENGAGEMENT || 0) }));
    out.reachTotal = sumVals(out.reachDaily);
    out.engagementTotal = sumVals(out.engagementDaily);
    out.savesTotal = rows.reduce((s, d) => s + Number(d.metrics.SAVE || 0), 0);
    out.clicksTotal = rows.reduce((s, d) => s + Number(d.metrics.PIN_CLICK || 0), 0);
    out.insightsOk = true;
  } catch (e) {
    out.insightsOk = false;
    out.insightsError = `Pinterest-analytics niet beschikbaar — controleer de scopes (user_accounts:read) en dat het account een zakelijk account is (${e.message}).`;
  }

  /* Recente pins. */
  try {
    const pr = await pinFetch('pins', { page_size: '10' });
    out.posts = (pr.items || []).map((p) => ({
      id: p.id, platform: 'pinterest',
      caption: clean(p.title || p.description).slice(0, 180),
      type: 'PIN',
      permalink: p.link || `https://www.pinterest.com/pin/${p.id}/`,
      thumb: pinImage(p),
      at: p.created_at || null,
      likes: null, comments: null
    }));
  } catch (e) { out.postsError = e.message; out.posts = []; }

  /* Per-pin analytics (best-effort) + benchmark. */
  if (out.insightsOk && Array.isArray(out.posts) && out.posts.length) {
    const followers = out.followers != null ? out.followers : null;
    await mapPool(out.posts, 3, async (po) => {
      try {
        const pa = await pinFetch(`pins/${po.id}/analytics`, {
          start_date: start, end_date: end,
          metric_types: 'IMPRESSION,SAVE,PIN_CLICK,OUTBOUND_CLICK', app_types: 'ALL'
        }, { timeoutMs: 12000 });
        const m = (pa.all && (pa.all.summary_metrics || pa.all.lifetime_metrics)) || {};
        po.reach = m.IMPRESSION != null ? Number(m.IMPRESSION) : null;
        po.saved = m.SAVE != null ? Number(m.SAVE) : null;
        po.clicks = m.PIN_CLICK != null ? Number(m.PIN_CLICK) : null;
        po.interactions = (Number(m.SAVE || 0) + Number(m.PIN_CLICK || 0) + Number(m.OUTBOUND_CLICK || 0)) || null;
        po.engagementPct = (po.reach > 0 && po.interactions != null) ? round1((po.interactions / po.reach) * 100) : null;
        po.reachPct = (followers > 0 && po.reach != null) ? round1((po.reach / followers) * 100) : null;
        po.engVerdict = verdict(po.engagementPct, BM.engGood, BM.engOk);
        po.reachVerdict = verdict(po.reachPct, BM.reachGood, BM.reachOk);
      } catch { /* pin-analytics zijn best-effort */ }
    });
    const eng = out.posts.map((p) => p.engagementPct).filter((v) => v != null);
    out.avgEngagementPct = eng.length ? round1(eng.reduce((s, v) => s + v, 0) / eng.length) : null;
    const reached = out.posts.map((p) => p.reach).filter((v) => v != null);
    out.postsReachAvg = reached.length ? Math.round(reached.reduce((s, v) => s + v, 0) / reached.length) : null;
  }

  return out;
}
