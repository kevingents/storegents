/**
 * lib/ga4-traffic.js
 *
 * Marketing-verkeer + conversies uit GA4 (read-only) voor het Marketing-dashboard.
 * Eén runReport met de kanaal-dimensie (sessionDefaultChannelGroup); totalen
 * worden client-side gesommeerd. Faalt nooit hard: niet gekoppeld → {ok:false}.
 */

import { ga4RunReport, readGa4Config } from './ga4-client.js';

const ymd = (d) => { const x = (d instanceof Date) ? d : new Date(d); return Number.isNaN(x.getTime()) ? '' : x.toISOString().slice(0, 10); };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * @param {{from:Date|string, to:Date|string}} range
 * @returns {Promise<{ok:boolean, sessions, users, newUsers, transactions, revenue,
 *   conversions, convRate, aov, byChannel:Array, propertyId?, error?}>}
 */
export async function getGa4Traffic({ from, to } = {}) {
  const cfg = readGa4Config();
  if (!cfg.refreshToken || !cfg.propertyId) {
    const mist = [
      !cfg.refreshToken && 'GOOGLE_REFRESH_TOKEN (met analytics.readonly)',
      !cfg.propertyId && 'GA4_PROPERTY_ID'
    ].filter(Boolean).join(', ');
    return { ok: false, byChannel: [], error: `GA4 niet volledig gekoppeld — ontbrekend: ${mist}.` };
  }
  const f = ymd(from), t = ymd(to);
  if (!f || !t) return { ok: false, byChannel: [], error: 'Ongeldige periode.' };

  const body = {
    dateRanges: [{ startDate: f, endDate: t }],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'newUsers' },
      { name: 'ecommercePurchases' },
      { name: 'purchaseRevenue' },
      { name: 'conversions' }
    ],
    limit: 50
  };

  try {
    const data = await ga4RunReport(body);
    const rows = data?.rows || [];
    const byChannel = rows.map((row) => {
      const ch = row.dimensionValues?.[0]?.value || '(overig)';
      const m = (row.metricValues || []).map((x) => num(x.value));
      return {
        channel: ch,
        sessions: m[0] || 0,
        users: m[1] || 0,
        newUsers: m[2] || 0,
        transactions: m[3] || 0,
        revenue: r2(m[4] || 0),
        conversions: r2(m[5] || 0)
      };
    }).sort((a, b) => b.sessions - a.sessions);

    const sum = (k) => byChannel.reduce((s, c) => s + (c[k] || 0), 0);
    const sessions = sum('sessions');
    const transactions = sum('transactions');
    const revenue = r2(sum('revenue'));

    return {
      ok: true,
      propertyId: cfg.propertyId,
      sessions,
      users: sum('users'),
      newUsers: sum('newUsers'),
      transactions,
      revenue,
      conversions: r2(sum('conversions')),
      convRate: sessions > 0 ? r2((transactions / sessions) * 100) : null, /* % bestellingen per sessie */
      aov: transactions > 0 ? r2(revenue / transactions) : null,           /* gem. orderwaarde */
      byChannel
    };
  } catch (e) {
    return { ok: false, byChannel: [], error: e.message || 'GA4-verkeer ophalen mislukte.' };
  }
}
