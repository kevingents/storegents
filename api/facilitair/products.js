/**
 * GET /api/facilitair/products?store=GENTS+Tilburg
 *
 * Levert producten-lijst + per product een advies-aantal op basis van
 * winkel-volumes (kassa-transacties + weborder-fulfillments laatste 30 dagen).
 * Inclusief de vorige bestelling voor "Vorige bestelling herhalen".
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import {
  FACILITAIR_PRODUCTS,
  FACILITAIR_CATEGORIES,
  FACILITAIR_SAFETY_MARGIN,
  calculateAdvisedQuantity
} from '../../lib/facilitair-products-config.js';
import { getLastFacilitairOrderForStore } from '../../lib/facilitair-orders-store.js';

function baseUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || process.env.VERCEL_URL || 'storegents.vercel.app';
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  return `${protocol}://${host}`.replace(/\/$/, '');
}

function isoDate(date) { return date.toISOString().slice(0, 10); }
function daysAgo(days) { const d = new Date(); d.setDate(d.getDate() - days); return isoDate(d); }

async function fetchJsonSafe(url, label, warnings) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout?.(45000), headers: { Accept: 'application/json' } });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
    if (!response.ok || data.success === false) {
      warnings.push(`${label}: HTTP ${response.status} ${data.message || ''}`.trim());
      return null;
    }
    return data;
  } catch (error) {
    warnings.push(`${label}: ${error.name === 'AbortError' ? 'timeout' : (error.message || String(error))}`);
    return null;
  }
}

function normalizeStore(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

/**
 * Haal totalTransactions per winkel op uit de bestaande customer-weekly-report.
 */
async function fetchTransactionsForStore(req, store, warnings) {
  const root = baseUrl(req);
  const token = encodeURIComponent(String(process.env.ADMIN_TOKEN || '').trim());
  const from = daysAgo(30);
  const to = isoDate(new Date());
  const url = `${root}/api/admin/customers/weekly-report?dateFrom=${encodeURIComponent(from)}&dateTo=${encodeURIComponent(to)}&allBranches=true&allReceipts=true&adminToken=${token}`;
  const data = await fetchJsonSafe(url, 'transactions-source', warnings);
  if (!data) return 0;
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const target = normalizeStore(store).toLowerCase();
  const match = rows.find((row) => normalizeStore(row.store || row.branchName || row.name).toLowerCase() === target);
  if (!match) return 0;
  return Number(match.totalTransactions ?? match.transactions ?? match.bonCount ?? 0);
}

/**
 * Haal aantal weborders op via store-weekly-order-report (afgelopen 30d).
 */
async function fetchWebordersForStore(req, store, warnings) {
  const root = baseUrl(req);
  const token = encodeURIComponent(String(process.env.ADMIN_TOKEN || '').trim());
  const from = daysAgo(30);
  const to = isoDate(new Date());
  const url = `${root}/api/admin/store-weekly-order-report?dateFrom=${encodeURIComponent(from)}&dateTo=${encodeURIComponent(to)}&adminToken=${token}`;
  const data = await fetchJsonSafe(url, 'weborders-source', warnings);
  if (!data) return 0;
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const target = normalizeStore(store).toLowerCase();
  const match = rows.find((row) => normalizeStore(row.store || row.branchName).toLowerCase() === target);
  if (!match) return 0;
  return Number(match.orderCount ?? match.openOrders ?? match.totalOrders ?? 0);
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  }

  try {
    const store = normalizeStore(req.query.store);
    if (!store) {
      return res.status(400).json({ success: false, message: 'Geef ?store=... mee.' });
    }

    const warnings = [];

    /* Parallelle volume-fetches + laatste bestelling */
    const [transactions, weborders, lastOrder] = await Promise.all([
      fetchTransactionsForStore(req, store, warnings),
      fetchWebordersForStore(req, store, warnings),
      getLastFacilitairOrderForStore(store)
    ]);

    /* Bouw producten met advies + groepering per categorie */
    const products = FACILITAIR_PRODUCTS.map((product) => {
      const { advisedQuantity, sourceCount, source } = calculateAdvisedQuantity(product, { transactions, weborders });
      return {
        ...product,
        advisedQuantity,
        advisorySource: source,
        advisorySourceCount: sourceCount
      };
    });

    /* Vorige bestelling: alleen relevante velden teruggeven voor "herhaal" */
    const previousOrder = lastOrder
      ? {
          id: lastOrder.id,
          createdAt: lastOrder.createdAt,
          status: lastOrder.status,
          items: lastOrder.items,
          note: lastOrder.note || ''
        }
      : null;

    return res.status(200).json({
      success: true,
      store,
      window: { days: 30, from: daysAgo(30), to: isoDate(new Date()) },
      volumes: { transactions, weborders },
      safetyMargin: FACILITAIR_SAFETY_MARGIN,
      categories: FACILITAIR_CATEGORIES,
      products,
      previousOrder,
      warnings
    });
  } catch (error) {
    console.error('[facilitair/products]', error);
    return res.status(500).json({ success: false, message: error.message || 'Producten konden niet worden geladen.' });
  }
}
