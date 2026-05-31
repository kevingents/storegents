/**
 * lib/bol-content-optimizer.js
 *
 * Berekent per EAN de OPTIMALE bol.com-content uit de Shopify-productdata:
 * genormaliseerde kleur + maat, materiaal/pasvorm/samenstelling uit metafields,
 * omschrijving, foto's en family-groepering (varianten van hetzelfde basis-
 * product). Levert ook een dekkingsoverzicht (welke content ontbreekt) zodat
 * we gericht kunnen verbeteren.
 *
 * Dit is de "bron van waarheid" voor wat de bol-content MOET zijn. Het pushen
 * gebeurt apart (bol-content-writer) met dry-run + review. Read-only hier.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { readProductsCache } from './shopify-products-cache.js';

const PATH = 'marketplace/bol-content-plan.json';
const MAX_AGE_MS = Number(process.env.BOL_CONTENT_MAX_AGE_MS || 12 * 60 * 60 * 1000);

const clean = (v) => String(v == null ? '' : v).trim();

/* ── Normalisatie maten ─────────────────────────────────────────────────
   bol verwacht consistente maatwaarden. We mappen de meest voorkomende
   GENTS-notaties naar een nette weergave. Onbekend → letterlijk overnemen. */
const SIZE_MAP = new Map([
  ['xs', 'XS'], ['s', 'S'], ['m', 'M'], ['l', 'L'], ['xl', 'XL'], ['xxl', 'XXL'], ['xxxl', 'XXXL'],
  ['2xl', 'XXL'], ['3xl', 'XXXL']
]);
function normalizeMaat(raw) {
  const s = clean(raw);
  if (!s) return '';
  const lc = s.toLowerCase().replace(/\s+/g, '');
  if (SIZE_MAP.has(lc)) return SIZE_MAP.get(lc);
  /* Confectie/numeriek (46, 48, W32/L34, 41) → laat staan, trim. */
  return s.toUpperCase().replace(/\s+/g, '');
}

/* ── Normalisatie kleuren ───────────────────────────────────────────────
   Map vrije kleurnamen naar een hoofdkleur (bol-kleurfilter). Onbekend →
   originele kleur als hoofdkleur. */
const COLOR_CANON = [
  ['zwart', ['zwart', 'black', 'antraciet zwart']],
  ['wit', ['wit', 'white', 'offwhite', 'off-white', 'ecru', 'creme', 'crème']],
  ['blauw', ['blauw', 'blue', 'navy', 'marine', 'denim', 'kobalt', 'jeans']],
  ['grijs', ['grijs', 'grey', 'gray', 'antraciet', 'taupe']],
  ['bruin', ['bruin', 'brown', 'cognac', 'camel', 'tan', 'beige', 'zand', 'khaki']],
  ['groen', ['groen', 'green', 'olijf', 'olive', 'army']],
  ['rood', ['rood', 'red', 'bordeaux', 'bordo', 'wijnrood']],
  ['roze', ['roze', 'pink', 'rose']],
  ['paars', ['paars', 'purple', 'lila']],
  ['geel', ['geel', 'yellow', 'oker']],
  ['oranje', ['oranje', 'orange']]
];
function normalizeKleur(raw) {
  const s = clean(raw);
  if (!s) return { kleur: '', hoofdkleur: '' };
  const lc = s.toLowerCase();
  for (const [canon, syns] of COLOR_CANON) {
    if (syns.some((w) => lc.includes(w))) return { kleur: s, hoofdkleur: canon };
  }
  return { kleur: s, hoofdkleur: s.toLowerCase() };
}

/** Bouw het optimale content-plan voor alle producten met een EAN. */
export async function buildBolContentPlan() {
  const cache = await readProductsCache();
  const byBarcode = (cache && cache.byBarcode) || {};
  const variants = [...new Map(Object.values(byBarcode).map((v) => [clean(v.barcode), v])).values()].filter((v) => clean(v.barcode));

  const families = new Map(); /* productId → { title, varianten:[ean] } */
  const items = [];
  const cov = { totaal: 0, metMerk: 0, metKleur: 0, metMaat: 0, metBeschrijving: 0, metFoto: 0, metMateriaal: 0 };

  for (const v of variants) {
    const ean = clean(v.barcode);
    const { kleur, hoofdkleur } = normalizeKleur(v.color);
    const maat = normalizeMaat(v.size);
    const beschrijving = clean(v.descriptionPlain);
    const fotos = Array.isArray(v.images) ? v.images.length : (v.image ? 1 : 0);
    const materiaal = clean(v.materiaal);
    const merk = clean(v.vendor);
    const ontbreekt = [];
    if (!merk) ontbreekt.push('merk');
    if (!kleur) ontbreekt.push('kleur');
    if (!maat) ontbreekt.push('maat');
    if (beschrijving.length < 40) ontbreekt.push('beschrijving');
    if (!fotos) ontbreekt.push('foto');
    if (!materiaal) ontbreekt.push('materiaal');

    cov.totaal += 1;
    if (merk) cov.metMerk += 1;
    if (kleur) cov.metKleur += 1;
    if (maat) cov.metMaat += 1;
    if (beschrijving.length >= 40) cov.metBeschrijving += 1;
    if (fotos) cov.metFoto += 1;
    if (materiaal) cov.metMateriaal += 1;

    const pid = clean(v.productId) || ean;
    if (!families.has(pid)) families.set(pid, { title: clean(v.title), varianten: [] });
    families.get(pid).varianten.push(ean);

    items.push({
      ean,
      family: pid,
      titel: clean(v.title),
      merk,
      productType: clean(v.productType),
      kleur, hoofdkleur, maat,
      materiaal,
      samenstelling: clean(v.samenstelling),
      pasvorm: clean(v.pasvorm),
      sluiting: clean(v.sluiting),
      hoofdgroep: clean(v.hoofdgroepOmschrijving || v.hoofdgroep),
      seizoen: clean(v.seizoen),
      beschrijvingLengte: beschrijving.length,
      aantalFotos: fotos,
      productUrl: clean(v.productUrl),
      ontbreekt
    });
  }

  /* Gat-buckets voor snelle actie. */
  const buckets = {
    geenMerk: items.filter((i) => i.ontbreekt.includes('merk')).slice(0, 1000),
    geenMaat: items.filter((i) => i.ontbreekt.includes('maat')).slice(0, 1000),
    geenKleur: items.filter((i) => i.ontbreekt.includes('kleur')).slice(0, 1000),
    geenBeschrijving: items.filter((i) => i.ontbreekt.includes('beschrijving')).slice(0, 1000),
    geenFoto: items.filter((i) => i.ontbreekt.includes('foto')).slice(0, 1000),
    geenMateriaal: items.filter((i) => i.ontbreekt.includes('materiaal')).slice(0, 1000)
  };
  const bucketCounts = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]));

  const familyList = [...families.entries()].map(([pid, f]) => ({ family: pid, titel: f.title, aantalVarianten: f.varianten.length }))
    .sort((a, b) => b.aantalVarianten - a.aantalVarianten);

  const result = {
    refreshedAt: new Date().toISOString(),
    coverage: cov,
    families: { totaal: families.size, top: familyList.slice(0, 100) },
    bucketCounts,
    buckets,
    items: items.slice(0, 2000)
  };
  try { await writeJsonBlob(PATH, result); } catch (_) {}
  return result;
}

export async function readBolContentPlan() { return readJsonBlob(PATH, null); }
export function isPlanFresh(p) { return p?.refreshedAt && (Date.now() - new Date(p.refreshedAt).getTime()) < MAX_AGE_MS; }

/** Geef het optimale content-model voor één EAN (voor de writer/preview). */
export async function getContentForEan(ean) {
  const plan = await readBolContentPlan();
  return (plan?.items || []).find((i) => i.ean === clean(ean)) || null;
}
