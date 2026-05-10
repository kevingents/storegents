import { addOrderCancellation } from './order-cancellation-store.js';
import { refundUnavailableOrderLine } from './shopify-unavailable-refund-client.js';
import { cancelFulfillment } from './srs-weborders-cancel-client.js';
import { appendUnavailableProcessingLog, unavailableLineKey } from './unavailable-processing-log-store.js';

function clean(value) {
  return String(value || '').trim();
}

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function norm(value) {
  return clean(value).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function isDoneCancelText(value) {
  const text = norm(value);
  return text.includes('cancelled') ||
    text.includes('canceled') ||
    text.includes('already processed') ||
    text.includes('already cancelled') ||
    text.includes('already canceled') ||
    text.includes('geen open aantal') ||
    text.includes('niet meer retour nemen dan er openstaat') ||
    text.includes('meer retour nemen dan er openstaat') ||
    text.includes('no open quantity') ||
    text.includes('nothing open') ||
    text.includes('verificatie vond dezelfde orderregel niet terug') ||
    text.includes('niet terug') ||
    text.includes('not found');
}

function isUnavailableStatusText(value) {
  const text = norm(value);
  return text.includes('unavailable') || text.includes('niet leverbaar') || text.includes('not available');
}

function isSrsCancelDoneResult(result = {}) {
  if (result?.success) return true;
  if (isDoneCancelText(JSON.stringify(result || {}))) return true;

  const verification = result?.verification || null;
  if (verification) {
    if (verification.success || verification.cancelled) return true;
    if (verification.stillUnavailable === false && verification.foundMatchingLine === false) return true;
    const statuses = Array.isArray(verification.statuses) ? verification.statuses : [];
    if (statuses.length && statuses.some(isDoneCancelText)) return true;
    if (statuses.length && !statuses.some(isUnavailableStatusText)) return true;
  }

  const attempts = Array.isArray(result?.attempts) ? result.attempts : [];
  return attempts.some((attempt) => isSrsCancelDoneResult(attempt));
}

function firstLine(record = {}) {
  return Array.isArray(record.items) && record.items.length ? record.items[0] : {};
}

function concreteId(record = {}) {
  const line = firstLine(record);
  return [record.id, line.fulfillmentId || '', line.orderLineNr || '', line.sku || line.barcode || '', 0].join('::');
}

function rowFromRecord(record = {}) {
  const line = firstLine(record);
  const shopifyOrderNr = clean(record.shopifyOrderNr || record.weborderNr || record.orderNr).replace(/^#/, '');
  return {
    id: concreteId(record),
    cancellationId: record.id || '',
    orderNr: shopifyOrderNr,
    shopifyOrderNr,
    weborderNr: shopifyOrderNr,
    srsOrderNr: clean(record.srsOrderNr || record.orderNr).replace(/^#/, ''),
    store: clean(record.store || line.lastResponsibleStore || 'Onbekend'),
    lastResponsibleStore: clean(line.lastResponsibleStore || record.store || 'Onbekend'),
    fulfillmentId: clean(line.fulfillmentId),
    orderLineNr: clean(line.orderLineNr),
    sku: clean(line.sku || line.barcode || line.articleNumber),
    barcode: clean(line.barcode || line.sku || line.articleNumber),
    title: clean(line.title || line.productName || line.sku || line.barcode),
    articleNumber: clean(line.articleNumber || line.sku || line.barcode),
    articleId: clean(line.articleId),
    quantity: Number(line.quantity || line.pieces || 1),
    amount: money(line.amount || record.amount || 0),
    currency: record.currency || 'EUR',
    refundStatus: record.refundStatus || 'pending',
    srsCancelStatus: record.srsCancelStatus || 'pending',
    srsStatus: record.srsStatus || line.srsStatus || 'pending',
    source: record.source || '',
    originalCancellation: record
  };
}

async function log(row, entry) {
  try {
    await appendUnavailableProcessingLog({
      orderNr: row.orderNr,
      shopifyOrderNr: row.shopifyOrderNr,
      weborderNr: row.weborderNr,
      srsOrderNr: row.srsOrderNr,
      lineKey: unavailableLineKey(row),
      cancellationId: row.cancellationId,
      fulfillmentId: row.fulfillmentId,
      orderLineNr: row.orderLineNr,
      sku: row.sku,
      barcode: row.barcode,
      title: row.title,
      store: row.lastResponsibleStore || row.store,
      amount: row.amount,
      currency: row.currency,
      ...entry
    });
  } catch (error) {
    console.error('[unavailable-cron-record-processor] log failed', error);
  }
}

async function ensureStored(record) {
  const saved = await addOrderCancellation(record);
  return saved.cancellation || record;
}

async function refund(row, employeeName) {
  return refundUnavailableOrderLine({
    orderNr: row.shopifyOrderNr || row.orderNr,
    item: {
      sku: row.sku,
      barcode: row.barcode,
      title: row.title,
      articleNumber: row.articleNumber,
      articleId: row.articleId,
      orderLineNr: row.orderLineNr
    },
    quantity: row.quantity || 1,
    employeeName,
    note: `Niet leverbaar automatisch verwerkt. SRS order ${row.srsOrderNr || row.orderNr}. SRS fulfillment ${row.fulfillmentId || row.orderLineNr || '-'}. Voorraad niet teruggeboekt.`
  });
}

async function cancel(row) {
  if (isDoneCancelText([row.srsCancelStatus, row.srsStatus, row.source].join(' '))) {
    return { success: true, skipped: true, status: 'already_cancelled', message: 'SRS stond al klaar.' };
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

function processedRecord(stored = {}, patch = {}) {
  return {
    ...stored,
    ...patch,
    id: stored.id,
    idempotencyKey: `${stored.idempotencyKey || stored.id || 'srs-unavailable'}::processed::${Date.now()}::${Math.random().toString(16).slice(2)}`,
    source: stored.source || 'srs_global_fulfillments_unavailable_lines',
    updatedAt: new Date().toISOString()
  };
}

async function saveProcessedCopy(stored, patch) {
  try {
    await addOrderCancellation(processedRecord(stored, patch));
  } catch (error) {
    console.error('[unavailable-cron-record-processor] processed copy save failed', error);
  }
}

export async function processSyncedUnavailableRecord(record, { employeeName = 'Automatische niet-leverbaar cron' } = {}) {
  const stored = await ensureStored(record);
  const row = rowFromRecord(stored);
  const patch = {
    processAttempts: Number(stored.processAttempts || 0) + 1,
    processedBy: employeeName,
    updatedAt: new Date().toISOString(),
    error: '',
    problemType: 'niet_leverbaar',
    stockReturnStatus: 'skipped_no_stock_return',
    mailStatus: 'shopify_refund_mail',
    shopifyOrderNr: row.shopifyOrderNr,
    weborderNr: row.weborderNr,
    srsOrderNr: row.srsOrderNr
  };
  const results = {};

  await log(row, { type: 'process_started', success: true, processedBy: employeeName, message: 'Cron verwerking gestart.' });

  try {
    results.refund = await refund(row, employeeName);
    const refundAmount = results.refund?.refundAmount || results.refund?.matchedAmount || row.amount || 0;
    patch.refundStatus = results.refund?.alreadyRefunded || results.refund?.status === 'already_refunded' ? 'already_refunded' : 'refunded';
    patch.refundResult = results.refund;
    patch.amount = money(refundAmount || row.amount || 0);
    patch.items = Array.isArray(stored.items) ? stored.items.map((item, index) => index === 0 ? { ...item, amount: patch.amount } : item) : stored.items;
    await log(row, {
      type: patch.refundStatus === 'already_refunded' ? 'shopify_already_refunded' : 'shopify_refund_created',
      success: true,
      processedBy: employeeName,
      refundStatus: patch.refundStatus,
      amount: patch.amount,
      message: patch.refundStatus === 'already_refunded' ? 'Shopify was al terugbetaald.' : 'Shopify terugbetaling verwerkt.',
      result: results.refund
    });

    try {
      results.srsCancel = await cancel(row);
      const srsDone = isSrsCancelDoneResult(results.srsCancel);
      patch.srsCancelStatus = srsDone ? 'cancelled_in_srs' : 'srs_cancel_failed';
      patch.srsStatus = srsDone ? 'cancelled_in_srs' : 'srs_cancel_failed';
      if (!srsDone) patch.error = results.srsCancel?.messages?.join(' | ') || results.srsCancel?.message || 'SRS cancel is niet bevestigd.';
    } catch (error) {
      if (isDoneCancelText(error.message)) {
        results.srsCancel = { success: true, skipped: true, status: 'already_cancelled_no_open_quantity', message: error.message };
        patch.srsCancelStatus = 'cancelled_in_srs';
        patch.srsStatus = 'cancelled_in_srs';
      } else {
        results.srsCancel = { success: false, error: error.message };
        patch.srsCancelStatus = 'srs_cancel_failed';
        patch.srsStatus = 'srs_cancel_failed';
        patch.error = error.message || 'SRS cancel mislukt.';
      }
    }

    await log(row, {
      type: patch.srsCancelStatus === 'cancelled_in_srs' ? 'srs_cancel_success' : 'srs_cancel_failed',
      success: patch.srsCancelStatus === 'cancelled_in_srs',
      processedBy: employeeName,
      refundStatus: patch.refundStatus,
      srsCancelStatus: patch.srsCancelStatus,
      message: patch.error || 'SRS orderregel geannuleerd of stond al geannuleerd.',
      result: results.srsCancel
    });

    const done = norm(patch.refundStatus).includes('refund') && patch.srsCancelStatus === 'cancelled_in_srs';
    patch.status = done ? 'processed' : 'open';
    if (done) patch.processedAt = new Date().toISOString();

    const finalRecord = processedRecord(stored, patch);
    await saveProcessedCopy(stored, patch);
    return {
      success: done,
      partial: !done,
      id: row.id,
      cancellation: finalRecord,
      results,
      message: done ? 'Cronregel volledig verwerkt.' : 'Cronregel gedeeltelijk verwerkt.'
    };
  } catch (error) {
    patch.status = 'open';
    patch.error = error.message || 'Verwerking mislukt.';
    const finalRecord = processedRecord(stored, patch);
    await saveProcessedCopy(stored, patch);
    await log(row, {
      type: 'process_failed',
      success: false,
      processedBy: employeeName,
      refundStatus: patch.refundStatus || row.refundStatus,
      srsCancelStatus: patch.srsCancelStatus || row.srsCancelStatus,
      message: patch.error,
      result: { error: patch.error }
    });
    return { success: false, partial: false, id: row.id, cancellation: finalRecord, results, error: patch.error, message: patch.error };
  }
}
