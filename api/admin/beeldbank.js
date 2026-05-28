/**
 * /api/admin/beeldbank
 *
 * Marketing-beeldbank: doorzoekbare galerij van álle Shopify-product­afbeeldingen,
 * gegroepeerd per collectie. Joint niets — leest puur de Shopify-product-cache
 * (lib/shopify-products-cache.js) en dedupe't per product.
 *
 * Query:
 *   q          vrije zoekterm (titel / merk / hoofdgroep / collectie)
 *   collection exacte collectie-naam
 *   vendor     exact merk
 *   seizoen    exact seizoen
 *   hoofdgroep exacte hoofdgroep
 *   offset     paginatie (default 0)
 *   limit      paginatie (default 120, max 500)
 *
 * Antwoord:
 *   { success, refreshedAt, total, returned, offset, limit, hasMore,
 *     facets:{ collections[], vendors[], seizoenen[], hoofdgroepen[] }, items[] }
 *
 * Auth: admin-token vereist.
 */

import { readProductsCache } from '../../lib/shopify-products-cache.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

const clean = (v) => String(v == null ? '' : v).trim();
const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 500;

/* Map → gesorteerde facet-lijst [{name,count}] (count desc, dan naam). */
function facetList(map, cap = 200) {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'nl'))
    .slice(0, cap);
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    const cache = await readProductsCache();

    /* Dedupe variant-cache → één entry per product; kleuren over álle varianten. */
    const byProduct = new Map();
    for (const v of Object.values(cache.bySku || {})) {
      const pid = v.productId || v.productHandle || v.title;
      if (!pid) continue;
      let entry = byProduct.get(pid);
      if (!entry) {
        const images = Array.isArray(v.images) ? v.images.filter(Boolean) : (v.image ? [v.image] : []);
        entry = {
          title: clean(v.title) || '—',
          handle: clean(v.productHandle),
          url: clean(v.productUrl),
          vendor: clean(v.vendor),
          hoofdgroep: clean(v.hoofdgroepOmschrijving) || clean(v.hoofdgroep),
          seizoen: clean(v.seizoen),
          collections: Array.isArray(v.collections) ? v.collections.map(clean).filter(Boolean) : [],
          image: clean(v.image) || images[0] || '',
          imagesCount: images.length,
          images: images.slice(0, 10),
          videos: Array.isArray(v.videos) ? v.videos.filter((x) => x && x.url).slice(0, 5) : [],
          _colors: new Set()
        };
        byProduct.set(pid, entry);
      }
      const col = clean(v.color);
      if (col) entry._colors.add(col);
    }

    /* Beeldbank = alléén producten met minstens één afbeelding. */
    const all = [...byProduct.values()].filter((p) => p.image);
    for (const p of all) { p.colors = [...p._colors]; delete p._colors; }

    /* Facets over de volledige beeld-set (stabiele filterlijst). */
    const cMap = new Map(), vMap = new Map(), sMap = new Map(), hMap = new Map(), kMap = new Map();
    const bump = (map, key) => { const k = clean(key); if (k) map.set(k, (map.get(k) || 0) + 1); };
    for (const p of all) {
      for (const c of p.collections) bump(cMap, c);
      for (const k of p.colors) bump(kMap, k);
      bump(vMap, p.vendor);
      bump(sMap, p.seizoen);
      bump(hMap, p.hoofdgroep);
    }

    /* Filters. */
    const q = clean(req.query?.q).toLowerCase();
    const fCollection = clean(req.query?.collection);
    const fVendor = clean(req.query?.vendor);
    const fSeizoen = clean(req.query?.seizoen);
    const fHoofdgroep = clean(req.query?.hoofdgroep);
    const fColor = clean(req.query?.color);
    const fVideo = clean(req.query?.video); /* '1' = met video, '0' = zonder */

    let filtered = all;
    if (fCollection) filtered = filtered.filter((p) => p.collections.includes(fCollection));
    if (fColor) filtered = filtered.filter((p) => p.colors.includes(fColor));
    if (fVideo === '1') filtered = filtered.filter((p) => (p.videos || []).length > 0);
    else if (fVideo === '0') filtered = filtered.filter((p) => !(p.videos || []).length);
    if (fVendor) filtered = filtered.filter((p) => p.vendor === fVendor);
    if (fSeizoen) filtered = filtered.filter((p) => p.seizoen === fSeizoen);
    if (fHoofdgroep) filtered = filtered.filter((p) => p.hoofdgroep === fHoofdgroep);
    if (q) {
      filtered = filtered.filter((p) => {
        const hay = `${p.title} ${p.vendor} ${p.hoofdgroep} ${p.collections.join(' ')} ${p.colors.join(' ')}`.toLowerCase();
        return hay.includes(q);
      });
    }

    /* Sorteer: per (eerste) collectie, dan titel → clustert netjes;
       producten zónder collectie komen achteraan. */
    filtered.sort((a, b) => {
      const ca = a.collections[0] || '';
      const cb = b.collections[0] || '';
      if (!ca !== !cb) return ca ? -1 : 1;
      return ca.localeCompare(cb, 'nl') || a.title.localeCompare(b.title, 'nl');
    });

    const offset = Math.max(0, parseInt(req.query?.offset, 10) || 0);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query?.limit, 10) || DEFAULT_LIMIT));
    const page = filtered.slice(offset, offset + limit);

    return res.status(200).json({
      success: true,
      refreshedAt: cache.refreshedAt || null,
      total: filtered.length,
      returned: page.length,
      offset,
      limit,
      hasMore: offset + page.length < filtered.length,
      collectionsAvailable: cMap.size > 0,
      withVideo: all.reduce((n, p) => n + ((p.videos || []).length ? 1 : 0), 0),
      facets: {
        collections: facetList(cMap),
        colors: facetList(kMap),
        vendors: facetList(vMap),
        seizoenen: facetList(sMap),
        hoofdgroepen: facetList(hMap)
      },
      items: page
    });
  } catch (e) {
    console.error('[admin/beeldbank]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
