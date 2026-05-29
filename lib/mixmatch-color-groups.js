/**
 * lib/mixmatch-color-groups.js
 *
 * Groepeert producten die "op elkaar lijken" = hetzelfde model in een andere
 * kleur. Match-sleutel (door gebruiker gekozen): de PRODUCTNAAM zonder het
 * kleurwoord. Bijv.:
 *   "Kostuum Milano Blauw"  → modelKey "kostuum milano"
 *   "Kostuum Milano Grijs"  → modelKey "kostuum milano"
 * → beide in dezelfde kleur-groep, dus kleur-varianten van elkaar.
 *
 * Hiermee kan de webshop een "ook in andere kleuren"-switcher tonen die naar
 * het zustermodel in een andere kleur linkt.
 *
 * Bron: Shopify-productcache (bySrsArtikelId).
 */

import { readProductsCache } from './shopify-products-cache.js';

const clean = (v) => String(v == null ? '' : v).trim();

/* Nederlandse + veelvoorkomende kleurwoorden (fallback als het color-veld
   leeg is). Het product.color-veld wordt sowieso uit de titel gestript. */
const COLOR_WORDS = [
  'zwart', 'blauw', 'donkerblauw', 'lichtblauw', 'middenblauw', 'marine', 'marineblauw', 'navy',
  'grijs', 'lichtgrijs', 'donkergrijs', 'middengrijs', 'antraciet', 'zilver',
  'bruin', 'donkerbruin', 'lichtbruin', 'beige', 'zand', 'camel', 'taupe', 'khaki', 'cognac',
  'groen', 'donkergroen', 'lichtgroen', 'olijf', 'olijfgroen', 'petrol', 'mint', 'flessengroen',
  'bordeaux', 'rood', 'wijnrood', 'roest',
  'wit', 'offwhite', 'off-white', 'ecru', 'creme', 'crème', 'gebroken wit',
  'roze', 'paars', 'lila', 'geel', 'oranje', 'turquoise', 'goud'
];

/** Maak een model-sleutel: titel zonder kleurwoord(en), genormaliseerd. */
export function modelKey(title, color) {
  let t = ' ' + String(title || '').toLowerCase() + ' ';
  const c = String(color || '').toLowerCase().trim();
  if (c) {
    /* Strip het exacte kleur-veld (kan uit meerdere woorden bestaan). */
    for (const part of c.split(/[\s/,&]+/).filter(Boolean)) {
      t = t.split(part).join(' ');
    }
  }
  for (const w of COLOR_WORDS) {
    t = t.replace(new RegExp('(^|[^a-z])' + w.replace(/[-]/g, '\\-') + '(?=[^a-z]|$)', 'g'), ' ');
  }
  t = t.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

function flatProducts(cache) {
  const byArt = cache?.bySrsArtikelId || {};
  const byHandle = new Map();
  for (const v of Object.values(byArt)) {
    const handle = clean(v.productHandle);
    if (!handle || byHandle.has(handle)) continue;
    byHandle.set(handle, {
      productId: clean(v.productId),
      handle,
      title: clean(v.title),
      color: clean(v.color),
      image: clean(v.image),
      price: clean(v.price),
      subgroep: clean(v.subgroep)
    });
  }
  return [...byHandle.values()];
}

/**
 * Bouw alle kleur-groepen. Een groep telt alleen mee als er minstens 2
 * producten met minstens 2 verschillende kleuren in zitten.
 * @param {object} [cache]  optioneel vooraf gelezen cache (voorkomt dubbele read)
 */
export async function buildColorGroups(cache = null) {
  const c = cache || await readProductsCache();
  const products = flatProducts(c);
  const groups = new Map();
  for (const p of products) {
    const key = modelKey(p.title, p.color);
    if (!key || key.length < 3) continue;
    if (!groups.has(key)) groups.set(key, { key, members: [] });
    groups.get(key).members.push(p);
  }
  const out = [];
  for (const g of groups.values()) {
    const handles = new Set(g.members.map((m) => m.handle));
    const colors = new Set(g.members.map((m) => (m.color || '').toLowerCase()).filter(Boolean));
    if (handles.size < 2 || colors.size < 2) continue;
    /* Modelnaam tonen = langste gemeenschappelijke titel-prefix (leesbaar). */
    out.push({
      key: g.key,
      modelName: commonTitleBase(g.members.map((m) => m.title)),
      colorCount: colors.size,
      count: g.members.length,
      colors: [...colors],
      members: g.members.sort((a, b) => String(a.color).localeCompare(String(b.color), 'nl'))
    });
  }
  out.sort((a, b) => b.count - a.count || a.modelName.localeCompare(b.modelName, 'nl'));
  return out;
}

/** Leesbare modelnaam = gemeenschappelijke woord-prefix van de titels. */
function commonTitleBase(titles) {
  if (!titles.length) return '';
  const split = titles.map((t) => String(t || '').trim().split(/\s+/));
  const first = split[0];
  let i = 0;
  for (; i < first.length; i++) {
    const w = first[i].toLowerCase();
    if (!split.every((arr) => (arr[i] || '').toLowerCase() === w)) break;
  }
  const base = first.slice(0, i).join(' ').trim();
  return base || titles[0];
}

/**
 * Kleur-varianten voor één product (op handle). Returnt de ANDERE producten in
 * dezelfde model-groep (zelfde naam, andere kleur).
 * @param {string} handle
 * @param {object} [cache]
 */
export async function colorVariantsForHandle(handle, cache = null) {
  const h = String(handle || '').toLowerCase().trim();
  if (!h) return [];
  const groups = await buildColorGroups(cache);
  for (const g of groups) {
    if (g.members.some((m) => m.handle.toLowerCase() === h)) {
      return g.members
        .filter((m) => m.handle.toLowerCase() !== h)
        .map((m) => ({ handle: m.handle, title: m.title, color: m.color, image: m.image }));
    }
  }
  return [];
}

export function summarizeColorGroups(groups = []) {
  return {
    groepen: groups.length,
    productenInGroepen: groups.reduce((n, g) => n + g.count, 0),
    grootste: groups[0] ? groups[0].count : 0
  };
}
