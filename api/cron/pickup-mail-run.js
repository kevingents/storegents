import { appendMailLog, getMailLog, wasSentRecently } from '../../lib/gents-mail-log-store.js';
import { ageLabel, operationalDaysBetween } from '../../lib/gents-business-deadline.js';
import { baseMailHtml, rowsTable, sendMail } from '../../lib/gents-mailer.js';
import { fetchInternalApi, getStoreMail, getStoreMailAsync, getStoreNames, isExcludedStore, requireCronSecret } from '../../lib/gents-mail-config.js';
import { getGroupMailRecipients } from '../../lib/mail-recipient-resolver.js';
import { trackedCron } from '../../lib/cron-auto-track.js';

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
  /* Centrale helper: base-URL + x-admin-token + Deployment-Protection bypass
     + HTML-respons-detectie op één plek (lib/gents-mail-config.js). */
  const data = await fetchInternalApi(
    req,
    `/api/pickup-orders?store=${encodeURIComponent(store)}&status=open&days=14&t=${Date.now()}`,
    { timeoutMs: 30000 }
  );
  return data.orders || [];
}

/**
 * Bouw recipient-lijst voor een specifiek pickup-mail-type:
 *  - Default: recipient.email + recipient.cc (uit Winkel-emailadressen)
 *  - PLUS group-recipients indien er groups zijn met matchende mailRules
 *  - Bij rule.mode='replace' worden de default-recipients overgeslagen
 */
async function buildRecipients({ type, store, defaultRecipient }) {
  const { emails: groupEmails, hasReplaceRule, groups } = await getGroupMailRecipients({ type, store });
  const finalTo = new Set();
  const finalCc = new Set();

  if (!hasReplaceRule && defaultRecipient?.email) {
    finalTo.add(String(defaultRecipient.email).toLowerCase());
    for (const c of (defaultRecipient.cc || [])) {
      if (c) finalCc.add(String(c).toLowerCase());
    }
  }
  for (const e of groupEmails) finalTo.add(e);

  return {
    to: [...finalTo],
    cc: [...finalCc].filter((c) => !finalTo.has(c)),
    groupCount: groups.length,
    replaceUsed: hasReplaceRule
  };
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

  const rcpt = await buildRecipients({ type: 'pickup-new', store, defaultRecipient: recipient });
  if (!rcpt.to.length) return { sent: false, count: 0, resendId: '', skipped: 'no-recipients' };

  const result = await sendMail({
    to: rcpt.to,
    cc: rcpt.cc,
    subject: `Nieuwe ophaalorder${orders.length === 1 ? '' : 's'} - ${store}`,
    html,
    text: `Nieuwe ophaalorders voor ${store}: ${orders.map(orderNumber).join(', ')}`
  });

  return { sent: true, count: orders.length, resendId: result.resendId || '', groupCount: rcpt.groupCount };
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

  const rcpt = await buildRecipients({ type: 'pickup-reminder', store, defaultRecipient: recipient });
  if (!rcpt.to.length) return { sent: false, count: 0, resendId: '', skipped: 'no-recipients' };

  const result = await sendMail({
    to: rcpt.to,
    cc: rcpt.cc,
    subject: `Reminder ophaalorder${orders.length === 1 ? '' : 's'} - ${store}`,
    html,
    text: `Reminder ophaalorders voor ${store}: ${orders.map(orderNumber).join(', ')}`
  });

  return { sent: true, count: orders.length, resendId: result.resendId || '', groupCount: rcpt.groupCount };
}

async function handler(req, res) {
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

      /* Skip mail-log entries voor dry-run runs — anders vervuilt de log met
         "zou-verstuurd-zijn" rijen die geen echte mails representeren. */
      if (!dryRun) {
        for (const order of newOrders) {
          await appendMailLog({ type: 'pickup_new_store', store, key: orderKey(order), order: orderNumber(order), status: 'sent', recipient: recipient.email, resendId: newResult.resendId || '' });
        }

        for (const order of reminderOrders) {
          await appendMailLog({ type: 'pickup_not_ready_reminder', store, key: orderKey(order), order: orderNumber(order), status: 'sent', recipient: recipient.email, resendId: reminderResult.resendId || '' });
        }
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

export default trackedCron('pickup-mail-run', handler);
