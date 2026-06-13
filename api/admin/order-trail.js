import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getFulfillments } from '../../lib/srs-weborders-message-client.js';
import { stockBySkus } from '../../lib/sku-stock.js';

/**
 * GET /api/admin/order-trail?orderNr=12345
 *
 * Verzend-route van een weborder: langs welke winkels 'ie is gegaan. Via SRS
 * GetFulfillments (per order) — elke branch met z'n status:
 *   cancelled = winkel kon niet leveren → doorgestuurd
 *   accepted/open = in behandeling
 *   completed = verzonden
 * Zo zie je dat een order bv. winkel A (niet leverbaar) → winkel B → verzonden ging.
 */

export const config = { maxDuration: 30 };

function clean(v) { return String(v == null ? '' : v).trim(); }

function isAuthorized(req) {
  const adminToken = clean(process.env.ADMIN_TOKEN);
  if (!adminToken) return false;
  const token = clean(
    req.headers['x-admin-token'] || req.headers['x-admin-pin'] || req.headers.authorization ||
    req.query?.adminToken || req.query?.admin_token || ''
  ).replace(/^Bearer\s+/i, '');
  return token === adminToken;
}

const STATUS_LABEL = {
  cancelled: 'Niet leverbaar — doorgestuurd',
  canceled: 'Niet leverbaar — doorgestuurd',
  accepted: 'In behandeling',
  open: 'In behandeling',
  pending: 'In behandeling',
  completed: 'Verzonden',
  shipped: 'Verzonden',
  fulfilled: 'Verzonden',
  processed: 'Verzonden',
};

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const orderNr = clean(req.query.orderNr || req.query.order || req.query.id).replace(/^#/, '');
  if (!orderNr) return res.status(400).json({ success: false, message: 'orderNr is verplicht.' });

  try {
    const { fulfillments } = await getFulfillments({ orderNr });

    const list = (fulfillments || []).map((f) => {
      const status = clean(f.status).toLowerCase() || 'open';
      return {
        store: f.fulfilmentStore || f.fulfillmentStore || `Branch ${f.fulfilmentBranchId || f.branchId || '?'}`,
        branchId: clean(f.fulfilmentBranchId || f.branchId),
        status,
        statusLabel: STATUS_LABEL[status] || f.status || '—',
        unavailable: status === 'cancelled' || status === 'canceled',
        sku: clean(f.sku),
        orderLineNr: clean(f.orderLineNr),
        at: clean(f.updatedAt || f.createdAt),
        fulfillmentId: clean(f.fulfillmentId),
      };
    }).sort((a, b) => String(a.at).localeCompare(String(b.at)));

    /* Winkel-keten in volgorde van eerste voorkomen. */
    const seen = new Set();
    const storeChain = [];
    for (const f of list) {
      if (f.store && !seen.has(f.store)) { seen.add(f.store); storeChain.push(f.store); }
    }
    /* Huidige locatie = laatste niet-geannuleerde, anders de laatste. */
    const active = list.filter((f) => !f.unavailable);
    const current = active.length ? active[active.length - 1] : (list[list.length - 1] || null);

    /* Voorraad per winkel voor de artikelen van deze order (SRS-snapshots).
       Zo zie je naar welke winkel je 'm kunt sturen die 'm écht heeft, i.p.v.
       de bounce. Faalt dit, dan tonen we de route gewoon zonder voorraad. */
    const skus = [...new Set(list.map((f) => f.sku).filter(Boolean))];
    let stockBySku = {};
    try {
      stockBySku = await stockBySkus(skus);
    } catch (e) {
      console.error('[admin/order-trail] stock lookup failed', e?.message || e);
    }

    return res.status(200).json({
      success: true,
      orderNr,
      count: list.length,
      hops: storeChain.length,
      storeChain,
      current,
      fulfillments: list,
      skus,
      stockBySku,
    });
  } catch (error) {
    console.error('[admin/order-trail]', error);
    return res.status(200).json({ success: false, message: error.message || 'Verzend-route kon niet worden opgehaald.' });
  }
}
