import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { readBranchSnapshot } from '../../lib/srs-stock-snapshot-store.js';
import { listAllBranches, getStoreNameByBranchId, isWarehouseStore } from '../../lib/branch-metrics.js';
import { readProductsCache } from '../../lib/shopify-products-cache.js';

/**
 * GET /api/store/article-search
 *
 * Doel: artikel-zoeker voor winkel-medewerkers. Toont per artikel:
 *   - Shopify product-foto + omschrijving
 *   - Voorraad in eigen winkel + alle andere winkels (vergelijkbaar zoeken)
 *
 * Query parameters (alle optioneel):
 *   ?q=blauw pak           → fuzzy match op titel/kleur/omschrijving
 *   ?color=Antraciet       → exacte kleur-filter
 *   ?size=50               → exacte maat-filter
 *   ?hoofdgroep=Pakken     → product-type filter
 *   ?store=GENTS Amsterdam → highlight eigen winkel + sorteer eerst
 *   ?limit=24              → default 24, max 100
 *   ?available=1           → alleen artikelen met >0 voorraad ergens
 *
 * Response:
 *   {
 *     success,
 *     query,
 *     count,
 *     truncated,
 *     facets: { colors: [{value, count}], sizes: [...], hoofdgroepen: [...] },
 *     results: [{
 *       articleNumber, barcode, sku, title, description,
 *       color, size, image, images, vendor, productType,
 *       totalPieces, branchCount,
 *       branches: [{ branchId, store, pieces, isOwn, type }]
 *     }]
 *   }
 *
 * Geen admin-token — winkel-medewerkers gebruiken dit ook vanaf hun POS.
 */

function clean(v) { return String(v || '').trim(); }
function lower(v) { return clean(v).toLowerCase(); }

function buildHaystack(article) {
  return [
    article.title, article.color, article.size,
    article.articleNumber, article.barcode, article.sku,
    article.vendor, article.productType, article.descriptionPlain,
    /* SRSERP metafields uit Shopify — zoeken op artikel-id, rve-nummer,
       subgroep en hoofdgroep-omschrijving werkt nu ook */
    article.srsArtikelId, article.srsRveArtikelnummer,
    article.subgroep, article.hoofdgroep, article.hoofdgroepOmschrijving
  ].map((v) => lower(v)).join(' ');
}

function rowMatchesAllWords(article, words) {
  if (!words.length) return true;
  const hay = buildHaystack(article);
  return words.every((w) => hay.includes(w));
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  const q = clean(req.query.q);
  const colorFilter = lower(req.query.color);
  const sizeFilter = lower(req.query.size);
  const hoofdgroepFilter = lower(req.query.hoofdgroep);
  const subgroepFilter = lower(req.query.subgroep);
  const ownStore = clean(req.query.store);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 24)));
  const onlyAvailable = String(req.query.available || '') === '1';

  const searchWords = q ? q.toLowerCase().split(/\s+/).filter((w) => w.length >= 2) : [];

  try {
    /* Parallel: alle branch-snapshots + Shopify product cache */
    const allBranches = listAllBranches();
    const branchIds = allBranches.map((b) => b.branchId).filter(Boolean);

    const [snapshots, productsCache] = await Promise.all([
      Promise.all(branchIds.map(async (bid) => {
        try {
          const snap = await readBranchSnapshot(bid);
          return { branchId: bid, snap };
        } catch {
          return { branchId: bid, snap: null };
        }
      })),
      readProductsCache()
    ]);

    /* Aggregeer per articleNumber/barcode over alle branches */
    const productMap = new Map();

    for (const { branchId, snap } of snapshots) {
      if (!snap || !Array.isArray(snap.rows)) continue;
      const branchName = getStoreNameByBranchId(branchId);

      for (const r of snap.rows) {
        const key = lower(r.articleNumber || r.sku || r.barcode);
        if (!key) continue;

        /* Join met Shopify cache voor foto + omschrijving + SRSERP metafields */
        const shopifyMatch = productsCache.byBarcode?.[lower(r.barcode)]
          || productsCache.bySku?.[lower(r.sku)]
          || productsCache.bySrsArticleNumber?.[lower(r.articleNumber)]
          || productsCache.bySrsArtikelId?.[lower(r.articleNumber)]
          || productsCache.bySrsRveArtikelnummer?.[lower(r.articleNumber)]
          || null;

        let entry = productMap.get(key);
        if (!entry) {
          entry = {
            articleNumber: clean(r.articleNumber || ''),
            barcode: clean(r.barcode || ''),
            sku: clean(r.sku || r.barcode || ''),
            title: clean(shopifyMatch?.title || r.title || ''),
            descriptionPlain: shopifyMatch?.descriptionPlain || '',
            description: shopifyMatch?.description || '',
            color: clean(r.color || shopifyMatch?.color || ''),
            size: clean(r.size || shopifyMatch?.size || ''),
            image: shopifyMatch?.image || '',
            images: shopifyMatch?.images || [],
            productUrl: shopifyMatch?.productUrl || '',
            vendor: clean(shopifyMatch?.vendor || ''),
            productType: clean(shopifyMatch?.productType || ''),
            price: clean(shopifyMatch?.price || ''),
            /* SRSERP metafields uit Shopify (gedeeld door alle varianten) */
            srsArtikelId: clean(shopifyMatch?.srsArtikelId || ''),
            srsRveArtikelnummer: clean(shopifyMatch?.srsRveArtikelnummer || ''),
            subgroep: clean(shopifyMatch?.subgroep || ''),
            hoofdgroep: clean(shopifyMatch?.hoofdgroep || ''),
            hoofdgroepOmschrijving: clean(shopifyMatch?.hoofdgroepOmschrijving || ''),
            totalPieces: 0,
            branchCount: 0,
            branches: []
          };
          productMap.set(key, entry);
        }

        const pieces = Number(r.pieces || 0);
        entry.totalPieces += pieces;
        entry.branches.push({
          branchId,
          store: branchName,
          pieces,
          isOwn: ownStore && branchName === ownStore,
          type: isWarehouseStore(branchName) ? 'warehouse' : 'retail'
        });
        if (pieces > 0) entry.branchCount += 1;
      }
    }

    let articles = Array.from(productMap.values());

    /* Facets bouwen (vóór filtering — zo zien gebruikers welke filters er zijn) */
    const facetMap = (key) => {
      const m = new Map();
      for (const a of articles) {
        const v = clean(a[key]);
        if (!v) continue;
        m.set(v, (m.get(v) || 0) + 1);
      }
      return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([value, count]) => ({ value, count }));
    };
    const facets = {
      colors: facetMap('color'),
      sizes: facetMap('size'),
      /* Hoofdgroep: prefereer SRSERP.hoofdgroep_omschrijving > productType uit Shopify */
      hoofdgroepen: facetMap('hoofdgroepOmschrijving').length
        ? facetMap('hoofdgroepOmschrijving')
        : facetMap('productType'),
      subgroepen: facetMap('subgroep')
    };

    /* Filters toepassen */
    if (q && searchWords.length) {
      articles = articles.filter((a) => rowMatchesAllWords(a, searchWords));
    }
    if (colorFilter) {
      articles = articles.filter((a) => lower(a.color) === colorFilter);
    }
    if (sizeFilter) {
      articles = articles.filter((a) => lower(a.size) === sizeFilter);
    }
    if (hoofdgroepFilter) {
      /* Match op SRSERP-hoofdgroep_omschrijving (prio) of Shopify productType (fallback) */
      articles = articles.filter((a) =>
        lower(a.hoofdgroepOmschrijving) === hoofdgroepFilter
        || lower(a.productType) === hoofdgroepFilter
      );
    }
    if (subgroepFilter) {
      articles = articles.filter((a) => lower(a.subgroep) === subgroepFilter);
    }
    if (onlyAvailable) {
      articles = articles.filter((a) => a.totalPieces > 0);
    }

    /* Sorteer:
       1. Artikelen met eigen-winkel voorraad eerst
       2. Daarna totaal aantal stuks aflopend
       3. Daarna alfabetisch op titel */
    articles.sort((a, b) => {
      const ownA = ownStore ? a.branches.some((b2) => b2.isOwn && b2.pieces > 0) : false;
      const ownB = ownStore ? b.branches.some((b2) => b2.isOwn && b2.pieces > 0) : false;
      if (ownA !== ownB) return ownA ? -1 : 1;
      if (a.totalPieces !== b.totalPieces) return b.totalPieces - a.totalPieces;
      return String(a.title || '').localeCompare(String(b.title || ''));
    });

    const totalMatched = articles.length;
    const truncated = totalMatched > limit;
    articles = articles.slice(0, limit);

    /* Branches per artikel ook sorteren: eigen winkel eerst, dan aantal aflopend */
    for (const a of articles) {
      a.branches.sort((x, y) => {
        if (x.isOwn !== y.isOwn) return x.isOwn ? -1 : 1;
        if (x.pieces !== y.pieces) return y.pieces - x.pieces;
        return String(x.store || '').localeCompare(String(y.store || ''));
      });
    }

    return res.status(200).json({
      success: true,
      query: {
        q,
        color: req.query.color || '',
        size: req.query.size || '',
        hoofdgroep: req.query.hoofdgroep || '',
        subgroep: req.query.subgroep || '',
        store: ownStore,
        available: onlyAvailable
      },
      count: totalMatched,
      shown: articles.length,
      truncated,
      facets,
      results: articles,
      productsCacheRefreshedAt: productsCache.refreshedAt || null,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[store/article-search]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Artikel-zoek mislukt.'
    });
  }
}
