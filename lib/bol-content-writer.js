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
import { getContentForEan, buildBolContentPlan, readBolContentPlan, isPlanFresh } from './bol-content-optimizer.js';
import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { readProductsCache } from './shopify-products-cache.js';
import { buildDescriptionSystemPrompt } from './brandbook.js';
import { claudeMessage, getClaudeKey } from './claude-client.js';

const clean = (v) => String(v == null ? '' : v).trim();
const STATE_PATH = 'marketplace/bol-content-state.json';
const AIDESC_PATH = 'marketplace/bol-ai-descriptions.json';

/* bol gebruikt voor kleding ENGELSE attribuut-id's (bevestigd via de
   catalogus: Description, Colour, Colour Group, EU Size, Closure, Family Name).
   Maat als EU-confectie heeft de waarde 'EU52'. Alles instelbaar via env. */
const DESC_ATTR = clean(process.env.BOL_ATTR_DESCRIPTION) || 'Description';
const FAMILY_ATTR = clean(process.env.BOL_ATTR_FAMILYKEY) || 'Family Name';
/* Kleding-attributen uit de SRSERP-metafields. Env-overridebaar zodat je de exacte
   bol-categorie-id's kunt zetten na 'Ontdek bol-velden'. bol negeert een id dat niet
   bij de categorie hoort (best-effort), dus dit kan nooit een hele push blokkeren. */
const FIT_ATTR = clean(process.env.BOL_ATTR_FIT) || 'Fit';
const SEASON_ATTR = clean(process.env.BOL_ATTR_SEASON) || 'Season';
const COMPOSITION_ATTR = clean(process.env.BOL_ATTR_COMPOSITION) || 'Material Composition';
const IMG_LABEL_MAIN = clean(process.env.BOL_IMAGE_LABEL_MAIN) || 'FRONT';
const IMG_LABEL_EXTRA = clean(process.env.BOL_IMAGE_LABEL_EXTRA) || 'DETAIL';
const IMAGES_ON = !['0', 'false', 'no'].includes(clean(process.env.BOL_CONTENT_IMAGES).toLowerCase());
/* Families bestaan al op bol → standaard UIT (aanzetten met BOL_FAMILIES=1). */
const FAMILIES_ON = ['1', 'true', 'yes'].includes(clean(process.env.BOL_FAMILIES).toLowerCase());
const AI_ON = !['0', 'false', 'no'].includes(clean(process.env.BOL_AI_DESC).toLowerCase());
const MIN_DESC = 120; /* korter dan dit = "zwak" → AI-aanvulling */
const SIZE_NUMERIC = /^\d+$/;
/* Maatadvies + EU-confectie-maattabel in de omschrijving (tegen retourreden
   "verkeerde maat"). Standaard AAN, uit te zetten met BOL_SIZE_ADVICE=0. */
const SIZE_ADVICE_ON = !['0', 'false', 'no'].includes(clean(process.env.BOL_SIZE_ADVICE).toLowerCase());
const CATALOG_PATH = clean(process.env.BOL_CATALOG_PATH) || '/content/catalog-products';
const FAMILY_STATE_PATH = 'marketplace/bol-family-state.json';

/* Family Name: alle varianten van hetzelfde product delen dezelfde, leesbare
   waarde (zoals bol ze toont: "GENTS | <product> <kleur>") → één familie. */
function familyName(item) {
  const naam = [clean(item.titel), clean(item.kleur)].filter(Boolean).join(' ');
  return [clean(item.merk) || 'GENTS', naam].filter(Boolean).join(' | ').slice(0, 80);
}
/* Maat → bol: numerieke confectie = 'EU Size' met 'EU'-prefix (EU52); een
   lettermaat (S/M/L/XL) = 'Size'. */
function sizeAttrs(item, attr) {
  const maat = clean(item.maat);
  if (!maat) return [];
  return SIZE_NUMERIC.test(maat) ? attr('EU Size', `EU${maat}`) : attr('Size', maat);
}

/* Pasvorm → maatadvies-zin. Onbekend = veilige default ("kies de grotere"). */
function fitAdvies(pasvorm) {
  const p = clean(pasvorm).toLowerCase();
  if (/slim|skinny|tailored|nauw|smal|getailleerd/.test(p)) return 'Deze pasvorm valt aan de slanke kant — twijfel je tussen twee maten, kies dan de grotere.';
  if (/relaxed|loose|ruim|comfort|wide|oversized/.test(p)) return 'Deze pasvorm valt ruim — wil je het strakker, kies dan een maat kleiner.';
  if (/regular|normaal|classic|modern|recht/.test(p)) return 'Deze pasvorm valt normaal — bestel je gebruikelijke maat.';
  return 'Bestel je gebruikelijke maat. Twijfel je tussen twee maten, kies dan de grotere.';
}

/* Maatadvies + EU-confectie-maattabel — verlaagt de #1 retourreden (verkeerde
   maat). Wordt aan de omschrijving toegevoegd, pasvorm-bewust. */
function sizeAdviceBlock(item) {
  const maat = clean(item.maat);
  if (!maat) return '';
  const parts = [];
  if (clean(item.pasvorm)) parts.push(`Pasvorm: ${clean(item.pasvorm)}.`);
  parts.push(`Maatadvies: ${fitAdvies(item.pasvorm)}`);
  if (SIZE_NUMERIC.test(maat)) parts.push('Maattabel (EU-confectie): 46 = XS, 48 = S, 50 = M, 52 = L, 54 = XL, 56 = XXL, 58 = 3XL.');
  parts.push('Twijfel je over je maat? Stuur ons gerust een bericht — we helpen je graag de juiste maat te kiezen.');
  return parts.join(' ');
}

/* Bouw een rijkere bol-titel: merk vooraan + producttitel + pasvorm. GEEN maat
   (elke EAN is een maat-variant binnen de family — bol toont de maatkiezer). */
function buildTitle(item) {
  const base = clean(item.titel);
  const merk = clean(item.merk);
  let t = base;
  if (merk && !base.toLowerCase().includes(merk.toLowerCase())) t = `${merk} ${base}`;
  /* Verrijk met pasvorm + materiaal voor bol-zoekvindbaarheid — alleen als ze er
     nog niet in staan (geen dubbelingen). bol kapt op 200 tekens. */
  const extra = [];
  const pas = clean(item.pasvorm);
  if (pas && !t.toLowerCase().includes(pas.toLowerCase())) extra.push(pas);
  const mat = clean(item.materiaal);
  if (mat && mat.length <= 24 && !t.toLowerCase().includes(mat.toLowerCase())) extra.push(mat);
  if (extra.length) t = `${t} – ${extra.join(' ')}`;
  /* Maat in de titel zodat elke variant herkenbaar is (numeriek = EU-confectie). */
  const maat = clean(item.maat);
  if (maat && !t.toLowerCase().includes(`maat ${maat.toLowerCase()}`)) t = `${t} – Maat ${maat}`;
  return t.slice(0, 200);
}

/**
 * Map ons content-model → bol content-payload. Alleen niet-lege waarden.
 * @param {object} item   optimizer-item
 * @param {{beschrijving?:string, afbeeldingen?:string[]}} extra  omschrijving + foto's
 */
export function buildBolPayload(item, extra = {}) {
  const attr = (id, value) => (clean(value) ? [{ id, values: [{ value: clean(value).slice(0, 2000) }] }] : []);
  /* Omschrijving + (optioneel) maatadvies/maattabel eronder. */
  const descDelen = [clean(extra.beschrijving)];
  if (SIZE_ADVICE_ON) { const adv = sizeAdviceBlock(item); if (adv) descDelen.push(adv); }
  const beschrijving = descDelen.filter(Boolean).join('\n\n');
  const attributes = [
    ...attr('EAN', item.ean),
    ...attr('Title', buildTitle(item)),
    ...attr('Brand', item.merk || 'GENTS'),
    ...attr('Colour', item.kleur),
    ...attr('Colour Group', item.hoofdkleur || item.kleur),
    ...sizeAttrs(item, attr),
    ...attr('Material', item.materiaal),
    ...attr(COMPOSITION_ATTR, item.samenstelling),
    ...attr('Closure', item.sluiting),
    ...attr(FIT_ATTR, item.pasvorm),
    ...attr(SEASON_ATTR, item.seizoen),
    ...attr(DESC_ATTR, beschrijving),
    ...(FAMILIES_ON ? attr(FAMILY_ATTR, familyName(item)) : [])
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

/* Gebruik het gecachte plan als het vers is (voorkomt herbouw bij elke actie). */
async function getPlan() {
  const cached = await readBolContentPlan();
  if (cached && isPlanFresh(cached)) return cached;
  return buildBolContentPlan();
}

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
    'Schrijf een wervende, verkopende bol.com-productomschrijving voor dit GENTS-herenartikel.',
    'Eisen: Nederlands, 3 tot 5 vloeiende zinnen, lopende tekst (géén opsomming of bullets).',
    'Verwerk natuurlijk: de stof/het materiaal, de pasvorm en een concreet draagmoment of stylingtip.',
    'Gebruik relevante zoekwoorden (producttype, kleur, gelegenheid) zodat het goed vindbaar is op bol — maar schrijf vloeiend, geen keyword-stapeling, geen overdreven merkherhaling, geen superlatieven-spam.',
    '',
    'Gegevens:',
    `- Titel: ${clean(item.titel)}`,
    item.merk ? `- Merk: ${clean(item.merk)}` : '',
    item.kleur ? `- Kleur: ${clean(item.kleur)}` : '',
    item.materiaal ? `- Materiaal: ${clean(item.materiaal)}` : '',
    item.pasvorm ? `- Pasvorm: ${clean(item.pasvorm)}` : '',
    item.seizoen ? `- Seizoen: ${clean(item.seizoen)}` : '',
    item.hoofdgroep ? `- Categorie: ${clean(item.hoofdgroep)}` : ''
  ].filter(Boolean).join('\n');
  try { const { text } = await claudeMessage({ system, user, maxTokens: 320, temperature: 0.7 }); return clean(text); }
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
 * Maak productfamilies aan WAAR ZE ONTBREKEN (zonder bestaande te overschrijven).
 * Per product: leest de bol-catalogus; heeft het al een Family Name → met rust
 * laten; zo niet → push enkel de Family Name. Idempotent + gecached, gebudgetteerd
 * voor de cron. Alle varianten van hetzelfde product/kleur delen dezelfde naam.
 *
 * @param {{maxCheck?:number, dryRun?:boolean}} opts
 */
export async function ensureBolFamilies({ maxCheck = 120, dryRun = false, items = null } = {}) {
  const allItems = Array.isArray(items) ? items : (await buildBolContentPlan()).items;
  const pushKlaar = allItems.filter(isPushReady);
  const stateBlob = await readJsonBlob(FAMILY_STATE_PATH, { byEan: {} });
  const byEan = stateBlob.byEan || {};
  const configured = isBolConfigured();
  const live = !dryRun && configured;
  const now = new Date().toISOString();

  /* Nog niet bekend als "heeft familie" → kandidaat. */
  const openstaand = pushKlaar.filter((it) => !byEan[it.ean]?.heeftFamily);
  const todo = openstaand.slice(0, maxCheck);

  let gecontroleerd = 0, aangemaakt = 0, alAanwezig = 0, fouten = 0;
  const resultaten = [];
  for (const it of todo) {
    const fam = familyName(it);
    /* Dry-run: GEEN bol-calls (zou traag zijn) — toon alleen wat zou gebeuren. */
    if (!live) { if (resultaten.length < 100) resultaten.push({ ean: it.ean, familyName: fam, actie: 'controleren + aanmaken' }); continue; }
    /* Live: per product checken of er al een familie is, anders aanmaken. */
    let heeft = null;
    try {
      const raw = await bolGet(`${CATALOG_PATH}/${it.ean}`);
      const list = raw?.attributes || raw?.productAttributes || [];
      heeft = list.some((a) => clean(a.id).toLowerCase() === FAMILY_ATTR.toLowerCase() && clean(a.values?.[0]?.value ?? a.value));
      gecontroleerd += 1;
    } catch { heeft = null; }
    if (heeft === true) { byEan[it.ean] = { heeftFamily: true, at: now }; alAanwezig += 1; continue; }
    try {
      await bolPost('/content/products', { language: 'nl', attributes: [
        { id: 'EAN', values: [{ value: it.ean }] },
        { id: FAMILY_ATTR, values: [{ value: fam }] }
      ] });
      byEan[it.ean] = { heeftFamily: true, at: now };
      aangemaakt += 1;
      if (resultaten.length < 100) resultaten.push({ ean: it.ean, familyName: fam, status: 'aangemaakt' });
    } catch (e) { fouten += 1; if (resultaten.length < 100) resultaten.push({ ean: it.ean, error: e.message }); }
  }
  if (live) { try { await writeJsonBlob(FAMILY_STATE_PATH, { refreshedAt: now, byEan }); } catch (_) {} }

  return {
    dryRun: !live, configured,
    pushKlaar: pushKlaar.length,
    zonderFamilie: openstaand.length,
    gecontroleerd, aangemaakt, alAanwezig, fouten,
    resterend: Math.max(0, openstaand.length - todo.length),
    resultaten
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
export async function runBolContentAuto({ maxPush = 300, dryRun = false, items = null } = {}) {
  /* Volledige catalogus: gebruik de doorgegeven items (cron) of (her)bouw het volle
     plan. NIET het gecachte plan — dat is op 2000 afgekapt voor het dashboard. */
  const allItems = Array.isArray(items) ? items : (await buildBolContentPlan()).items;
  const state = await readJsonBlob(STATE_PATH, { byEan: {} });
  const byEan = state.byEan || {};
  const pushKlaar = allItems.filter(isPushReady);

  const live = !dryRun && isBolConfigured();
  const aiOn = AI_ON && Boolean(getClaudeKey());
  const aiBlob = aiOn ? await readJsonBlob(AIDESC_PATH, { byFamily: {} }) : { byFamily: {} };
  const byFamily = aiBlob.byFamily || {};

  /* Verrijking INCLUSIEF reeds gecachte AI-tekst, zodat de signature overeenkomt
     met wat we straks daadwerkelijk pushen (alleen NIEUW gegenereerde AI wijkt af
     en krijgt hieronder een herberekende sig). aiNodig = beschrijving te kort én
     nog geen AI gecached. */
  const eanCache = await buildEanCache();
  const enrich = (item) => {
    const entry = eanCache.get(clean(item.ean));
    let beschrijving = clean(entry?.descriptionPlain).slice(0, 2000);
    let aiNodig = false;
    if (beschrijving.length < MIN_DESC) {
      const fam = clean(item.family) || clean(item.ean);
      if (aiOn && byFamily[fam]?.text) beschrijving = byFamily[fam].text;
      else if (aiOn) aiNodig = true;
    }
    return { ex: { beschrijving, afbeeldingen: imagesFor(entry) }, aiNodig };
  };

  const kandidaten = [];
  for (const item of pushKlaar) {
    const { ex, aiNodig } = enrich(item);
    const payload = buildBolPayload(item, ex);
    const sig = signature(JSON.stringify(payload));
    /* Alleen pushen als de (AI-inclusieve) sig afwijkt van de laatst gepushte. */
    if (byEan[item.ean]?.sig === sig) continue;
    kandidaten.push({ item, ex, payload, sig, aiNodig });
  }

  let aiBudget = (aiOn && live) ? Number(process.env.BOL_AI_DESC_MAX || 60) : 0; /* dry-run genereert geen nieuwe AI */
  let aiGenerated = 0, gepusht = 0, fouten = 0;
  const resultaten = [];

  try {
    for (const c of kandidaten.slice(0, maxPush)) {
      let payload = c.payload;
      let sig = c.sig;
      if (c.aiNodig && aiBudget > 0) {
        const fam = clean(c.item.family) || clean(c.item.ean);
        const g = await genAiDescription(c.item);
        if (g) {
          byFamily[fam] = { text: g, at: new Date().toISOString() };
          aiBudget -= 1; aiGenerated += 1;
          payload = buildBolPayload(c.item, { ...c.ex, beschrijving: g });
          sig = signature(JSON.stringify(payload)); /* FINALE sig = wat we echt pushen */
        }
      }
      if (!live) { if (resultaten.length < 100) resultaten.push({ ean: c.item.ean, payload }); continue; }
      try {
        const res = await bolPost('/content/products', payload);
        byEan[c.item.ean] = { sig, at: new Date().toISOString() };
        gepusht += 1;
        if (resultaten.length < 100) resultaten.push({ ean: c.item.ean, status: clean(res?.processStatusId || res?.status || 'verzonden') });
      } catch (e) {
        fouten += 1;
        if (resultaten.length < 100) resultaten.push({ ean: c.item.ean, error: e.message });
      }
    }
  } finally {
    /* State + AI-cache ALTIJD wegschrijven (ook bij crash/timeout) zodat
       gepushte sigs + gegenereerde (betaalde) AI-teksten niet verloren gaan en
       dezelfde content niet onnodig opnieuw gepusht/gegenereerd wordt. */
    if (live) { try { await writeJsonBlob(STATE_PATH, { refreshedAt: new Date().toISOString(), byEan }); } catch (_) {} }
    if (aiOn && aiGenerated) { try { await writeJsonBlob(AIDESC_PATH, { refreshedAt: new Date().toISOString(), byFamily }); } catch (_) {} }
  }

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
