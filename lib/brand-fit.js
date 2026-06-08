/**
 * lib/brand-fit.js
 *
 * Merk-fit-score: hoe goed past een uiting (social-post, advertentie) bij de
 * GENTS brand assets uit het brandbook? Gebruikt Claude — vision voor beeld,
 * tekst voor copy — en geeft een cijfer 0-100 + verdict + plus/min-punten.
 *
 * Blob-gecached per (kind|beeld|tekst): scoort elke uiting maar één keer, tenzij
 * de inhoud wijzigt. Read-only t.o.v. de bron; schrijft alleen de score-cache.
 */

import crypto from 'node:crypto';
import { claudeVision, claudeMessage } from './claude-client.js';
import { BRANDBOOK } from './brandbook.js';
import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const PROMPT_VERSION = 'v1';
const CACHE_PATH = 'marketing/brand-fit-cache.json';
const clean = (v) => String(v == null ? '' : v).trim();

/** Condenseert de scoorbare brandbook-onderdelen tot een systeemprompt. */
export function buildBrandFitSystemPrompt() {
  const b = BRANDBOOK;
  const join = (arr, f) => (arr || []).map(f).join('; ');
  const photoDo = join(b.photography.modelDo, (x) => `${x.title} (${x.points.join(', ')})`);
  const photoDont = join(b.photography.modelDont, (x) => `${x.title} (${x.points.join(', ')})`);
  return [
    `Je bent de merkbewaker van ${b.brand.name}. ${b.brand.positioning}`,
    `Positionering: ${b.brand.proposition.join(' · ')}.`,
    `Kernwaarden: ${(b.values || []).map((v) => v.title).join(', ')}.`,
    `FOTOGRAFIE-STIJL: ${b.photography.aesthetic.join(', ')}. Kenmerken: ${b.photography.kenmerken.join('; ')}.`,
    `FOTO WEL: ${photoDo}.`,
    `FOTO NIET: ${photoDont}.`,
    `KLEUREN: ${b.colors.primary.concat(b.colors.accent).map((c) => c.name).join(', ')} — ${b.colors.usage.join('; ')}.`,
    `TONE-OF-VOICE WEL: ${b.toneOfVoice.do.join('; ')}.`,
    `TONE-OF-VOICE NIET: ${b.toneOfVoice.dont.join('; ')}.`,
    `Focus altijd op de GELEGENHEID (bruiloft, zakelijk, gala), niet op demografie/leeftijd. Subtiele "betaalbare luxe" — geen opschepperige luxury-marketing.`,
    ``,
    `Beoordeel hoe goed de aangeleverde uiting (beeld en/of tekst) bij deze merk-assets past.`,
    `Antwoord UITSLUITEND met geldige JSON, exact dit formaat (geen tekst eromheen):`,
    `{"score": <geheel 0-100>, "verdict": "<1 korte Nederlandse zin>", "beeld": <0-100 of null>, "tekst": <0-100 of null>, "plus": ["<max 3 sterke punten>"], "min": ["<max 3 verbeterpunten>"]}`,
    `Richtlijn: 85-100 = volledig on-brand; 70-84 = grotendeels; 50-69 = twijfel/afwijkingen; <50 = off-brand. Wees streng maar eerlijk.`
  ].join('\n');
}

function hashKey(parts) {
  return crypto.createHash('sha1').update(`${PROMPT_VERSION}|${parts.join('|')}`).digest('hex');
}

function parseJson(text) {
  let s = clean(text).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch { return null; }
}

const clampScore = (n) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null;
};
const gradeOf = (s) => s == null ? '—' : (s >= 85 ? 'on-brand' : s >= 70 ? 'grotendeels' : s >= 50 ? 'twijfel' : 'off-brand');

/* Haalt het beeld serverside op en geeft een data-URL terug, zodat Claude het
   als base64 krijgt i.p.v. de URL zelf op te halen (die fetch respecteert
   robots.txt — IG/FB-CDN's blokkeren dat). Faalt zacht: '' bij elke fout. */
async function fetchImageAsDataUrl(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    let resp;
    try { resp = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GENTS-portal/1.0)' } }); }
    finally { clearTimeout(t); }
    if (!resp.ok) return '';
    let ct = clean(resp.headers.get('content-type')).split(';')[0].toLowerCase();
    if (!/^image\/(jpe?g|png|gif|webp)$/.test(ct)) ct = 'image/jpeg';
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length || buf.length > 4500000) return '';
    return `data:${ct};base64,${buf.toString('base64')}`;
  } catch { return ''; }
}

let _cache = null;
async function loadCache() {
  if (_cache) return _cache;
  _cache = await readJsonBlob(CACHE_PATH, { items: {} }).catch(() => ({ items: {} }));
  if (!_cache || !_cache.items) _cache = { items: {} };
  return _cache;
}
async function saveCache() { if (_cache) { try { await writeJsonBlob(CACHE_PATH, _cache); } catch { /* best-effort */ } } }

/**
 * Score één uiting.
 * @param {{imageUrl?:string, text?:string, kind?:string}} input
 * @param {{useCache?:boolean}} [opts]
 */
export async function scoreBrandFit({ imageUrl, text, kind } = {}, { useCache = true } = {}) {
  const img = clean(imageUrl);
  const txt = clean(text);
  if (!img && !txt) return { score: null, grade: '—', verdict: 'Geen inhoud om te beoordelen.', error: 'leeg' };

  const key = hashKey([kind || '', img, txt.slice(0, 600)]);
  if (useCache) { const c = await loadCache(); if (c.items[key]) return { ...c.items[key], cached: true }; }

  /* Beeld serverside ophalen → base64 naar Claude (zie fetchImageAsDataUrl). */
  const dataUrl = img ? await fetchImageAsDataUrl(img) : '';

  const system = buildBrandFitSystemPrompt();
  const userParts = [];
  if (kind) userParts.push(`Type uiting: ${kind}.`);
  if (txt) userParts.push(`Tekst/caption:\n"""${txt.slice(0, 1200)}"""`);
  userParts.push(dataUrl
    ? 'Beoordeel ook het bijgevoegde beeld: fotografie-stijl, achtergrond, pasvorm, grooming, sfeer, kleurgebruik en of het merk-logo/woordmerk correct is.'
    : (img
      ? 'Het beeld kon niet worden opgehaald — beoordeel op basis van de caption en geef beeld:null.'
      : 'Er is geen beeld; beoordeel alleen de tekst op tone-of-voice en positionering.'));

  let raw;
  try {
    raw = dataUrl
      ? await claudeVision({ system, user: userParts.join('\n'), imageUrls: [dataUrl], maxTokens: 500, temperature: 0 })
      : await claudeMessage({ system, user: userParts.join('\n'), maxTokens: 400, temperature: 0 });
  } catch (e) {
    return { score: null, grade: '—', verdict: '', error: e.message || 'AI-fout' };
  }

  const j = parseJson(raw.text) || {};
  const score = clampScore(j.score);
  const out = {
    score,
    grade: gradeOf(score),
    verdict: clean(j.verdict).slice(0, 200),
    beeld: clampScore(j.beeld),
    tekst: clampScore(j.tekst),
    plus: Array.isArray(j.plus) ? j.plus.map((x) => clean(x)).filter(Boolean).slice(0, 3) : [],
    min: Array.isArray(j.min) ? j.min.map((x) => clean(x)).filter(Boolean).slice(0, 3) : [],
    scoredAt: new Date().toISOString()
  };
  /* Niet cachen als er wél een beeld was maar dat niet opgehaald kon worden —
     dan mag een volgende poging het opnieuw proberen (CDN-blip / 403). */
  if (useCache && score != null && (dataUrl || !img)) { const c = await loadCache(); c.items[key] = out; await saveCache(); }
  return out;
}
