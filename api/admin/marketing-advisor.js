/**
 * GET /api/admin/marketing-advisor?period=week|maand|kwartaal|jaar
 *
 * "Marketing-analist": verzamelt de marketing-resultaten (omzet/marge, Google +
 * Meta ad spend, POAS/ROAS, GA4-verkeer) voor de gekozen periode én de vorige
 * periode, en laat Claude als kritische data-analist beoordelen:
 *   - of het externe marketingbureau goed presteert (rapportcijfer + oordeel)
 *   - sterke punten / zorgen (met cijfer-onderbouwing)
 *   - concrete aanbevelingen
 *   - benchmark tegen typische fashion-e-commerce cijfers
 *   - kritische vragen om aan het bureau te stellen
 *
 * Read-only. Resultaat 6u gecached per periode (Claude-calls kosten geld);
 * ?refresh=1 omzeilt de cache. Auth: admin-token.
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { computePoasForRange } from '../../lib/poas-compute.js';
import { getGoogleAdsCampaigns } from '../../lib/google-ads-spend.js';
import { getMetaAdsSpend } from '../../lib/meta-ads-spend.js';
import { getGa4Traffic } from '../../lib/ga4-traffic.js';
import { readPortalConfig, marketingTargets } from '../../lib/portal-config-store.js';
import { claudeMessage } from '../../lib/claude-client.js';
import { readJsonBlob, writeJsonBlob } from '../../lib/json-blob-store.js';

export const maxDuration = 120;

const CACHE_PATH = 'marketing/advisor-cache.json';
const CACHE_MS = 6 * 60 * 60 * 1000;
const ymd = (d) => d.toISOString().slice(0, 10);
const r2 = (n) => (n == null ? null : Math.round((Number(n) || 0) * 100) / 100);

function rangeAndPrev(period) {
  const now = new Date();
  const days = period === 'week' ? 7 : (period === 'kwartaal' || period === 'quarter') ? 90 : (period === 'jaar' || period === 'year') ? 365 : 30;
  const to = new Date(now);
  const from = new Date(now.getTime() - (days - 1) * 86400000);
  const prevTo = new Date(from.getTime() - 86400000);
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * 86400000);
  return { from, to, prevFrom, prevTo, days };
}

/* Verzamel de kerncijfers voor één periode. Faalt zacht per bron. */
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

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const period = String(req.query.period || 'maand').toLowerCase();
  const refresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());

  try {
    const cache = refresh ? null : await readJsonBlob(CACHE_PATH, null).catch(() => null);
    if (cache && cache.period === period && cache.at && (Date.now() - new Date(cache.at).getTime()) < CACHE_MS) {
      return res.status(200).json({ ...cache.payload, cached: true, generatedAt: cache.at });
    }

    const { from, to, prevFrom, prevTo } = rangeAndPrev(period);
    const [cur, prev, cfg] = await Promise.all([
      gather(from, to),
      gather(prevFrom, prevTo),
      readPortalConfig().catch(() => ({}))
    ]);
    const targets = marketingTargets(cfg);

    const system = 'Je bent een kritische, ervaren marketing-data-analist. Je beoordeelt namens GENTS — een Nederlands herenmode-merk met een webshop (gents.nl) én circa 19 fysieke winkels — of hun EXTERNE marketingbureau goed werk levert. Wees eerlijk, concreet en cijfer-onderbouwd; vermijd holle marketingtaal. Benchmark tegen typische cijfers voor fashion e-commerce in Nederland. Antwoord UITSLUITEND met geldige JSON, zonder tekst eromheen.';

    const user = `Marketingdata GENTS, periode "${period}" (${ymd(from)} t/m ${ymd(to)}), met de vorige even lange periode ter vergelijking. Alle bedragen in euro.

HUIDIGE PERIODE:
${JSON.stringify(cur, null, 1)}

VORIGE PERIODE:
${JSON.stringify(prev, null, 1)}

MAANDTARGETS (door GENTS ingesteld):
${JSON.stringify(targets || {}, null, 1)}

Weeg vooral: POAS_online (brutowinst ÷ online ad spend; ≥1 = winstgevend), ROAS, GA4-conversie%, retour%, de trend t.o.v. vorige periode, de kanaalverdeling (te afhankelijk van betaald verkeer vs. organisch?), en Shopping- vs Winkel-spend. Winkel-spend stuurt fysieke winkels aan (niet de webshop-POAS). Als een waarde null is, benoem het als "nog te koppelen / meten" i.p.v. te gokken.

Geef JSON met EXACT deze velden:
{
  "rapportcijfer": <getal 1-10 voor de prestatie van het marketingbureau>,
  "oordeel": "<2-3 zinnen: doet het bureau het goed? waarom wel/niet, met de belangrijkste cijfers>",
  "sterkePunten": ["<punt>", "..."],
  "zorgen": ["<zorg met cijfer-onderbouwing>", "..."],
  "aanbevelingen": ["<concrete, uitvoerbare actie>", "..."],
  "benchmark": [{"metric":"<bv. Conversie>","gents":"<waarde>","benchmark":"<typische fashion-range NL>","oordeel":"<onder/op/boven niveau>"}, "..."],
  "vragenVoorBureau": ["<kritische vraag om aan het bureau te stellen>", "..."]
}`;

    let advice = null, raw = '';
    try {
      const out = await claudeMessage({ system, user, maxTokens: 1800, temperature: 0.4 });
      raw = String(out?.text || '');
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) advice = JSON.parse(m[0]);
    } catch (e) {
      return res.status(200).json({ success: false, message: `Analist kon geen advies genereren: ${e.message || e}`, period });
    }
    if (!advice) {
      return res.status(200).json({ success: false, message: 'Analist gaf geen leesbaar advies terug.', period, raw: raw.slice(0, 400) });
    }

    const payload = {
      success: true,
      period,
      range: { from: ymd(from), to: ymd(to) },
      data: { current: cur, previous: prev, targets },
      advice
    };
    try { await writeJsonBlob(CACHE_PATH, { period, at: new Date().toISOString(), payload }); } catch (_) {}
    return res.status(200).json({ ...payload, cached: false, generatedAt: new Date().toISOString() });
  } catch (e) {
    console.error('[admin/marketing-advisor]', e);
    return res.status(200).json({ success: false, message: e.message || 'Advies genereren mislukt.', period });
  }
}
