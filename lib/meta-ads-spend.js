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
