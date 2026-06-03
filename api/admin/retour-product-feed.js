import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { readJsonBlob, writeJsonBlob } from '../../lib/json-blob-store.js';

/**
 * GET /api/admin/retour-product-feed?format=csv&months=12&adminToken=...
 *
 * Productfeed voor Channable: per product (SKU) het retourpercentage (totaal),
 * met aantal besteld en aantal retour over de gekozen periode.
 *
 * Bron: Shopify orders (created_at) met line_items + geneste refunds.
 *   - besteld  = som van bestelde stuks per SKU (excl. geannuleerd / offline bon)
 *   - retour   = som van geretourneerde stuks per SKU (refund_line_items)
 *   - retour%  = retour / besteld * 100
 *
 * format=csv (default) → text/csv voor Channable-import (auth via ?adminToken=).
 * format=json          → JSON voor preview in de portal.
 *
 * Kolommen CSV: sku, product, aantal_besteld, aantal_retour, retourpercentage, retour_waarde
 */

export const maxDuration = 300;

const DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '';
const TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || process.env.SHOPIFY_ADMIN_TOKEN || '';
const API = process.env.SHOPIFY_API_VERSION || '2025-01';

/* In-memory cache: per-product retour-aggregatie verandert nauwelijks; Channable
   trekt 1x/dag. ?refresh=1 forceert vers. Default 6 uur. */
const FEED_CACHE = new Map();
const FEED_TTL_MS = Number(process.env.RETOUR_FEED_CACHE_MS || 6 * 60 * 60 * 1000) || 6 * 60 * 60 * 1000;
/* Persistente snapshot (blob): overleeft koude starts; nachtelijke cron ververst (30u marge). */
const FEED_BLOB_MAX_AGE_MS = Number(process.env.RETOUR_FEED_BLOB_MAX_AGE_MS || 30 * 60 * 60 * 1000) || 30 * 60 * 60 * 1000;
const feedBlobPath = (months, maxOrders) => `report-snapshots/retour-product-feed-${months}-${maxOrders}.json`;

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
  if (!adminToken) return false;
  const token = String(
    req.headers['x-admin-token'] || req.headers['x-admin-pin'] || req.headers.authorization ||
    req.query.adminToken || req.query.admin_token || ''
  ).replace(/^Bearer\s+/i, '').trim();
  return token === adminToken;
}

function num(v) { return Math.round(Number(v || 0) * 100) / 100; }
function csvCell(v) { return `"${String(v == null ? '' : v).replace(/"/g, '""')}"`; }

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of String(linkHeader).split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const format = String(req.query.format || 'csv').toLowerCase();

  if (!DOMAIN || !TOKEN) {
    const msg = 'SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_ACCESS_TOKEN ontbreekt in Vercel.';
    if (format === 'json') return res.status(200).json({ success: false, configured: false, message: msg });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send(`# ${msg}`);
  }

  const months = Math.max(1, Math.min(36, Number(req.query.months || 12)));
  const maxOrders = Math.max(500, Math.min(40000, Number(req.query.maxOrders || 15000)));

  /* Format-helper: csv én json delen dezelfde aggregatie (en dus dezelfde cache). */
  const formatOut = (rows, meta) => {
    if (format === 'json') {
      return res.status(200).json({
        success: true, months, scanned: meta.scanned, truncated: meta.truncated, cached: Boolean(meta.cached),
        note: 'Retour% per product op stuks-basis (geretourneerde stuks / bestelde stuks). Excl. geannuleerd + offline bon.',
        count: rows.length, rows: rows.slice(0, Number(req.query.limit || 1000))
      });
    }
    const header = ['sku', 'product', 'aantal_besteld', 'aantal_retour', 'retourpercentage', 'retour_waarde'];
    const lines = [header.join(',')];
    for (const r of rows) lines.push([csvCell(r.sku), csvCell(r.product), r.besteld, r.retour, r.retourpercentage, r.retourwaarde].join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="gents-retour-productfeed-${months}mnd.csv"`);
    return res.status(200).send(lines.join('\n'));
  };

  const refresh = ['1', 'true'].includes(String(req.query.refresh || ''));
  const cacheKey = `feed:${months}:${maxOrders}`;
  const cacheHit = FEED_CACHE.get(cacheKey);
  if (!refresh && cacheHit && Date.now() - cacheHit.ts < FEED_TTL_MS) {
    return formatOut(cacheHit.rows, { scanned: cacheHit.scanned, truncated: cacheHit.truncated, cached: true });
  }
  if (!refresh) {
    try {
      const snap = await readJsonBlob(feedBlobPath(months, maxOrders), null);
      if (snap && Array.isArray(snap.rows) && snap.savedAt && Date.now() - snap.savedAt < FEED_BLOB_MAX_AGE_MS) {
        FEED_CACHE.set(cacheKey, { ts: Date.now(), rows: snap.rows, scanned: snap.scanned, truncated: snap.truncated });
        return formatOut(snap.rows, { scanned: snap.scanned, truncated: snap.truncated, cached: 'snapshot' });
      }
    } catch (_) { /* geen/oude snapshot → live berekenen */ }
  }

  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);

  /* sku → { sku, title, ordered, returned, returnedAmount } */
  const map = new Map();
  const bump = (sku, title, fields) => {
    const key = String(sku || title || '').trim() || '(onbekend)';
    const cur = map.get(key) || { sku: String(sku || '').trim(), title: String(title || '').trim() || key, ordered: 0, returned: 0, returnedAmount: 0 };
    if (!cur.title && title) cur.title = String(title).trim();
    cur.ordered += fields.ordered || 0;
    cur.returned += fields.returned || 0;
    cur.returnedAmount += fields.returnedAmount || 0;
    map.set(key, cur);
  };

  try {
    let url = `https://${DOMAIN}/admin/api/${API}/orders.json?status=any&order=created_at+desc`
      + `&created_at_min=${start.toISOString()}&created_at_max=${now.toISOString()}`
      + `&limit=250&fields=id,created_at,cancelled_at,tags,line_items,refunds`;
    let scanned = 0, truncated = false;

    while (url && scanned < maxOrders) {
      const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': TOKEN, Accept: 'application/json' } });
      if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`Shopify ${r.status} — ${t.slice(0, 140)}`); }
      const d = await r.json();
      const orders = d.orders || [];
      if (!orders.length) break;

      for (const o of orders) {
        scanned++;
        const tags = String(o.tags || '').split(',').map(t => t.trim());
        if (tags.includes('gents-offline')) continue;
        if (o.cancelled_at) continue;

        for (const li of (o.line_items || [])) {
          bump(li.sku, li.title, { ordered: Number(li.quantity || 0) });
        }
        for (const rf of (o.refunds || [])) {
          for (const rli of (rf.refund_line_items || [])) {
            const q = Number(rli.quantity || 0);
            if (q <= 0) continue;
            const li = rli.line_item || {};
            const amt = Number(rli.subtotal != null ? rli.subtotal : (rli.subtotal_set?.shop_money?.amount || 0));
            bump(li.sku, li.title, { returned: q, returnedAmount: amt });
          }
        }
      }
      const next = parseNextLink(r.headers.get('link'));
      if (next && scanned >= maxOrders) { truncated = true; break; }
      url = next;
    }

    const rows = [...map.values()]
      .map(r => ({
        sku: r.sku,
        product: r.title,
        besteld: r.ordered,
        retour: r.returned,
        retourpercentage: r.ordered > 0 ? Number(((r.returned / r.ordered) * 100).toFixed(1)) : 0,
        retourwaarde: num(r.returnedAmount)
      }))
      .filter(r => r.besteld > 0 || r.retour > 0)
      .sort((a, b) => b.retour - a.retour);

    FEED_CACHE.set(cacheKey, { ts: Date.now(), rows, scanned, truncated });
    if (FEED_CACHE.size > 50) FEED_CACHE.delete(FEED_CACHE.keys().next().value);
    writeJsonBlob(feedBlobPath(months, maxOrders), { savedAt: Date.now(), rows, scanned, truncated }).catch(() => {});
    return formatOut(rows, { scanned, truncated });
  } catch (error) {
    console.error('[admin/retour-product-feed]', error);
    if (format === 'json') return res.status(200).json({ success: false, configured: true, message: error.message });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send(`# Fout: ${error.message}`);
  }
}
