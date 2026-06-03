import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { readJsonBlob, writeJsonBlob } from '../../lib/json-blob-store.js';

/**
 * GET /api/admin/retour-cohort?months=6
 *
 * ZUIVER retourpercentage per maand (cohort-basis): van de orders die in maand M
 * zijn GEPLAATST, welk % is (ooit) geretourneerd? De retour telt mee bij de
 * BESTELMAAND van de order — niet bij de datum waarop de refund verwerkt werd.
 *
 * Dat is het verschil met een periode-teller: een refund in juni voor een
 * mei-order telt hier bij MEI (de maand waarin besteld is).
 *
 * Bron: Shopify orders (created_at) inclusief geneste refunds. Eén scan levert
 * zowel de noemer (orders geplaatst) als de teller (orders met productretour).
 *
 * Telregels:
 *   - Geannuleerde orders (cancelled_at) tellen NIET mee (geen retour, geen verkoop).
 *   - Offline winkelbonnen (tag 'gents-offline') worden overgeslagen (zitten via SRS).
 *   - "Geretourneerd" = order heeft ≥1 refund mét refund_line_items (echt product
 *     terug), niet alleen een geldcorrectie/annulering.
 *
 * Response: { success, months, rows: [{ month, ordersPlaced, ordersReturned,
 *            returnedUnits, returnedAmount, returnPct }], totals, truncated }
 */

export const maxDuration = 300;

const DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '';
const TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || process.env.SHOPIFY_ADMIN_TOKEN || '';
const API = process.env.SHOPIFY_API_VERSION || '2025-01';

/* In-memory cache: historische maanden veranderen niet, dus hergebruik het
   scan-resultaat. ?refresh=1 forceert een verse scan. Default 6 uur. */
const COHORT_CACHE = new Map();
const COHORT_TTL_MS = Number(process.env.RETOUR_COHORT_CACHE_MS || 6 * 60 * 60 * 1000) || 6 * 60 * 60 * 1000;
/* Persistente snapshot (blob): overleeft koude starts; nachtelijke cron ververst (30u marge). */
const COHORT_BLOB_MAX_AGE_MS = Number(process.env.RETOUR_COHORT_BLOB_MAX_AGE_MS || 30 * 60 * 60 * 1000) || 30 * 60 * 60 * 1000;
const cohortBlobPath = (months, maxOrders) => `report-snapshots/retour-cohort-${months}-${maxOrders}.json`;

function monthKey(d) { return String(d || '').slice(0, 7); } // "YYYY-MM"
function num(v) { return Math.round(Number(v || 0) * 100) / 100; }

/* Shopify REST cursor-paginatie: de 'next'-URL staat in de Link-header. */
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
  if (requireAdmin(req, res)) return;

  if (!DOMAIN || !TOKEN) {
    return res.status(200).json({
      success: false, configured: false,
      message: 'SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_ACCESS_TOKEN ontbreekt in Vercel.'
    });
  }

  const months = Math.max(1, Math.min(24, Number(req.query.months || 6)));
  const maxOrders = Math.max(500, Math.min(30000, Number(req.query.maxOrders || 10000)));

  const refresh = ['1', 'true'].includes(String(req.query.refresh || ''));
  const cacheKey = `cohort:${months}:${maxOrders}`;
  const hit = COHORT_CACHE.get(cacheKey);
  if (!refresh && hit && Date.now() - hit.ts < COHORT_TTL_MS) {
    return res.status(200).json({ ...hit.payload, cached: true, cacheAgeMs: Date.now() - hit.ts });
  }
  if (!refresh) {
    try {
      const snap = await readJsonBlob(cohortBlobPath(months, maxOrders), null);
      if (snap && snap.payload && snap.savedAt && Date.now() - snap.savedAt < COHORT_BLOB_MAX_AGE_MS) {
        COHORT_CACHE.set(cacheKey, { ts: Date.now(), payload: snap.payload });
        return res.status(200).json({ ...snap.payload, cached: 'snapshot', cacheAgeMs: Date.now() - snap.savedAt });
      }
    } catch (_) { /* geen/oude snapshot → live berekenen */ }
  }

  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1); // 1e dag, N maanden terug

  /* Lege maand-buckets vooraf, zodat ook 0-maanden in de reeks staan */
  const buckets = new Map();
  for (let i = 0; i < months; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const k = monthKey(d.toISOString());
    buckets.set(k, { month: k, ordersPlaced: 0, ordersReturned: 0, returnedUnits: 0, returnedAmount: 0 });
  }

  try {
    let url = `https://${DOMAIN}/admin/api/${API}/orders.json?status=any&order=created_at+desc`
      + `&created_at_min=${start.toISOString()}&created_at_max=${now.toISOString()}`
      + `&limit=250&fields=id,created_at,cancelled_at,tags,refunds`;
    let scanned = 0, pages = 0, truncated = false;

    while (url && scanned < maxOrders) {
      const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': TOKEN, Accept: 'application/json' } });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`Shopify ${r.status} (${API}) — ${t.slice(0, 140)}`);
      }
      const d = await r.json();
      const orders = d.orders || [];
      if (!orders.length) break;

      for (const o of orders) {
        scanned++;
        const tags = String(o.tags || '').split(',').map(t => t.trim());
        if (tags.includes('gents-offline')) continue; // offline winkelbon → telt elders
        if (o.cancelled_at) continue;                  // annulering ≠ retour
        const b = buckets.get(monthKey(o.created_at));
        if (!b) continue;                              // buiten reeks
        b.ordersPlaced++;

        let units = 0, amount = 0;
        for (const rf of (o.refunds || [])) {
          for (const rli of (rf.refund_line_items || [])) {
            const q = Number(rli.quantity || 0);
            if (q > 0) {
              units += q;
              amount += Number(rli.subtotal != null ? rli.subtotal : (rli.subtotal_set?.shop_money?.amount || 0));
            }
          }
        }
        if (units > 0) { b.ordersReturned++; b.returnedUnits += units; b.returnedAmount += amount; }
      }

      pages++;
      const next = parseNextLink(r.headers.get('link'));
      if (next && scanned >= maxOrders) { truncated = true; break; }
      url = next;
    }

    const rows = [...buckets.values()].map(b => ({
      ...b,
      returnedAmount: num(b.returnedAmount),
      returnPct: b.ordersPlaced ? Number(((b.ordersReturned / b.ordersPlaced) * 100).toFixed(1)) : null
    }));
    const totPlaced = rows.reduce((s, b) => s + b.ordersPlaced, 0);
    const totReturned = rows.reduce((s, b) => s + b.ordersReturned, 0);
    const totAmount = num(rows.reduce((s, b) => s + b.returnedAmount, 0));

    const payload = {
      success: true,
      mode: 'cohort_by_order_month',
      note: 'Zuiver: retour telt bij de bestelmaand van de order (niet de refund-datum). Excl. geannuleerde orders en offline winkelbonnen.',
      months, scanned, pages, truncated,
      generatedAt: new Date().toISOString(),
      totals: {
        ordersPlaced: totPlaced,
        ordersReturned: totReturned,
        returnedAmount: totAmount,
        returnPct: totPlaced ? Number(((totReturned / totPlaced) * 100).toFixed(1)) : null
      },
      rows
    };
    COHORT_CACHE.set(cacheKey, { ts: Date.now(), payload });
    if (COHORT_CACHE.size > 50) COHORT_CACHE.delete(COHORT_CACHE.keys().next().value);
    writeJsonBlob(cohortBlobPath(months, maxOrders), { savedAt: Date.now(), payload }).catch(() => {});
    return res.status(200).json(payload);
  } catch (error) {
    console.error('[admin/retour-cohort]', error);
    return res.status(200).json({ success: false, configured: true, message: error.message || 'Cohort kon niet berekend worden.' });
  }
}
