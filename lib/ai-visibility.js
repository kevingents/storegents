/**
 * lib/ai-visibility.js
 *
 * "AI-vindbaarheid": hoe goed is de GENTS-webshop vindbaar/leesbaar voor AI &
 * LLM's? Twee onderdelen:
 *
 *  1. Technische AI-readiness (runAiReadiness) — leest de LIVE site:
 *     robots.txt (AI-crawler-toegang), llms.txt, sitemap.xml, schema.org/JSON-LD
 *     op home + productpagina, meta-description en Open Graph. → checklist + score.
 *
 *  2. Live AI-test-queries (runAiTestQueries) — stelt echte koopvragen aan Claude
 *     en meet of/hoe GENTS genoemd wordt. → mentions + snippets.
 *
 * Read-only. Resultaten worden gecached in Blob.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { claudeMessage, getClaudeKey } from './claude-client.js';

const READINESS_PATH = 'ai-visibility/readiness.json';
const TESTS_PATH = 'ai-visibility/test-queries.json';
const READINESS_MAX_AGE_MS = Number(process.env.AI_VIS_MAX_AGE_MS || 12 * 60 * 60 * 1000);
const FETCH_TIMEOUT_MS = 12000;

function siteBase() {
  const raw = (process.env.AI_VIS_SITE_URL || process.env.LIVE_STORE_URL || 'https://www.gents.nl').trim();
  return raw.replace(/\/$/, '');
}

/* AI-/LLM-crawlers waarvan toegang relevant is voor AI-vindbaarheid. */
const AI_CRAWLERS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'anthropic-ai', 'Claude-Web', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'CCBot', 'Bytespider'];

async function fetchText(url, { accept = 'text/html', timeout = FETCH_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'GENTS-AI-Visibility-Audit/1.0', Accept: accept }, signal: ctrl.signal, redirect: 'follow' });
    const text = await resp.text().catch(() => '');
    return { ok: resp.ok, status: resp.status, text };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: String(e?.message || e) };
  } finally { clearTimeout(t); }
}

/* Parse robots.txt → per AI-crawler: allowed/blocked (Disallow: / in eigen of *-groep). */
function parseRobots(robotsText) {
  const lines = String(robotsText || '').split(/\r?\n/).map((l) => l.trim());
  const groups = []; /* { agents:[lc], disallowAll:bool } */
  let cur = null;
  for (const line of lines) {
    if (/^#/.test(line) || !line) continue;
    const m = line.match(/^user-agent:\s*(.+)$/i);
    if (m) {
      if (!cur || cur._afterRule) { cur = { agents: [], rules: [], _afterRule: false }; groups.push(cur); }
      cur.agents.push(m[1].trim().toLowerCase());
      continue;
    }
    const d = line.match(/^disallow:\s*(.*)$/i);
    if (d && cur) { cur._afterRule = true; cur.rules.push({ type: 'disallow', path: d[1].trim() }); continue; }
    const a = line.match(/^allow:\s*(.*)$/i);
    if (a && cur) { cur._afterRule = true; cur.rules.push({ type: 'allow', path: a[1].trim() }); }
  }
  const blocksAll = (g) => g.rules.some((r) => r.type === 'disallow' && r.path === '/');
  const groupFor = (agentLc) => groups.find((g) => g.agents.includes(agentLc));
  const starGroup = groups.find((g) => g.agents.includes('*'));
  const result = {};
  for (const bot of AI_CRAWLERS) {
    const g = groupFor(bot.toLowerCase());
    let blocked;
    if (g) blocked = blocksAll(g);
    else blocked = starGroup ? blocksAll(starGroup) : false; /* niet genoemd → valt onder * of toegestaan */
    result[bot] = blocked ? 'blocked' : 'allowed';
  }
  return result;
}

function firstProductUrlFromSitemap(sitemapText, base) {
  /* products-sitemap of index → pak eerste /products/-url. */
  const urls = [...String(sitemapText || '').matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1].trim());
  const prod = urls.find((u) => /\/products\//.test(u));
  if (prod) return prod;
  /* sitemap-index → eerste products-sitemap volgen kan, maar houd het simpel. */
  return '';
}

function hasJsonLdType(html, types) {
  const blocks = [...String(html || '').matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const joined = blocks.join(' ');
  return types.some((t) => new RegExp(`"@type"\\s*:\\s*"?${t}`, 'i').test(joined));
}

/** Technische AI-readiness-audit van de live site. */
export async function runAiReadiness() {
  const base = siteBase();
  const [robots, llms, sitemap, home] = await Promise.all([
    fetchText(`${base}/robots.txt`, { accept: 'text/plain' }),
    fetchText(`${base}/llms.txt`, { accept: 'text/plain' }),
    fetchText(`${base}/sitemap.xml`, { accept: 'application/xml' }),
    fetchText(`${base}/`)
  ]);

  const crawlers = robots.ok ? parseRobots(robots.text) : {};
  const blockedAi = Object.entries(crawlers).filter(([, v]) => v === 'blocked').map(([k]) => k);

  /* Eén productpagina checken op Product-schema. */
  let productSchema = null, productUrl = '';
  try {
    productUrl = sitemap.ok ? firstProductUrlFromSitemap(sitemap.text, base) : '';
    if (productUrl) {
      const p = await fetchText(productUrl);
      productSchema = p.ok ? hasJsonLdType(p.text, ['Product']) : false;
    }
  } catch (_) { productSchema = null; }

  const homeHasOrg = home.ok ? hasJsonLdType(home.text, ['Organization', 'WebSite', 'Store']) : false;
  const homeMeta = home.ok ? /<meta[^>]+name=["']description["'][^>]+content=["'][^"']{20,}/i.test(home.text) : false;
  const homeOg = home.ok ? /<meta[^>]+property=["']og:(title|image)["']/i.test(home.text) : false;

  const checks = [
    { id: 'ai-crawlers', label: 'AI-crawlers toegestaan', status: !robots.ok ? 'warn' : (blockedAi.length ? 'warn' : 'pass'),
      detail: !robots.ok ? 'robots.txt niet leesbaar' : (blockedAi.length ? `Geblokkeerd: ${blockedAi.join(', ')}` : 'GPTBot, ClaudeBot, PerplexityBot e.d. mogen crawlen'),
      advies: blockedAi.length ? 'Sta AI-crawlers toe in robots.txt zodat ChatGPT/Claude/Perplexity je producten kunnen lezen en aanbevelen.' : '' },
    { id: 'llms-txt', label: 'llms.txt aanwezig', status: llms.ok && llms.text.trim() ? 'pass' : 'fail',
      detail: llms.ok && llms.text.trim() ? `${base}/llms.txt gevonden` : 'Geen llms.txt',
      advies: (llms.ok && llms.text.trim()) ? '' : 'Voeg een /llms.txt toe met een korte beschrijving van GENTS + links naar belangrijke pagina’s. AI-modellen gebruiken dit als startpunt.' },
    { id: 'sitemap', label: 'sitemap.xml aanwezig', status: sitemap.ok && /<urlset|<sitemapindex/i.test(sitemap.text) ? 'pass' : 'fail',
      detail: sitemap.ok ? 'sitemap.xml gevonden' : 'Geen sitemap.xml', advies: sitemap.ok ? '' : 'Zorg dat sitemap.xml bereikbaar is — crawlers ontdekken zo al je producten.' },
    { id: 'schema-org', label: 'Organisatie/site-schema (JSON-LD)', status: homeHasOrg ? 'pass' : 'warn',
      detail: homeHasOrg ? 'Organization/WebSite-schema gevonden op home' : 'Geen Organization/WebSite JSON-LD op de homepage',
      advies: homeHasOrg ? '' : 'Voeg Organization- + WebSite-schema (JSON-LD) toe — AI begrijpt dan wie GENTS is.' },
    { id: 'product-schema', label: 'Product-schema (JSON-LD)', status: productSchema === true ? 'pass' : productSchema === false ? 'warn' : 'warn',
      detail: productSchema === true ? `Product-schema gevonden${productUrl ? ' op een productpagina' : ''}` : productSchema === false ? 'Geen Product JSON-LD op de gecontroleerde productpagina' : 'Kon geen productpagina controleren',
      advies: productSchema === true ? '' : 'Voeg Product-schema (naam, prijs, beschikbaarheid, merk, reviews) toe — essentieel voor AI-shopping & rich results.' },
    { id: 'meta-description', label: 'Meta-description op home', status: homeMeta ? 'pass' : 'warn',
      detail: homeMeta ? 'Aanwezig' : 'Geen/zeer korte meta-description', advies: homeMeta ? '' : 'Zet een heldere meta-description op de homepage.' },
    { id: 'open-graph', label: 'Open Graph-tags', status: homeOg ? 'pass' : 'warn',
      detail: homeOg ? 'og:title/og:image aanwezig' : 'Geen Open Graph-tags', advies: homeOg ? '' : 'Voeg og:title/og:description/og:image toe voor nette previews in AI-antwoorden en social.' }
  ];

  const pass = checks.filter((c) => c.status === 'pass').length;
  const score = Math.round((pass / checks.length) * 100);

  const result = { refreshedAt: new Date().toISOString(), site: base, score, checks, crawlers, productUrlChecked: productUrl };
  try { await writeJsonBlob(READINESS_PATH, result); } catch (_) {}
  return result;
}

export async function readAiReadiness() { return readJsonBlob(READINESS_PATH, null); }
export function isReadinessFresh(r) { return r?.refreshedAt && (Date.now() - new Date(r.refreshedAt).getTime()) < READINESS_MAX_AGE_MS; }

/* Default koopvragen (NL herenmode) om AI-vindbaarheid te testen. */
export const DEFAULT_AI_QUERIES = [
  'Waar koop ik het beste een herenpak in Nederland?',
  'Welke winkels verkopen kwaliteits-herenmode in Nederland?',
  'Beste winkel voor een maatpak of mooi colbert in Nederland?',
  'Ik zoek een herenmodewinkel met meerdere filialen in Nederland — welke raad je aan?',
  'Waar vind ik goede herenkleding voor een bruiloft of gala?'
];

const BRAND_RE = /\bgents\b/i;

/** Stel de koopvragen aan Claude en meet of GENTS genoemd wordt. */
export async function runAiTestQueries({ queries } = {}) {
  if (!getClaudeKey()) throw new Error('CLAUDE_API_KEY ontbreekt — AI-test-queries niet beschikbaar.');
  const qs = (Array.isArray(queries) && queries.length ? queries : DEFAULT_AI_QUERIES).slice(0, 8);
  const system = 'Je bent een behulpzame Nederlandse shopping-assistent. Beantwoord de vraag kort en noem concrete winkels/merken (3-6) waar de klant terecht kan. Wees eerlijk en specifiek.';

  const results = [];
  for (const q of qs) {
    try {
      const { text, model } = await claudeMessage({ system, user: q, maxTokens: 400, temperature: 0.4 });
      const mentioned = BRAND_RE.test(text || '');
      let snippet = '';
      if (mentioned) {
        const idx = text.search(BRAND_RE);
        snippet = text.slice(Math.max(0, idx - 80), idx + 80).replace(/\s+/g, ' ').trim();
      }
      results.push({ query: q, mentioned, snippet, model: model || '' });
    } catch (e) {
      results.push({ query: q, mentioned: false, error: String(e?.message || e) });
    }
  }
  const mentionedCount = results.filter((r) => r.mentioned).length;
  const out = { refreshedAt: new Date().toISOString(), total: results.length, mentionedCount, results };
  try { await writeJsonBlob(TESTS_PATH, out); } catch (_) {}
  return out;
}

export async function readAiTestQueries() { return readJsonBlob(TESTS_PATH, null); }
