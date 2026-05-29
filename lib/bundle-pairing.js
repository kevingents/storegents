/**
 * lib/bundle-pairing.js
 *
 * VERKENNINGSFASE voor Shopify-bundles (compleet pak = colbert + broek, soms
 * + gilet). Doel van deze module: kijken of we de losse producten kunnen
 * ophalen en correct kunnen koppelen — vóórdat we daadwerkelijk bundles
 * aanmaken.
 *
 * Koppel-logica (door gebruiker aangeleverd): SRSERP.artikel_id heeft de vorm
 * <PREFIX>-<CODE>, bv. broek PAN-SW091 hoort bij colbert COL-SW091. Prefix =
 * kledingtype (COL = colbert, PAN = broek/pantalon, GIL/VES = gilet), de CODE
 * na het streepje is gedeeld binnen één pak.
 *
 * Bron: Shopify-productcache (readProductsCache → bySrsArtikelId). Voor het
 * inspecteren van de RUWE metavelden (bv. "stof") doen we een kleine live
 * GraphQL-call op een steekproef matched producten — zo zien we exact welke
 * metafield-keys bestaan en kunnen we ze later combineren.
 */

import { readProductsCache } from './shopify-products-cache.js';

const clean = (v) => String(v == null ? '' : v).trim();

/* Prefix → rol. Uitbreidbaar; onbekende prefixes vallen onder 'overig' en
   worden in prefixStats gerapporteerd zodat we ze kunnen herkennen. */
const ROLE_BY_PREFIX = {
  COL: 'colbert', COLBERT: 'colbert', JAS: 'colbert',
  PAN: 'broek', PANTALON: 'broek', BRO: 'broek', BROEK: 'broek', TRO: 'broek',
  GIL: 'gilet', GILET: 'gilet', VES: 'gilet', VST: 'gilet', WAI: 'gilet'
};

/** Split artikel_id op het eerste streepje → { prefix, suffix }. */
export function parseArtikelId(id) {
  const v = clean(id);
  const m = v.match(/^([A-Za-z0-9]+)\s*-\s*(.+)$/);
  if (!m) return { raw: v, prefix: '', suffix: '', ok: false };
  return { raw: v, prefix: m[1].toUpperCase(), suffix: m[2].trim().toUpperCase(), ok: true };
}

function productSummary(v, parsed) {
  return {
    artikelId: clean(v.srsArtikelId),
    prefix: parsed.prefix,
    suffix: parsed.suffix,
    role: ROLE_BY_PREFIX[parsed.prefix] || 'overig',
    productId: clean(v.productId),
    title: clean(v.title),
    handle: clean(v.productHandle),
    productUrl: clean(v.productUrl),
    sku: clean(v.articleNumber || v.sku),
    color: clean(v.color),
    vendor: clean(v.vendor),
    price: clean(v.price),
    image: clean(v.image),
    imagesCount: Array.isArray(v.images) ? v.images.length : 0,
    images: Array.isArray(v.images) ? v.images.slice(0, 6) : [],
    seizoen: clean(v.seizoen),
    jaar: clean(v.jaar),
    subgroep: clean(v.subgroep),
    hoofdgroep: clean(v.hoofdgroep),
    rveArtikelnummer: clean(v.srsRveArtikelnummer),
    /* Stof-/detailvelden (voor "metavelden combineren"). */
    materiaal: clean(v.materiaal),
    samenstelling: clean(v.samenstelling),
    pasvorm: clean(v.pasvorm),
    sluiting: clean(v.sluiting),
    mixAndMatch: clean(v.mixAndMatch)
  };
}

/**
 * Vind kandidaat-pakken: groepeer alle producten met artikel_id op de CODE na
 * het streepje, en zoek per groep een colbert + broek (+ optioneel gilet).
 */
export async function findBundlePairs() {
  const cache = await readProductsCache();
  const byArt = cache?.bySrsArtikelId || {};
  const entries = Object.values(byArt);

  const prefixStats = {};
  const groups = new Map();
  const seen = new Set();
  let withArtikelId = 0;
  let parseable = 0;

  for (const v of entries) {
    const aid = clean(v.srsArtikelId);
    if (!aid) continue;
    const lc = aid.toLowerCase();
    if (seen.has(lc)) continue;
    seen.add(lc);
    withArtikelId += 1;

    const parsed = parseArtikelId(aid);
    if (!parsed.ok) continue;
    parseable += 1;
    prefixStats[parsed.prefix] = (prefixStats[parsed.prefix] || 0) + 1;

    let g = groups.get(parsed.suffix);
    if (!g) { g = { suffix: parsed.suffix, products: [] }; groups.set(parsed.suffix, g); }
    g.products.push(productSummary(v, parsed));
  }

  const pairs = [];
  const colbertsZonderBroek = [];
  const broekenZonderColbert = [];

  for (const g of groups.values()) {
    const colbert = g.products.find((p) => p.role === 'colbert');
    const broek = g.products.find((p) => p.role === 'broek');
    const gilet = g.products.find((p) => p.role === 'gilet');
    if (colbert && broek) {
      pairs.push({
        code: g.suffix,
        threePiece: Boolean(gilet),
        colbert,
        broek,
        gilet: gilet || null,
        photosTotal: (colbert.imagesCount || 0) + (broek.imagesCount || 0) + (gilet ? gilet.imagesCount || 0 : 0),
        seizoenMatch: (colbert.seizoen && broek.seizoen) ? (colbert.seizoen === broek.seizoen) : null,
        stofMatch: (colbert.materiaal && broek.materiaal) ? (colbert.materiaal.toLowerCase() === broek.materiaal.toLowerCase()) : null,
        /* Voorgestelde gecombineerde metavelden voor het pak (colbert leidend,
           broek vult aan). Input voor het straks aanmaken van de bundle. */
        combinedMeta: {
          materiaal: colbert.materiaal || broek.materiaal || '',
          samenstelling: colbert.samenstelling || broek.samenstelling || '',
          pasvorm: colbert.pasvorm || broek.pasvorm || '',
          seizoen: colbert.seizoen || broek.seizoen || '',
          jaar: colbert.jaar || broek.jaar || ''
        }
      });
    } else if (colbert) {
      colbertsZonderBroek.push(colbert);
    } else if (broek) {
      broekenZonderColbert.push(broek);
    }
  }
  pairs.sort((a, b) => a.code.localeCompare(b.code));

  return {
    refreshedAt: cache?.refreshedAt || null,
    totals: {
      productenMetArtikelId: withArtikelId,
      parseable,
      pakken: pairs.length,
      driedelig: pairs.filter((p) => p.threePiece).length,
      colbertsZonderBroek: colbertsZonderBroek.length,
      broekenZonderColbert: broekenZonderColbert.length,
      prefixes: Object.keys(prefixStats).length
    },
    prefixStats: Object.entries(prefixStats)
      .map(([prefix, count]) => ({ prefix, count, role: ROLE_BY_PREFIX[prefix] || 'overig' }))
      .sort((a, b) => b.count - a.count),
    pairs,
    colbertsZonderBroek: colbertsZonderBroek.slice(0, 100),
    broekenZonderColbert: broekenZonderColbert.slice(0, 100)
  };
}

/* ── Live metafield-inspectie (om "stof" e.d. te vinden) ── */
function shopCfg() {
  const shop = (process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || '';
  const version = process.env.SHOPIFY_API_VERSION || '2025-01';
  if (!shop || !token) return null;
  return { shop, token, version };
}

/**
 * Haal voor een steekproef product-id's (gid://shopify/Product/...) ALLE
 * metavelden live op, zodat we zien welke keys bestaan (bv. SRSERP.stof) en met
 * welke voorbeeldwaarde — input om later de juiste velden te combineren.
 */
export async function inspectMetafields(productIds = []) {
  const cfg = shopCfg();
  if (!cfg) return { configured: false, products: [], keys: [] };
  const ids = [...new Set((productIds || []).filter(Boolean))].slice(0, 25);
  if (!ids.length) return { configured: true, products: [], keys: [] };

  const query = `query($ids:[ID!]!){
    nodes(ids:$ids){ ... on Product { id title metafields(first:60){ edges { node { namespace key value type } } } } }
  }`;

  let json;
  try {
    const resp = await fetch(`https://${cfg.shop}/admin/api/${cfg.version}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': cfg.token, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables: { ids } })
    });
    if (!resp.ok) return { configured: true, error: `Shopify GraphQL ${resp.status}`, products: [], keys: [] };
    json = await resp.json();
  } catch (e) {
    return { configured: true, error: e.message || 'GraphQL-call faalde', products: [], keys: [] };
  }
  if (json?.errors) return { configured: true, error: JSON.stringify(json.errors).slice(0, 200), products: [], keys: [] };

  const keyMap = new Map();
  const products = (json?.data?.nodes || []).filter(Boolean).map((n) => {
    const mfs = (n.metafields?.edges || []).map((e) => ({
      namespace: clean(e?.node?.namespace),
      key: clean(e?.node?.key),
      type: clean(e?.node?.type),
      value: String(e?.node?.value || '').slice(0, 140)
    })).filter((m) => m.key);
    for (const m of mfs) {
      const k = `${m.namespace}.${m.key}`;
      if (!keyMap.has(k)) keyMap.set(k, { key: k, type: m.type, sample: m.value, count: 0 });
      keyMap.get(k).count += 1;
    }
    return { id: clean(n.id), title: clean(n.title), metafields: mfs };
  });

  return {
    configured: true,
    products,
    keys: [...keyMap.values()].sort((a, b) => a.key.localeCompare(b.key))
  };
}
