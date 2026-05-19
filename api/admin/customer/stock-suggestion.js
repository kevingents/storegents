/**
 * GET /api/admin/customer/stock-suggestion?customerEmail=X&store=GENTS%20Amersfoort
 *
 * Voorraad-suggestie aan de balie: combineer de top-voorkeuren van een klant
 * (maten + kleuren uit kassa-transacties) met de huidige winkel-voorraad uit
 * de SRS stock-snapshot. Levert max ~20 items terug die de klant
 * waarschijnlijk leuk vindt EN op voorraad zijn in deze winkel.
 *
 * Gebruik:
 *   "Hij koopt meestal M / Navy / €70 gem. In deze winkel: 8 matches."
 */

import { handleCors, setCorsHeaders } from '../../../lib/cors.js';
import { getTransactions } from '../../../lib/srs-customers-client.js';
import { getCustomers } from '../../../lib/srs-customers-client.js';
import { getBranchIdByStore } from '../../../lib/branch-metrics.js';
import { readBranchSnapshot, pickBranchStockRows } from '../../../lib/srs-stock-snapshot-store.js';

function isAuthorized(req) {
  const expected = String(process.env.ADMIN_TOKEN || '').trim();
  if (!expected) return true;
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return token === expected;
}

function clean(value) { return String(value || '').trim(); }
function normSize(value) { return clean(value).toUpperCase(); }
function normColor(value) { return clean(value).toLowerCase(); }

function topNFromMap(map, n = 3) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

/**
 * Maat-fallback logica: bepaalt of een rij-maat 1 stap af zit van de
 * klant-voorkeur (zo dan score lager dan exacte match).
 *
 * Ondersteunt:
 *   - Letter-maten: XS · S · M · L · XL · XXL · XXXL (volgorde)
 *   - Numerieke maten: 36, 37, ..., 64 (broekmaten, schoenen)
 *   - Lengte/breedte: W30L32, W32L34 etc. (matched op W-deel)
 */
const LETTER_LADDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL'];

function sizeProximity(rowSize, prefSize) {
  if (!rowSize || !prefSize) return 'none';
  const a = String(rowSize).toUpperCase().trim();
  const b = String(prefSize).toUpperCase().trim();
  if (a === b) return 'exact';

  /* Letter-maat ladder */
  const ia = LETTER_LADDER.indexOf(a);
  const ib = LETTER_LADDER.indexOf(b);
  if (ia !== -1 && ib !== -1) {
    const diff = Math.abs(ia - ib);
    return diff === 1 ? 'neighbor' : 'none';
  }

  /* Pure numerieke maat (broek, schoen) */
  const numA = Number(a.replace(/[^\d]/g, ''));
  const numB = Number(b.replace(/[^\d]/g, ''));
  if (Number.isFinite(numA) && Number.isFinite(numB) && numA > 0 && numB > 0) {
    const diff = Math.abs(numA - numB);
    /* Voor schoenmaten/broekmaten: ±1 is buurmaat. Soms ±2 voor schoen (39/40/41) */
    if (diff === 0) return 'exact';
    if (diff === 1) return 'neighbor';
    if (diff === 2 && numA >= 35 && numA <= 50) return 'far-neighbor';
    return 'none';
  }

  /* W/L jeans-maat: 'W32L34' vs 'W33L34' */
  const wA = a.match(/^W(\d+)/);
  const wB = b.match(/^W(\d+)/);
  if (wA && wB) {
    const diff = Math.abs(Number(wA[1]) - Number(wB[1]));
    if (diff === 0) return 'exact';
    if (diff === 1) return 'neighbor';
  }

  return 'none';
}

/**
 * Voor een rij-maat bepaal de BESTE proximity tegen alle klant-voorkeuren.
 * Geeft 'exact' / 'neighbor' / 'far-neighbor' / 'none' terug.
 */
function bestSizeMatch(rowSize, prefSizes) {
  if (!rowSize || !prefSizes?.length) return 'none';
  let best = 'none';
  const rank = { exact: 3, neighbor: 2, 'far-neighbor': 1, none: 0 };
  for (const p of prefSizes) {
    const prox = sizeProximity(rowSize, p);
    if (rank[prox] > rank[best]) best = prox;
  }
  return best;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const email = clean(req.query.customerEmail || req.query.email);
  const customerIdParam = clean(req.query.customerId);
  const store = clean(req.query.store);

  if (!email && !customerIdParam) {
    return res.status(400).json({ success: false, message: 'customerEmail of customerId verplicht.' });
  }
  if (!store) {
    return res.status(400).json({ success: false, message: 'store verplicht.' });
  }

  const branchId = String(getBranchIdByStore?.(store) || '').trim();
  if (!branchId) {
    return res.status(400).json({ success: false, message: `Onbekende winkel: ${store}` });
  }

  try {
    /* 1. Zoek de klant in SRS */
    let customerId = customerIdParam;
    if (!customerId && email) {
      const c = await getCustomers({ email });
      customerId = String(c?.customers?.[0]?.customerId || '');
    }
    if (!customerId) {
      return res.status(404).json({ success: false, message: 'Klant niet gevonden in SRS.' });
    }

    /* 2. Haal transacties op (5 jaar, max 200 rijen) */
    const now = new Date();
    const fromDate = new Date(now);
    fromDate.setFullYear(fromDate.getFullYear() - 5);
    const from = `${fromDate.toISOString().slice(0, 10)}T00:00:00`;
    const until = `${now.toISOString().slice(0, 10)}T23:59:59`;
    const txResult = await getTransactions({ customerId, from, until });
    const transactions = txResult?.transactions || [];

    /* 3. Bereken klant-voorkeuren */
    const sizeMap = new Map();
    const colorMap = new Map();
    const brandMap = new Map();
    let totalAmount = 0;
    let bonCount = 0;

    for (const tx of transactions) {
      const amount = Number(tx.total ?? tx.amount ?? 0);
      if (amount > 0) {
        totalAmount += amount;
        bonCount += 1;
      }
      for (const item of (tx.items || [])) {
        const size = normSize(item.size || item.maat || '');
        const color = normColor(item.color || item.kleur || '');
        const brand = clean(item.brand || item.merk || item.supplierName || '');
        if (size) sizeMap.set(size, (sizeMap.get(size) || 0) + 1);
        if (color) colorMap.set(color, (colorMap.get(color) || 0) + 1);
        if (brand) brandMap.set(brand, (brandMap.get(brand) || 0) + 1);
      }
    }

    const topSizes = topNFromMap(sizeMap, 3);
    const topColors = topNFromMap(colorMap, 3);
    const topBrands = topNFromMap(brandMap, 3);
    const avgAmount = bonCount > 0 ? totalAmount / bonCount : 0;

    /* 4. Lees stock-snapshot voor deze winkel */
    const snapshot = await readBranchSnapshot(branchId);
    if (!snapshot || !snapshot.rows?.length) {
      return res.status(200).json({
        success: true,
        store,
        branchId,
        customerId,
        preferences: { topSizes, topColors, topBrands, avgAmount, bonCount },
        snapshot: { available: false, message: 'Stock-snapshot ontbreekt — wacht op SFTP delta cron.' },
        suggestions: []
      });
    }

    const stockRows = pickBranchStockRows(snapshot, { onlyAvailable: true });

    /* 5. Match: rows met size in topSizes (of ±1 buurmaat) OF color in topColors */
    const topSizeKeys = topSizes.map((s) => s.key);
    const topColorSet = new Set(topColors.map((c) => c.key));
    const topBrandSet = new Set(topBrands.map((b) => b.key.toLowerCase()));

    const scored = [];
    for (const row of stockRows) {
      const rowSize = normSize(row.size || '');
      const rowColor = normColor(row.color || '');
      const rowBrand = clean(row.brand || row.supplierName || '').toLowerCase();

      let score = 0;
      const matchReasons = [];

      /* Maat met buurmaat-fallback */
      const sizeMatch = bestSizeMatch(rowSize, topSizeKeys);
      if (sizeMatch === 'exact') {
        score += 3;
        matchReasons.push(`maat ${rowSize}`);
      } else if (sizeMatch === 'neighbor') {
        score += 2;
        matchReasons.push(`maat ${rowSize} (buurmaat)`);
      } else if (sizeMatch === 'far-neighbor') {
        score += 1;
        matchReasons.push(`maat ${rowSize} (±2)`);
      }

      if (rowColor && topColorSet.has(rowColor)) {
        score += 2;
        matchReasons.push(`kleur ${rowColor}`);
      }
      if (rowBrand && topBrandSet.has(rowBrand)) {
        score += 2;
        matchReasons.push(`merk ${rowBrand}`);
      }
      if (score > 0) {
        scored.push({ ...row, _score: score, _matchReasons: matchReasons, _sizeMatch: sizeMatch });
      }
    }

    /* 6. Sorteer en limiteer */
    scored.sort((a, b) => b._score - a._score);
    const suggestions = scored.slice(0, 20).map((row) => ({
      barcode: row.barcode,
      sku: row.sku,
      title: row.title,
      color: row.color,
      size: row.size,
      pieces: row.pieces,
      unitPrice: row.unitPrice,
      articleNumber: row.articleNumber,
      score: row._score,
      matchReasons: row._matchReasons
    }));

    return res.status(200).json({
      success: true,
      store,
      branchId,
      customerId,
      preferences: { topSizes, topColors, topBrands, avgAmount, bonCount },
      snapshot: {
        available: true,
        updatedAt: snapshot.updatedAt,
        rowCount: stockRows.length
      },
      suggestions,
      totalMatches: scored.length
    });
  } catch (error) {
    console.error('[customer-stock-suggestion]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Voorraad-suggestie kon niet worden gemaakt.'
    });
  }
}
