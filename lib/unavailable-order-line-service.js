import { getOrderCancellations, updateOrderCancellation } from './order-cancellation-store.js';
import { cancelFulfillment } from './srs-weborders-cancel-client.js';
import { refundUnavailableOrderLine } from './shopify-unavailable-refund-client.js';

function clean(value) {
  return String(value || '').trim();
}

function normalizeStatus(value) {
  return clean(value).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function isUnavailableLike(row = {}) {
  const value = normalizeStatus([
    row.srsLineStatus,
    row.srsStatus,
    row.status,
    row.reason,
    row.srsSourceStatus
  ].filter(Boolean).join(' '));

  return value.includes('niet leverbaar') ||
    value.includes('unavailable') ||
    value.includes('not available') ||
    value.includes('geannuleerd') ||
    value.includes('cancelled') ||
    value.includes('canceled') ||
    value.includes('annulled');
}

function lineRowsForCancellation(cancellation = {}) {
  const lines = Array.isArray(cancellation.items) && cancellation.items.length ? cancellation.items : [{}];

  return lines.map((line, index) => ({
    id: [cancellation.id, line.fulfillmentId || '', line.orderLineNr || '', line.sku || line.barcode || '', index].join('::'),
    cancellationId: cancellation.id,
    lineIndex: index,
    idempotencyKey: cancellation.idempotencyKey || '',
    createdAt: cancellation.createdAt || '',
    updatedAt: cancellation.updatedAt || '',
    month: cancellation.month || '',
    store: cancellation.store || 'Onbekend',
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
    lastResponsibleStore: cancellation.store || 'Onbekend',
    srsLineStatus: clean(line.srsStatus || line.status || cancellation.srsSourceStatus || cancellation.srsStatus || ''),
    status: cancellation.status || 'open',
    mailStatus: cancellation.mailStatus || 'pending',
    refundStatus: cancellation.refundStatus || 'pending',
    srsCancelStatus: cancellation.srsStatus || 'pending',
    stockReturnStatus: 'skipped_no_stock_return',
    processedAt: cancellation.processedAt || '',
    processedBy: cancellation.processedBy || '',
    processAttempts: Number(cancellation.processAttempts || 0),
    error: cancellation.error || '',
    originalCancellation: cancellation
  })).filter(isUnavailableLike);
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
      const completed = ['processed', 'completed', 'done'].includes(normalizeStatus(row.status)) ||
        ['sent'].includes(normalizeStatus(row.mailStatus)) &&
        ['refunded', 'already refunded', 'already_refunded', 'already refunded or no transaction'].some((value) => normalizeStatus(row.refundStatus).includes(normalizeStatus(value))) &&
        normalizeStatus(row.srsCancelStatus).includes('cancel');

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
    if (!['sent'].includes(normalizeStatus(row.mailStatus))) acc.mailPending += 1;
    if (!normalizeStatus(row.refundStatus).includes('refund')) acc.refundPending += 1;
    if (!normalizeStatus(row.srsCancelStatus).includes('cancel')) acc.srsCancelPending += 1;
    if (row.error || normalizeStatus(row.status).includes('failed')) acc.failed += 1;
    acc.amount += Number(row.amount || 0);
    return acc;
  }, { total: 0, mailPending: 0, refundPending: 0, srsCancelPending: 0, failed: 0, amount: 0 });

  return { rows, totals };
}

async function sendUnavailableMail(row, { force = false } = {}) {
  if (!force && normalizeStatus(row.originalCancellation.mailStatus) === 'sent') {
    return row.originalCancellation.mailResult || { success: true, skipped: true, status: 'already_sent' };
  }

  const apiKey = process.env.RESEND_API_KEY || process.env.MAIL_API_KEY || '';
  const from = process.env.MAIL_FROM || process.env.EMAIL_FROM || 'GENTS <no-reply@gents.nl>';
  const to = clean(row.customerEmail);

  if (!to) throw new Error('Klant e-mail ontbreekt. Mail kan niet worden verzonden.');
  if (!apiKey) throw new Error('RESEND_API_KEY ontbreekt. Mail kan niet worden verzonden.');

  const subject = `Artikel niet leverbaar voor order ${row.orderNr}`;
  const html = `
    <p>Beste ${row.customerName || 'klant'},</p>
    <p>Helaas is onderstaand artikel uit je bestelling niet leverbaar:</p>
    <ul>
      <li><strong>${row.title || row.sku || 'Artikel'}</strong></li>
      <li>SKU/barcode: ${row.sku || row.barcode || '-'}</li>
      <li>Aantal: ${row.quantity || 1}</li>
      <li>Order: ${row.orderNr}</li>
    </ul>
    <p>We verwerken de terugbetaling voor dit artikel. Onze excuses voor het ongemak.</p>
    <p>Met vriendelijke groet,<br>GENTS</p>
  `;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to, subject, html })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || data?.error || `Mail fout ${response.status}`);

  return { success: true, provider: 'resend', id: data.id || '', to, subject };
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
    note: `Niet leverbaar verwerkt. SRS fulfillment ${row.fulfillmentId || row.orderLineNr || '-'}. Voorraad niet teruggeboekt.`
  });
}

export async function processUnavailableOrderLine({
  id,
  steps = ['mail', 'refund', 'srs_cancel'],
  employeeName = 'Administratie',
  force = false
} = {}) {
  const { rows } = await listUnavailableOrderLines({ status: 'all' });
  const row = rows.find((item) => item.id === id || item.cancellationId === id);

  if (!row) throw new Error('Niet-leverbare orderregel niet gevonden.');

  const cancellation = row.originalCancellation;
  const results = {};
  const patch = {
    processAttempts: Number(cancellation.processAttempts || 0) + 1,
    processedBy: employeeName,
    updatedAt: new Date().toISOString(),
    error: ''
  };

  try {
    if (steps.includes('mail')) {
      results.mail = await sendUnavailableMail(row, { force });
      patch.mailStatus = 'sent';
      patch.mailResult = results.mail;
    }

    if (steps.includes('refund')) {
      results.refund = await refundInShopify(row, { force, employeeName });
      patch.refundStatus = results.refund?.alreadyRefunded || results.refund?.status === 'already_refunded'
        ? 'already_refunded'
        : 'refunded';
      patch.refundResult = results.refund;
    }

    if (steps.includes('srs_cancel')) {
      results.srsCancel = await cancelInSrs(row, { force });
      patch.srsStatus = results.srsCancel?.success ? 'cancelled_in_srs' : 'srs_cancel_check';
      patch.srsResult = {
        ...(cancellation.srsResult || {}),
        cancel: results.srsCancel,
        stockReturnStatus: 'skipped_no_stock_return'
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
      message: 'Niet-leverbare orderregel verwerkt. Voorraad is niet teruggeboekt.'
    };
  } catch (error) {
    patch.status = 'failed';
    patch.error = error.message || 'Verwerking mislukt.';
    await updateOrderCancellation(cancellation.id, patch);
    throw error;
  }
}
