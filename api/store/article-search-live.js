/**
 * Realtime artikel-search via Shopify GraphQL — geen cache nodig.
 *
 *   GET /api/store/article-search-live?q=rokjas&store=GENTS+Arnhem&limit=30
 *     [&color=blauw][&size=M][&hoofdgroep=Pakken][&subgroep=...]
 *     [&available=1]
 *
 * Response: zelfde shape als /api/store/article-search zodat de frontend
 * geen wijzigingen nodig heeft. Extra field: realtime: true.
 */

import { realtimeSearch } from '../../lib/shopify-realtime-search.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

function clean(v) { return String(v ?? '').trim(); }
function lower(v) { return clean(v).toLowerCase(); }

function buildFacets(results) {
  const facetMap = (key) => {
    const m = new Map();
    for (const a of results) {
      const v = clean(a[key]);
      if (!v) continue;
      m.set(v, (m.get(v) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([value, count]) => ({ value, count }));
  };
  return {
    colors: facetMap('color'),
    sizes: facetMap('size'),
    hoofdgroepen: facetMap('hoofdgroepOmschrijving').length ? facetMap('hoofdgroepOmschrijving') : facetMap('productType'),
    subgroepen: facetMap('subgroep')
  };
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  const q = clean(req.query.q);
  const ownStore = clean(req.query.store);
  const colorFilter = lower(req.query.color);
  const sizeFilter = lower(req.query.size);
  const hoofdgroepFilter = lower(req.query.hoofdgroep);
  const subgroepFilter = lower(req.query.subgroep);
  const onlyAvailable = String(req.query.available || '') === '1';
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 30)));

  if (!q || q.length < 2) {
    return res.status(200).json({
      success: true,
      realtime: true,
      query: { q, kind: q ? 'short' : 'empty' },
      count: 0,
      shown: 0,
      results: [],
      facets: { colors: [], sizes: [], hoofdgroepen: [], subgroepen: [] }
    });
  }

  try {
    const { results: rawResults, cached, productCount, inventoryStatus } = await realtimeSearch({ q, ownStore, limit: limit * 2 });

    /* Inventory-betrouwbaarheid: als ALLE chunks faalden óf 0 variants succeeded,
       dan is de voorraad-data onbruikbaar en moeten we de available-filter
       overslaan (anders krijgt user 0 resultaten ondanks producten in Shopify). */
    const inventoryReliable = inventoryStatus
      ? (inventoryStatus.chunksOk > 0 && inventoryStatus.succeeded > 0)
      : true;

    /* Filter toepassen post-search */
    let results = rawResults;
    if (colorFilter) results = results.filter((r) => lower(r.color) === colorFilter);
    if (sizeFilter) results = results.filter((r) => lower(r.size) === sizeFilter);
    if (hoofdgroepFilter) results = results.filter((r) =>
      lower(r.hoofdgroepOmschrijving) === hoofdgroepFilter
      || lower(r.productType) === hoofdgroepFilter
    );
    if (subgroepFilter) results = results.filter((r) => lower(r.subgroep) === subgroepFilter);
    /* Available-filter alleen toepassen als inventory daadwerkelijk geladen is */
    if (onlyAvailable && inventoryReliable) {
      results = results.filter((r) => r.totalPieces > 0);
    }

    /* Sorteer: eigen-winkel voorraad eerst, dan op totaalPieces, dan title */
    results.sort((a, b) => {
      const ownA = ownStore ? a.branches.some((b2) => b2.isOwn && b2.pieces > 0) : false;
      const ownB = ownStore ? b.branches.some((b2) => b2.isOwn && b2.pieces > 0) : false;
      if (ownA !== ownB) return ownA ? -1 : 1;
      if (a.totalPieces !== b.totalPieces) return b.totalPieces - a.totalPieces;
      return String(a.title || '').localeCompare(String(b.title || ''));
    });

    const facets = buildFacets(rawResults);
    const totalMatched = results.length;
    const truncated = totalMatched > limit;
    results = results.slice(0, limit);

    return res.status(200).json({
      success: true,
      realtime: true,
      cached,
      query: {
        q,
        kind: 'realtime',
        color: req.query.color || '',
        size: req.query.size || '',
        hoofdgroep: req.query.hoofdgroep || '',
        subgroep: req.query.subgroep || '',
        store: ownStore,
        available: onlyAvailable
      },
      count: totalMatched,
      shown: results.length,
      truncated,
      productCount,
      facets,
      results,
      inventoryStatus,
      inventoryReliable,
      productsCacheRefreshedAt: new Date().toISOString(),
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[article-search-live]', error);
    return res.status(error.status || 502).json({
      success: false,
      realtime: true,
      message: error.message || 'Shopify realtime-search faalde.',
      hint: 'Zorg dat SHOPIFY_STORE_DOMAIN + SHOPIFY_ADMIN_ACCESS_TOKEN in Vercel env staan.'
    });
  }
}
