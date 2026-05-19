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

    /* 5. Match: rows met size in topSizes OF color in topColors */
    const topSizeSet = new Set(topSizes.map((s) => s.key));
    const topColorSet = new Set(topColors.map((c) => c.key));
    const topBrandSet = new Set(topBrands.map((b) => b.key.toLowerCase()));

    const scored = [];
    for (const row of stockRows) {
      const rowSize = normSize(row.size || '');
      const rowColor = normColor(row.color || '');
      const rowBrand = clean(row.brand || row.supplierName || '').toLowerCase();

      let score = 0;
      const matchReasons = [];
      if (rowSize && topSizeSet.has(rowSize)) {
        score += 3;
        matchReasons.push(`maat ${rowSize}`);
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
        scored.push({ ...row, _score: score, _matchReasons: matchReasons });
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
