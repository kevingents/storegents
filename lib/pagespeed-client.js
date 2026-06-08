/**
 * lib/pagespeed-client.js
 *
 * Google PageSpeed Insights (Lighthouse-labmeting + CrUX-veldgegevens) voor de
 * SEO-ranking-pagina. Meet de echte sitesnelheid / Core Web Vitals van een paar
 * sleutel-URL's op mobiel. Read-only, blob-gecached (PSI is traag: ~10-30s/URL).
 *
 * Env (alles optioneel — PSI werkt ook zonder key, met lager quotum):
 *   PAGESPEED_API_KEY / GOOGLE_PAGESPEED_API_KEY / GOOGLE_API_KEY
 *       API-key voor een hoger quotum.
 *   PAGESPEED_URLS
 *       Komma-gescheiden lijst URL's (default: homepage + /collections/all).
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const PATH = 'marketing/pagespeed.json';
const PSI_URL = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const TIMEOUT_MS = Number(process.env.PAGESPEED_TIMEOUT_MS || 35000);
const MAX_AGE_MS = Number(process.env.PAGESPEED_MAX_AGE_MS || 12 * 60 * 60 * 1000);

const clean = (v) => String(v == null ? '' : v).trim();

/* Server-side call stuurt standaard geen Referer → een API-key met HTTP-referrer-
   restrictie blokkeert dat ("referer <empty> blocked"). We sturen daarom een
   Referer mee die matcht met de site. Beste praktijk blijft: zet de key op
   Application restriction = None + API restriction = PageSpeed Insights API. */
const REFERER = clean(process.env.PAGESPEED_REFERER) || 'https://gents.nl/';

function apiKey() {
  return clean(process.env.PAGESPEED_API_KEY || process.env.GOOGLE_PAGESPEED_API_KEY || process.env.GOOGLE_API_KEY);
}

/** Sleutel-URL's: env-override of een verstandige default voor gents.nl. */
function targetUrls() {
  const raw = clean(process.env.PAGESPEED_URLS);
  if (raw) return raw.split(',').map((s) => clean(s)).filter(Boolean).map((u) => ({ url: u, label: u }));
  return [
    { url: 'https://gents.nl/', label: 'Homepage' },
    { url: 'https://gents.nl/collections/all', label: 'Alle producten' }
  ];
}

/* Core Web Vitals-drempels → rating good / needs-improvement / poor. */
function rate(metric, v) {
  if (v == null || !Number.isFinite(v)) return 'unknown';
  const T = {
    lcp: [2500, 4000], fcp: [1800, 3000], inp: [200, 500],
    cls: [0.1, 0.25], tbt: [200, 600], si: [3400, 5800]
  }[metric];
  if (!T) return 'unknown';
  return v <= T[0] ? 'good' : v <= T[1] ? 'ni' : 'poor';
}

function labAudit(lh, id) {
  const a = lh && lh.audits && lh.audits[id];
  return a && typeof a.numericValue === 'number' ? a.numericValue : null;
}

function fieldPct(exp, key) {
  const m = exp && exp.metrics && exp.metrics[key];
  return m && typeof m.percentile === 'number' ? m.percentile : null;
}

async function runOne(target, key) {
  const params = new URLSearchParams();
  params.set('url', target.url);
  params.set('strategy', 'mobile');
  params.append('category', 'performance');
  if (key) params.set('key', key);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${PSI_URL}?${params.toString()}`, { signal: ctrl.signal, headers: { Referer: REFERER } });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { url: target.url, label: target.label, error: clean(data && data.error && data.error.message) || `PageSpeed (${resp.status})` };
    }

    const lh = data.lighthouseResult || {};
    const score = lh.categories && lh.categories.performance ? lh.categories.performance.score : null;
    const lab = {
      lcp: labAudit(lh, 'largest-contentful-paint'),
      fcp: labAudit(lh, 'first-contentful-paint'),
      cls: labAudit(lh, 'cumulative-layout-shift'),
      tbt: labAudit(lh, 'total-blocking-time'),
      si: labAudit(lh, 'speed-index'),
      tti: labAudit(lh, 'interactive')
    };

    /* Veldgegevens (echte gebruikers, CrUX) — pagina-niveau, val terug op origin. */
    const exp = data.loadingExperience || {};
    const orig = data.originLoadingExperience || {};
    const pickField = (k) => fieldPct(exp, k) ?? fieldPct(orig, k);
    const onlyOrigin = !(exp.metrics && Object.keys(exp.metrics).length) && !!(orig.metrics && Object.keys(orig.metrics).length);
    const clsRaw = pickField('CUMULATIVE_LAYOUT_SHIFT_SCORE');
    const field = {
      overall: clean(exp.overall_category) || clean(orig.overall_category) || '',
      origin: onlyOrigin,
      lcp: pickField('LARGEST_CONTENTFUL_PAINT_MS'),
      cls: clsRaw == null ? null : clsRaw / 100, /* CrUX levert CLS ×100 */
      inp: pickField('INTERACTION_TO_NEXT_PAINT'),
      fcp: pickField('FIRST_CONTENTFUL_PAINT_MS')
    };

    return {
      url: clean(data.id) || target.url,
      label: target.label,
      score: typeof score === 'number' ? Math.round(score * 100) : null,
      lab: { ...lab, ratings: { lcp: rate('lcp', lab.lcp), fcp: rate('fcp', lab.fcp), cls: rate('cls', lab.cls), tbt: rate('tbt', lab.tbt), si: rate('si', lab.si) } },
      field: { ...field, ratings: { lcp: rate('lcp', field.lcp), cls: rate('cls', field.cls), inp: rate('inp', field.inp), fcp: rate('fcp', field.fcp) } }
    };
  } catch (e) {
    return { url: target.url, label: target.label, error: e.name === 'AbortError' ? `Time-out na ${Math.round(TIMEOUT_MS / 1000)}s` : (e.message || 'PageSpeed-fout') };
  } finally { clearTimeout(t); }
}

export async function runPageSpeed() {
  const targets = targetUrls();
  const key = apiKey();
  const results = await Promise.all(targets.map((t) => runOne(t, key)));
  const ok = results.filter((r) => !r.error && r.score != null);
  const quota = results.some((r) => /quota|429|rate.?limit/i.test(r.error || ''));
  const result = {
    configured: true,
    refreshedAt: new Date().toISOString(),
    hasKey: !!key,
    quotaHint: quota && !key, /* keyless quotum op → vraag om PAGESPEED_API_KEY */
    strategy: 'mobile',
    avgScore: ok.length ? Math.round(ok.reduce((n, r) => n + r.score, 0) / ok.length) : null,
    results
  };
  /* Alleen cachen als er minstens één geslaagde meting is — zo blijft een
     mislukte run (bv. quota op) niet 12u hangen en probeert hij opnieuw zodra
     er een API-key staat. */
  if (ok.length) { try { await writeJsonBlob(PATH, result); } catch (_) {} }
  return result;
}

export async function readPageSpeed() { return readJsonBlob(PATH, null); }
export function isPageSpeedFresh(d) { return d && d.refreshedAt && (Date.now() - new Date(d.refreshedAt).getTime()) < MAX_AGE_MS; }
