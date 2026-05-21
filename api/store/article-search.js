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

/**
 * Detecteer wat voor soort zoekterm de gebruiker heeft ingegeven.
 *  - artikelcode  → korte numeriek, 3-7 cijfers (bv. "12345", "8", "0008")
 *                   GENTS-medewerkers gebruiken dit het meest. Skip barcode-match.
 *  - barcode      → lange numeriek, 8+ cijfers (EAN-13 etc.)
 *  - identifier   → letter+cijfer combinatie zonder spaties (SKU-stijl)
 *  - name         → vrije tekst (1+ woorden, kan spaties bevatten)
 *  - short        → te kort voor zinvolle search
 */
function detectQueryKind(q) {
  const v = clean(q);
  if (!v) return 'empty';
  if (v.length < 2) return 'short';
  /* Spaces → vrije-tekst / naam-zoek */
  if (/\s/.test(v)) return 'name';
  /* Volledig numeriek? */
  if (/^\d+$/.test(v)) {
    if (v.length <= 7) return 'artikelcode';
    return 'barcode';
  }
  /* Letter+cijfer combinatie zonder spaties → identifier (SKU-stijl) */
  if (/^[A-Za-z0-9._/\\-]+$/.test(v) && v.length >= 3) return 'identifier';
  return 'name';
}

/**
 * Strip leading zeros voor artikelcode-matching ("00000008" matched "8").
 */
function stripLeadingZeros(v) {
  return String(v || '').replace(/^0+(?=\d)/, '');
}

/**
 * Match een article tegen een artikelcode-query (korte numeriek).
 * Match alleen op articleNumber / sku / srsArtikelId / srsRveArtikelnummer.
 * EXPLICIET NIET op barcode — gebruiker wil dat niet.
 */
function matchesArtikelcode(article, q) {
  const target = lower(stripLeadingZeros(q));
  const candidates = [article.articleNumber, article.sku, article.srsArtikelId, article.srsRveArtikelnummer];
  for (const c of candidates) {
    const val = lower(stripLeadingZeros(c));
    if (!val) continue;
    if (val === target) return true;                  /* exact match */
    if (val.endsWith(target) && target.length >= 3) return true; /* trailing match (handig voor leading-zero variaties) */
    if (val.includes(target) && target.length >= 4) return true; /* contains, min 4 cijfers anders te losse match */
  }
  return false;
}

/**
 * Match een article tegen een barcode-query.
 * Match alleen op barcode.
 */
function matchesBarcode(article, q) {
  const target = lower(q);
  const bc = lower(article.barcode);
  if (!bc) return false;
  return bc === target || bc.endsWith(target);
}

/**
 * Bouw haystack voor name-search — bevat ALLE doorzoekbare velden.
 */
function buildHaystack(article) {
  return [
    article.title, article.color, article.size,
    article.articleNumber, article.barcode, article.sku,
    article.vendor, article.productType, article.descriptionPlain,
    /* SRSERP metafields uit Shopify */
    article.srsArtikelId, article.srsRveArtikelnummer,
    article.subgroep, article.hoofdgroep, article.hoofdgroepOmschrijving
  ].map((v) => lower(v)).join(' ');
}

function rowMatchesAllWords(article, words) {
  if (!words.length) return true;
  const hay = buildHaystack(article);
  return words.every((w) => hay.includes(w));
}

/**
 * Combineer alle match-strategieën o.b.v. query-kind.
 */
function matchesQuery(article, q, kind, searchWords) {
  if (!q) return true;
  switch (kind) {
    case 'artikelcode':
      /* Korte numeriek → alleen artikelcode-velden, NIET barcode */
      return matchesArtikelcode(article, q);
    case 'barcode':
      /* Lange numeriek → alleen barcode */
      return matchesBarcode(article, q);
    case 'identifier':
      /* Alphanumeriek zonder spaties → eerst artikelcode-velden, fallback name-search */
      return matchesArtikelcode(article, q) || rowMatchesAllWords(article, searchWords);
    case 'name':
    default:
      return rowMatchesAllWords(article, searchWords);
  }
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

  const queryKind = detectQueryKind(q);
  const searchWords = q ? q.toLowerCase().split(/\s+/).filter((w) => w.length >= 2) : [];

  if (queryKind === 'short') {
    return res.status(400).json({
      success: false,
      message: 'Zoekterm te kort — minimaal 2 tekens.'
    });
  }

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

    /* Filters toepassen — gebruik query-kind specifieke matcher */
    if (q) {
      articles = articles.filter((a) => matchesQuery(a, q, queryKind, searchWords));
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
        kind: queryKind, /* 'artikelcode' | 'barcode' | 'identifier' | 'name' */
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
