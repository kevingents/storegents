import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { getTransactions } from '../../../lib/srs-customers-client.js';
import { getStoreNameByBranchId } from '../../../lib/branch-metrics.js';
import {
  findShopifyCustomerByEmail,
  isTransactionAlreadySynced,
  createOfflineOrderInShopify
} from '../../../lib/shopify-offline-sync.js';

/**
 * POST /api/admin/customer/sync-offline-purchases
 *
 * Sync SRS offline transacties van een klant naar Shopify als Orders.
 *
 * Body:
 *   {
 *     customerId,       — SRS klantnummer (verplicht)
 *     email,            — klant-email voor Shopify lookup (verplicht)
 *     from,             — ISO datum (default: 90 dagen terug)
 *     until,            — ISO datum (default: nu)
 *     dryRun?: boolean  — geen orders aanmaken, alleen rapporteren
 *     maxOrders?: number — max te creëren orders (default 20)
 *   }
 *
 * Response:
 *   {
 *     success, customerId, email,
 *     shopifyCustomer: { id, totalSpent, orderCount },
 *     summary: { totalTransactions, alreadySynced, newSynced, skipped, errors },
 *     created: [{ srsReceipt, shopifyOrderName, total, store, dateTime }],
 *     errors: [{ srsReceipt, message }]
 *   }
 */

function clean(v) { return String(v || '').trim(); }
function isoDateDaysAgo(d) {
  const dt = new Date();
  dt.setDate(dt.getDate() - Number(d));
  return dt.toISOString();
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });

  /* PAUSE: offline-sync is uit via env. Zet OFFLINE_SYNC_PAUSED=1 in Vercel
     om alle calls te blokkeren (handmatige UI én eventuele cron). Met dezelfde
     env naar leeg/0/false zet je de sync weer aan zonder code-deploy. */
  const paused = ['1', 'true', 'yes', 'on'].includes(String(process.env.OFFLINE_SYNC_PAUSED || '').trim().toLowerCase());
  if (paused) {
    return res.status(503).json({
      success: false,
      paused: true,
      message: 'Offline order-sync is gepauzeerd. Zet env OFFLINE_SYNC_PAUSED=0 in Vercel om te hervatten.'
    });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const customerId = clean(body.customerId);
  const email = clean(body.email);
  const from = clean(body.from) || isoDateDaysAgo(90);
  const until = clean(body.until) || new Date().toISOString();
  const dryRun = body.dryRun === true || String(body.dryRun) === 'true';
  const maxOrders = Math.max(1, Math.min(100, Number(body.maxOrders || 20)));

  if (!customerId) return res.status(400).json({ success: false, message: 'customerId is verplicht.' });
  if (!email) return res.status(400).json({ success: false, message: 'email is verplicht (voor Shopify lookup).' });

  const startedAt = Date.now();

  try {
    /* Stap 1: lookup Shopify klant */
    const shopifyCustomer = await findShopifyCustomerByEmail(email);
    if (!shopifyCustomer) {
      return res.status(404).json({
        success: false,
        customerId, email,
        message: `Geen Shopify klant gevonden voor email ${email}. Maak eerst een Shopify klant aan (handmatig of via klantkaart-aanmaken).`,
        shopifyCustomer: null
      });
    }

    /* Stap 2: haal SRS transacties op */
    const { transactions = [] } = await getTransactions({
      customerId,
      from: from.length === 10 ? `${from}T00:00:00` : from,
      until: until.length === 10 ? `${until}T23:59:59` : until
    });

    /* Filter alleen transacties met items + positief bedrag (geen retouren) */
    const validTransactions = transactions.filter((t) => {
      if (!Array.isArray(t.items) || !t.items.length) return false;
      const total = t.items.reduce((s, i) => s + Number(i.charged || 0), 0);
      return total > 0;
    });

    if (!validTransactions.length) {
      return res.status(200).json({
        success: true,
        customerId, email,
        shopifyCustomer: {
          id: shopifyCustomer.id,
          totalSpent: shopifyCustomer.totalSpent,
          orderCount: shopifyCustomer.orderCount
        },
        summary: { totalTransactions: 0, alreadySynced: 0, newSynced: 0, skipped: 0, errors: 0 },
        created: [],
        errors: [],
        message: 'Geen offline transacties gevonden in deze periode.'
      });
    }

    /* Stap 3: per transactie checken of al synced; zo niet → aanmaken */
    const created = [];
    const errors = [];
    let alreadySynced = 0;
    let skipped = 0;

    for (const tx of validTransactions) {
      if (created.length >= maxOrders) {
        skipped += 1;
        continue;
      }
      const branchId = clean(tx.branchId);
      const receiptNr = clean(tx.receiptNr);
      if (!branchId || !receiptNr) {
        skipped += 1;
        continue;
      }

      try {
        /* Idempotency check */
        const existing = await isTransactionAlreadySynced({ branchId, receiptNr });
        if (existing) {
          alreadySynced += 1;
          continue;
        }

        const storeName = getStoreNameByBranchId(branchId) || `Branch ${branchId}`;

        if (dryRun) {
          created.push({
            srsReceipt: receiptNr,
            shopifyOrderName: '(dry-run)',
            total: tx.items.reduce((s, i) => s + Number(i.charged || 0), 0),
            store: storeName,
            dateTime: tx.dateTime,
            itemCount: tx.items.length
          });
          continue;
        }

        const order = await createOfflineOrderInShopify({
          shopifyCustomerId: shopifyCustomer.id,
          transaction: tx,
          storeName
        });

        created.push({
          srsReceipt: receiptNr,
          shopifyOrderName: order.name,
          shopifyOrderId: order.id,
          total: order.total,
          store: storeName,
          dateTime: tx.dateTime,
          itemCount: tx.items.length
        });
      } catch (err) {
        errors.push({
          srsReceipt: receiptNr,
          branchId,
          message: err.message || 'Onbekende fout'
        });
      }
    }

    return res.status(200).json({
      success: true,
      customerId,
      email,
      dryRun,
      shopifyCustomer: {
        id: shopifyCustomer.id,
        totalSpent: shopifyCustomer.totalSpent,
        orderCount: shopifyCustomer.orderCount
      },
      summary: {
        totalTransactions: validTransactions.length,
        alreadySynced,
        newSynced: created.length,
        skipped,
        errors: errors.length
      },
      created,
      errors,
      runtimeMs: Date.now() - startedAt
    });
  } catch (error) {
    console.error('[admin/customer/sync-offline-purchases] error:', error);
    return res.status(500).json({
      success: false,
      customerId, email,
      message: error.message || 'Sync mislukt.',
      runtimeMs: Date.now() - startedAt
    });
  }
}
