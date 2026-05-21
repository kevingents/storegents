import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { readBranchSnapshot } from '../../lib/srs-stock-snapshot-store.js';
import { listAllBranches, getStoreNameByBranchId, isWarehouseStore } from '../../lib/branch-metrics.js';
import { getAllOpenstaandeUitwisselingen } from '../../lib/srs-exchanges-client.js';

/**
 * GET /api/store/stock-lookup
 *
 * Winkel-tool: zoek artikel-voorraad over ALLE branches + check lopende
 * uitwisselingen. Geen admin-token nodig (winkel-medewerkers gebruiken het).
 *
 * Query parameters (één van):
 *   ?barcode=XXX        — exact match op barcode (legacy)
 *   ?sku=XXX            — exact match op SKU (legacy)
 *   ?query=XXX          — generic: matcht barcode, sku, articleNumber (exact)
 *                         OF titel (case-insensitive contains, min 3 tekens)
 *
 * Bij meerdere matches via name-search → response bevat `matches: [...]`
 * met aparte product-cards, en client kan er één kiezen.
 *
 * Response (single match):
 *   {
 *     success,
 *     query: { barcode, sku, value, kind },
 *     item: { barcode, sku, articleNumber, title, color, size },
 *     totalPieces,
 *     branchCount,
 *     branches: [{ branchId, store, pieces, type, updatedAt, isOwn? }],
 *     exchanges: { count, aantal, items: [...] }
 *   }
 *
 * Response (multiple matches via name-search):
 *   {
 *     success,
 *     query: { value, kind:'name' },
 *     multipleMatches: true,
 *     matches: [{ barcode, sku, articleNumber, title, color, size, totalPieces, branchCount }]
 *   }
 *
 * Cache: exchanges 5 min in-memory (zwaar SOAP-call).
 */

const EXCHANGES_CACHE_TTL_MS = Number(process.env.STOCK_LOOKUP_EXCH_CACHE_MS || 5 * 60 * 1000);
let exchangesCache = { at: 0, data: null };

function clean(v) { return String(v || '').trim(); }
function eqBarcode(a, b) {
  return clean(a).toLowerCase() === clean(b).toLowerCase();
}
/* Partial match: query is substring van veld (bv. articleNumber-prefix bij scan) */
function containsCode(field, query) {
  const f = clean(field).toLowerCase();
  const q = clean(query).toLowerCase();
  return Boolean(f && q && f.includes(q));
}
/* Bouw doorzoekbare haystack uit row — naast titel ook kleur/maat/sku/artnr.
   We voegen ook brand/Description-variant velden toe voor het geval delta-merge
   sommige velden anders heeft opgeslagen (raw was er, maar wordt niet bewaard
   na merge — defensief bouwen we de haystack uit alle string-velden). */
function buildRowHaystack(r) {
  const parts = [];
  /* Standaard structured fields */
  parts.push(r.title, r.color, r.size, r.sku, r.barcode, r.articleNumber);
  /* Defensieve fallback — pak ook alle andere string-velden mee zodat oudere
     snapshot-data met alternatieve veldnamen (bv. description, productName)
     toch matched. We slaan grote/object-velden over. */
  for (const [k, v] of Object.entries(r || {})) {
    if (['title', 'color', 'size', 'sku', 'barcode', 'articleNumber', 'pieces',
         'stockType', 'unitPrice', 'source', 'sourceFile', 'updatedAt', 'raw',
         'branchId', 'store'].includes(k)) continue;
    if (typeof v === 'string' && v.length < 200) parts.push(v);
  }
  return parts.map((v) => String(v || '').toLowerCase()).join(' ');
}
/* Strikte match: ALLE zoekwoorden moeten in de haystack */
function rowMatchesAllWords(r, words) {
  if (!words.length) return false;
  const hay = buildRowHaystack(r);
  if (!hay) return false;
  return words.every((w) => hay.includes(w));
}
/* Loose match: tel hoeveel van de zoekwoorden voorkomen — voor fallback */
function rowMatchScore(r, words) {
  if (!words.length) return 0;
  const hay = buildRowHaystack(r);
  if (!hay) return 0;
  let hits = 0;
  for (const w of words) if (hay.includes(w)) hits++;
  return hits;
}

/* Verzamel rows die matchen → groepeer per articleNumber/sku/barcode */
function collectProductMatches(snapshots, matchFn) {
  const map = new Map();
  for (const { branchId, snap } of snapshots) {
    if (!snap || !Array.isArray(snap.rows)) continue;
    for (const r of snap.rows) {
      if (!matchFn(r)) continue;
      const key = String(r.articleNumber || r.sku || r.barcode || '').trim().toLowerCase();
      if (!key) continue;
      const entry = map.get(key) || {
        barcode: String(r.barcode || '').trim(),
        sku: String(r.sku || r.barcode || '').trim(),
        articleNumber: String(r.articleNumber || '').trim(),
        title: String(r.title || '').trim(),
        color: String(r.color || '').trim(),
        size: String(r.size || '').trim(),
        totalPieces: 0,
        branchCount: 0,
        _branchSet: new Set(),
        _sampleRow: r
      };
      entry.totalPieces += Number(r.pieces || 0);
      entry._branchSet.add(branchId);
      if (!entry.title && r.title) entry.title = String(r.title).trim();
      map.set(key, entry);
    }
  }
  return map;
}
/* Detecteer wat voor soort zoekterm het is.
   - Spaties → name (vrije tekst, fuzzy op alle velden)
   - <3 chars → short (te kort om iets zinnigs mee te doen)
   - 3+ alphanumeric chars zonder spaties → identifier (barcode/SKU/artikelnr) —
     verlaagd van 5 naar 3 zodat korte artikelcodes (bv. "G42") ook werken
   - Anders → name */
function detectQueryKind(value) {
  const v = clean(value);
  if (!v) return 'empty';
  if (/\s/.test(v)) return 'name';
  if (v.length < 3) return 'short';
  if (/^[A-Za-z0-9._/\\-]+$/.test(v) && v.length >= 3) return 'identifier';
  return 'name';
}

async function getCachedExchanges() {
  if (exchangesCache.data && (Date.now() - exchangesCache.at) < EXCHANGES_CACHE_TTL_MS) {
    return { data: exchangesCache.data, fromCache: true };
  }
  try {
    const r = await getAllOpenstaandeUitwisselingen({ days: 60 });
    exchangesCache = { at: Date.now(), data: r };
    return { data: r, fromCache: false };
  } catch (error) {
    console.warn('[stock-lookup] exchanges fetch faalde:', error.message);
    return { data: { exchanges: [], error: error.message }, fromCache: false };
  }
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  const barcode = clean(req.query.barcode);
  const sku = clean(req.query.sku);
  const query = clean(req.query.query || req.query.q); /* nieuw: generic */
  const ownStore = clean(req.query.store); /* huidige winkel voor highlight */

  if (!barcode && !sku && !query) {
    return res.status(400).json({ success: false, message: 'Geef barcode, sku of query mee.' });
  }

  /* Bepaal soort zoekopdracht */
  const queryValue = barcode || sku || query;
  let queryKind;
  if (barcode) queryKind = 'barcode';
  else if (sku) queryKind = 'sku';
  else queryKind = detectQueryKind(query);

  if (queryKind === 'short') {
    return res.status(400).json({ success: false, message: 'Zoekterm te kort — minimaal 3 tekens.' });
  }

  /* Voor name-zoek: bouw woorden vooraf — gebruikt voor zowel strict als loose */
  const searchWords = (queryKind === 'name' || queryKind === 'identifier')
    ? String(queryValue || '').toLowerCase().split(/\s+/).filter((w) => w.length >= 2)
    : [];

  /* Strikte match per row. Voor identifiers proberen we eerst EXACT, dan
     CONTAINS (partial barcode/sku/articleNumber match) — kassa-medewerkers
     scannen soms maar deel van een barcode, of SRS-articleNumber heeft
     leading zeros / suffixes die de exact-match breken. */
  const matchRow = (r) => {
    if (queryKind === 'barcode') {
      return eqBarcode(r.barcode, queryValue) || containsCode(r.barcode, queryValue);
    }
    if (queryKind === 'sku') {
      return eqBarcode(r.sku, queryValue)
        || eqBarcode(r.barcode, queryValue)
        || containsCode(r.sku, queryValue)
        || containsCode(r.barcode, queryValue);
    }
    if (queryKind === 'identifier') {
      /* 1) Exact match — snelste pad voor scanners */
      if (eqBarcode(r.barcode, queryValue) || eqBarcode(r.sku, queryValue) || eqBarcode(r.articleNumber, queryValue)) return true;
      /* 2) Partial code match — voor scanners die maar deel van de barcode pakken
         en voor SRS-articleNumbers met formats als "12345-S" of "0012345" */
      if (containsCode(r.barcode, queryValue) || containsCode(r.sku, queryValue) || containsCode(r.articleNumber, queryValue)) return true;
      /* 3) Vrije-tekst fallback — identifier zou ook deel kunnen zijn van titel */
      return searchWords.length > 0 && rowMatchesAllWords(r, searchWords);
    }
    if (queryKind === 'name') {
      return rowMatchesAllWords(r, searchWords);
    }
    return false;
  };

  try {
    /* Parallel: alle branch-snapshots + open uitwisselingen */
    const allBranches = listAllBranches();
    const branchIds = allBranches.map((b) => b.branchId).filter(Boolean);

    const [snapshots, exchangesResult] = await Promise.all([
      Promise.all(branchIds.map(async (bid) => {
        try {
          const snap = await readBranchSnapshot(bid);
          return { branchId: bid, snap };
        } catch {
          return { branchId: bid, snap: null };
        }
      })),
      getCachedExchanges()
    ]);

    /* Bij name-search → mogelijke verschillende artikelen groeperen per articleNumber/sku */
    if (queryKind === 'name' || queryKind === 'identifier') {
      /* Stap 1: strict matching */
      const productMap = collectProductMatches(snapshots, matchRow);

      /* Stap 2: als 0 strict matches en >1 zoekwoord → probeer loose (N-1 woorden) */
      let isFuzzy = false;
      if (productMap.size === 0 && searchWords.length >= 2) {
        isFuzzy = true;
        const minHits = Math.max(1, searchWords.length - 1); /* minstens N-1 van N */
        const looseMatch = (r) => rowMatchScore(r, searchWords) >= minHits;
        const looseProductMap = collectProductMatches(snapshots, looseMatch);
        /* Voeg score-velden toe voor sortering */
        for (const entry of looseProductMap.values()) {
          entry._matchScore = entry._sampleRow ? rowMatchScore(entry._sampleRow, searchWords) : 0;
        }
        /* Overschrijf productMap */
        for (const [k, v] of looseProductMap) productMap.set(k, v);
      }

      /* >1 distinct artikel → multipleMatches response.
         OOK bij fuzzy met 1 match → toon als picker zodat de gebruiker
         duidelijk ziet dat 't een fuzzy hit is en die kan bevestigen. */
      const showMultiple = productMap.size > 1 || (isFuzzy && productMap.size === 1);
      if (showMultiple) {
        const matches = Array.from(productMap.values()).map(e => ({
          barcode: e.barcode,
          sku: e.sku,
          articleNumber: e.articleNumber,
          title: e.title,
          color: e.color,
          size: e.size,
          totalPieces: e.totalPieces,
          branchCount: e._branchSet.size,
          matchScore: e._matchScore || searchWords.length
        })).sort((a, b) => {
          /* Fuzzy: sorteer op match-score desc, dan op stock desc */
          if (isFuzzy && a.matchScore !== b.matchScore) return b.matchScore - a.matchScore;
          return b.totalPieces - a.totalPieces;
        }).slice(0, 50);
        return res.status(200).json({
          success: true,
          query: { value: queryValue, kind: queryKind, fuzzy: isFuzzy, searchWords },
          multipleMatches: true,
          matchCount: productMap.size,
          truncated: productMap.size > 50,
          fuzzyHint: isFuzzy ? `Geen exact match op alle ${searchWords.length} woorden — fuzzy matches op ${searchWords.length - 1}+ woorden getoond.` : null,
          matches,
          generatedAt: new Date().toISOString()
        });
      }
      /* Precies 1 distinct artikel via strict match → val terug op normale
         single-response; matchRow hieronder pakt 'm. */
    }

    /* Filter rows per branch op de barcode/sku/articleNumber/title */
    const branches = [];
    let item = null;
    for (const { branchId, snap } of snapshots) {
      if (!snap || !Array.isArray(snap.rows)) continue;
      const matchingRows = snap.rows.filter(matchRow);
      if (!matchingRows.length) continue;

      /* Eerste niet-lege metadata wint */
      if (!item) {
        const first = matchingRows[0];
        item = {
          barcode: clean(first.barcode),
          sku: clean(first.sku || first.barcode),
          articleNumber: clean(first.articleNumber || ''),
          title: clean(first.title || ''),
          color: clean(first.color || ''),
          size: clean(first.size || '')
        };
      }

      const branchName = getStoreNameByBranchId(branchId);
      const pieces = matchingRows.reduce((s, r) => s + Number(r.pieces || 0), 0);

      branches.push({
        branchId,
        store: branchName,
        pieces,
        type: isWarehouseStore(branchName) ? 'warehouse' : 'retail',
        updatedAt: snap.updatedAt || null,
        isOwn: ownStore && branchName === ownStore
      });
    }

    /* Sort: eigen winkel bovenaan, dan met voorraad > 0 op aantal aflopend,
       dan rest alfabetisch */
    branches.sort((a, b) => {
      if (a.isOwn && !b.isOwn) return -1;
      if (!a.isOwn && b.isOwn) return 1;
      if (a.pieces !== b.pieces) return b.pieces - a.pieces;
      return a.store.localeCompare(b.store);
    });

    const totalPieces = branches.reduce((s, b) => s + b.pieces, 0);

    /* Filter exchanges — gebruik resolved item-velden uit de gevonden snapshot */
    const exchBarcode = item?.barcode || (queryKind === 'barcode' ? queryValue : '');
    const exchSku = item?.sku || (queryKind === 'sku' ? queryValue : '');
    const exchArticle = item?.articleNumber || (queryKind === 'identifier' ? queryValue : '');

    const matchExchItem = (it) => (
      (exchBarcode && (eqBarcode(it.barcode, exchBarcode) || eqBarcode(it.sku, exchBarcode))) ||
      (exchSku && (eqBarcode(it.sku, exchSku) || eqBarcode(it.barcode, exchSku))) ||
      (exchArticle && eqBarcode(it.articleNumber, exchArticle))
    );

    const matchingExchanges = [];
    for (const exch of (exchangesResult.data.exchanges || [])) {
      const items = exch.items || [];
      if (!items.some(matchExchItem)) continue;
      const itemsInExchange = items.filter(matchExchItem);
      const aantalInExchange = itemsInExchange.reduce((s, i) => s + Number(i.aantal || 0), 0);
      matchingExchanges.push({
        uitwisselingId: exch.uitwisselingId,
        vanFiliaal: exch.vanFiliaal,
        vanWinkel: exch.vanWinkel,
        naarFiliaal: exch.naarFiliaal,
        naarWinkel: exch.naarWinkel,
        sellerName: exch.sellerName || exch.verkoper || '',
        createdAt: exch.createdAt || exch.aangemaaktOp || '',
        aantal: aantalInExchange,
        totalItemsInExchange: exch.itemCount
      });
    }

    matchingExchanges.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    return res.status(200).json({
      success: true,
      query: { barcode, sku, value: queryValue, kind: queryKind },
      item,
      totalPieces,
      branchCount: branches.length,
      branches,
      exchanges: {
        count: matchingExchanges.length,
        aantal: matchingExchanges.reduce((s, e) => s + Number(e.aantal || 0), 0),
        items: matchingExchanges
      },
      exchangesFromCache: exchangesResult.fromCache,
      exchangesError: exchangesResult.data.error || null,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[stock-lookup] error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Voorraad-lookup mislukt.'
    });
  }
}
