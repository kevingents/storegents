import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { getSrsReturnLogs, saveSrsReturnLogs } from '../../../lib/srs-return-log-store.js';
import { findShopifyCustomerByEmail } from '../../../lib/shopify-gift-card-client.js';

/**
 * POST /api/admin/return-logs/bulk-link
 *
 * Processeert ALLE orphan retour-records in 1 run:
 *   - Voor elk: zoek Shopify-klant op email → orders ophalen → score matches
 *   - Confidence 'exact-amount' (=order total/subtotal matcht) → AUTO-KOPPEL
 *   - Lagere confidence → resultaat tonen voor handmatige review
 *   - Geen klant gevonden / geen email → markeer als 'cannot-auto-link'
 *
 * Body (optioneel):
 *   { dryRun: true }   → simuleert zonder write naar Blob (preview)
 *   { autoThreshold: 'exact-amount' | 'line-amount' }
 *     Welke confidence-level voor auto-write (default exact-amount)
 *
 * Response:
 *   { success, total, autoLinked, manualReview, noMatch, errors, results: [...] }
 */

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || process.env.SHOPIFY_ADMIN_TOKEN || '';
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';

function clean(v) { return String(v || '').trim(); }
function moneyEq(a, b) { return Math.abs(Number(a || 0) - Number(b || 0)) < 0.01; }

async function fetchShopifyOrdersForCustomer(customerId) {
  if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN || !customerId) return [];
  const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/customers/${encodeURIComponent(customerId)}/orders.json?status=any&limit=50&fields=id,name,order_number,created_at,total_price,subtotal_price,line_items,financial_status,fulfillment_status`;
  const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Shopify ${r.status}`);
  const d = await r.json();
  return d.orders || [];
}

function calcRefundAmount(log) {
  if (log.refundAmount && Number(log.refundAmount) > 0) return Number(log.refundAmount);
  const items = Array.isArray(log.items) ? log.items : [];
  return Math.round(items.reduce((s, it) => s + (Number(it.amount || it.price || 0) * Number(it.quantity || it.pieces || 1)), 0) * 100) / 100;
}

function scoreMatch(refundAmount, order, retourTime) {
  const orderTotal = Number(order.total_price || 0);
  const orderSubtotal = Number(order.subtotal_price || 0);
  const orderCreated = new Date(order.created_at).getTime();
  if (orderCreated > retourTime) return { confidence: 'none', score: 0 };
  if (moneyEq(refundAmount, orderTotal) || moneyEq(refundAmount, orderSubtotal)) return { confidence: 'exact-amount', score: 100 };
  const lineMatch = (order.line_items || []).some((li) => moneyEq(refundAmount, Number(li.price || 0) * Number(li.quantity || 1)));
  if (lineMatch) return { confidence: 'line-amount', score: 85 };
  return { confidence: 'customer-only', score: 30 };
}

const CONFIDENCE_RANK = { 'exact-amount': 3, 'line-amount': 2, 'customer-only': 1, 'none': 0 };
function meetsThreshold(confidence, threshold) {
  return CONFIDENCE_RANK[confidence] >= CONFIDENCE_RANK[threshold];
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });
  if (requireAdmin(req, res)) return;

  if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN) {
    return res.status(200).json({ success: false, configured: false, message: 'SHOPIFY_ADMIN_ACCESS_TOKEN / SHOPIFY_STORE_DOMAIN ontbreekt.' });
  }

  const body = req.body || {};
  const dryRun = Boolean(body.dryRun);
  const autoThreshold = clean(body.autoThreshold || 'exact-amount');

  const startedAt = Date.now();

  try {
    const allLogs = await getSrsReturnLogs();
    const orphans = allLogs.filter((l) => !clean(l.orderNr) && !clean(l.shopifyOrderId));

    const results = [];
    let autoLinked = 0;
    let manualReview = 0;
    let noMatch = 0;
    let errorCount = 0;

    /* Limiteer tot eerste 50 om Shopify niet te overbelasten */
    const toProcess = orphans.slice(0, 50);

    for (const log of toProcess) {
      const email = clean(log.customerEmail).toLowerCase();
      const result = {
        logId: log.id,
        customerEmail: email,
        customerName: clean(log.customerName),
        refundAmount: calcRefundAmount(log),
        retourCreatedAt: log.createdAt,
        status: 'no-match',
        action: 'none',
        confidence: null,
        match: null,
        error: null
      };

      if (!email) {
        result.status = 'cannot-auto-link';
        result.error = 'Geen klant-email';
        noMatch += 1;
        results.push(result);
        continue;
      }

      try {
        const customer = await findShopifyCustomerByEmail(email);
        if (!customer?.id) {
          result.status = 'cannot-auto-link';
          result.error = 'Geen Shopify-klant gevonden';
          noMatch += 1;
          results.push(result);
          continue;
        }

        const orders = await fetchShopifyOrdersForCustomer(customer.id);
        const retourTime = log.createdAt ? new Date(log.createdAt).getTime() : Date.now();
        const refundAmount = result.refundAmount;

        const scored = orders.map((o) => ({
          orderName: clean(o.name).replace(/^#/, ''),
          orderId: String(o.id),
          total: Number(o.total_price || 0),
          createdAt: o.created_at,
          ...scoreMatch(refundAmount, o, retourTime)
        }))
          .filter((s) => s.confidence !== 'none')
          .sort((a, b) => b.score - a.score);

        if (!scored.length) {
          result.status = 'no-match';
          result.error = 'Geen matchende order gevonden';
          noMatch += 1;
          results.push(result);
          continue;
        }

        const best = scored[0];
        result.match = best;
        result.confidence = best.confidence;

        if (meetsThreshold(best.confidence, autoThreshold)) {
          /* Auto-koppel */
          if (!dryRun) {
            const idx = allLogs.findIndex((l) => String(l.id) === String(log.id));
            if (idx !== -1) {
              allLogs[idx] = {
                ...allLogs[idx],
                orderNr: best.orderName,
                shopifyOrderId: best.orderId,
                _lastManualUpdate: {
                  updatedAt: new Date().toISOString(),
                  updatedBy: 'bulk-auto-link',
                  note: `Auto-koppel via bulk-link (confidence: ${best.confidence}, score: ${best.score})`
                }
              };
            }
          }
          result.status = 'auto-linked';
          result.action = dryRun ? 'would-link' : 'linked';
          autoLinked += 1;
        } else {
          result.status = 'needs-review';
          result.action = 'manual-review';
          manualReview += 1;
        }
      } catch (error) {
        result.status = 'error';
        result.error = error.message;
        errorCount += 1;
      }
      results.push(result);
    }

    /* Schrijf bijgewerkte logs weg (in 1 keer) */
    if (!dryRun && autoLinked > 0) {
      await saveSrsReturnLogs(allLogs);
    }

    return res.status(200).json({
      success: true,
      dryRun,
      autoThreshold,
      total: orphans.length,
      processed: toProcess.length,
      autoLinked,
      manualReview,
      noMatch,
      errors: errorCount,
      elapsedMs: Date.now() - startedAt,
      results,
      hint: orphans.length > 50 ? `Slechts eerste 50 verwerkt — herhaal voor de resterende ${orphans.length - 50}.` : null
    });
  } catch (error) {
    console.error('[return-logs/bulk-link] error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Bulk-link mislukt.' });
  }
}
