import { appendMailLog, getMailLog, wasSentRecently } from '../../lib/gents-mail-log-store.js';
import { ageLabel, isOverdueWithWeekendRule, operationalDaysBetween } from '../../lib/gents-business-deadline.js';
import { baseMailHtml, rowsTable, sendMail } from '../../lib/gents-mailer.js';
import { getAdminToken, getApiBaseUrl, getStoreMail, getStoreNames, isExcludedStore, requireCronSecret } from '../../lib/gents-mail-config.js';

function setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function orderKey(row) {
  return String(row.fulfillmentId || row.id || row.orderNr || row.orderNumber || row.orderName || `${row.sku || ''}-${row.createdAt || ''}`).trim();
}

function orderNumber(row) {
  return String(row.orderNr || row.orderNumber || row.orderName || row.name || row.orderId || row.id || '-').trim();
}

function orderCreatedAt(row) {
  return row.createdAt || row.created_at || row.dateTime || row.created || row.updatedAt || '';
}

function sku(row) {
  return row.sku || row.barcode || row.productSku || row.articleNumber || '-';
}

function customer(row) {
  return row.customerName || row.customer || row.deliveryName || row.billingName || '-';
}

function quantity(row) {
  return row.quantity ?? row.pieces ?? row.aantal ?? 1;
}

function flattenOpenWeborders(data) {
  const summary = data.summary || {};
  const combined = [];

  ['requests', 'items', 'rows'].forEach((key) => {
    if (Array.isArray(data[key])) combined.push(...data[key]);
  });

  ['fulfilmentOpen', 'sellingOpen', 'overdue'].forEach((key) => {
    if (Array.isArray(summary[key])) combined.push(...summary[key]);
  });

  const map = new Map();
  for (const row of combined) {
    const key = orderKey(row);
    if (key && !map.has(key)) map.set(key, row);
  }

  return Array.from(map.values());
}

async function fetchStoreOpenWeborders(req, store) {
  const baseUrl = getApiBaseUrl(req);
  if (!baseUrl) throw new Error('GENTS_API_BASE_URL ontbreekt.');

  const url = `${baseUrl}/api/srs/open-weborders?store=${encodeURIComponent(store)}&t=${Date.now()}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'x-admin-token': getAdminToken()
    },
    signal: AbortSignal.timeout(Number(process.env.WEBORDER_MAIL_STORE_TIMEOUT_MS || 25000))
  });

  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_error) { data = { message: text }; }

  if (!response.ok || data.success === false) {
    throw new Error(data.message || data.error || `Openstaande weborders endpoint fout ${response.status}`);
  }

  return data;
}

function getOverdueRows(rows) {
  const deadlineDays = Number(process.env.WEBORDER_DEADLINE_OPERATIONAL_DAYS || 2);
  return (rows || []).filter((row) => {
    if (row.overdue === true) return true;
    return isOverdueWithWeekendRule(orderCreatedAt(row), deadlineDays);
  });
}

async function sendStoreOverdueMail({ store, recipient, overdueRows, dryRun }) {
  if (!overdueRows.length) return { sent: false, count: 0, resendId: '' };

  const html = baseMailHtml({
    title: `Te late openstaande orders - ${store}`,
    intro: 'Deze openstaande SRS/weborders zijn over de deadline. Zaterdag en zondag tellen samen als 1 operationele dag.',
    bodyHtml: rowsTable(overdueRows, [
      { label: 'Order', value: orderNumber },
      { label: 'Klant', value: customer },
      { label: 'SKU', value: sku },
      { label: 'Aantal', value: quantity },
      { label: 'Leeftijd', value: (row) => ageLabel(orderCreatedAt(row)) }
    ])
  });

  if (dryRun) return { sent: false, count: overdueRows.length, resendId: '' };

  const result = await sendMail({
    to: recipient.email,
    cc: recipient.cc,
    subject: `Actie nodig: ${overdueRows.length} te late order${overdueRows.length === 1 ? '' : 's'} - ${store}`,
    html,
    text: `Te late orders voor ${store}: ${overdueRows.map(orderNumber).join(', ')}`
  });

  return { sent: true, count: overdueRows.length, resendId: result.resendId || '' };
}

async function sendRegionManagerMail({ store, recipient, overdueRows, dryRun }) {
  const managerRecipients = recipient.regionManagerEmail || [];
  if (!managerRecipients.length || !overdueRows.length) return { sent: false, count: 0, resendId: '' };

  const escalationRows = overdueRows.filter((row) => operationalDaysBetween(orderCreatedAt(row)) >= 4);
  if (!escalationRows.length) return { sent: false, count: 0, resendId: '' };

  const html = baseMailHtml({
    title: `Escalatie te late orders - ${store}`,
    intro: 'Deze openstaande orders staan 4 operationele dagen of langer open. Controle door regiomanager gewenst.',
    bodyHtml: rowsTable(escalationRows, [
      { label: 'Order', value: orderNumber },
      { label: 'Klant', value: customer },
      { label: 'SKU', value: sku },
      { label: 'Aantal', value: quantity },
      { label: 'Leeftijd', value: (row) => ageLabel(orderCreatedAt(row)) }
    ])
  });

  if (dryRun) return { sent: false, count: escalationRows.length, resendId: '' };

  const result = await sendMail({
    to: managerRecipients,
    subject: `Escalatie: ${escalationRows.length} order${escalationRows.length === 1 ? '' : 's'} langer dan 4 dagen open - ${store}`,
    html,
    text: `Escalatie ${store}: ${escalationRows.map(orderNumber).join(', ')}`
  });

  return { sent: true, count: escalationRows.length, resendId: result.resendId || '' };
}

export default async function handler(req, res) {
  setNoStore(res);
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen GET/POST is toegestaan.' });
  }

  if (!requireCronSecret(req, res, 'WEBORDER_MAIL_SECRET')) return;

  const dryRun = String(req.query.dryRun || req.query.preview || '') === '1';
  const onlyStore = String(req.query.store || '').trim();
  const stores = onlyStore ? [onlyStore] : getStoreNames().filter((store) => !isExcludedStore(store));
  const logRows = await getMailLog();
  const results = [];

  for (const store of stores) {
    const recipient = getStoreMail(store);

    if (!recipient.email) {
      results.push({ store, skipped: true, reason: 'Geen winkel e-mail ingesteld.' });
      await appendMailLog({ type: 'weborder_config', store, key: 'missing_email', status: 'error', message: 'Geen winkel e-mail ingesteld.' });
      continue;
    }

    try {
      const data = await fetchStoreOpenWeborders(req, store);
      const rows = flattenOpenWeborders(data);
      const overdueRows = getOverdueRows(rows);

      const storeMailRows = overdueRows.filter((row) => !wasSentRecently(logRows, {
        type: 'weborder_overdue_store',
        store,
        key: orderKey(row),
        withinHours: 20
      }));

      const managerRows = overdueRows.filter((row) => operationalDaysBetween(orderCreatedAt(row)) >= 4 && !wasSentRecently(logRows, {
        type: 'weborder_overdue_region_manager',
        store,
        key: orderKey(row),
        withinHours: 20
      }));

      const storeMail = await sendStoreOverdueMail({ store, recipient, overdueRows: storeMailRows, dryRun });
      const managerMail = await sendRegionManagerMail({ store, recipient, overdueRows: managerRows, dryRun });

      for (const row of storeMailRows) {
        await appendMailLog({ type: 'weborder_overdue_store', store, key: orderKey(row), order: orderNumber(row), status: dryRun ? 'dry_run' : 'sent', recipient: recipient.email, resendId: storeMail.resendId || '' });
      }

      for (const row of managerRows) {
        await appendMailLog({ type: 'weborder_overdue_region_manager', store, key: orderKey(row), order: orderNumber(row), status: dryRun ? 'dry_run' : 'sent', recipient: (recipient.regionManagerEmail || []).join(', '), resendId: managerMail.resendId || '' });
      }

      results.push({ store, open: rows.length, overdue: overdueRows.length, storeMails: storeMail.count, regionManagerMails: managerMail.count, source: data.source || 'open-weborders' });
    } catch (error) {
      results.push({ store, error: error.message });
      await appendMailLog({ type: 'weborder_run_error', store, key: 'run', status: 'error', message: error.message });
    }
  }

  return res.status(200).json({
    success: true,
    dryRun,
    stores: stores.length,
    results
  });
}
