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
 *   ?withStock=0           → SKIP branch-snapshot fetch (instant search, geen stock).
 *                            Frontend belt daarna /api/store/article-stock voor
 *                            realtime stock per variant. Aanbevolen voor UI.
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

/* Cache voor de SRS-snapshot pieces-map (5 min TTL) — voorkomt dat elke
   'Alleen op voorraad' search opnieuw 20 branch-snapshots leest. */
let __PIECES_CACHE__ = { at: 0, data: null };
const PIECES_CACHE_TTL = 5 * 60 * 1000;

async function loadPiecesFromSnapshots() {
  if (__PIECES_CACHE__.data && (Date.now() - __PIECES_CACHE__.at) < PIECES_CACHE_TTL) {
    return __PIECES_CACHE__.data;
  }
  const branches = listAllBranches();
  const snapshots = await Promise.all(branches.map(async (b) => {
    try { return await readBranchSnapshot(b.branchId); }
    catch { return null; }
  }));
  const piecesByKey = new Map();
  for (const snap of snapshots) {
    if (!snap?.rows?.length) continue;
    for (const r of snap.rows) {
      const pieces = Number(r.pieces || 0);
      if (!pieces) continue;
      /* Index op barcode, sku én articleNumber zodat elke lookup-vorm matched */
      const keys = [lower(r.barcode), lower(r.sku), lower(r.articleNumber)].filter(Boolean);
      for (const k of keys) {
        piecesByKey.set(k, (piecesByKey.get(k) || 0) + pieces);
      }
    }
  }
  __PIECES_CACHE__ = { at: Date.now(), data: piecesByKey };
  return piecesByKey;
}

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
  /* Volledig numeriek? Voor lengte-vergelijking strippen we leading zeros,
     anders zou "00000008" (artikelcode met padding) als barcode worden gezien. */
  if (/^\d+$/.test(v)) {
    const stripped = v.replace(/^0+(?=\d)/, '');
    if (stripped.length <= 7) return 'artikelcode';
    return 'barcode';
  }
  /* Identifier (SKU-stijl) = MOET cijfers of separator bevatten — pure letters
     (bv "rokjas", "broek") is een NAAM-zoekopdracht, geen SKU. */
  if (/^[A-Za-z0-9._/\\-]+$/.test(v) && v.length >= 3) {
    const hasDigit = /\d/.test(v);
    const hasSeparator = /[._/\\-]/.test(v);
    if (hasDigit || hasSeparator) return 'identifier';
  }
  return 'name';
}

/**
 * Strip leading zeros voor artikelcode-matching ("00000008" matched "8").
 */
function stripLeadingZeros(v) {
  return String(v || '').replace(/^0+(?=\d)/, '');
}

/**
 * Match een article tegen een artikelcode-query (korte numeriek). Returnt een
 * match-score:
 *   100 = exact match
 *    80 = match na strippen van leading zeros (00002038 ≡ 2038)
 *    60 = endsWith (val eindigt op target — handig voor partial codes)
 *    30 = includes substring (alleen voor target ≥ 6 chars want anders matched
 *         elke SKU die toevallig die cijfers bevat — was de bug)
 *     0 = geen match
 *
 * Match alleen op articleNumber / sku / srsArtikelId / srsRveArtikelnummer.
 * EXPLICIET NIET op barcode — gebruiker wil dat niet.
 */
function matchesArtikelcode(article, q) {
  const targetRaw = lower(q);
  const targetStripped = stripLeadingZeros(targetRaw);
  /* Shopify `productType` bevat de SRS Artikel NR (kort, zonder leading
     zeros) — dat is wat de SRS-POS gebruikt en wat Shopify naar SRS pusht.
     bv. '00002038' (POS-input) ↔ productType '2038' ↔ Rokjas polywol.
     Eerst checken op exact-match daar — hoogste prioriteit. */
  const productTypeRaw = lower(article.productType);
  if (productTypeRaw && /^\d+$/.test(productTypeRaw)) {
    if (productTypeRaw === targetRaw) return 100;
    if (productTypeRaw === targetStripped) return 95;
  }

  /* SRS-padded code? '00002038' met leading zeros is typische SRS POS notatie.
     Bij padded queries beperken we matching tot SKU / articleNumber (=barcode
     suffix-stijl) — srsArtikelId / srsRveArtikelnummer hebben eigen formats
     die toevallig op 2038 kunnen eindigen wat geen relevante matches zijn.

     Bij niet-padded queries (bv. '912038') zoeken we breder. */
  const hasLeadingZeros = /^0+\d/.test(targetRaw);
  const minPartialLen = hasLeadingZeros ? 3 : 5;
  const candidates = hasLeadingZeros
    ? [article.articleNumber, article.sku]
    : [article.articleNumber, article.sku, article.srsArtikelId, article.srsRveArtikelnummer];
  let best = 0;
  for (const c of candidates) {
    const valRaw = lower(c);
    if (!valRaw) continue;
    const valStripped = stripLeadingZeros(valRaw);
    if (!valStripped) continue;
    if (valRaw === targetRaw) return 100;
    if (valStripped === targetStripped) best = Math.max(best, 90);
    if (targetStripped.length < minPartialLen) continue;
    if (valStripped.endsWith(targetStripped)) best = Math.max(best, 70);
    else if (valStripped.includes(targetStripped) && targetStripped.length >= 6) {
      best = Math.max(best, 40);
    }
  }
  return best;
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
 * Bouw een uniforme result-entry uit een SRS-snapshot row + Shopify match
 * (of alleen Shopify variant in stockless modus).
 */
function buildEntry(srsRow, shopifyMatch) {
  const productId = clean(shopifyMatch?.productId || '');
  const colorLower = lower(srsRow?.color || shopifyMatch?.color || '');
  return {
    articleNumber: clean(srsRow?.articleNumber || shopifyMatch?.articleNumber || ''),
    barcode: clean(srsRow?.barcode || shopifyMatch?.barcode || ''),
    sku: clean(srsRow?.sku || shopifyMatch?.sku || srsRow?.barcode || ''),
    /* variantId — Shopify GraphQL ID. Frontend gebruikt dit om realtime stock
       op te halen via /api/store/article-stock. */
    variantId: clean(shopifyMatch?.variantId || ''),
    productId,
    /* articleKey — unieke identifier per artikel+kleur (gedeeld over maten).
       Frontend groepeert hier op zodat 1 kaartje per artikel toont, met alle
       maten als chips eronder. Fallback srsRveArtikelnummer als productId leeg
       (variant nog niet in Shopify). */
    articleKey: (productId ? productId + '||' + colorLower : (clean(shopifyMatch?.srsRveArtikelnummer || '') + '||' + colorLower)),
    title: clean(shopifyMatch?.title || srsRow?.title || ''),
    descriptionPlain: shopifyMatch?.descriptionPlain || '',
    description: shopifyMatch?.description || '',
    color: clean(srsRow?.color || shopifyMatch?.color || ''),
    size: clean(srsRow?.size || shopifyMatch?.size || ''),
    image: shopifyMatch?.image || '',
    images: shopifyMatch?.images || [],
    productUrl: shopifyMatch?.productUrl || '',
    vendor: clean(shopifyMatch?.vendor || ''),
    productType: clean(shopifyMatch?.productType || ''),
    price: clean(shopifyMatch?.price || ''),
    srsArtikelId: clean(shopifyMatch?.srsArtikelId || ''),
    srsRveArtikelnummer: clean(shopifyMatch?.srsRveArtikelnummer || ''),
    subgroep: clean(shopifyMatch?.subgroep || ''),
    hoofdgroep: clean(shopifyMatch?.hoofdgroep || ''),
    hoofdgroepOmschrijving: clean(shopifyMatch?.hoofdgroepOmschrijving || ''),
    totalPieces: 0,
    branchCount: 0,
    branches: []
  };
}

/**
 * Combineer alle match-strategieën o.b.v. query-kind. Returnt een score
 * (0-100). 0 = geen match. Wordt gebruikt voor zowel filteren als rangschikken.
 */
function matchQueryScore(article, q, kind, searchWords) {
  if (!q) return 50; /* geen query → alles meegeven met neutrale score */
  switch (kind) {
    case 'artikelcode':
      return matchesArtikelcode(article, q);
    case 'barcode':
      return matchesBarcode(article, q) ? 100 : 0;
    case 'identifier': {
      const code = matchesArtikelcode(article, q);
      if (code > 0) return code;
      return rowMatchesAllWords(article, searchWords) ? 40 : 0;
    }
    case 'name':
    default:
      return rowMatchesAllWords(article, searchWords) ? 50 : 0;
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
  /* withStock=0 → skip branch-snapshot fetch, return resultaten zonder stock-info.
     Frontend belt daarna /api/store/article-stock voor realtime Shopify stock
     per variant. Aanbevolen voor UI (instant search). */
  const withStock = String(req.query.withStock || '1') !== '0';

  const queryKind = detectQueryKind(q);
  const searchWords = q ? q.toLowerCase().split(/\s+/).filter((w) => w.length >= 2) : [];

  if (queryKind === 'short') {
    return res.status(400).json({
      success: false,
      message: 'Zoekterm te kort — minimaal 2 tekens.'
    });
  }

  try {
    let productMap = new Map();
    let productsCache;

    if (withStock) {
      /* === Volle modus: aggregeer per articleNumber/barcode over branch-snapshots. === */
      const allBranches = listAllBranches();
      const branchIds = allBranches.map((b) => b.branchId).filter(Boolean);
      let snapshots;
      [snapshots, productsCache] = await Promise.all([
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

      for (const { branchId, snap } of snapshots) {
        if (!snap || !Array.isArray(snap.rows)) continue;
        const branchName = getStoreNameByBranchId(branchId);

        for (const r of snap.rows) {
          const key = lower(r.articleNumber || r.sku || r.barcode);
          if (!key) continue;

          const shopifyMatch = productsCache.byBarcode?.[lower(r.barcode)]
            || productsCache.bySku?.[lower(r.sku)]
            || productsCache.bySrsArticleNumber?.[lower(r.articleNumber)]
            || productsCache.bySrsArtikelId?.[lower(r.articleNumber)]
            || productsCache.bySrsRveArtikelnummer?.[lower(r.articleNumber)]
            || null;

          let entry = productMap.get(key);
          if (!entry) {
            entry = buildEntry(r, shopifyMatch);
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
    } else {
      /* === Stockless modus: itereer Shopify products cache direct.
            Ultra-snel (<100ms), geen branch-snapshot reads. Frontend lazy-loadt
            de stock per zichtbare kaart via /api/store/article-stock. */
      productsCache = await readProductsCache();
      const seen = new Set();
      const allVariants = Object.values(productsCache.byBarcode || {});
      for (const v of allVariants) {
        const key = lower(v.barcode || v.sku || v.articleNumber);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        productMap.set(key, buildEntry(v, v));
      }
    }

    let articles = Array.from(productMap.values());

    /* Filters toepassen — gebruik query-kind specifieke matcher met score.
       Bij query: bereken score per article, filter score>0, behoud score voor
       latere sort. Bij EXACT match (score 100) onderdrukken we lagere matches
       want de gebruiker wil 'precies dit artikel' niet 'iets dat erop lijkt'. */
    if (q) {
      const scored = articles.map((a) => ({ a, score: matchQueryScore(a, q, queryKind, searchWords) }))
        .filter((x) => x.score > 0);
      const topScore = scored.reduce((m, x) => Math.max(m, x.score), 0);
      /* Als er minstens 1 sterke match is (≥90: exact of productType match),
         toon alleen artikelen in die top-klasse — vermijd dat zwakke suffix-
         matches het echte artikel uit de POS-code wegdrukken. Voor zwakkere
         beste scores houden we alles want dan is er sowieso geen sterke hit. */
      const minScore = topScore >= 90 ? 80 : 1;
      articles = scored.filter((x) => x.score >= minScore).map((x) => Object.assign(x.a, { _matchScore: x.score }));
    }

    /* Facets bouwen ná q-filter zodat counts kloppen met wat de gebruiker
       ziet zodra hij een facet aanklikt. Color/size/hoofdgroep filters worden
       hieronder pas toegepast — zo zien gebruikers nog wel welke kleuren/maten
       beschikbaar zijn bij hun naam-zoek.

       Filter placeholder-waarden (Default Title / Onbekend / —) uit zodat ze
       niet als kleur/maat-optie verschijnen — die geven 0 results bij click. */
    const PLACEHOLDER_VALUES = new Set(['default title', 'onbekend', '—', '-', '']);
    const facetMap = (key) => {
      const m = new Map();
      for (const a of articles) {
        const v = clean(a[key]);
        if (!v) continue;
        if (PLACEHOLDER_VALUES.has(v.toLowerCase())) continue;
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

    if (colorFilter) {
      articles = articles.filter((a) => lower(a.color) === colorFilter);
    }
    if (sizeFilter) {
      articles = articles.filter((a) => lower(a.size) === sizeFilter);
    }
    if (hoofdgroepFilter) {
      articles = articles.filter((a) =>
        lower(a.hoofdgroepOmschrijving) === hoofdgroepFilter
        || lower(a.productType) === hoofdgroepFilter
      );
    }
    if (subgroepFilter) {
      articles = articles.filter((a) => lower(a.subgroep) === subgroepFilter);
    }
    if (onlyAvailable) {
      if (withStock) {
        articles = articles.filter((a) => a.totalPieces > 0);
      } else {
        /* Stockless modus + available filter: doe een lichtgewicht SRS-snapshot
           scan om totalPieces te bepalen per artikel. Voorkomt 'X van Y' bug
           waarbij gebruiker 4 op voorraad zag van 545 omdat alleen de eerste
           30 client-side gefilterd werden (BUG-1 uit audit). */
        const piecesByKey = await loadPiecesFromSnapshots();
        articles = articles.filter((a) => {
          const k1 = lower(a.barcode);
          const k2 = lower(a.sku);
          const k3 = lower(a.articleNumber);
          return (piecesByKey.get(k1) || piecesByKey.get(k2) || piecesByKey.get(k3) || 0) > 0;
        });
      }
    }

    /* Sorteer:
       1. Match-score aflopend (exact matches eerst)
       2. (alleen volle modus) Artikelen met eigen-winkel voorraad eerst
       3. (alleen volle modus) Daarna totaal aantal stuks aflopend
       4. Daarna alfabetisch op titel */
    articles.sort((a, b) => {
      const sa = Number(a._matchScore || 0);
      const sb = Number(b._matchScore || 0);
      if (sa !== sb) return sb - sa;
      if (withStock) {
        const ownA = ownStore ? a.branches.some((b2) => b2.isOwn && b2.pieces > 0) : false;
        const ownB = ownStore ? b.branches.some((b2) => b2.isOwn && b2.pieces > 0) : false;
        if (ownA !== ownB) return ownA ? -1 : 1;
        if (a.totalPieces !== b.totalPieces) return b.totalPieces - a.totalPieces;
      }
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
