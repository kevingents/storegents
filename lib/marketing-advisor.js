/**
 * lib/marketing-advisor.js
 *
 * Kern van de "Marketing-analist": verzamelt de marketing-resultaten (omzet/marge,
 * Google + Meta ad spend, POAS/ROAS, GA4-verkeer) voor de gekozen periode + de
 * vorige periode, en laat Claude als kritische analist beoordelen of het externe
 * marketingbureau goed presteert. Gedeeld door de admin-endpoint én de maand-cron.
 */

import { computePoasForRange } from './poas-compute.js';
import { getGoogleAdsCampaigns } from './google-ads-spend.js';
import { getMetaAdsSpend } from './meta-ads-spend.js';
import { getGa4Traffic } from './ga4-traffic.js';
import { readPortalConfig, marketingTargets } from './portal-config-store.js';
import { claudeMessage } from './claude-client.js';

const ymd = (d) => d.toISOString().slice(0, 10);
const r2 = (n) => (n == null ? null : Math.round((Number(n) || 0) * 100) / 100);

/* Sluit afgekapte JSON netjes af (truncatie-reparatie). */
function closeTruncatedJson(s) {
  let inStr = false, esc = false;
  const stack = [];
  let out = '';
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    out += ch;
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, '');
  while (stack.length) out += stack.pop();
  return out;
}

function parseJsonLoose(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const i = t.indexOf('{');
  if (i > 0) t = t.slice(i);
  try { return JSON.parse(t); } catch (_) {}
  const j = t.lastIndexOf('}');
  if (j > 0) { try { return JSON.parse(t.slice(0, j + 1)); } catch (_) {} }
  try { return JSON.parse(closeTruncatedJson(t)); } catch (_) {}
  return null;
}

function rangeAndPrev(period) {
  const now = new Date();
  const days = period === 'week' ? 7 : (period === 'kwartaal' || period === 'quarter') ? 90 : (period === 'jaar' || period === 'year') ? 365 : 30;
  const to = new Date(now);
  const from = new Date(now.getTime() - (days - 1) * 86400000);
  const prevTo = new Date(from.getTime() - 86400000);
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * 86400000);
  return { from, to, prevFrom, prevTo };
}

async function gather(from, to) {
  const [fin, g, meta, ga4] = await Promise.all([
    computePoasForRange({ from, to }).catch(() => ({ configured: false })),
    getGoogleAdsCampaigns({ from, to }).catch(() => ({ ok: false })),
    getMetaAdsSpend({ from, to }).catch(() => ({ ok: false })),
    getGa4Traffic({ from, to }).catch(() => ({ ok: false }))
  ]);

  const shopping = g.ok ? r2(g.splits?.shopping?.spend || 0) : null;
  const winkel = g.ok ? r2(g.splits?.winkel?.spend || 0) : null;
  const googleConv = g.ok ? r2((g.campaigns || []).reduce((s, c) => s + (c.conversions || 0), 0)) : null;
  const metaSpend = meta.ok ? r2(meta.spend) : null;
  const adSpendOnline = r2((shopping || 0) + (metaSpend || 0));

  return {
    omzetExBtw: r2(fin.nettoOmzetEx),
    omzetInclBtw: r2(fin.nettoOmzetIncl),
    brutowinst: r2(fin.brutowinst),
    margePct: fin.margePct ?? null,
    retourPct: fin.retourPct ?? null,
    online_orders: fin.orderCount ?? null,
    googleSpend_shopping: shopping,
    googleSpend_winkel: winkel,
    metaSpend,
    adSpendOnline,
    googleConversies: googleConv,
    poas_online: (adSpendOnline > 0 && fin.brutowinst != null) ? r2(fin.brutowinst / adSpendOnline) : null,
    roas_online: (adSpendOnline > 0 && fin.nettoOmzetIncl != null) ? r2(fin.nettoOmzetIncl / adSpendOnline) : null,
    ga4: ga4.ok ? {
      sessies: ga4.sessions, gebruikers: ga4.users, nieuweGebruikers: ga4.newUsers,
      conversiePct: ga4.convRate, transacties: ga4.transactions, omzet: ga4.revenue,
      topKanalen: (ga4.byChannel || []).slice(0, 6).map((c) => ({ kanaal: c.channel, sessies: c.sessions, omzet: c.revenue }))
    } : null
  };
}

/**
 * Genereer het marketing-advies voor een periode.
 * @returns {Promise<{ok:boolean, advice?:object, data?:object, range?:object, period:string, raw?:string, error?:string}>}
 */
export async function generateMarketingAdvice(period = 'maand') {
  const { from, to, prevFrom, prevTo } = rangeAndPrev(period);
  const [cur, prev, cfg] = await Promise.all([
    gather(from, to),
    gather(prevFrom, prevTo),
    readPortalConfig().catch(() => ({}))
  ]);
  const targets = marketingTargets(cfg);

  const system = 'Je bent een kritische, ervaren marketing-data-analist. Je beoordeelt namens GENTS — een Nederlands herenmode-merk met een webshop (gents.nl) én circa 19 fysieke winkels — of hun EXTERNE marketingbureau goed werk levert. Wees eerlijk, concreet en cijfer-onderbouwd; vermijd holle marketingtaal. Benchmark tegen typische cijfers voor fashion e-commerce in Nederland. Antwoord met UITSLUITEND één geldig JSON-object: begin je antwoord met { en eindig met }. Geen inleiding, geen uitleg, geen markdown-fences (```).';

  const user = `Marketingdata GENTS, periode "${period}" (${ymd(from)} t/m ${ymd(to)}), met de vorige even lange periode ter vergelijking. Alle bedragen in euro.

HUIDIGE PERIODE:
${JSON.stringify(cur, null, 1)}

VORIGE PERIODE:
${JSON.stringify(prev, null, 1)}

MAANDTARGETS (door GENTS ingesteld):
${JSON.stringify(targets || {}, null, 1)}

Weeg vooral: POAS_online (brutowinst ÷ online ad spend; ≥1 = winstgevend), ROAS, GA4-conversie%, retour%, de trend t.o.v. vorige periode, de kanaalverdeling (te afhankelijk van betaald verkeer vs. organisch?), en Shopping- vs Winkel-spend. Winkel-spend stuurt de fysieke winkels aan (niet de webshop-POAS). Als een waarde null is, benoem het als "nog te koppelen / meten" i.p.v. te gokken.

Geef JSON met EXACT deze velden:
{
  "rapportcijfer": <getal 1-10 voor de prestatie van het marketingbureau>,
  "oordeel": "<2-3 zinnen: doet het bureau het goed? waarom wel/niet, met de belangrijkste cijfers>",
  "sterkePunten": ["<punt>", "..."],
  "zorgen": ["<zorg met cijfer-onderbouwing>", "..."],
  "aanbevelingen": ["<concrete, uitvoerbare actie>", "..."],
  "benchmark": [{"metric":"<bv. Conversie>","gents":"<waarde>","benchmark":"<typische fashion-range NL>","oordeel":"<onder/op/boven niveau>"}, "..."],
  "vragenVoorBureau": ["<kritische vraag om aan het bureau te stellen>", "..."]
}

Houd het BEKNOPT zodat het in één JSON-object past: max 4 sterke punten, max 4 zorgen, max 5 aanbevelingen, max 5 benchmark-rijen, max 4 vragen. Elke regel is één korte zin (geen lange alinea's).`;

  let raw = '';
  try {
    const out = await claudeMessage({ system, user, maxTokens: 4096, temperature: 0.4 });
    raw = String(out?.text || '');
  } catch (e) {
    return { ok: false, period, error: `Analist kon geen advies genereren: ${e.message || e}` };
  }
  const advice = parseJsonLoose(raw);
  if (!advice) return { ok: false, period, error: 'Analist gaf geen leesbaar advies terug.', raw: raw.slice(0, 1200) };

  return {
    ok: true,
    period,
    range: { from: ymd(from), to: ymd(to) },
    data: { current: cur, previous: prev, targets },
    advice
  };
}
