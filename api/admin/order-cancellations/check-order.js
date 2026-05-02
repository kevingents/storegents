import { getFulfillments, getWebordersWithDetails } from '../../../lib/srs-weborders-message-client.js';
import { addOrderCancellation } from '../../../lib/order-cancellation-store.js';
import { getStoreNameByBranchId } from '../../../lib/branch-metrics.js';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
}

function isAdmin(req) {
  if (!ADMIN_TOKEN) return true;
  const token = String(req.headers['x-admin-token'] || req.query.adminToken || '').trim();
  return token === ADMIN_TOKEN;
}

function cleanOrder(value) {
  return String(value || '').trim().replace(/^#/, '');
}

function cleanStatus(value) {
  return String(value || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isCancellationStatus(value) {
  const status = cleanStatus(value);
  return ['unavailable', 'niet leverbaar', 'not available', 'cancelled', 'canceled', 'geannuleerd', 'annulled'].includes(status);
}

function reasonFromStatus(value) {
  const status = cleanStatus(value);
  if (['unavailable', 'niet leverbaar', 'not available'].includes(status)) return 'Niet leverbaar volgens SRS';
  if (['cancelled', 'canceled', 'geannuleerd', 'annulled'].includes(status)) return 'Geannuleerd volgens SRS';
  return 'SRS annulering / niet leverbaar';
}

function parseNumber(value, fallback = 0) {
  const n = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

function findDetailLine(details, fulfillment) {
  const orderLineNr = String(fulfillment.orderLineNr || fulfillment.OrderLineNr || fulfillment.order_line_nr || '').trim();
  const sku = String(fulfillment.sku || fulfillment.Sku || '').trim();
  const barcode = String(fulfillment.barcode || fulfillment.ean || fulfillment.Sku || '').trim();

  const allLines = [];
  if (Array.isArray(details?.lines)) allLines.push(...details.lines);
  if (Array.isArray(details?.items)) allLines.push(...details.items);
  if (details?.detailsByOrder instanceof Map) {
    for (const value of details.detailsByOrder.values()) {
      if (Array.isArray(value?.lines)) allLines.push(...value.lines);
      if (Array.isArray(value?.items)) allLines.push(...value.items);
    }
  }

  return allLines.find((line) => {
    return (
      (orderLineNr && String(line.orderLineNr || line.OrderLineNr || line.lineNr || '').trim() === orderLineNr) ||
      (sku && String(line.sku || line.Sku || '').trim() === sku) ||
      (barcode && String(line.barcode || line.ean || line.Sku || '').trim() === barcode)
    );
  }) || null;
}

function normalizeFulfillment(fulfillment, detailLine, storeFallback) {
  const status = fulfillment.status || fulfillment.Status || fulfillment.srsStatus || fulfillment.fulfillmentStatus || fulfillment.FulfillmentStatus || '';
  const branchId = String(fulfillment.branchId || fulfillment.BranchId || fulfillment.filiaal || fulfillment.Filiaal || fulfillment.currentBranch || '').trim();
  const store = fulfillment.store || fulfillment.storeName || getStoreNameByBranchId(branchId) || storeFallback || '';
  const quantity = parseNumber(fulfillment.quantity || fulfillment.aantal || fulfillment.Aantal || detailLine?.quantity || detailLine?.aantal, 1);
  const amount = parseNumber(fulfillment.amount || fulfillment.price || detailLine?.amount || detailLine?.price || detailLine?.linePrice, 0);

  const item = {
    fulfillmentId: String(fulfillment.fulfillmentId || fulfillment.LeveropdrachtId || fulfillment.id || '').trim(),
    orderLineNr: String(fulfillment.orderLineNr || fulfillment.OrderLineNr || detailLine?.orderLineNr || '').trim(),
    articleNumber: fulfillment.articleNumber || fulfillment.artikelnummer || detailLine?.articleNumber || detailLine?.artikelnummer || fulfillment.sku || '',
    articleId: fulfillment.articleId || fulfillment.artikelId || detailLine?.articleId || detailLine?.artikelId || '',
    sku: fulfillment.sku || fulfillment.Sku || detailLine?.sku || '',
    barcode: fulfillment.barcode || fulfillment.ean || detailLine?.barcode || detailLine?.ean || fulfillment.Sku || '',
    title: fulfillment.productName || fulfillment.title || detailLine?.title || detailLine?.productName || fulfillment.sku || '',
    color: fulfillment.color || fulfillment.kleur || detailLine?.color || detailLine?.kleur || '',
    size: fulfillment.size || fulfillment.maat || detailLine?.size || detailLine?.maat || '',
    quantity,
    amount,
    srsStatus: status,
    branchId
  };

  return { store, status, item, amount };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (!isAdmin(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    const orderNr = cleanOrder(req.query.order || req.query.orderNr || req.query.orderNumber);
    const dryRun = String(req.query.dryRun || 'false').toLowerCase() === 'true';
    const storeFallback = String(req.query.store || '').trim();

    if (!orderNr) return res.status(400).json({ success: false, message: 'Ordernummer ontbreekt.' });

    const fulfillmentsResult = await getFulfillments({ orderNr });
    const fulfillments = fulfillmentsResult.fulfillments || fulfillmentsResult.items || [];

    let details = null;
    try { details = await getWebordersWithDetails(orderNr); } catch (error) { details = { error: error.message }; }

    const cancellationFulfillments = fulfillments.filter((item) => isCancellationStatus(item.status || item.Status || item.srsStatus || item.fulfillmentStatus || item.FulfillmentStatus));
    const records = [];
    let created = 0;
    let duplicates = 0;

    for (const fulfillment of cancellationFulfillments) {
      const detailLine = findDetailLine(details, fulfillment);
      const normalized = normalizeFulfillment(fulfillment, detailLine, storeFallback);
      const reason = reasonFromStatus(normalized.status);
      const sourceDate = fulfillment.date || fulfillment.createdAt || fulfillment.updatedAt || fulfillment.timestamp || new Date().toISOString();
      const payload = {
        idempotencyKey: [
          'srs-check-order-line',
          orderNr,
          normalized.item.fulfillmentId,
          normalized.item.orderLineNr,
          normalized.item.articleNumber,
          normalized.item.barcode,
          cleanStatus(normalized.status)
        ].join('::'),
        createdAt: sourceDate,
        updatedAt: new Date().toISOString(),
        month: new Date(sourceDate).toString() === 'Invalid Date' ? new Date().toISOString().slice(0, 7) : new Date(sourceDate).toISOString().slice(0, 7),
        store: normalized.store,
        employeeName: 'SRS ordercontrole administratie',
        orderNr,
        type: 'partial',
        reason,
        customerEmail: details?.customerEmail || '',
        customerName: details?.customerName || fulfillment.customerName || '',
        amount: normalized.amount,
        currency: 'EUR',
        items: [normalized.item],
        status: 'completed',
        srsStatus: cleanStatus(normalized.status).includes('cancel') || cleanStatus(normalized.status).includes('geannuleerd') ? 'cancelled_in_srs' : 'unavailable_in_srs',
        refundStatus: 'pending',
        mailStatus: 'pending',
        source: 'srs_check_order_fulfillment_lines',
        srsResult: {
          detectedStatus: normalized.status,
          fulfillmentId: normalized.item.fulfillmentId,
          orderLineNr: normalized.item.orderLineNr,
          checkedAt: new Date().toISOString()
        }
      };

      records.push(payload);

      if (!dryRun) {
        const result = await addOrderCancellation(payload);
        if (result.duplicate) duplicates += 1;
        else created += 1;
      }
    }

    return res.status(200).json({
      success: true,
      orderNr,
      dryRun,
      scanned: fulfillments.length,
      found: cancellationFulfillments.length,
      created: dryRun ? 0 : created,
      duplicates: dryRun ? 0 : duplicates,
      rows: records,
      message: dryRun
        ? `Dry-run klaar. ${records.length} niet-leverbare/geannuleerde orderregel(s) gevonden voor order ${orderNr}.`
        : `Order ${orderNr} gecontroleerd. ${created} nieuw, ${duplicates} al bekend.`
    });
  } catch (error) {
    console.error('Check order cancellations error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Order kon niet worden gecontroleerd.' });
  }
}
