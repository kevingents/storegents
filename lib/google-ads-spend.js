/**
 * lib/google-ads-spend.js
 *
 * Haalt de Google Ads-advertentiekosten (spend) per periode op via GAQL, voor de
 * POAS-berekening op het Marketing-dashboard. Account-niveau (alle campagnes
 * samen), per dag. Faalt nooit hard: zonder volledige koppeling → {ok:false,
 * spend:null, error} zodat het dashboard alsnog omzet/marge kan tonen.
 */

import { gaql, readAdsConfig } from './google-ads-client.js';

const ymd = (d) => {
  const x = (d instanceof Date) ? d : new Date(d);
  return Number.isNaN(x.getTime()) ? '' : x.toISOString().slice(0, 10);
};
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * @param {{from:Date|string, to:Date|string}} range
 * @returns {Promise<{ok:boolean, spend:number|null, byDay:Array<{day,spend}>, currency?:string, customerId?:string, error?:string}>}
 */
export async function getGoogleAdsSpend({ from, to } = {}) {
  const cfg = readAdsConfig();
  if (!cfg.refreshToken || !cfg.developerToken || !cfg.customerId) {
    const mist = [
      !cfg.refreshToken && 'refresh token',
      !cfg.developerToken && 'developer token',
      !cfg.customerId && 'GOOGLE_ADS_CUSTOMER_ID'
    ].filter(Boolean).join(', ');
    return { ok: false, spend: null, byDay: [], error: `Google Ads niet volledig gekoppeld — ontbrekend: ${mist}.` };
  }
  const f = ymd(from), t = ymd(to);
  if (!f || !t) return { ok: false, spend: null, byDay: [], error: 'Ongeldige periode.' };

  const query = `SELECT segments.date, metrics.cost_micros FROM customer WHERE segments.date BETWEEN '${f}' AND '${t}'`;
  try {
    const rows = await gaql(query);
    const byDay = {};
    let micros = 0;
    for (const row of rows) {
      const day = row?.segments?.date || '';
      /* REST levert camelCase (costMicros); val terug op snake_case. */
      const c = Number(row?.metrics?.costMicros ?? row?.metrics?.cost_micros ?? 0);
      micros += c;
      if (day) byDay[day] = (byDay[day] || 0) + c;
    }
    return {
      ok: true,
      spend: r2(micros / 1e6),
      byDay: Object.entries(byDay).map(([day, m]) => ({ day, spend: r2(m / 1e6) })).sort((a, b) => a.day.localeCompare(b.day)),
      customerId: cfg.customerId
    };
  } catch (e) {
    return { ok: false, spend: null, byDay: [], error: e.message || 'Google Ads-spend ophalen mislukte.' };
  }
}
