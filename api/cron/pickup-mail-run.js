import { appendMailLog, getMailLog, wasSentRecently } from '../../lib/gents-mail-log-store.js';
import { ageLabel, operationalDaysBetween } from '../../lib/gents-business-deadline.js';
import { baseMailHtml, rowsTable, sendMail } from '../../lib/gents-mailer.js';
import { getAdminToken, getApiBaseUrl, getStoreMail, getStoreMailAsync, getStoreNames, isExcludedStore, requireCronSecret } from '../../lib/gents-mail-config.js';

function setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function orderKey(order) {
  return String(order.id || order.orderId || order.name || order.orderNumber || '').trim();
}

function orderNumber(order) {
  return String(order.name || order.orderName || order.orderNumber || order.id || '-').trim();
}

function customerName(order) {
  return order.customer || order.customerName || order.shippingAddress?.name || order.email || '-';
}

function orderEmail(order) {
  return order.email || order.customerEmail || order.customer?.email || '-';
}

function orderCreatedAt(order) {
  return order.createdAt || order.created_at || order.processedAt || order.processed_at || '';
}

function isReadyOrInformed(order) {
  const status = String(order.pickupStatus || '').toLowerCase();
  const label = String(order.pickupStatusLabel || '').toLowerCase();
  const tags = String(order.tags || '').toLowerCase();
  return Boolean(order.customerInformed) || status.includes('ready') || status.includes('klaar') || status.includes('notified') || label.includes('geinformeerd') || label.includes('geïnformeerd') || label.includes('klaar') || tags.includes('pickup_ready') || tags.includes('pickup_notified');
}

function itemsText(order) {
  const items = Array.isArray(order.items) ? order.items : Array.isArray(order.line_items) ? order.line_items : [];
  return items.map((item) => `${item.quantity || item.aantal || 1}x ${item.name || item.title || item.sku || '-'}`).join(', ');
}

async function fetchPickupOrders(req, store) {
  const baseUrl = getApiBaseUrl(req);
  if (!baseUrl) throw new Error('GENTS_API_BASE_URL ontbreekt.');

  const url = `${baseUrl}/api/pickup-orders?store=${encodeURIComponent(store)}&status=open&days=14&t=${Date.now()}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'x-admin-token': getAdminToken()
    },
    signal: AbortSignal.timeout(30000)
  });

  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_error) { data = { message: text }; }

  if (!response.ok || data.success === false) {
    throw new Error(data.message || data.error || `Pickup endpoint fout ${response.status}`);
  }

  return data.orders || [];
}

async function mailNewPickup({ store, recipient, orders, dryRun }) {
  if (!orders.length) return { sent: false, count: 0, resendId: '' };

  const html = baseMailHtml({
    title: `Nieuwe ophaalorder${orders.length === 1 ? '' : 's'} - ${store}`,
    intro: 'Er staan nieuwe ophaalorders klaar om in de winkel te controleren en klaar te zetten.',
    bodyHtml: rowsTable(orders, [
      { label: 'Order', value: orderNumber },
      { label: 'Klant', value: customerName },
      { label: 'E-mail', value: orderEmail },
      { label: 'Leeftijd', value: (row) => ageLabel(orderCreatedAt(row)) },
      { label: 'Artikelen', value: itemsText }
    ])
  });

  if (dryRun) return { sent: false, count: orders.length, resendId: '' };

  const result = await sendMail({
    to: recipient.email,
    cc: recipient.cc,
    subject: `Nieuwe ophaalorder${orders.length === 1 ? '' : 's'} - ${store}`,
    html,
    text: `Nieuwe ophaalorders voor ${store}: ${orders.map(orderNumber).join(', ')}`
  });

  return { sent: true, count: orders.length, resendId: result.resendId || '' };
}

async function mailPickupReminder({ store, recipient, orders, dryRun }) {
  if (!orders.length) return { sent: false, count: 0, resendId: '' };

  const html = baseMailHtml({
    title: `Reminder: ophaalorder${orders.length === 1 ? '' : 's'} nog niet klaargezet - ${store}`,
    intro: 'Deze ophaalorders staan langer dan 1 operationele dag open en lijken nog niet klaar / niet geïnformeerd.',
    bodyHtml: rowsTable(orders, [
      { label: 'Order', value: orderNumber },
      { label: 'Klant', value: customerName },
      { label: 'E-mail', value: orderEmail },
      { label: 'Leeftijd', value: (row) => ageLabel(orderCreatedAt(row)) },
      { label: 'Artikelen', value: itemsText }
    ])
  });

  if (dryRun) return { sent: false, count: orders.length, resendId: '' };

  const result = await sendMail({
    to: recipient.email,
    cc: recipient.cc,
    subject: `Reminder ophaalorder${orders.length === 1 ? '' : 's'} - ${store}`,
    html,
    text: `Reminder ophaalorders voor ${store}: ${orders.map(orderNumber).join(', ')}`
  });

  return { sent: true, count: orders.length, resendId: result.resendId || '' };
}

export default async function handler(req, res) {
  setNoStore(res);
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen GET/POST is toegestaan.' });
  }

  if (!requireCronSecret(req, res, 'PICKUP_MAIL_SECRET')) return;

  const dryRun = String(req.query.dryRun || req.query.preview || '') === '1';
  const onlyStore = String(req.query.store || '').trim();
  const stores = onlyStore ? [onlyStore] : getStoreNames().filter((store) => !isExcludedStore(store));
  const logRows = await getMailLog();
  const results = [];

  for (const store of stores) {
    /* Async variant leest eerst uit Blob (admin > Winkel-emailadressen). */
    const recipient = await getStoreMailAsync(store);

    if (!recipient.email) {
      results.push({ store, skipped: true, reason: 'Geen winkel e-mail ingesteld.' });
      await appendMailLog({ type: 'pickup_config', store, key: 'missing_email', status: 'error', message: 'Geen winkel e-mail ingesteld.' });
      continue;
    }

    try {
      const orders = await fetchPickupOrders(req, store);
      const newOrders = [];
      const reminderOrders = [];

      for (const order of orders) {
        const key = orderKey(order);
        const createdAt = orderCreatedAt(order);
        const operationalDays = operationalDaysBetween(createdAt);
        const ready = isReadyOrInformed(order);

        if (!wasSentRecently(logRows, { type: 'pickup_new_store', store, key, withinHours: 72 })) {
          newOrders.push(order);
        }

        if (!ready && operationalDays >= 1 && !wasSentRecently(logRows, { type: 'pickup_not_ready_reminder', store, key, withinHours: 24 })) {
          reminderOrders.push(order);
        }
      }

      const newResult = await mailNewPickup({ store, recipient, orders: newOrders, dryRun });
      const reminderResult = await mailPickupReminder({ store, recipient, orders: reminderOrders, dryRun });

      for (const order of newOrders) {
        await appendMailLog({ type: 'pickup_new_store', store, key: orderKey(order), order: orderNumber(order), status: dryRun ? 'dry_run' : 'sent', recipient: recipient.email, resendId: newResult.resendId || '' });
      }

      for (const order of reminderOrders) {
        await appendMailLog({ type: 'pickup_not_ready_reminder', store, key: orderKey(order), order: orderNumber(order), status: dryRun ? 'dry_run' : 'sent', recipient: recipient.email, resendId: reminderResult.resendId || '' });
      }

      results.push({ store, open: orders.length, newMails: newResult.count, reminderMails: reminderResult.count });
    } catch (error) {
      results.push({ store, error: error.message });
      await appendMailLog({ type: 'pickup_run_error', store, key: 'run', status: 'error', message: error.message });
    }
  }

  return res.status(200).json({
    success: true,
    dryRun,
    stores: stores.length,
    results
  });
}
