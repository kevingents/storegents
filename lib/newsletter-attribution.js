/**
 * lib/newsletter-attribution.js
 *
 * E-mail-omzet-attributie: koppelt Shopify-orders aan een nieuwsbrief via de
 * UTM-tag (utm_campaign=<newsletterId>) die op de nieuwsbrief-links staat. Telt
 * per nieuwsbrief het aantal orders + netto-omzet binnen een venster.
 *
 * Matchbron: order.landing_site (de eerste pagina van de sessie, incl. UTM-query)
 * en order.note_attributes (fallback). Last-touch via landing_site is een
 * pragmatische benadering — geen perfecte multi-touch-attributie.
 */

import { listNewsletters } from './newsletter-builder.js';

let _cache = null; /* { key, at, data } */
const CACHE_MS = 30 * 60 * 1000;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function fetchOrders({ from, to, maxPages = 10 }) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '';
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || process.env.SHOPIFY_ADMIN_TOKEN || '';
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2025-01';
  if (!domain || !token) return { orders: [], configured: false };
  const fields = 'id,name,created_at,cancelled_at,total_price,refunds,landing_site,referring_site,note_attributes,source_name';
  let url = `https://${domain}/admin/api/${apiVersion}/orders.json?status=any&created_at_min=${new Date(from).toISOString()}&created_at_max=${new Date(to).toISOString()}&limit=250&fields=${fields}`;
  const orders = [];
  let pages = 0;
  while (url && pages < maxPages) {
    const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': token, Accept: 'application/json' } });
    if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`Shopify API ${r.status} — ${t.slice(0, 100)}`); }
    const d = await r.json();
    orders.push(...(d.orders || []));
    pages += 1;
    const link = r.headers.get('link') || r.headers.get('Link') || '';
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : '';
  }
  return { orders, configured: true };
}

/* utm_campaign uit een order halen (landing_site of note_attributes). */
function campaignOf(order) {
  const ls = String(order.landing_site || '') + ' ' + String(order.referring_site || '');
  let m = ls.match(/utm_campaign=([^&\s]+)/i);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
  for (const a of (order.note_attributes || [])) {
    if (String(a.name || '').toLowerCase() === 'utm_campaign' && a.value) return String(a.value);
  }
  return '';
}

function netOf(order) {
  const total = Number(order.total_price || 0);
  const refunded = (order.refunds || []).reduce((s, rf) => s + (rf.transactions || []).reduce((ss, tx) => ss + Number(tx.amount || 0), 0), 0);
  return total - refunded;
}

/**
 * @param {{days?:number}} opts
 * @returns {Promise<{configured, days, perNewsletter:Object, totals:{orders,revenue,newsletters}}>}
 */
export async function attributeNewsletters({ days = 30 } = {}) {
  const dayN = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
  const key = `nl-attr-${dayN}`;
  if (_cache && _cache.key === key && (Date.now() - _cache.at) < CACHE_MS) return _cache.data;

  const to = new Date();
  const from = new Date(to.getTime() - dayN * 86400000);
  let res;
  try { res = await fetchOrders({ from, to }); }
  catch (e) { return { configured: true, error: e.message, perNewsletter: {}, totals: { orders: 0, revenue: 0 } }; }
  if (!res.configured) return { configured: false, perNewsletter: {}, totals: { orders: 0, revenue: 0 } };

  const per = {};
  for (const o of res.orders) {
    if (o.cancelled_at) continue;
    const camp = campaignOf(o);
    if (!camp || !/^nl-/.test(camp)) continue; /* alleen onze nieuwsbrief-campagnes */
    per[camp] = per[camp] || { orders: 0, revenue: 0 };
    per[camp].orders += 1;
    per[camp].revenue += netOf(o);
  }
  for (const k of Object.keys(per)) per[k].revenue = r2(per[k].revenue);

  /* Namen erbij. */
  const names = {};
  try { (await listNewsletters()).forEach((n) => { names[n.id] = n.name; }); } catch (_) { /* namen optioneel */ }
  const perNewsletter = {};
  for (const [id, v] of Object.entries(per)) perNewsletter[id] = { ...v, name: names[id] || id };

  const totals = {
    orders: Object.values(per).reduce((s, v) => s + v.orders, 0),
    revenue: r2(Object.values(per).reduce((s, v) => s + v.revenue, 0)),
    newsletters: Object.keys(per).length
  };
  const data = { configured: true, days: dayN, perNewsletter, totals };
  _cache = { key, at: Date.now(), data };
  return data;
}
