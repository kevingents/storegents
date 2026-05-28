/**
 * GET /api/feeds/channable-margin?token=…
 *
 * Marge-/inkoopprijs-feed (CSV) voor Channable om POAS te meten. Per EAN:
 * verkoopprijs (Shopify, incl-BTW), inkoopprijs (SRS-verkopen kostprijs, ex-BTW),
 * en de winstmarge ex-BTW. Channable joint deze feed op EAN met de hoofdfeed en
 * rekent POAS = (omzet ex-BTW − inkoop) ÷ ad spend.
 *
 * Beveiliging: ?token= moet matchen met CHANNABLE_FEED_TOKEN (fallback FEED_TOKEN
 * of ADMIN_TOKEN). Zet bij voorkeur een eigen CHANNABLE_FEED_TOKEN zodat de feed-
 * URL niet het admin-token bevat.
 *
 * Kolommen (komma-gescheiden, decimaal-punt):
 *   ean, sku, titel, merk, verkoopprijs, inkoopprijs, btw, marge, marge_pct
 */

import { readProductCost } from '../../lib/product-cost-store.js';
import { readProductsCache } from '../../lib/shopify-products-cache.js';

export const maxDuration = 30;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const lc = (v) => String(v == null ? '' : v).trim().toLowerCase();

function feedToken(req) {
  return String(req.query?.token || req.headers['x-feed-token'] || '').trim();
}

function csvCell(v) {
  const t = String(v == null ? '' : v);
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

export default async function handler(req, res) {
  const expected = String(process.env.CHANNABLE_FEED_TOKEN || process.env.FEED_TOKEN || process.env.ADMIN_TOKEN || '').trim();
  if (!expected || feedToken(req) !== expected) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(401).send('Niet bevoegd. Geef een geldig ?token mee.');
  }

  try {
    const [cost, cache] = await Promise.all([
      readProductCost(),
      readProductsCache().catch(() => null)
    ]);
    const byBarcode = cache?.byBarcode || {};

    const cols = ['ean', 'sku', 'titel', 'merk', 'verkoopprijs', 'inkoopprijs', 'btw', 'marge', 'marge_pct'];
    const lines = [cols.join(',')];
    const seen = new Set();

    for (const [sku, c] of Object.entries(cost.bySku || {})) {
      const variant = byBarcode[lc(sku)] || null;
      /* Verkoopprijs incl-BTW: bij voorkeur de actuele Shopify-prijs, anders de
         gecalculeerde verkoopprijs uit de verkopen. */
      const sellIncl = variant && Number(variant.price) > 0 ? Number(variant.price) : Number(c.sell) || 0;
      const inkoop = Number(c.kostprijs) || 0;
      if (sellIncl <= 0 || inkoop <= 0) continue;

      const btw = Number(c.btw) || 21;
      const sellEx = sellIncl / (1 + btw / 100);
      const marge = round2(sellEx - inkoop);
      const margePct = sellEx > 0 ? round1((marge / sellEx) * 100) : 0;

      const ean = (variant && variant.barcode) ? variant.barcode : sku;
      if (seen.has(ean)) continue;
      seen.add(ean);

      lines.push([
        ean,
        (variant && (variant.articleNumber || variant.sku)) || sku,
        (variant && variant.title) || '',
        (variant && variant.vendor) || '',
        round2(sellIncl),
        round2(inkoop),
        btw,
        marge,
        margePct
      ].map(csvCell).join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-Rows', String(lines.length - 1));
    return res.status(200).send(lines.join('\n'));
  } catch (e) {
    console.error('[feeds/channable-margin]', e);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).send('Fout bij genereren feed: ' + (e.message || 'onbekend'));
  }
}
