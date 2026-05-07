import { getOrderCancellations, updateOrderCancellation } from './order-cancellation-store.js';
import { cancelFulfillment } from './srs-weborders-cancel-client.js';
import { refundUnavailableOrderLine } from './shopify-unavailable-refund-client.js';

function clean(value) {
  return String(value || '').trim();
}

function normalizeStatus(value) {
  return clean(value).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function baseCancellationId(value) {
  return clean(value).split('::')[0] || clean(value);
}

function sameUnavailableRowId(row = {}, id = '') {
  const cleanId = clean(id);
  const baseId = baseCancellationId(cleanId);

  return row.id === cleanId ||
    row.cancellationId === cleanId ||
    row.cancellationId === baseId ||
    cleanId.startsWith(`${row.cancellationId}::`);
}

function isUnavailableLineStatus(value) {
  const status = normalizeStatus(value);
  return status.includes('niet leverbaar') ||
    status.includes('unavailable') ||
    status.includes('not available') ||
    status.includes('srs global get fulfillments unavailable') ||
    status.includes('srs global fulfillments unavailable');
}

function isUnavailableLike(row = {}) {
  const value = normalizeStatus([
    row.srsLineStatus,
    row.srsStatus,
    row.status,
    row.reason,
    row.srsSourceStatus,
    row.source,
    row.originalCancellation?.source,
    row.originalCancellation?.srsStatus,
    row.originalCancellation?.srsSourceStatus,
    row.originalCancellation?.reason
  ].filter(Boolean).join(' '));

  return isUnavailableLineStatus(value);
}

function lineRowsForCancellation(cancellation = {}) {
  const lines = Array.isArray(cancellation.items) && cancellation.items.length ? cancellation.items : [{}];

  return lines.map((line, index) => {
    const source = clean(cancellation.source || '');
    const srsLineStatus = clean(
      line.srsStatus ||
      line.status ||
      cancellation.srsSourceStatus ||
      cancellation.srsStatus ||
      cancellation.reason ||
      ''
    );

    const srsCancelStatus = clean(
      cancellation.srsCancelStatus ||
      cancellation.srsCancelResult?.status ||
      ''
    ) || (
      normalizeStatus(cancellation.srsStatus).includes('cancelled in srs') ||
      normalizeStatus(cancellation.srsStatus).includes('cancelled_in_srs') ||
      normalizeStatus(cancellation.srsStatus).includes('cancelled')
        ? 'cancelled_in_srs'
        : 'pending'
    );

    return {
      id: [cancellation.id, line.fulfillmentId || '', line.orderLineNr || '', line.sku || line.barcode || '', index].join('::'),
      cancellationId: cancellation.id,
      lineIndex: index,
      idempotencyKey: cancellation.idempotencyKey || '',
      createdAt: cancellation.createdAt || '',
      updatedAt: cancellation.updatedAt || '',
      month: cancellation.month || '',
      store: clean(cancellation.store || line.lastResponsibleStore || 'Onbekend'),
      orderNr: cancellation.orderNr || '',
      employeeName: cancellation.employeeName || '',
      customerName: cancellation.customerName || '',
      customerEmail: cancellation.customerEmail || '',
      reason: cancellation.reason || 'Niet leverbaar',
      currency: cancellation.currency || 'EUR',
      amount: Number(line.amount || cancellation.amount || 0),
      quantity: Number(line.quantity || line.pieces || 1),
      fulfillmentId: clean(line.fulfillmentId),
      orderLineNr: clean(line.orderLineNr),
      articleNumber: clean(line.articleNumber || line.artikelnummer || line.sku || ''),
      articleId: clean(line.articleId || line.artikelId || ''),
      sku: clean(line.sku || line.barcode || ''),
      barcode: clean(line.barcode || line.sku || ''),
      title: clean(line.title || line.productName || line.sku || line.barcode || ''),
      color: clean(line.color || line.kleur || ''),
      size: clean(line.size || line.maat || ''),
      branchId: clean(line.branchId || cancellation.branchId || ''),
      currentBranch: clean(line.currentBranch || line.huidigFiliaal || line.branchId || ''),
      originBranch: clean(line.originBranch || line.herkomstFiliaal || cancellation.store || ''),
      lastResponsibleStore: clean(line.lastResponsibleStore || cancellation.store || 'Onbekend'),
      srsUnavailableStore: clean(line.srsUnavailableStore || ''),
      srsLineStatus,
      srsStatus: clean(cancellation.srsStatus || line.srsStatus || cancellation.srsSourceStatus || ''),
      srsSourceStatus: clean(cancellation.srsSourceStatus || ''),
      source,
      status: isUnavailableLineStatus(source) || isUnavailableLineStatus(srsLineStatus) ? 'open' : (cancellation.status || 'open'),
      mailStatus: cancellation.mailStatus || 'shopify_refund_mail',
      refundStatus: cancellation.refundStatus || 'pending',
      srsCancelStatus,
      stockReturnStatus: cancellation.stockReturnStatus || 'skipped_no_stock_return',
      processedAt: cancellation.processedAt || '',
      processedBy: cancellation.processedBy || '',
      processAttempts: Number(cancellation.processAttempts || 0),
      error: cancellation.error || '',
      problemType: 'niet_leverbaar',
      originalCancellation: cancellation
    };
  }).filter(isUnavailableLike);
}

function isCompleted(row) {
  const refundDone = normalizeStatus(row.refundStatus).includes('refunded') ||
    normalizeStatus(row.refundStatus).includes('already');
  const srsCancelDone = normalizeStatus(row.srsCancelStatus).includes('cancel') ||
    normalizeStatus(row.srsStatus).includes('cancelled in srs') ||
    normalizeStatus(row.srsStatus).includes('cancelled_in_srs');

  return refundDone && srsCancelDone;
}

export async function listUnavailableOrderLines({
  store = '',
  status = 'open',
  dateFrom = '',
  dateTo = '',
  query = ''
} = {}) {
  const cancellations = await getOrderCancellations();
  let rows = cancellations.flatMap(lineRowsForCancellation);

  const storeFilter = clean(store);
  if (storeFilter && !['all', 'alle', '*'].includes(storeFilter.toLowerCase())) {
    rows = rows.filter((row) => row.store === storeFilter || row.lastResponsibleStore === storeFilter);
  }

  const from = dateFrom ? new Date(dateFrom) : null;
  const to = dateTo ? new Date(dateTo) : null;
  const toExclusive = to && !Number.isNaN(to.getTime()) ? new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1) : null;

  if (from && !Number.isNaN(from.getTime())) {
    rows = rows.filter((row) => {
      const d = new Date(row.createdAt || row.updatedAt || '');
      return Number.isNaN(d.getTime()) || d >= from;
    });
  }

  if (toExclusive) {
    rows = rows.filter((row) => {
      const d = new Date(row.createdAt || row.updatedAt || '');
      return Number.isNaN(d.getTime()) || d < toExclusive;
    });
  }

  const statusFilter = clean(status).toLowerCase();
  if (statusFilter && !['all', 'alles', '*'].includes(statusFilter)) {
    rows = rows.filter((row) => {
      const completed = isCompleted(row);
      if (statusFilter === 'open') return !completed;
      if (statusFilter === 'failed' || statusFilter === 'fout') return Boolean(row.error) || normalizeStatus(row.status).includes('failed');
      if (statusFilter === 'processed' || statusFilter === 'verwerkt') return completed;
      return true;
    });
  }

  const q = clean(query).toLowerCase();
  if (q) {
    rows = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(q));
  }

  rows.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));

  const totals = rows.reduce((acc, row) => {
    acc.total += 1;
    acc.mailPending = 0;
    if (!(normalizeStatus(row.refundStatus).includes('refunded') || normalizeStatus(row.refundStatus).includes('already'))) acc.refundPending += 1;
    if (!(normalizeStatus(row.srsCancelStatus).includes('cancel') || normalizeStatus(row.srsStatus).includes('cancelled in srs') || normalizeStatus(row.srsStatus).includes('cancelled_in_srs'))) acc.srsCancelPending += 1;
    if (row.error || normalizeStatus(row.status).includes('failed')) acc.failed += 1;
    acc.amount += Number(row.amount || 0);
    return acc;
  }, { total: 0, mailPending: 0, refundPending: 0, srsCancelPending: 0, failed: 0, amount: 0 });

  return { rows, totals };
}

async function cancelInSrs(row, { force = false } = {}) {
  const current = normalizeStatus(row.originalCancellation.srsStatus);
  if (!force && current.includes('cancel')) {
    return row.originalCancellation.srsResult || { success: true, skipped: true, status: 'already_cancelled' };
  }

  return cancelFulfillment({
    orderNr: row.orderNr,
    fulfillmentId: row.fulfillmentId,
    orderLineNr: row.orderLineNr,
    sku: row.sku || row.barcode,
    barcode: row.barcode || row.sku,
    pieces: row.quantity || 1,
    price: row.amount || 0,
    dateTime: new Date().toISOString().slice(0, 19)
  });
}

async function refundInShopify(row, { force = false, employeeName = '' } = {}) {
  const current = normalizeStatus(row.originalCancellation.refundStatus);
  if (!force && (current.includes('refund') || current.includes('already'))) {
    return row.originalCancellation.refundResult || { success: true, skipped: true, status: 'already_refunded' };
  }

  return refundUnavailableOrderLine({
    orderNr: row.orderNr,
    item: {
      sku: row.sku,
      barcode: row.barcode,
      title: row.title
    },
    quantity: row.quantity || 1,
    employeeName: employeeName || 'Administratie',
    note: `Niet leverbaar verwerkt op orderregelniveau. SRS fulfillment ${row.fulfillmentId || row.orderLineNr || '-'}. Overige orderregels niet geannuleerd. Voorraad niet teruggeboekt.`
  });
}

export async function processUnavailableOrderLine({
  id,
  steps = ['refund', 'srs_cancel'],
  employeeName = 'Administratie',
  force = false
} = {}) {
  const { rows } = await listUnavailableOrderLines({ status: 'all' });
  const row = rows.find((item) => sameUnavailableRowId(item, id));

  if (!row) throw new Error('Niet-leverbare orderregel niet gevonden. Haal de order opnieuw op met Zoek in SRS of Openstaand laden.');
  if (!isUnavailableLike(row)) throw new Error('Deze regel is niet als niet-leverbaar herkend en wordt niet verwerkt.');

  const cancellation = row.originalCancellation;
  const results = {};
  const patch = {
    processAttempts: Number(cancellation.processAttempts || 0) + 1,
    processedBy: employeeName,
    updatedAt: new Date().toISOString(),
    error: '',
    problemType: 'niet_leverbaar',
    stockReturnStatus: 'skipped_no_stock_return',
    mailStatus: 'shopify_refund_mail'
  };

  try {
    if (steps.includes('refund')) {
      results.refund = await refundInShopify(row, { force, employeeName });
      patch.refundStatus = results.refund?.alreadyRefunded || results.refund?.status === 'already_refunded'
        ? 'already_refunded'
        : 'refunded';
      patch.refundResult = results.refund;
    }

    if (steps.includes('srs_cancel')) {
      results.srsCancel = await cancelInSrs(row, { force });
      patch.srsCancelStatus = results.srsCancel?.success ? 'cancelled_in_srs' : 'srs_cancel_check';
      patch.srsStatus = results.srsCancel?.success ? 'cancelled_in_srs' : 'srs_cancel_check';
      patch.srsResult = {
        ...(cancellation.srsResult || {}),
        cancel: results.srsCancel,
        stockReturnStatus: 'skipped_no_stock_return',
        orderLevelCancel: false,
        lineLevelOnly: true
      };
    }

    patch.status = 'processed';
    patch.processedAt = new Date().toISOString();

    const updated = await updateOrderCancellation(cancellation.id, patch);

    return {
      success: true,
      id,
      cancellation: updated,
      results,
      message: 'Niet-leverbare orderregel verwerkt. Alleen deze regel is geannuleerd/terugbetaald; overige orderregels blijven ongemoeid. Shopify stuurt de terugbetaalmail. Voorraad is niet teruggeboekt.'
    };
  } catch (error) {
    patch.status = 'failed';
    patch.error = error.message || 'Verwerking mislukt.';
    await updateOrderCancellation(cancellation.id, patch);
    throw error;
  }
}
