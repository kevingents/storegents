/**
 * Content-kalender intelligentie: genereert content-tips op basis van het weer
 * (Open-Meteo, gratis/geen key), seizoen & gelegenheden (brandbook),
 * verkoopcijfers (top-winkels + bestsellers) en een AI-contentplan (Claude,
 * met nette fallback). Resultaat wordt gecachet in een Blob; de cron ververst.
 */

import { claudeMessage, getClaudeKey } from './claude-client.js';
import { BRANDBOOK } from './brandbook.js';
import { BUSINESS_CONFIG } from './business-config.js';
import { aggregateBranchForPeriod } from './srs-revenue-cache-store.js';
import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const PATH = 'marketing/content-calendar.json';
const LAT = 52.09, LON = 5.12; // centraal NL (Utrecht)

const WCODE = {
  0: 'Helder', 1: 'Overw. helder', 2: 'Half bewolkt', 3: 'Bewolkt', 45: 'Mist', 48: 'Mist',
  51: 'Lichte motregen', 53: 'Motregen', 55: 'Dichte motregen', 56: 'IJzel', 57: 'IJzel',
  61: 'Lichte regen', 63: 'Regen', 65: 'Zware regen', 66: 'IJsregen', 67: 'IJsregen',
  71: 'Lichte sneeuw', 73: 'Sneeuw', 75: 'Zware sneeuw', 77: 'Sneeuwkorrels',
  80: 'Buien', 81: 'Buien', 82: 'Zware buien', 85: 'Sneeuwbuien', 86: 'Sneeuwbuien',
  95: 'Onweer', 96: 'Onweer + hagel', 99: 'Zwaar onweer'
};
const RAIN = new Set([51, 53, 55, 61, 63, 65, 80, 81, 82, 95, 96, 99]);
const SNOW = new Set([71, 73, 75, 77, 85, 86]);

export async function getWeather(days = 14) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum&forecast_days=${days}&timezone=Europe%2FAmsterdam`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Open-Meteo fout ' + r.status);
  const j = await r.json();
  const d = j.daily || {};
  const t = d.time || [];
  const out = [];
  for (let i = 0; i < t.length; i++) {
    const code = Number(d.weathercode?.[i] ?? 0);
    out.push({
      date: t[i],
      tmax: Math.round(Number(d.temperature_2m_max?.[i] ?? 0)),
      tmin: Math.round(Number(d.temperature_2m_min?.[i] ?? 0)),
      precip: Number(d.precipitation_sum?.[i] ?? 0),
      code, label: WCODE[code] || '—',
      rain: RAIN.has(code), snow: SNOW.has(code)
    });
  }
  return out;
}

const NL_DAY = (iso) => { try { return new Date(iso + 'T12:00:00').toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' }); } catch { return iso; } };

function seasonalTips(now) {
  const m = now.getMonth() + 1;
  const tips = [];
  const add = (title, body) => tips.push({ date: null, tag: 'Seizoen', title, body, reason: '' });
  if (m >= 4 && m <= 9) add('Bruiloftseizoen', 'Piek voor bruiloften: pakken, jacquet, gilets, pochets en schoenen. Maak bruiloftsgast- en bruidegom-content + dresscode-tips.');
  if (m === 6 || m === 7) add('Gala & diploma-uitreikingen', 'Examenfeesten en gala’s: smoking, vlinderstrik, lakschoenen. Black-tie-guide en styling-reels werken nu goed.');
  if (m >= 5 && m <= 8) add('Zomer', 'Warme maanden: linnen pakken, lichte overhemden, polo en zomerse accessoires in de spotlight.');
  if (m === 9 || m === 10) add('Najaarscollectie', 'Introduceer tailoring in herfsttinten, three-piece looks en wollen stoffen.');
  if (m === 11 || m === 12) add('Feestdagen & gala', 'Kerst, gala’s en oud-en-nieuw: smoking, feestelijke accessoires, cadeaubonnen en perfecte-feestlook-content.');
  if (m >= 1 && m <= 3) add('Zakelijk Q1', 'Begin van het jaar: business formal, nette overhemden en de nieuwe collectie onder de aandacht.');
  return tips;
}

function weatherTips(weather) {
  const tips = [];
  const next = weather.slice(0, 12);
  const rain = next.find((d) => d.rain || d.precip >= 3);
  const warm = next.filter((d) => d.tmax >= 22).sort((a, b) => b.tmax - a.tmax)[0];
  const cold = next.filter((d) => d.tmax <= 7).sort((a, b) => a.tmax - b.tmax)[0];
  const snow = next.find((d) => d.snow);
  if (rain) tips.push({ date: rain.date, tag: 'Weer', title: 'Regen op komst', body: `Regen rond ${NL_DAY(rain.date)} — push trenchcoats, regenjassen, paraplu’s en waterafstotende schoenen.`, reason: `${rain.label}, ${rain.precip} mm` });
  if (warm) tips.push({ date: warm.date, tag: 'Weer', title: 'Warm weer', body: `Tot ${warm.tmax}°C rond ${NL_DAY(warm.date)} — linnen pakken, lichte overhemden en zomerse looks vooraan zetten.`, reason: `${warm.tmax}°C` });
  if (cold) tips.push({ date: cold.date, tag: 'Weer', title: 'Koud weer', body: `Rond ${cold.tmax}°C bij ${NL_DAY(cold.date)} — wollen jassen, truien, sjaals en three-piece looks promoten.`, reason: `${cold.tmax}°C` });
  if (snow) tips.push({ date: snow.date, tag: 'Weer', title: 'Sneeuw verwacht', body: `Sneeuw rond ${NL_DAY(snow.date)} — winterjassen, handschoenen en sjaals; sfeervolle winter-content maken.`, reason: snow.label });
  return tips;
}

async function salesSignal() {
  try {
    const retail = (BUSINESS_CONFIG.branches?.list || []).filter((b) => b.kind === 'retail');
    const perStore = [];
    const productCount = new Map();
    for (const b of retail) {
      try {
        const agg = await aggregateBranchForPeriod(b.branchId, 'week');
        if (agg && agg.revenue) perStore.push({ store: b.store, revenue: agg.revenue });
        for (const p of (agg?.topProducts || []).slice(0, 5)) {
          const name = String(p.name || p.title || p.product || p.description || '').trim();
          const qty = Number(p.qty || p.count || p.itemsSold || p.quantity || 0) || 1;
          if (name) productCount.set(name, (productCount.get(name) || 0) + qty);
        }
      } catch (_) { /* branch zonder cache → skip */ }
    }
    perStore.sort((a, b) => b.revenue - a.revenue);
    return {
      topStores: perStore.slice(0, 3).map((s) => s.store),
      topProducts: [...productCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n]) => n),
      hasData: perStore.length > 0
    };
  } catch (_) {
    return { topStores: [], topProducts: [], hasData: false };
  }
}

function salesTips(sales) {
  const tips = [];
  if (sales.topStores.length) tips.push({ date: null, tag: 'Verkoop', title: 'Top-winkels deze week', body: `${sales.topStores.join(', ')} draaien het best — maak local-spotlight/UGC-content en tag deze winkels.`, reason: 'omzet (week)' });
  if (sales.topProducts.length) tips.push({ date: null, tag: 'Verkoop', title: 'Bestsellers nu', body: `Best verkocht: ${sales.topProducts.slice(0, 4).join(', ')}. Zet deze in als hero-product in social + nieuwsbrief.`, reason: 'verkoopcijfers' });
  return tips;
}

async function aiPlan({ weather, sales, season }) {
  if (!getClaudeKey()) return '';
  const wsum = weather.slice(0, 10).map((d) => `${d.date}: ${d.label} ${d.tmax}°C${d.rain ? ' (regen)' : ''}`).join('; ');
  const system = `Je bent de content-strateeg van ${BRANDBOOK.brand.name} (premium herenmode, formele-momenten-specialist). Tone of voice: ${BRANDBOOK.toneOfVoice.personality.join(', ')}. Focus op de gelegenheid, niet op demografie. Geen emoji.`;
  const user = [
    'Maak een kort content-plan voor de komende twee weken (social + e-mail).',
    `Weer (NL): ${wsum || 'onbekend'}`,
    season.length ? `Seizoen/gelegenheden: ${season.map((s) => s.title).join(', ')}` : '',
    sales.topStores.length ? `Best draaiende winkels: ${sales.topStores.join(', ')}` : '',
    sales.topProducts.length ? `Bestsellers: ${sales.topProducts.join(', ')}` : '',
    '',
    'Geef 5 concrete ideeen, elk op een nieuwe regel als: "- [kanaal] idee (waarom nu)". Max 110 woorden totaal.'
  ].filter(Boolean).join('\n');
  try {
    const { text } = await claudeMessage({ system, user, maxTokens: 320, temperature: 0.8 });
    return text;
  } catch (_) { return ''; }
}

export async function refreshContentCalendar() {
  const now = new Date();
  let weather = [];
  try { weather = await getWeather(14); } catch (_) { weather = []; }
  const season = seasonalTips(now);
  const sales = await salesSignal();
  const tips = [...weatherTips(weather), ...season, ...salesTips(sales)];
  const plan = await aiPlan({ weather, sales, season });
  const data = {
    weather, tips, aiPlan: plan,
    sales: { topStores: sales.topStores, topProducts: sales.topProducts },
    generatedAt: new Date().toISOString()
  };
  try { await writeJsonBlob(PATH, data); } catch (_) { /* best-effort cache */ }
  return data;
}

export async function readContentCalendar() {
  return readJsonBlob(PATH, null);
}
