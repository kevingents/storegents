/**
 * lib/meta-ads-spend.js
 *
 * Leest de Meta (Facebook/Instagram) advertentiekosten per periode via de
 * Marketing API (Insights, level=account). Read-only — voor de POAS-berekening.
 * Faalt nooit hard: zonder token/account → {ok:false, spend:null, error}.
 *
 * Vercel-env (secrets):
 *   META_ADS_ACCESS_TOKEN   System-User-token uit Business Manager met `ads_read`
 *                           (langlevend/niet-verlopend). Fallback: META_ACCESS_TOKEN
 *   META_ADS_ACCOUNT_ID     advertentieaccount-id (act_1234… of alleen de cijfers).
 *                           Fallback: META_AD_ACCOUNT_ID
 *   META_APP_SECRET         (optioneel) → voegt appsecret_proof toe (veiliger).
 *   META_ADS_API_VERSION    (optioneel) default 'v21.0'
 */

import crypto from 'crypto';

const clean = (v) => String(v == null ? '' : v).trim();
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ymd = (d) => {
  const x = (d instanceof Date) ? d : new Date(d);
  return Number.isNaN(x.getTime()) ? '' : x.toISOString().slice(0, 10);
};

function metaConfig() {
  const accountRaw = clean(process.env.META_ADS_ACCOUNT_ID || process.env.META_AD_ACCOUNT_ID);
  const account = accountRaw ? (accountRaw.startsWith('act_') ? accountRaw : 'act_' + accountRaw.replace(/\D/g, '')) : '';
  return {
    /* Eén System-User-token kan alles (ads_read + instagram_basic + …) — daarom
       vallen we ook terug op het Instagram-token zodat één var volstaat. */
    token: clean(process.env.META_ADS_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN || process.env.INSTAGRAM_GRAPH_TOKEN),
    account,
    appSecret: clean(process.env.META_APP_SECRET),
    version: clean(process.env.META_ADS_API_VERSION) || 'v21.0'
  };
}

/**
 * @param {{from:Date|string, to:Date|string}} range
 * @returns {Promise<{ok:boolean, spend:number|null, byDay:Array<{day,spend}>, account?:string, currency?:string, error?:string}>}
 */
export async function getMetaAdsSpend({ from, to } = {}) {
  const cfg = metaConfig();
  if (!cfg.token || !cfg.account) {
    const mist = [!cfg.token && 'META_ADS_ACCESS_TOKEN', !cfg.account && 'META_ADS_ACCOUNT_ID'].filter(Boolean).join(', ');
    return { ok: false, spend: null, byDay: [], error: `Meta niet gekoppeld — ontbrekend: ${mist}.` };
  }
  const f = ymd(from), t = ymd(to);
  if (!f || !t) return { ok: false, spend: null, byDay: [], error: 'Ongeldige periode.' };

  const params = new URLSearchParams();
  params.set('fields', 'spend');
  params.set('level', 'account');
  params.set('time_increment', '1');
  params.set('time_range', JSON.stringify({ since: f, until: t }));
  params.set('access_token', cfg.token);
  if (cfg.appSecret) {
    params.set('appsecret_proof', crypto.createHmac('sha256', cfg.appSecret).update(cfg.token).digest('hex'));
  }
  const url = `https://graph.facebook.com/${cfg.version}/${cfg.account}/insights?${params.toString()}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok || j.error) {
      return { ok: false, spend: null, byDay: [], error: (j.error && j.error.message) || `Meta API fout ${resp.status}` };
    }
    let total = 0;
    const byDay = [];
    for (const row of (j.data || [])) {
      const s = Number(row.spend || 0);
      total += s;
      byDay.push({ day: row.date_start, spend: r2(s) });
    }
    return { ok: true, spend: r2(total), byDay, account: cfg.account };
  } catch (e) {
    return { ok: false, spend: null, byDay: [], error: e.name === 'AbortError' ? 'Meta API timeout.' : (e.message || 'Meta-spend ophalen mislukte.') };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lopende Meta-campagnes (effective_status ACTIVE) met insights over de periode.
 * @param {{from:Date|string, to:Date|string}} range
 * @returns {Promise<{ok:boolean, platform:'meta', campaigns:Array, spend:number, error?:string}>}
 */
export async function getMetaAdsCampaigns({ from, to } = {}) {
  const cfg = metaConfig();
  if (!cfg.token || !cfg.account) {
    const mist = [!cfg.token && 'META_ADS_ACCESS_TOKEN', !cfg.account && 'META_ADS_ACCOUNT_ID'].filter(Boolean).join(', ');
    return { ok: false, platform: 'meta', campaigns: [], spend: 0, error: `Meta niet gekoppeld — ontbrekend: ${mist}.` };
  }
  const f = ymd(from), t = ymd(to);
  if (!f || !t) return { ok: false, platform: 'meta', campaigns: [], spend: 0, error: 'Ongeldige periode.' };

  const base = `https://graph.facebook.com/${cfg.version}`;
  const proof = cfg.appSecret ? crypto.createHmac('sha256', cfg.appSecret).update(cfg.token).digest('hex') : '';
  const auth = (p) => { p.set('access_token', cfg.token); if (proof) p.set('appsecret_proof', proof); return p; };
  const fetchJson = async (url) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw new Error((j.error && j.error.message) || `Meta API fout ${r.status}`);
      return j;
    } finally { clearTimeout(timer); }
  };

  try {
    /* 1. Actieve campagnes (naam, status, doel, budget). */
    const cp = auth(new URLSearchParams());
    cp.set('fields', 'name,effective_status,objective,daily_budget,lifetime_budget');
    cp.set('effective_status', JSON.stringify(['ACTIVE']));
    cp.set('limit', '200');
    const campData = await fetchJson(`${base}/${cfg.account}/campaigns?${cp.toString()}`);
    const active = (campData.data || []);

    /* 2. Insights per campagne voor de periode. */
    const ip = auth(new URLSearchParams());
    ip.set('level', 'campaign');
    ip.set('fields', 'campaign_id,spend,impressions,clicks');
    ip.set('time_range', JSON.stringify({ since: f, until: t }));
    ip.set('limit', '500');
    const insData = await fetchJson(`${base}/${cfg.account}/insights?${ip.toString()}`);
    const insByCamp = new Map((insData.data || []).map((row) => [String(row.campaign_id), row]));

    const campaigns = active.map((c) => {
      const ins = insByCamp.get(String(c.id)) || {};
      return {
        id: String(c.id),
        name: c.name,
        status: c.effective_status,
        objective: c.objective || '',
        budget: r2(Number(c.daily_budget || c.lifetime_budget || 0) / 100),
        budgetType: c.daily_budget ? 'dag' : (c.lifetime_budget ? 'totaal' : ''),
        spend: r2(Number(ins.spend || 0)),
        impressions: Number(ins.impressions || 0),
        clicks: Number(ins.clicks || 0)
      };
    }).sort((a, b) => b.spend - a.spend);

    return { ok: true, platform: 'meta', campaigns, spend: r2(campaigns.reduce((s, c) => s + c.spend, 0)), account: cfg.account };
  } catch (e) {
    return { ok: false, platform: 'meta', campaigns: [], spend: 0, error: e.name === 'AbortError' ? 'Meta API timeout.' : (e.message || 'Meta-campagnes ophalen mislukte.') };
  }
}
