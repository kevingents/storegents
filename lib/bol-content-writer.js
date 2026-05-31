/**
 * lib/bol-content-writer.js
 *
 * Bouwt het bol Content-API-payload uit het optimizer-plan en pusht het
 * (POST /retailer/content/products). Verrijkt elke push met:
 *   - attributen (merk, kleur, maat, materiaal, pasvorm, …)
 *   - een verkopende omschrijving (Shopify-tekst, of AI-gegenereerd als die
 *     ontbreekt — budget-gelimiteerd en per family gecached)
 *   - afbeeldingen (assets uit de Shopify-product-cache)
 *
 * Standaard DRY-RUN: dan wordt niets naar bol gestuurd maar zie je exact wat
 * verstuurd zou worden, zodat we de mapping eerst op de demo kunnen valideren.
 */

import { bolPost, bolGet, isBolConfigured, getBolConfig } from './bol-client.js';
import { getContentForEan, buildBolContentPlan, readBolContentPlan } from './bol-content-optimizer.js';
import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { readProductsCache } from './shopify-products-cache.js';
import { buildDescriptionSystemPrompt } from './brandbook.js';
import { claudeMessage, getClaudeKey } from './claude-client.js';

const clean = (v) => String(v == null ? '' : v).trim();
const STATE_PATH = 'marketplace/bol-content-state.json';
const AIDESC_PATH = 'marketplace/bol-ai-descriptions.json';

/* Instelbaar (validatie op demo kan een afwijkende id/structuur opleveren).
   Officiële bol-structuur: assets[].labels zijn positioneel (FRONT/BACK/
   MODEL_FRONT/DETAIL…), min 1 / max 2 per foto; FRONT = hoofdfoto. De exacte
   id's + geldige labels zijn categorie-specifiek (chunk in het bol-datamodel). */
const DESC_ATTR = clean(process.env.BOL_ATTR_DESCRIPTION) || 'Productomschrijving';
const FAMILY_ATTR = clean(process.env.BOL_ATTR_FAMILYKEY) || 'Family Key';
const IMG_LABEL_MAIN = clean(process.env.BOL_IMAGE_LABEL_MAIN) || 'FRONT';
const IMG_LABEL_EXTRA = clean(process.env.BOL_IMAGE_LABEL_EXTRA) || 'DETAIL';
const IMAGES_ON = !['0', 'false', 'no'].includes(clean(process.env.BOL_CONTENT_IMAGES).toLowerCase());
const FAMILIES_ON = !['0', 'false', 'no'].includes(clean(process.env.BOL_FAMILIES).toLowerCase());
const AI_ON = !['0', 'false', 'no'].includes(clean(process.env.BOL_AI_DESC).toLowerCase());
const MIN_DESC = 120; /* korter dan dit = "zwak" → AI-aanvulling */

/* Family Key: alle varianten van hetzelfde Shopify-product krijgen dezelfde
   key → bol groepeert ze tot één productfamilie (maat-/kleurkiezer op één
   pagina). Alleen [A-Za-z0-9_|-] toegestaan, geen spaties (bol-regel). */
function familyKey(item) {
  const raw = clean(item.family) || clean(item.ean);
  const safe = raw.replace(/[^A-Za-z0-9_|-]/g, '').slice(0, 40);
  return safe ? `GENTS-${safe}` : '';
}

/* Bouw een rijkere bol-titel: merk vooraan + producttitel + pasvorm. GEEN maat
   (elke EAN is een maat-variant binnen de family — bol toont de maatkiezer). */
function buildTitle(item) {
  const base = clean(item.titel);
  const merk = clean(item.merk);
  let t = base;
  if (merk && !base.toLowerCase().includes(merk.toLowerCase())) t = `${merk} ${base}`;
  const pas = clean(item.pasvorm);
  if (pas && !t.toLowerCase().includes(pas.toLowerCase())) t = `${t} – ${pas}`;
  return t.slice(0, 200);
}

/**
 * Map ons content-model → bol content-payload. Alleen niet-lege waarden.
 * @param {object} item   optimizer-item
 * @param {{beschrijving?:string, afbeeldingen?:string[]}} extra  omschrijving + foto's
 */
export function buildBolPayload(item, extra = {}) {
  const attr = (id, value) => (clean(value) ? [{ id, values: [{ value: clean(value).slice(0, 2000) }] }] : []);
  const attributes = [
    ...attr('EAN', item.ean),
    ...attr('Title', buildTitle(item)),
    ...attr('Merk', item.merk || 'GENTS'),
    ...attr('Kleur', item.kleur),
    ...attr('Maat', item.maat),
    ...attr('Materiaal', item.materiaal),
    ...attr('Samenstelling', item.samenstelling),
    ...attr('Pasvorm', item.pasvorm),
    ...attr('Sluiting', item.sluiting),
    ...attr('Doelgroep', 'Heren'),
    ...attr('Kleur volgens fabrikant', item.kleur),
    ...attr(DESC_ATTR, extra.beschrijving),
    ...(FAMILIES_ON ? attr(FAMILY_ATTR, familyKey(item)) : [])
  ];
  const payload = { language: 'nl', attributes };
  const imgs = (extra.afbeeldingen || []).map(clean).filter(Boolean).slice(0, 8);
  if (IMAGES_ON && imgs.length) {
    payload.assets = imgs.map((url, i) => ({ url, labels: [i === 0 ? IMG_LABEL_MAIN : IMG_LABEL_EXTRA] }));
  }
  return payload;
}

/* Push-criterium: identiteits-content aanwezig (kleur + maat + EAN). */
export function isPushReady(item) {
  return Boolean(clean(item.kleur) && clean(item.maat) && clean(item.ean));
}

/* Goedkope content-handtekening om alleen te pushen wat écht wijzigde. */
function signature(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); }

/* ── Verrijking uit de Shopify-product-cache (omschrijving + foto's). ───── */
async function buildEanCache() {
  const cache = await readProductsCache().catch(() => null);
  const m = new Map();
  for (const v of Object.values(cache?.byBarcode || {})) {
    const ean = clean(v.barcode);
    if (ean && !m.has(ean)) m.set(ean, v);
  }
  return m;
}
function imagesFor(entry) {
  if (!entry) return [];
  if (Array.isArray(entry.images) && entry.images.length) return entry.images;
  return entry.image ? [entry.image] : [];
}

/* AI-omschrijving in de GENTS tone-of-voice (alleen als Shopify er geen heeft). */
async function genAiDescription(item) {
  if (!getClaudeKey()) return '';
  const system = buildDescriptionSystemPrompt();
  const user = [
    'Schrijf een korte, wervende bol.com-productomschrijving (Nederlands, 2 tot 4 vloeiende zinnen, geen opsomming, geen overdreven merkherhaling) voor dit GENTS-herenartikel:',
    `- Titel: ${clean(item.titel)}`,
    item.merk ? `- Merk: ${clean(item.merk)}` : '',
    item.kleur ? `- Kleur: ${clean(item.kleur)}` : '',
    item.materiaal ? `- Materiaal: ${clean(item.materiaal)}` : '',
    item.pasvorm ? `- Pasvorm: ${clean(item.pasvorm)}` : '',
    item.hoofdgroep ? `- Categorie: ${clean(item.hoofdgroep)}` : ''
  ].filter(Boolean).join('\n');
  try { const { text } = await claudeMessage({ system, user, maxTokens: 240, temperature: 0.7 }); return clean(text); }
  catch { return ''; }
}

/**
 * Push content voor een set EAN's (handmatige selectie). Verrijkt met Shopify-
 * omschrijving + foto's + reeds gecachte AI-omschrijving (genereert zelf geen
 * nieuwe AI-teksten — dat doet de autonome cron, budget-gelimiteerd).
 * @returns {Promise<object>} { dryRun, aantal, resultaten:[{ean, payload, status?, error?}] }
 */
export async function pushBolContent({ eans = [], dryRun = true } = {}) {
  if (!dryRun && !isBolConfigured()) throw new Error('bol niet gekoppeld — kan niet live pushen.');
  const list = (Array.isArray(eans) ? eans : []).map(clean).filter(Boolean).slice(0, 200);
  if (!list.length) throw new Error('Geen EANs opgegeven.');

  const plan = await readBolContentPlan();
  const byEanItem = new Map((plan?.items || []).map((i) => [clean(i.ean), i]));
  const eanCache = await buildEanCache();
  const aiCache = (await readJsonBlob(AIDESC_PATH, { byFamily: {} })).byFamily || {};

  const extraFor = (item) => {
    const entry = eanCache.get(clean(item.ean));
    let beschrijving = clean(entry?.descriptionPlain).slice(0, 2000);
    if (beschrijving.length < MIN_DESC) {
      const fam = clean(item.family) || clean(item.ean);
      if (aiCache[fam]?.text) beschrijving = aiCache[fam].text;
    }
    return { beschrijving, afbeeldingen: imagesFor(entry) };
  };

  const resultaten = [];
  for (const ean of list) {
    const item = byEanItem.get(ean) || await getContentForEan(ean);
    if (!item) { resultaten.push({ ean, error: 'Geen content-plan voor deze EAN (ververs eerst het plan).' }); continue; }
    const payload = buildBolPayload(item, extraFor(item));
    if (dryRun) { resultaten.push({ ean, payload }); continue; }
    try {
      const res = await bolPost('/content/products', payload);
      resultaten.push({ ean, status: clean(res?.status || res?.processStatusId || 'verzonden'), processId: clean(res?.processStatusId || res?.id) });
    } catch (e) { resultaten.push({ ean, error: e.message }); }
  }
  return { dryRun, aantal: resultaten.length, resultaten };
}

/** Ververs het plan (optimizer) — convenience voor de endpoint. */
export async function refreshPlan() { return buildBolContentPlan(); }

/**
 * Ontdek de ECHTE bol-attribuut-id's + asset-labels voor een specifieke EAN via
 * de catalog-product-content (get-catalog-product). Zo hoeven we de categorie-
 * specifieke id's (o.a. de omschrijving) niet te gokken. Vereist bol-koppeling.
 */
const DEMO_EAN = '0842776106209'; /* bol's enige voorbeeld-EAN in de demo-omgeving */

export async function discoverBolCatalog(ean) {
  if (!isBolConfigured()) throw new Error('bol niet gekoppeld — kan de catalogus niet uitlezen.');
  const cfg = getBolConfig();
  const gevraagd = clean(ean);
  /* De demo-omgeving kent alleen de voorbeeld-EAN; eigen EANs geven een 500.
     In demo lezen we daarom de voorbeeld-EAN uit om de VELDSTRUCTUUR te tonen. */
  const e = cfg.demo ? DEMO_EAN : gevraagd;
  if (!e) throw new Error('Geen EAN opgegeven.');
  const base = clean(process.env.BOL_CATALOG_PATH) || '/content/catalog-products';
  let raw;
  try { raw = await bolGet(`${base}/${e}`); }
  catch (err) {
    if (cfg.demo) throw new Error(`De bol-DEMO ondersteunt dit lees-endpoint niet betrouwbaar — zelfs bol's eigen voorbeeld-EAN ${DEMO_EAN} geeft hier een 500. Je auth werkt (anders was het een 401). Zet BOL_DEMO=0 (live) om de echte attribuut-id's van je eigen artikelen uit te lezen.`);
    throw err;
  }
  const list = raw?.attributes || raw?.productAttributes || [];
  const attributen = list.map((a) => ({ id: clean(a.id), waarde: clean(a.values?.[0]?.value ?? a.value) })).filter((a) => a.id);
  const assets = (raw?.assets || []).map((a) => ({ labels: a.labels || a.usage || [], url: clean(a.url || a.variants?.[0]?.url) }));
  return {
    ean: e,
    demoVoorbeeld: cfg.demo,
    melding: cfg.demo ? `Demo-omgeving: bol kent alleen de voorbeeld-EAN ${DEMO_EAN}. Dit toont de veld-structuur (attribuut-id's + labels) die ook live geldt. Je eigen EAN ${gevraagd || '—'} lees je uit met BOL_DEMO=0 (live).` : '',
    chunk: clean(raw?.gpcChunkId || raw?.chunkId),
    publishing: clean(raw?.publishingStatus || raw?.publishing),
    huidigeAttributen: attributen,
    huidigeAssets: assets,
    onzeDescAttr: DESC_ATTR,
    onzeImageLabels: { hoofd: IMG_LABEL_MAIN, extra: IMG_LABEL_EXTRA }
  };
}

/**
 * AUTONOOM: optimaliseer + push de content voor alle push-klare producten.
 * Verrijkt met omschrijving (Shopify, of AI als die ontbreekt — budget per run)
 * en afbeeldingen, en pusht alleen wat nieuw/gewijzigd is. Voor de cron.
 *
 * @param {{maxPush?:number, dryRun?:boolean}} opts
 * @returns {Promise<object>}
 */
export async function runBolContentAuto({ maxPush = 300, dryRun = false } = {}) {
  const plan = await buildBolContentPlan();
  const state = await readJsonBlob(STATE_PATH, { byEan: {} });
  const byEan = state.byEan || {};
  const pushKlaar = plan.items.filter(isPushReady);

  /* Basis-verrijking (Shopify-omschrijving + foto's) — geen AI; bepaalt of er
     iets wijzigde. AI-tekst voegen we daarna alleen toe aan wat we echt pushen. */
  const eanCache = await buildEanCache();
  const baseExtra = (item) => {
    const entry = eanCache.get(clean(item.ean));
    return { beschrijving: clean(entry?.descriptionPlain).slice(0, 2000), afbeeldingen: imagesFor(entry) };
  };

  const kandidaten = [];
  for (const item of pushKlaar) {
    const ex = baseExtra(item);
    const payload = buildBolPayload(item, ex);
    const sig = signature(JSON.stringify(payload));
    if (byEan[item.ean]?.sig === sig) continue;
    kandidaten.push({ item, ex, payload, sig });
  }

  const live = !dryRun && isBolConfigured();
  const aiOn = AI_ON && Boolean(getClaudeKey());
  let aiBudget = (aiOn && live) ? Number(process.env.BOL_AI_DESC_MAX || 60) : 0; /* dry-run genereert geen nieuwe AI */
  const aiBlob = aiOn ? await readJsonBlob(AIDESC_PATH, { byFamily: {} }) : { byFamily: {} };
  const byFamily = aiBlob.byFamily || {};
  let aiGenerated = 0;

  let gepusht = 0, fouten = 0;
  const resultaten = [];
  for (const c of kandidaten.slice(0, maxPush)) {
    let payload = c.payload;
    if (aiOn && (!c.ex.beschrijving || c.ex.beschrijving.length < MIN_DESC)) {
      const fam = clean(c.item.family) || clean(c.item.ean);
      let aiText = byFamily[fam]?.text;
      if (!aiText && aiBudget > 0) {
        const g = await genAiDescription(c.item);
        if (g) { aiText = g; byFamily[fam] = { text: g, at: new Date().toISOString() }; aiBudget -= 1; aiGenerated += 1; }
      }
      if (aiText) payload = buildBolPayload(c.item, { ...c.ex, beschrijving: aiText });
    }
    if (!live) { if (resultaten.length < 100) resultaten.push({ ean: c.item.ean, payload }); continue; }
    try {
      const res = await bolPost('/content/products', payload);
      byEan[c.item.ean] = { sig: c.sig, at: new Date().toISOString() };
      gepusht += 1;
      if (resultaten.length < 100) resultaten.push({ ean: c.item.ean, status: clean(res?.processStatusId || res?.status || 'verzonden') });
    } catch (e) {
      fouten += 1;
      if (resultaten.length < 100) resultaten.push({ ean: c.item.ean, error: e.message });
    }
  }
  if (live) { try { await writeJsonBlob(STATE_PATH, { refreshedAt: new Date().toISOString(), byEan }); } catch (_) {} }
  if (aiOn && aiGenerated) { try { await writeJsonBlob(AIDESC_PATH, { refreshedAt: new Date().toISOString(), byFamily }); } catch (_) {} }

  return {
    dryRun: !live,
    pushKlaar: pushKlaar.length,
    kandidaten: kandidaten.length,
    gepusht, fouten,
    aiGegenereerd: aiGenerated,
    resterend: Math.max(0, kandidaten.length - maxPush),
    resultaten
  };
}
