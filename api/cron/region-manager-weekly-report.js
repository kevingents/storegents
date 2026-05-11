import { appendMailLog } from '../../lib/gents-mail-log-store.js';
import { ageLabel, isOverdueWithWeekendRule, operationalDaysBetween } from '../../lib/gents-business-deadline.js';
import { baseMailHtml, rowsTable, sendMail } from '../../lib/gents-mailer.js';
import { getAdminToken, getApiBaseUrl, requireCronSecret } from '../../lib/gents-mail-config.js';
import { getRegionReportConfig } from '../../lib/region-report-config-store.js';

function setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function hasAdminAccess(req) {
  const expected = getAdminToken();
  const given = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(expected && given && expected === given);
}

function isoDate(date) { return date.toISOString().slice(0, 10); }
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function startOfPreviousWeek() {
  const now = new Date();
  const day = now.getDay() || 7;
  const mondayThisWeek = addDays(now, 1 - day);
  return addDays(mondayThisWeek, -7);
}
function endOfPreviousWeek() { return addDays(startOfPreviousWeek(), 6); }

function orderKey(row = {}) {
  return String(row.fulfillmentId || row.id || row.orderNr || row.orderNumber || row.orderName || `${row.sku || ''}-${row.createdAt || ''}`).trim();
}
function orderNumber(row = {}) {
  return String(row.orderNr || row.orderNumber || row.orderName || row.name || row.orderId || row.id || '-').trim();
}
function orderCreatedAt(row = {}) {
  return row.createdAt || row.created_at || row.dateTime || row.created || row.updatedAt || '';
}
function flattenOpenWeborders(data = {}) {
  const summary = data.summary || {};
  const combined = [];
  ['requests', 'items', 'rows'].forEach((key) => Array.isArray(data[key]) && combined.push(...data[key]));
  ['currentOpen', 'fulfilmentOpen', 'fulfillmentOpen', 'overdue'].forEach((key) => Array.isArray(summary[key]) && combined.push(...summary[key]));
  const map = new Map();
  for (const row of combined) {
    const key = orderKey(row);
    if (key && !map.has(key)) map.set(key, row);
  }
  return Array.from(map.values());
}
function number(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

async function fetchJson(url, label, timeoutMs = 45000) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'x-admin-token': getAdminToken() },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_error) { data = { message: text }; }
  if (!response.ok || data.success === false) throw new Error(`${label}: ${data.message || data.error || response.status}`);
  return data;
}

function metricFromScoreboard(row = {}) {
  const c = row.components || {};
  return {
    store: row.store,
    labelCreated: number(c.labelCreated),
    customersWithEmail: number(c.withEmail ?? c.loyaltyOptIn ?? 0),
    customersWithoutEmail: number(c.withoutEmail ?? Math.max(0, number(c.customerRegistrations) - number(c.withEmail ?? c.loyaltyOptIn ?? 0))),
    customerRegistrations: number(c.customerRegistrations)
  };
}

function summarizeRegion({ region, scoreboardRows, overdueByStore, exchangeRows }) {
  const stores = new Set(region.stores || []);
  const metrics = scoreboardRows.filter((row) => stores.has(row.store)).map(metricFromScoreboard);
  const overdueStores = Array.from(overdueByStore.values()).filter((row) => stores.has(row.store) && row.overdueCount > 0);
  const exchanges = exchangeRows.filter((row) => stores.has(row.store || row.toStore || row.destinationStore || row.targetStore));

  return {
    region,
    metrics,
    overdueStores,
    exchanges,
    totals: {
      labelCreated: metrics.reduce((sum, row) => sum + row.labelCreated, 0),
      customersWithEmail: metrics.reduce((sum, row) => sum + row.customersWithEmail, 0),
      customersWithoutEmail: metrics.reduce((sum, row) => sum + row.customersWithoutEmail, 0),
      customerRegistrations: metrics.reduce((sum, row) => sum + row.customerRegistrations, 0),
      overdueOrderStores: overdueStores.length,
      overdueOrders: overdueStores.reduce((sum, row) => sum + number(row.overdueCount), 0),
      overdueExchanges: exchanges.length
    }
  };
}

function reportHtml(summary, dateFrom, dateTo) {
  const metricRows = summary.metrics.sort((a, b) => a.store.localeCompare(b.store, 'nl'));
  const overdueRows = summary.overdueStores.sort((a, b) => b.overdueCount - a.overdueCount || a.store.localeCompare(b.store, 'nl'));
  const exchangeRows = summary.exchanges.slice(0, 80);
  return `
    <div style="display:grid;gap:12px;margin-bottom:18px;">
      <div style="padding:16px;border:1px solid #e1e6eb;border-radius:16px;background:#f8fafc;">
        <strong>Periode:</strong> ${esc(dateFrom)} t/m ${esc(dateTo)}<br>
        <strong>Winkels in regio:</strong> ${esc((summary.region.stores || []).join(', '))}
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;">
        ${[
          ['Winkels te laat', summary.totals.overdueOrderStores],
          ['Te late orders', summary.totals.overdueOrders],
          ['Labels', summary.totals.labelCreated],
          ['Uitwisselingen te laat', summary.totals.overdueExchanges]
        ].map(([label, value]) => `<div style="padding:14px;border:1px solid #e1e6eb;border-radius:14px;background:#fff;"><span style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#3a4a5a;font-weight:700;">${esc(label)}</span><strong style="display:block;font-size:28px;color:#0a1f33;">${esc(value)}</strong></div>`).join('')}
      </div>
    </div>
    <h2 style="font-size:18px;color:#0a1f33;">Winkels die te laat hebben geleverd</h2>
    ${overdueRows.length ? rowsTable(overdueRows, [
      { label: 'Winkel', value: (row) => row.store },
      { label: 'Open orders', value: (row) => row.openCount },
      { label: 'Te laat', value: (row) => row.overdueCount },
      { label: 'Oudste', value: (row) => `${row.oldestAgeHours || 0} uur` }
    ]) : '<p style="color:#3a4a5a;">Geen te late openstaande orders in deze regio.</p>'}
    <h2 style="font-size:18px;color:#0a1f33;margin-top:24px;">Labels en klantinschrijvingen</h2>
    ${rowsTable(metricRows, [
      { label: 'Winkel', value: (row) => row.store },
      { label: 'Labels', value: (row) => row.labelCreated },
      { label: 'Klanten met e-mail', value: (row) => row.customersWithEmail },
      { label: 'Klanten zonder e-mail', value: (row) => row.customersWithoutEmail }
    ])}
    <h2 style="font-size:18px;color:#0a1f33;margin-top:24px;">Uitwisselingen te laat</h2>
    ${exchangeRows.length ? rowsTable(exchangeRows, [
      { label: 'Winkel', value: (row) => row.store || row.toStore || row.destinationStore || row.targetStore || '-' },
      { label: 'Order', value: (row) => row.orderNr || row.orderNumber || row.id || '-' },
      { label: 'Leeftijd', value: (row) => ageLabel(row.createdAt || row.dateTime || row.updatedAt) },
      { label: 'Status', value: (row) => row.status || '-' }
    ]) : '<p style="color:#3a4a5a;">Geen te late uitwisselingen gevonden.</p>'}`;
}

export default async function handler(req, res) {
  setNoStore(res);
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen GET/POST is toegestaan.' });
  const dryRun = String(req.query.dryRun || req.query.preview || '') === '1';
  if (!hasAdminAccess(req) && !requireCronSecret(req, res, 'REGION_REPORT_SECRET')) return;

  const dateFrom = String(req.query.dateFrom || req.query.from || isoDate(startOfPreviousWeek())).trim();
  const dateTo = String(req.query.dateTo || req.query.to || isoDate(endOfPreviousWeek())).trim();
  const onlyRegion = String(req.query.region || '').trim();
  const baseUrl = getApiBaseUrl(req);
  const config = await getRegionReportConfig();
  const token = encodeURIComponent(getAdminToken());
  const query = `dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}&from=${encodeURIComponent(dateFrom)}&to=${encodeURIComponent(dateTo)}&adminToken=${token}&admin_token=${token}`;
  const warnings = [];

  let scoreboardRows = [];
  try {
    const scoreboard = await fetchJson(`${baseUrl}/api/admin/scoreboard/omnichannel?${query}`, 'omnichannel-scoreboard');
    scoreboardRows = Array.isArray(scoreboard.rows) ? scoreboard.rows : [];
  } catch (error) { warnings.push(error.message); }

  const overdueByStore = new Map();
  for (const region of config.regions || []) {
    for (const store of region.stores || []) {
      try {
        const data = await fetchJson(`${baseUrl}/api/srs/open-weborders?store=${encodeURIComponent(store)}&t=${Date.now()}`, `open-weborders ${store}`, 30000);
        const rows = flattenOpenWeborders(data);
        const overdue = rows.filter((row) => row.overdue === true || isOverdueWithWeekendRule(orderCreatedAt(row), config.deadlineOperationalDays || 2));
        overdueByStore.set(store, { store, openCount: rows.length, overdueCount: overdue.length, oldestAgeHours: Math.max(0, ...overdue.map((row) => operationalDaysBetween(orderCreatedAt(row)) * 24)) });
      } catch (error) { warnings.push(error.message); }
    }
  }

  let exchangeRows = [];
  try {
    const exchanges = await fetchJson(`${baseUrl}/api/admin/exchanges?${query}`, 'admin-exchanges', 30000);
    const rows = Array.isArray(exchanges.rows) ? exchanges.rows : Array.isArray(exchanges.exchanges) ? exchanges.exchanges : [];
    exchangeRows = rows.filter((row) => row.overdue === true || isOverdueWithWeekendRule(row.createdAt || row.dateTime || row.updatedAt, config.exchangeDeadlineOperationalDays || 7));
  } catch (error) {
    warnings.push(`admin-exchanges niet beschikbaar: ${error.message}`);
  }

  const results = [];
  for (const region of config.regions || []) {
    if (onlyRegion && region.id !== onlyRegion && region.name !== onlyRegion) continue;
    const summary = summarizeRegion({ region, scoreboardRows, overdueByStore, exchangeRows });
    if (!region.email) {
      results.push({ region: region.name, skipped: true, reason: 'Geen regiomanager e-mail ingesteld.', totals: summary.totals });
      continue;
    }

    const html = baseMailHtml({
      title: `Weekrapport ${region.name}`,
      intro: 'Wekelijkse rapportage met te late orders, labels, klantinschrijvingen en te late uitwisselingen.',
      bodyHtml: reportHtml(summary, dateFrom, dateTo)
    });

    if (!dryRun) {
      await sendMail({
        to: region.email,
        cc: region.cc,
        subject: `GENTS weekrapport ${region.name} - ${dateFrom} t/m ${dateTo}`,
        html,
        text: `Weekrapport ${region.name}: ${summary.totals.overdueOrders} te late orders, ${summary.totals.labelCreated} labels, ${summary.totals.customerRegistrations} klantinschrijvingen.`
      });
      await appendMailLog({ type: 'region_manager_weekly_report', store: region.name, key: `${dateFrom}_${dateTo}`, status: 'sent', recipient: region.email });
    }

    results.push({ region: region.name, recipient: region.email, dryRun, totals: summary.totals });
  }

  return res.status(200).json({ success: true, dryRun, dateFrom, dateTo, warnings, results });
}
