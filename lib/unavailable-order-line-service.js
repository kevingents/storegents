import { getOrderCancellations, updateOrderCancellation } from './order-cancellation-store.js';
import { cancelFulfillment } from './srs-weborders-cancel-client.js';
import { refundUnavailableOrderLine } from './shopify-unavailable-refund-client.js';
import { appendUnavailableProcessingLog, unavailableLineKey } from './unavailable-processing-log-store.js';

function clean(value) {
  return String(value || '').trim();
}

function moneyNumber(value) {
  return Math.round(Number(value || 0) * 100) / 100;
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
  return row.id === cleanId || row.cancellationId === cleanId || row.cancellationId === baseId || cleanId.startsWith(`${row.cancellationId}::`);
}

function isUnavailableLineStatus(value) {
  const status = normalizeStatus(value);
  return status.includes('niet leverbaar') ||
    status.includes('unavailable') ||
    status.includes('not available') ||
    status.includes('srs global get fulfillments unavailable') ||
    status.includes('srs global fulfillments unavailable') ||
    status.includes('resolved unavailable');
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

function resolveShopifyOrderNr(value = {}) {
  return clean(
    value.shopifyOrderNr ||
    value.weborderNr ||
    value.webOrderNr ||
    value.shopifyOrderName ||
    value.orderName ||
    value.orderNr ||
    value.originalCancellation?.shopifyOrderNr ||
    value.originalCancellation?.weborderNr ||
    value.originalCancellation?.webOrderNr ||
    value.originalCancellation?.orderName ||
    value.originalCancellation?.orderNr
  ).replace(/^#/, '');
}

function resolveSrsOrderNr(value = {}) {
  return clean(
    value.srsOrderNr ||
    value.customerOrderNr ||
    value.klantBestellingNr ||
    value.klantbestellingNr ||
    value.orderNr ||
    value.originalCancellation?.srsOrderNr ||
    value.originalCancellation?.customerOrderNr ||
    value.originalCancellation?.klantBestellingNr ||
    value.originalCancellation?.klantbestellingNr ||
    value.originalCancellation?.orderNr
  ).replace(/^#/, '');
}

function isPositiveSrsCancelStatus(value) {
  const status = normalizeStatus(value);
  return status === 'cancelled in srs' ||
    status === 'canceled in srs' ||
    status === 'cancelled' ||
    status === 'canceled' ||
    status === 'already cancelled' ||
    status === 'already canceled' ||
    status.includes('cancelled in srs') ||
    status.includes('canceled in srs') ||
    status.includes('already cancelled') ||
    status.includes('already canceled');
}

function isAlreadyResolvedSrsLine(row = {}) {
  const value = normalizeStatus([
    row.srsCancelStatus,
    row.srsStatus,
    row.srsLineStatus,
    row.srsSourceStatus,
    row.source,
    row.originalCancellation?.srsCancelStatus,
    row.originalCancellation?.srsStatus,
    row.originalCancellation?.srsSourceStatus,
    row.originalCancellation?.source,
    row.originalCancellation?.srsResult?.detectedStatus,
    row.originalCancellation?.srsResult?.resolvedInSrs ? 'cancelled_in_srs' : ''
  ].filter(Boolean).join(' '));

  return isPositiveSrsCancelStatus(value) ||
    value.includes('resolved unavailable') ||
    value.includes('resolved in srs') ||
    value.includes('srs global fulfillments resolved unavailable');
}

function isNoOpenSrsQuantityError(value) {
  const message = normalizeStatus(value);
  return message.includes('niet meer retour nemen dan er openstaat') ||
    message.includes('meer retour nemen dan er openstaat') ||
    message.includes('no open quantity') ||
    message.includes('nothing open') ||
    message.includes('already processed') ||
    message.includes('already cancelled') ||
    message.includes('already canceled');
}

function lineRowsForCancellation(cancellation = {}) {
  const lines = Array.isArray(cancellation.items) && cancellation.items.length ? cancellation.items : [{}];

  return lines.map((line, index) => {
    const source = clean(cancellation.source || '');
    const srsLineStatus = clean(line.srsStatus || line.status || cancellation.srsSourceStatus || cancellation.srsStatus || cancellation.reason || '');
    const srsCancelStatus = clean(cancellation.srsCancelStatus || cancellation.srsCancelResult?.status || '') || (
      isPositiveSrsCancelStatus(cancellation.srsStatus) ? 'cancelled_in_srs' : 'pending'
    );
    const shopifyOrderNr = resolveShopifyOrderNr(cancellation);
    const srsOrderNr = resolveSrsOrderNr(cancellation);

    return {
      id: [cancellation.id, line.fulfillmentId || '', line.orderLineNr || '', line.sku || line.barcode || '', index].join('::'),
      cancellationId: cancellation.id,
      lineIndex: index,
      idempotencyKey: cancellation.idempotencyKey || '',
      createdAt: cancellation.createdAt || '',
      updatedAt: cancellation.updatedAt || '',
      month: cancellation.month || '',
      store: clean(cancellation.store || line.lastResponsibleStore || 'Onbekend'),
      orderNr: shopifyOrderNr || cancellation.orderNr || '',
      shopifyOrderNr,
      weborderNr: shopifyOrderNr,
      srsOrderNr,
      customerOrderNr: clean(cancellation.customerOrderNr || cancellation.klantBestellingNr || cancellation.klantbestellingNr || ''),
      employeeName: cancellation.employeeName || '',
      customerName: cancellation.customerName || '',
      customerEmail: cancellation.customerEmail || '',
      reason: cancellation.reason || 'Niet leverbaar',
      currency: cancellation.currency || 'EUR',
      amount: moneyNumber(line.amount || cancellation.amount || cancellation.refundAmount || 0),
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

function isRefundDone(row = {}) {
  const status = normalizeStatus(row.refundStatus);
  return status.includes('refunded') || status.includes('refund') || status.includes('already');
}

function isSrsCancelDone(row = {}) {
  return isPositiveSrsCancelStatus([row.srsCancelStatus, row.srsStatus, row.srsSourceStatus, row.source].filter(Boolean).join(' '));
}

function isCompleted(row) {
  return isRefundDone(row) && isSrsCancelDone(row);
}

function rowScore(row = {}) {
  return Number(isRefundDone(row)) * 10 +
    Number(isSrsCancelDone(row)) * 10 +
    Number(!row.error) * 2 +
    Number(row.amount || 0) / 100000 +
    (row.updatedAt || row.createdAt ? 1 : 0);
}

function dedupeUnavailableRows(rows = []) {
  const map = new Map();

  for (const row of rows) {
    const key = unavailableLineKey(row) || row.id;
    const existing = map.get(key);
    if (!existing || rowScore(row) >= rowScore(existing)) map.set(key, row);
  }

  return Array.from(map.values());
}

function logBase(row = {}, extra = {}) {
  return {
    orderNr: row.orderNr,
    shopifyOrderNr: row.shopifyOrderNr || row.weborderNr || row.orderNr,
    weborderNr: row.weborderNr || row.shopifyOrderNr || row.orderNr,
    srsOrderNr: row.srsOrderNr || row.orderNr,
    customerOrderNr: row.customerOrderNr || '',
    lineKey: unavailableLineKey(row),
    cancellationId: row.cancellationId,
    fulfillmentId: row.fulfillmentId,
    orderLineNr: row.orderLineNr,
    sku: row.sku,
    barcode: row.barcode,
    title: row.title,
    store: row.lastResponsibleStore || row.store,
    amount: row.amount,
    currency: row.currency || 'EUR',
    refundStatus: row.refundStatus,
    srsCancelStatus: row.srsCancelStatus,
    ...extra
  };
}

async function writeProcessLog(row, entry) {
  try {
    return await appendUnavailableProcessingLog(logBase(row, entry));
  } catch (error) {
    console.error('[unavailable-processing-log]', error);
    return null;
  }
}

export async function listUnavailableOrderLines({ store = '', status = 'open', dateFrom = '', dateTo = '', query = '' } = {}) {
  const cancellations = await getOrderCancellations();
  let rows = dedupeUnavailableRows(cancellations.flatMap(lineRowsForCancellation));

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
  if (q) rows = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(q));
  rows.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));

  const totals = rows.reduce((acc, row) => {
    acc.total += 1;
    acc.mailPending = 0;
    if (!isRefundDone(row)) acc.refundPending += 1;
    if (!isSrsCancelDone(row)) acc.srsCancelPending += 1;
    if (row.error || normalizeStatus(row.status).includes('failed')) acc.failed += 1;
    acc.amount += Number(row.amount || 0);
    return acc;
  }, { total: 0, mailPending: 0, refundPending: 0, srsCancelPending: 0, failed: 0, amount: 0 });

  totals.amount = moneyNumber(totals.amount);
  return { rows, totals };
}

async function cancelInSrs(row, { force = false } = {}) {
  if (isAlreadyResolvedSrsLine(row)) {
    return {
      success: true,
      skipped: true,
      status: 'already_cancelled',
      alreadyCancelled: true,
      message: 'SRS regel stond al geannuleerd/verwerkt.'
    };
  }

  return cancelFulfillment({
    orderNr: row.srsOrderNr || row.orderNr,
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
    return row.originalCancellation.refundResult || { success: true, skipped: true, status: 'already_refunded', alreadyRefunded: true, matchedAmount: row.amount || 0, refundAmount: 0 };
  }

  return refundUnavailableOrderLine({
    orderNr: row.shopifyOrderNr || row.weborderNr || row.orderNr,
    item: { sku: row.sku, barcode: row.barcode, title: row.title, articleNumber: row.articleNumber, articleId: row.articleId, orderLineNr: row.orderLineNr },
    quantity: row.quantity || 1,
    employeeName: employeeName || 'Administratie',
    note: `Niet leverbaar verwerkt op orderregelniveau. SRS order ${row.srsOrderNr || row.orderNr}. SRS fulfillment ${row.fulfillmentId || row.orderLineNr || '-'}. Overige orderregels niet geannuleerd. Voorraad niet teruggeboekt.`
  });
}

function patchLineAmounts(cancellation = {}, row = {}, amount = 0) {
  const safeAmount = moneyNumber(amount);
  if (!safeAmount || safeAmount <= 0) return null;

  const items = Array.isArray(cancellation.items) ? cancellation.items.map((item, index) => {
    const sameLine = index === row.lineIndex ||
      clean(item.fulfillmentId) === clean(row.fulfillmentId) && clean(item.orderLineNr) === clean(row.orderLineNr) && clean(item.sku || item.barcode) === clean(row.sku || row.barcode);
    return sameLine ? { ...item, amount: safeAmount } : item;
  }) : cancellation.items;

  return { amount: safeAmount, items };
}

function finalStatusFromPatch(patch = {}) {
  const refundDone = normalizeStatus(patch.refundStatus).includes('refunded') || normalizeStatus(patch.refundStatus).includes('already');
  const srsDone = isPositiveSrsCancelStatus([patch.srsCancelStatus, patch.srsStatus].filter(Boolean).join(' '));
  return refundDone && srsDone ? 'processed' : 'open';
}

export async function processUnavailableOrderLine({ id, steps = ['refund', 'srs_cancel'], employeeName = 'Administratie', force = false } = {}) {
  const requiredSteps = Array.from(new Set([...(Array.isArray(steps) ? steps : []), 'refund', 'srs_cancel']));
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
    mailStatus: 'shopify_refund_mail',
    refundStatus: cancellation.refundStatus || row.refundStatus || 'pending',
    srsCancelStatus: cancellation.srsCancelStatus || row.srsCancelStatus || 'pending',
    srsStatus: cancellation.srsStatus || row.srsStatus || 'pending',
    shopifyOrderNr: row.shopifyOrderNr || row.weborderNr || row.orderNr,
    weborderNr: row.weborderNr || row.shopifyOrderNr || row.orderNr,
    srsOrderNr: row.srsOrderNr || row.orderNr,
    customerOrderNr: row.customerOrderNr || cancellation.customerOrderNr || ''
  };

  await writeProcessLog(row, { type: 'process_started', success: true, processedBy: employeeName, message: 'Verwerking gestart.' });

  try {
    if (requiredSteps.includes('refund')) {
      results.refund = await refundInShopify(row, { force, employeeName });
      const refundAmount = results.refund?.refundAmount || results.refund?.matchedAmount || row.amount || 0;
      const amountPatch = patchLineAmounts(cancellation, row, refundAmount);
      if (amountPatch) Object.assign(patch, amountPatch);
      patch.refundStatus = results.refund?.alreadyRefunded || results.refund?.status === 'already_refunded' ? 'already_refunded' : 'refunded';
      patch.refundResult = results.refund;

      await writeProcessLog(row, {
        type: patch.refundStatus === 'already_refunded' ? 'shopify_already_refunded' : 'shopify_refund_created',
        success: true,
        processedBy: employeeName,
        amount: moneyNumber(refundAmount || row.amount || 0),
        refundStatus: patch.refundStatus,
        srsCancelStatus: patch.srsCancelStatus,
        message: patch.refundStatus === 'already_refunded' ? 'Shopify was al terugbetaald.' : 'Shopify terugbetaling verwerkt.',
        result: results.refund
      });
    }

    if (requiredSteps.includes('srs_cancel')) {
      try {
        results.srsCancel = await cancelInSrs(row, { force });
        patch.srsCancelStatus = results.srsCancel?.success ? 'cancelled_in_srs' : 'srs_cancel_failed';
        patch.srsStatus = results.srsCancel?.success ? 'cancelled_in_srs' : 'srs_cancel_failed';
        if (!results.srsCancel?.success) patch.error = results.srsCancel?.messages?.join(' | ') || 'SRS cancel is niet bevestigd.';
        patch.srsResult = {
          ...(cancellation.srsResult || {}),
          cancel: results.srsCancel,
          stockReturnStatus: 'skipped_no_stock_return',
          orderLevelCancel: false,
          lineLevelOnly: true
        };

        await writeProcessLog(row, {
          type: results.srsCancel?.success ? 'srs_cancel_success' : 'srs_cancel_failed',
          success: Boolean(results.srsCancel?.success),
          processedBy: employeeName,
          refundStatus: patch.refundStatus,
          srsCancelStatus: patch.srsCancelStatus,
          message: results.srsCancel?.success ? 'SRS orderregel geannuleerd of stond al geannuleerd.' : patch.error,
          result: results.srsCancel
        });
      } catch (error) {
        if (isNoOpenSrsQuantityError(error.message)) {
          results.srsCancel = {
            success: true,
            skipped: true,
            status: 'already_cancelled_no_open_quantity',
            alreadyCancelled: true,
            message: error.message || 'SRS regel had geen open aantal meer.'
          };
          patch.srsCancelStatus = 'cancelled_in_srs';
          patch.srsStatus = 'cancelled_in_srs';
          patch.error = '';
          patch.srsResult = {
            ...(cancellation.srsResult || {}),
            cancel: results.srsCancel,
            stockReturnStatus: 'skipped_no_stock_return',
            orderLevelCancel: false,
            lineLevelOnly: true
          };
          await writeProcessLog(row, {
            type: 'srs_already_cancelled',
            success: true,
            processedBy: employeeName,
            refundStatus: patch.refundStatus,
            srsCancelStatus: patch.srsCancelStatus,
            message: 'SRS had geen open aantal meer; beschouwd als al geannuleerd/verwerkt.',
            result: results.srsCancel
          });
        } else {
          patch.srsCancelStatus = 'srs_cancel_failed';
          patch.srsStatus = 'srs_cancel_failed';
          patch.error = error.message || 'SRS cancel mislukt.';
          await writeProcessLog(row, {
            type: 'srs_cancel_failed',
            success: false,
            processedBy: employeeName,
            refundStatus: patch.refundStatus,
            srsCancelStatus: patch.srsCancelStatus,
            message: patch.error,
            result: { error: patch.error }
          });
        }
      }
    }

    patch.status = finalStatusFromPatch(patch);
    if (patch.status === 'processed') patch.processedAt = new Date().toISOString();

    const updated = await updateOrderCancellation(cancellation.id, patch);

    return {
      success: patch.status === 'processed',
      partial: patch.status !== 'processed',
      id,
      cancellation: updated,
      results,
      message: patch.status === 'processed'
        ? 'Niet-leverbare orderregel verwerkt. Shopify is terugbetaald of was al terugbetaald, en SRS is geannuleerd. Voorraad is niet teruggeboekt.'
        : 'Niet-leverbare orderregel gedeeltelijk verwerkt. Shopify is klaar, maar SRS cancel staat nog open of is mislukt.'
    };
  } catch (error) {
    patch.status = 'open';
    patch.error = error.message || 'Verwerking mislukt.';
    await updateOrderCancellation(cancellation.id, patch);
    await writeProcessLog(row, {
      type: 'process_failed',
      success: false,
      processedBy: employeeName,
      refundStatus: patch.refundStatus,
      srsCancelStatus: patch.srsCancelStatus,
      message: patch.error,
      result: { error: patch.error }
    });
    throw error;
  }
}
