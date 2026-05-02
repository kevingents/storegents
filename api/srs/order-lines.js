import { getFulfillments, getWebordersWithDetails } from '../../lib/srs-weborders-message-client.js';
import { getStoreNameByBranchId } from '../../lib/branch-metrics.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function cleanOrderNr(value) {
  return String(value || '').replace(/^#/, '').trim();
}

function cleanStatus(value) {
  return String(value || '').toLowerCase().replace(/[_-]+/g, ' ').trim();
}

function statusLabel(value) {
  const status = cleanStatus(value);

  if (status === 'processed') return 'Geleverd aan klant';
  if (status === 'unavailable') return 'Niet leverbaar';
  if (status === 'cancelled' || status === 'canceled') return 'Geannuleerd';
  if (status === 'accepted') return 'Aangemeld';
  if (status === 'pending') return 'In behandeling';
  if (status === 'available') return 'Beschikbaar';
  if (status === 'offered') return 'Aangeboden';
  if (status === 'dropshipment request') return 'Dropshipment aanvraag';

  return value || 'Onbekend';
}

function lineType(value) {
  const status = cleanStatus(value);

  if (status === 'unavailable') return 'niet_leverbaar';
  if (status === 'cancelled' || status === 'canceled') return 'geannuleerd';
  if (status === 'processed') return 'geleverd';
  if (status === 'accepted' || status === 'pending' || status === 'available' || status === 'offered') return 'open';

  return 'onbekend';
}

function branchLabel(branchId) {
  const id = String(branchId || '').trim();

  if (!id) return 'SRS zonder filiaal';

  const store = getStoreNameByBranchId(id);

  if (store && !String(store).toLowerCase().startsWith('filiaal ')) {
    return store;
  }

  return store || `Filiaal ${id}`;
}

function getDetailLineForFulfillment(detail, fulfillment) {
  const sku = String(fulfillment.sku || '').trim();
  const orderLineNr = String(fulfillment.orderLineNr || '').trim();
  const fulfillmentId = String(fulfillment.fulfillmentId || '').trim();

  const lines = Array.isArray(detail?.items) ? detail.items : [];

  return (
    lines.find((line) => orderLineNr && String(line.orderLineNr || '').trim() === orderLineNr) ||
    lines.find((line) => sku && String(line.sku || line.barcode || '').trim() === sku) ||
    lines.find((line) => fulfillmentId && String(line.fulfillmentId || '').trim() === fulfillmentId) ||
    null
  );
}

function parseNumber(value, fallback = 0) {
  const number = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(number) ? number : fallback;
}

function money(value) {
  const number = Number(value || 0);

  return number.toLocaleString('nl-NL', {
    style: 'currency',
    currency: 'EUR'
  });
}

function buildSummary(lines) {
  const byBranch = new Map();

  for (const line of lines) {
    const key = line.branchId || 'zonder-filiaal';

    if (!byBranch.has(key)) {
      byBranch.set(key, {
        branchId: line.branchId,
        store: line.store,
        totalLines: 0,
        openLines: 0,
        processedLines: 0,
        unavailableLines: 0,
        cancelledLines: 0,
        amount: 0,
        statuses: {}
      });
    }

    const row = byBranch.get(key);
    const type = line.lineType;

    row.totalLines += 1;
    row.amount += Number(line.amount || 0);

    if (type === 'open') row.openLines += 1;
    if (type === 'geleverd') row.processedLines += 1;
    if (type === 'niet_leverbaar') row.unavailableLines += 1;
    if (type === 'geannuleerd') row.cancelledLines += 1;

    row.statuses[line.status] = (row.statuses[line.status] || 0) + 1;
  }

  return Array.from(byBranch.values()).sort((a, b) => {
    if (b.unavailableLines !== a.unavailableLines) return b.unavailableLines - a.unavailableLines;
    if (b.cancelledLines !== a.cancelledLines) return b.cancelledLines - a.cancelledLines;
    if (b.openLines !== a.openLines) return b.openLines - a.openLines;
    return String(a.store).localeCompare(String(b.store), 'nl');
  });
}

function buildLines({ orderNr, fulfillments, detail }) {
  return (fulfillments || []).map((fulfillment, index) => {
    const detailLine = getDetailLineForFulfillment(detail, fulfillment);

    const branchId = String(
      fulfillment.branchId ||
      fulfillment.fulfillmentBranchId ||
      fulfillment.fulfilmentBranchId ||
      ''
    ).trim();

    const sku = String(fulfillment.sku || detailLine?.sku || detailLine?.barcode || '').trim();
    const quantity = parseNumber(detailLine?.quantity || detailLine?.pieces || fulfillment.quantity || fulfillment.pieces, 1);
    const unitPrice = parseNumber(detailLine?.price || fulfillment.productPrice || fulfillment.price, 0);
    const amount = Math.max(0, quantity * unitPrice);
    const status = String(fulfillment.status || '').trim();

    return {
      index: index + 1,
      orderNr,
      fulfillmentId: String(fulfillment.fulfillmentId || fulfillment.id || '').trim(),
      orderLineNr: String(fulfillment.orderLineNr || detailLine?.orderLineNr || '').trim(),
      sku,
      barcode: String(detailLine?.barcode || sku || '').trim(),
      title: String(
        detailLine?.title ||
        detailLine?.productName ||
        fulfillment.productName ||
        sku ||
        'Onbekend artikel'
      ).trim(),
      color: String(detailLine?.color || detailLine?.kleur || fulfillment.color || fulfillment.kleur || '').trim(),
      size: String(detailLine?.size || detailLine?.maat || fulfillment.size || fulfillment.maat || '').trim(),
      quantity,
      unitPrice,
      amount,
      amountLabel: money(amount),
      status,
      statusLabel: statusLabel(status),
      lineType: lineType(status),
      branchId,
      store: branchLabel(branchId),
      multipleFulfillmentsOpen: String(fulfillment.multipleFulfillmentsOpen || '').toLowerCase() === 'true',
      createdAt: fulfillment.createdAt || '',
      updatedAt: fulfillment.updatedAt || '',
      raw: {
        fulfillment,
        detailLine
      }
    };
  });
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      message: 'Alleen GET is toegestaan.'
    });
  }

  const orderNr = cleanOrderNr(req.query.orderNr || req.query.order || req.query.weborder || '');

  if (!orderNr) {
    return res.status(400).json({
      success: false,
      message: 'SRS OrderNr ontbreekt. Gebruik bijvoorbeeld ?orderNr=32547.'
    });
  }

  try {
    const [fulfillmentResult, detailResult] = await Promise.allSettled([
      getFulfillments({ orderNr }),
      getWebordersWithDetails(orderNr)
    ]);

    const fulfillments =
      fulfillmentResult.status === 'fulfilled'
        ? fulfillmentResult.value.fulfillments || []
        : [];

    const detail =
      detailResult.status === 'fulfilled'
        ? detailResult.value.detailsByOrder?.get(orderNr) || null
        : null;

    const lines = buildLines({
      orderNr,
      fulfillments,
      detail
    });

    const unavailableLines = lines.filter((line) => line.lineType === 'niet_leverbaar');
    const cancelledLines = lines.filter((line) => line.lineType === 'geannuleerd');
    const processedLines = lines.filter((line) => line.lineType === 'geleverd');
    const openLines = lines.filter((line) => line.lineType === 'open');

    return res.status(200).json({
      success: true,
      source: 'srs_get_fulfillments_order_lines',
      orderNr,
      customer: detail
        ? {
            name: detail.customerName || '',
            email: detail.customerEmail || '',
            phone: detail.customerPhone || '',
            deliveryStreet: detail.deliveryStreet || '',
            deliveryHouseNumber: detail.deliveryHouseNumber || '',
            deliveryPostalCode: detail.deliveryPostalCode || '',
            deliveryCity: detail.deliveryCity || '',
            deliveryCountry: detail.deliveryCountry || ''
          }
        : null,
      counts: {
        total: lines.length,
        open: openLines.length,
        processed: processedLines.length,
        unavailable: unavailableLines.length,
        cancelled: cancelledLines.length,
        withoutBranch: lines.filter((line) => !line.branchId).length
      },
      amount: {
        total: lines.reduce((sum, line) => sum + Number(line.amount || 0), 0),
        unavailable: unavailableLines.reduce((sum, line) => sum + Number(line.amount || 0), 0),
        cancelled: cancelledLines.reduce((sum, line) => sum + Number(line.amount || 0), 0)
      },
      summaryByBranch: buildSummary(lines),
      lines,
      warnings: [
        ...lines
          .filter((line) => !line.branchId)
          .map((line) => `Leveropdracht ${line.fulfillmentId || line.sku} heeft geen branchId vanuit SRS.`)
      ],
      errors: {
        fulfillments:
          fulfillmentResult.status === 'rejected'
            ? fulfillmentResult.reason?.message || 'GetFulfillments mislukt.'
            : '',
        details:
          detailResult.status === 'rejected'
            ? detailResult.reason?.message || 'GetWebordersWithDetails mislukt.'
            : ''
      }
    });
  } catch (error) {
    console.error('SRS order lines error:', error);

    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'SRS orderregels konden niet worden opgehaald.',
      details: error.fault || error.data || null
    });
  }
}
