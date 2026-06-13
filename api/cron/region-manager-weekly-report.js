import { appendMailLog } from '../../lib/gents-mail-log-store.js';
import { ageLabel, isOverdueWithWeekendRule, operationalDaysBetween } from '../../lib/gents-business-deadline.js';
import { baseMailHtml, rowsTable, sendMail } from '../../lib/gents-mailer.js';
import { getAdminToken, getApiBaseUrl, requireCronSecret } from '../../lib/gents-mail-config.js';
import { getRegionReportConfig } from '../../lib/region-report-config-store.js';
import { addCurrentOverdueOrder, addLoggedWeeklyOverdueOrders, ensureWeeklyStoreRow } from '../../lib/region-weekly-overdue-memory.js';
import { addSnapshotWeeklyOverdueOrders } from '../../lib/weekly-overdue-snapshot-store.js';
import { getDragerCache, summarizeDragers } from '../../lib/srs-dragers-store.js';
import { getOrderCancellations, cancellationLineRows } from '../../lib/order-cancellation-store.js';
import { trackedCron } from '../../lib/cron-auto-track.js';

function setNoStore(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-pin, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function hasAdminAccess(req) {
  const expected = getAdminToken();
  const given = String(req.headers['x-admin-token'] || req.headers['x-admin-pin'] || req.headers.authorization || req.query.adminToken || req.query.admin_token || req.query.token || '').replace(/^Bearer\s+/i, '').trim();
  return Boolean(expected && given && expected === given);
}

function isoDate(date) { return date.toISOString().slice(0, 10); }
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function startOfPreviousWeek(now = new Date()) { const day = now.getDay() || 7; return addDays(addDays(now, 1 - day), -7); }
function endOfPreviousWeek(now = new Date()) { return addDays(startOfPreviousWeek(now), 6); }

/* Day-of-week in 1..7 (1=ma, 7=zo) zoals ISO-8601 verwacht. */
function nlDayOfWeek(date) {
  const d = date.getUTCDay();
  return d === 0 ? 7 : d;
}

/* ISO-week-nummer (1..53) — gebruikt voor biweekly schedule check. */
function isoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

/* Bepaalt of de cron-handler vandaag een mail moet sturen. De Vercel-
   cron fireert dagelijks; deze check filtert per config. */
function shouldRunToday(schedule = {}, now = new Date()) {
  const freq = schedule.frequency || 'weekly';
  const dow = nlDayOfWeek(now);
  if (freq === 'weekly') return dow === Number(schedule.dayOfWeek || 1);
  if (freq === 'biweekly') return dow === Number(schedule.dayOfWeek || 1) && isoWeekNumber(now) % 2 === 0;
  if (freq === 'monthly') return now.getUTCDate() === Number(schedule.dayOfMonth || 1);
  return false;
}

/* Date-range per gekozen periode-modus. Default = vorige kalender-week. */
function periodRange(period, now = new Date()) {
  if (period === 'last-2-weeks') {
    const end = endOfPreviousWeek(now);
    const start = addDays(end, -13);
    return { from: isoDate(start), to: isoDate(end), label: 'vorige 2 weken' };
  }
  if (period === 'last-month') {
    const firstOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const lastOfPreviousMonth = addDays(firstOfThisMonth, -1);
    const firstOfPreviousMonth = new Date(Date.UTC(lastOfPreviousMonth.getUTCFullYear(), lastOfPreviousMonth.getUTCMonth(), 1));
    return { from: isoDate(firstOfPreviousMonth), to: isoDate(lastOfPreviousMonth), label: 'vorige maand' };
  }
  return { from: isoDate(startOfPreviousWeek(now)), to: isoDate(endOfPreviousWeek(now)), label: 'vorige week' };
}

/* Het venster direct vóór wat periodRange teruggeeft — voor de vergelijking
   "t.o.v. de periode ervoor". Week/2-weken: even lang, direct ervoor.
   Maand: de kalendermaand ervoor. */
function previousPeriodRange(period, now = new Date()) {
  const cur = periodRange(period, now);
  const from = new Date(cur.from);
  const to = new Date(cur.to);
  if (period === 'last-month') {
    const firstOfCur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
    const lastPrev = addDays(firstOfCur, -1);
    const firstPrev = new Date(Date.UTC(lastPrev.getUTCFullYear(), lastPrev.getUTCMonth(), 1));
    return { from: isoDate(firstPrev), to: isoDate(lastPrev), label: 'maand ervoor' };
  }
  const lengthDays = Math.round((to - from) / 86400000) + 1;
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(lengthDays - 1));
  return { from: isoDate(prevFrom), to: isoDate(prevTo), label: period === 'last-2-weeks' ? '2 weken ervoor' : 'week ervoor' };
}

function number(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function esc(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
function orderKey(row = {}) { return String(row.fulfillmentId || row.id || row.orderNr || row.orderNumber || row.orderName || `${row.sku || ''}-${row.createdAt || ''}`).trim(); }
function orderCreatedAt(row = {}) { return row.createdAt || row.created_at || row.dateTime || row.created || row.updatedAt || ''; }
function exchangeStore(row = {}) { return row.store || row.toStore || row.destinationStore || row.targetStore || 'Onbekend'; }

function flattenOpenWeborders(data = {}) {
  const summary = data.summary || {};
  const combined = [];
  ['requests', 'items', 'rows'].forEach((key) => Array.isArray(data[key]) && combined.push(...data[key]));
  ['currentOpen', 'fulfilmentOpen', 'fulfillmentOpen', 'overdue'].forEach((key) => Array.isArray(summary[key]) && combined.push(...summary[key]));
  const map = new Map();
  for (const row of combined) { const key = orderKey(row); if (key && !map.has(key)) map.set(key, row); }
  return Array.from(map.values());
}

async function fetchJson(url, label, timeoutMs = 45000) {
  const response = await fetch(url, { headers: { Accept: 'application/json', 'x-admin-token': getAdminToken() }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_error) { data = { message: text }; }
  if (!response.ok || data.success === false) {
    const detail = typeof data.message === 'string' ? data.message : typeof data.error === 'string' ? data.error : data.message || data.error ? JSON.stringify(data.message || data.error) : response.status;
    throw new Error(`${label}: ${detail}`);
  }
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

/* Skips per winkel: hoe vaak een winkel een orderregel niet-leverbaar meldde
   (SRS cancel/unavailable-fulfillment) in de periode. Bron: order-cancellations
   (gevuld door de srs-cancellations-nightly cron, één record per skip met de
   meldende winkel + SRS-datum). Telt álle skips, ook als 'ie elders wél geleverd is. */
function skipsByStore(rows = [], { dateFrom = '', dateTo = '', stores = [] } = {}) {
  const storeSet = new Set((stores || []).map((s) => String(s || '').trim()));
  const from = dateFrom ? new Date(dateFrom) : null;
  const to = dateTo ? new Date(dateTo) : null;
  const toExclusive = to && !Number.isNaN(to.getTime())
    ? new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1)
    : null;
  const map = new Map();
  for (const row of rows) {
    const store = String(row.store || row.lastResponsibleStore || '').trim();
    if (!store || !storeSet.has(store)) continue;
    const raw = row.createdAt || row.processedAt || row.updatedAt;
    const d = raw ? new Date(raw) : null;
    if (!d || Number.isNaN(d.getTime())) continue;
    if (from && d < from) continue;
    if (toExclusive && d >= toExclusive) continue;
    if (!map.has(store)) map.set(store, { store, skips: 0, items: 0, _orders: new Set() });
    const m = map.get(store);
    m.skips += 1;
    m.items += number(row.quantity || 1);
    if (row.orderNr) m._orders.add(String(row.orderNr));
  }
  return Array.from(map.values())
    .map((m) => ({ store: m.store, skips: m.skips, items: m.items, orders: m._orders.size }))
    .sort((a, b) => b.skips - a.skips || a.store.localeCompare(b.store, 'nl'));
}

/* Voeg de skips van de huidige periode samen met die van de periode ervoor,
   per winkel, met het verschil. Toont ook winkels die naar 0 zakten (verbetering). */
function mergeSkipComparison(current = [], previous = []) {
  const prevMap = new Map(previous.map((r) => [r.store, r.skips]));
  const curMap = new Map(current.map((r) => [r.store, r]));
  const stores = new Set([...current.map((r) => r.store), ...previous.map((r) => r.store)]);
  return [...stores].map((store) => {
    const c = curMap.get(store) || { skips: 0, items: 0, orders: 0 };
    const prevSkips = number(prevMap.get(store));
    return { store, skips: c.skips, items: c.items, orders: c.orders, prevSkips, deltaSkips: c.skips - prevSkips };
  }).sort((a, b) => b.skips - a.skips || b.prevSkips - a.prevSkips || a.store.localeCompare(b.store, 'nl'));
}

/* "+3" (meer = slechter) / "-2" (minder = beter) / "0" — als tekst, want
   rowsTable escapet HTML (geen kleur mogelijk). */
function deltaLabel(delta) {
  const d = number(delta);
  if (d > 0) return `+${d}`;
  if (d < 0) return `${d}`;
  return '0';
}

function exchangeTotalsByStore(exchangeRows = []) {
  const map = new Map();
  for (const row of exchangeRows) {
    const store = exchangeStore(row);
    if (!map.has(store)) map.set(store, { store, overdueExchanges: 0 });
    map.get(store).overdueExchanges += 1;
  }
  return Array.from(map.values()).sort((a, b) => b.overdueExchanges - a.overdueExchanges || a.store.localeCompare(b.store, 'nl'));
}

function summarizeRegion({ region, scoreboardRows, overdueByStore, dragerRows, skipStores = [] }) {
  const stores = new Set(region.stores || []);
  const metrics = scoreboardRows.filter((row) => stores.has(row.store)).map(metricFromScoreboard);
  const overdueStores = Array.from(overdueByStore.values()).filter((row) => stores.has(row.store) && row.overdueCount > 0);
  /* Openstaande dragers per toegewezen winkel: open + te laat (>drempel). */
  const dragerStores = [...stores].map((store) => {
    const s = summarizeDragers(dragerRows || [], store);
    return { store, openCount: s.openCount, overdueCount: s.overdueCount, oldestAgeHours: s.oldestAgeHours };
  }).filter((r) => r.openCount > 0 || r.overdueCount > 0)
    .sort((a, b) => b.overdueCount - a.overdueCount || b.openCount - a.openCount || a.store.localeCompare(b.store, 'nl'));

  return {
    region,
    metrics,
    overdueStores,
    dragerStores,
    skipStores,
    totals: {
      labelCreated: metrics.reduce((sum, row) => sum + row.labelCreated, 0),
      customersWithEmail: metrics.reduce((sum, row) => sum + row.customersWithEmail, 0),
      customersWithoutEmail: metrics.reduce((sum, row) => sum + row.customersWithoutEmail, 0),
      customerRegistrations: metrics.reduce((sum, row) => sum + row.customerRegistrations, 0),
      overdueOrderStores: overdueStores.length,
      overdueOrders: overdueStores.reduce((sum, row) => sum + number(row.overdueCount), 0),
      currentOverdueOrders: overdueStores.reduce((sum, row) => sum + number(row.currentOverdueCount), 0),
      processedAfterOverdue: overdueStores.reduce((sum, row) => sum + Math.max(0, number(row.overdueCount) - number(row.currentOverdueCount)), 0),
      openDragers: dragerStores.reduce((sum, row) => sum + number(row.openCount), 0),
      teLateDragers: dragerStores.reduce((sum, row) => sum + number(row.overdueCount), 0),
      winkelsMetDragers: dragerStores.length,
      skips: skipStores.reduce((sum, row) => sum + number(row.skips), 0),
      skipItems: skipStores.reduce((sum, row) => sum + number(row.items), 0),
      prevSkips: skipStores.reduce((sum, row) => sum + number(row.prevSkips), 0),
      deltaSkips: skipStores.reduce((sum, row) => sum + number(row.deltaSkips), 0),
      winkelsMetSkips: skipStores.filter((row) => number(row.skips) > 0).length
    }
  };
}

function reportHtml(summary, dateFrom, dateTo, periodLabel = 'vorige week', diagnostics = {}) {
  const region = summary.region || {};
  /* Default true tenzij expliciet false — backwards compat met oude config. */
  const sections = {
    pickpack: region.sections?.pickpack !== false,
    overdueOrders: region.sections?.overdueOrders !== false,
    /* "Openstaande dragers" vervangt de oude uitwisselingen-sectie (oude
       overdueExchanges-vlag blijft gerespecteerd voor backwards-compat). */
    openDragers: region.sections?.openDragers !== false && region.sections?.overdueExchanges !== false,
    customerSignups: region.sections?.customerSignups !== false,
    shippingLabels: region.sections?.shippingLabels !== false,
    /* Skips = hoe vaak een winkel niet-leverbaar meldde (bounce). Default aan. */
    skips: region.sections?.skips !== false
  };

  const metricRows = summary.metrics.sort((a, b) => a.store.localeCompare(b.store, 'nl'));
  const overdueRows = summary.overdueStores.sort((a, b) => b.overdueCount - a.overdueCount || a.store.localeCompare(b.store, 'nl'));

  /* Diagnose-banner: toon ALLEEN als data-fetches faalden of de mail
     verdacht leeg is (alle metrics nul én geen stores in regio of geen
     data-rijen). Anders is dit overbodige ruis voor de regio-manager. */
  const allZero =
    summary.totals.overdueOrders === 0 &&
    summary.totals.labelCreated === 0 &&
    summary.totals.customerRegistrations === 0 &&
    summary.totals.openDragers === 0 &&
    summary.totals.skips === 0;
  const hasWarnings = (diagnostics.scoreboardWarnings || []).length > 0 ||
                      (diagnostics.cronWarnings || []).length > 0;
  const dq = diagnostics.scoreboardDataQuality || {};
  const shouldShowDiagnostics = hasWarnings || (allZero && metricRows.length === 0);

  const diagnosticsBlock = shouldShowDiagnostics ? `
    <div style="margin-bottom:14px;padding:14px;border:1px solid #fbbf24;background:#fffbeb;border-radius:12px;font-size:13px;color:#78350f">
      <strong style="display:block;margin-bottom:6px;color:#92400e">⚠ Diagnose: dit rapport bevat mogelijk geen volledige data</strong>
      ${allZero && !hasWarnings ? `<p style="margin:6px 0;color:#78350f">Alle metrics zijn 0 — controleer of de data-bronnen (scoreboard, SRS, exchanges) draaien. Mogelijk vakantie-periode of een stille storing.</p>` : ''}
      ${(diagnostics.scoreboardWarnings || []).length ? `<p style="margin:8px 0 4px;color:#78350f"><strong>Scoreboard problemen:</strong></p>
        <ul style="margin:0;padding-left:18px;font-size:12px;color:#78350f">
          ${diagnostics.scoreboardWarnings.slice(0, 8).map((w) => `<li>${esc(String(w))}</li>`).join('')}
        </ul>` : ''}
      ${(diagnostics.cronWarnings || []).length ? `<p style="margin:8px 0 4px;color:#78350f"><strong>Cron problemen:</strong></p>
        <ul style="margin:0;padding-left:18px;font-size:12px;color:#78350f">
          ${diagnostics.cronWarnings.slice(0, 8).map((w) => `<li>${esc(String(w))}</li>`).join('')}
        </ul>` : ''}
      ${Object.keys(dq).length ? `<p style="margin:8px 0 4px;color:#78350f"><strong>Data-quality flags:</strong></p>
        <ul style="margin:0;padding-left:18px;font-size:12px;color:#78350f">
          <li>Klantdata beschikbaar: ${dq.hasCustomerData ? 'ja' : 'NEE'}</li>
          <li>Label-aantal opgehaald: ${number(dq.labelCount || 0)}</li>
          <li>Bron-klanten: ${number(dq.sourceCustomerCount || 0)}</li>
          <li>Annuleringen-regels: ${number(dq.cancellationLineCount || 0)}</li>
        </ul>` : ''}
      <p style="margin:8px 0 0;font-size:11.5px;color:#92400e">Admin: kijk in /api/admin/scoreboard/omnichannel met dezelfde periode om de bron te controleren.</p>
    </div>
  ` : '';

  /* Bouw totals-rijen alleen voor secties die aan staan. */
  const totalsRows = [];
  if (sections.overdueOrders) {
    totalsRows.push({ label: 'Winkels te laat', value: summary.totals.overdueOrderStores });
    totalsRows.push({ label: 'Te laat in periode', value: summary.totals.overdueOrders });
    totalsRows.push({ label: 'Nu nog te laat', value: summary.totals.currentOverdueOrders });
    totalsRows.push({ label: 'Verwerkt na te laat', value: summary.totals.processedAfterOverdue });
  }
  if (sections.skips) {
    const compareLabel = summary.skipCompareLabel || 'periode ervoor';
    totalsRows.push({
      label: 'Niet-leverbaar gemeld (skips)',
      value: `${summary.totals.skips} (${compareLabel}: ${summary.totals.prevSkips}, ${deltaLabel(summary.totals.deltaSkips)})`
    });
    totalsRows.push({ label: 'Winkels met skips', value: summary.totals.winkelsMetSkips });
  }
  if (sections.shippingLabels) totalsRows.push({ label: 'Labels', value: summary.totals.labelCreated });
  if (sections.customerSignups) {
    totalsRows.push({ label: 'Klanten met e-mail', value: summary.totals.customersWithEmail });
    totalsRows.push({ label: 'Klanten zonder e-mail', value: summary.totals.customersWithoutEmail });
  }
  if (sections.openDragers) {
    totalsRows.push({ label: 'Open dragers', value: summary.totals.openDragers });
    totalsRows.push({ label: 'Dragers te laat', value: summary.totals.teLateDragers });
  }

  return `
    ${diagnosticsBlock}
    <div style="display:grid;gap:12px;margin-bottom:18px;">
      <div style="padding:16px;border:1px solid #e1e6eb;border-radius:16px;background:#f8fafc;">
        <strong>Periode:</strong> ${esc(periodLabel)} (${esc(dateFrom)} t/m ${esc(dateTo)})<br>
        <strong>Winkels in regio:</strong> ${esc((region.stores || []).join(', '))}<br>
        <span style="color:#3a4a5a;">Orders blijven meetellen zodra ze in deze periode als te laat zijn geregistreerd, ook als ze later verwerkt zijn.</span>
      </div>
    </div>
    ${totalsRows.length ? `<h2 style="font-size:18px;color:#0a1f33;">Regio totaal</h2>
    ${rowsTable(totalsRows, [{ label: 'Metric', value: (row) => row.label }, { label: 'Aantal', value: (row) => row.value }])}` : ''}
    ${sections.overdueOrders ? `<h2 style="font-size:18px;color:#0a1f33;">Winkels die te laat hebben geleverd</h2>
    ${overdueRows.length ? rowsTable(overdueRows, [
      { label: 'Winkel', value: (row) => row.store },
      { label: 'Open orders nu', value: (row) => row.openCount },
      { label: 'Te laat in periode', value: (row) => row.overdueCount },
      { label: 'Nu nog te laat', value: (row) => row.currentOverdueCount || 0 },
      { label: 'Verwerkt na te laat', value: (row) => Math.max(0, number(row.overdueCount) - number(row.currentOverdueCount)) },
      { label: 'Oudste huidige', value: (row) => row.oldestAgeHours ? `${row.oldestAgeHours} uur` : '-' }
    ]) : '<p style="color:#3a4a5a;">Geen te late orders in deze regio geregistreerd.</p>'}` : ''}
    ${sections.skips ? `<h2 style="font-size:18px;color:#0a1f33;margin-top:24px;">Niet-leverbaar gemeld (skips per winkel)</h2>
    <p style="color:#3a4a5a;font-size:13px;margin:0 0 8px;">Hoe vaak een winkel een orderregel niet-leverbaar meldde, waardoor de order naar een andere winkel ging. Veel skips = vaak geen voorraad of niet opgepakt. "Verschil" vergelijkt met de ${esc(summary.skipCompareLabel || 'periode ervoor')} (+ = meer skips, dus slechter).</p>
    ${(summary.skipStores || []).length ? rowsTable(summary.skipStores, [
      { label: 'Winkel', value: (row) => row.store },
      { label: 'Skips', value: (row) => row.skips },
      { label: summary.skipCompareLabel || 'Ervoor', value: (row) => row.prevSkips },
      { label: 'Verschil', value: (row) => deltaLabel(row.deltaSkips) },
      { label: 'Artikelen', value: (row) => row.items },
      { label: 'Orders', value: (row) => row.orders }
    ]) : '<p style="color:#3a4a5a;">Geen skips geregistreerd in deze of de vorige periode.</p>'}` : ''}
    ${(sections.shippingLabels || sections.customerSignups) ? `<h2 style="font-size:18px;color:#0a1f33;margin-top:24px;">${sections.shippingLabels && sections.customerSignups ? 'Labels en klantinschrijvingen' : sections.shippingLabels ? 'Verzendlabels' : 'Klantinschrijvingen'}</h2>
    ${rowsTable(metricRows, [
      { label: 'Winkel', value: (row) => row.store },
      ...(sections.shippingLabels ? [{ label: 'Labels', value: (row) => row.labelCreated }] : []),
      ...(sections.customerSignups ? [
        { label: 'Klanten met e-mail', value: (row) => row.customersWithEmail },
        { label: 'Klanten zonder e-mail', value: (row) => row.customersWithoutEmail }
      ] : [])
    ])}` : ''}
    ${sections.openDragers ? `<h2 style="font-size:18px;color:#0a1f33;margin-top:24px;">Openstaande dragers per winkel</h2>
    <p style="color:#3a4a5a;font-size:13px;margin:0 0 8px;">Openstaande dragers (onderweg/nog binnen te melden) per toegewezen winkel, met hoeveel er te laat zijn.</p>
    ${summary.dragerStores.length ? rowsTable(summary.dragerStores, [
      { label: 'Winkel', value: (row) => row.store },
      { label: 'Open dragers', value: (row) => row.openCount },
      { label: 'Te laat', value: (row) => row.overdueCount },
      { label: 'Oudste', value: (row) => row.oldestAgeHours ? `${Math.floor(Number(row.oldestAgeHours) / 24)}d ${Math.round(Number(row.oldestAgeHours) % 24)}u` : '-' }
    ]) : '<p style="color:#3a4a5a;">Geen openstaande dragers voor de toegewezen winkels.</p>'}` : ''}`;
}

async function handler(req, res) {
  setNoStore(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen GET/POST is toegestaan.' });
  const dryRun = String(req.query.dryRun || req.query.preview || '') === '1';
  const forceRun = String(req.query.force || req.query.forceRun || '') === '1';
  if (!hasAdminAccess(req) && !requireCronSecret(req, res, 'REGION_REPORT_SECRET')) return;

  const config = await getRegionReportConfig();

  /* Schedule-gating: Vercel-cron fireert dagelijks. Sla over als vandaag
     niet matcht met config.schedule, tenzij ?force=1 of ?dryRun=1 (preview). */
  const now = new Date();
  if (!forceRun && !dryRun && !shouldRunToday(config.schedule || {}, now)) {
    return res.status(200).json({
      success: true,
      skipped: 'schedule-mismatch',
      schedule: config.schedule,
      today: { dayOfWeek: nlDayOfWeek(now), dayOfMonth: now.getUTCDate(), isoWeek: isoWeekNumber(now) }
    });
  }

  const onlyRegion = String(req.query.region || '').trim();
  const baseUrl = getApiBaseUrl(req);
  const token = encodeURIComponent(getAdminToken());
  const warnings = [];

  /* Cache per period-key zodat regio's met dezelfde periode dezelfde
     fetch hergebruiken (scoreboard + exchanges zijn niet per-regio). */
  const periodCache = new Map();

  async function loadPeriodData(periodKey, dateFrom, dateTo) {
    if (periodCache.has(periodKey)) return periodCache.get(periodKey);
    /* refresh=1 bypassed de in-memory cache van /api/admin/scoreboard/omnichannel
       zodat we altijd verse data krijgen — de cron mag wat langzamer zijn,
       een gecachet-leeg-resultaat is veel erger. */
    const query = `dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}&from=${encodeURIComponent(dateFrom)}&to=${encodeURIComponent(dateTo)}&adminToken=${token}&admin_token=${token}`;
    let scoreboardRows = [];
    let scoreboardWarnings = [];
    let scoreboardDataQuality = null;
    try {
      const scoreboard = await fetchJson(`${baseUrl}/api/admin/scoreboard/omnichannel?${query}&refresh=1`, `omnichannel-scoreboard (${periodKey})`);
      scoreboardRows = Array.isArray(scoreboard.rows) ? scoreboard.rows : [];
      /* Scoreboard returnt ALTIJD 200 OK, ook bij interne fetch-fouten.
         Pak zelf de degraded-vlag + warnings array zodat we die kunnen
         doorgeven aan de mail-diagnose. */
      if (Array.isArray(scoreboard.warnings)) scoreboardWarnings = scoreboard.warnings;
      if (scoreboard.dataQuality) scoreboardDataQuality = scoreboard.dataQuality;
      if (scoreboard.degraded) warnings.push(`scoreboard degraded (${periodKey}): ${scoreboardWarnings.join(' | ') || 'onbekende reden'}`);
    } catch (error) { warnings.push(error.message); }
    const data = { scoreboardRows, scoreboardWarnings, scoreboardDataQuality };
    periodCache.set(periodKey, data);
    return data;
  }

  /* Openstaande dragers: snapshot van NU (niet periode-gebonden), één keer. */
  let dragerRows = [];
  try { dragerRows = await getDragerCache(); } catch (error) { warnings.push(`dragers niet beschikbaar: ${error.message}`); }

  /* Skips (niet-leverbaar gemeld) per winkel: alle annulering-regels één keer
     inlezen, daarna per regio op periode + winkels filteren. */
  let cancellationRows = [];
  try { cancellationRows = cancellationLineRows(await getOrderCancellations()); }
  catch (error) { warnings.push(`skips/annuleringen niet beschikbaar: ${error.message}`); }

  const results = [];
  for (const region of config.regions || []) {
    if (onlyRegion && region.id !== onlyRegion && region.name !== onlyRegion) continue;

    /* Per regio: bepaal eigen periode (last-week / last-2-weeks / last-month). */
    const { from: dateFrom, to: dateTo, label: periodLabel } = periodRange(region.period, now);
    const periodKey = `${dateFrom}_${dateTo}`;
    const { scoreboardRows, scoreboardWarnings, scoreboardDataQuality } = await loadPeriodData(periodKey, dateFrom, dateTo);

    /* Overdues moeten altijd per-store gefetched worden — geen caching. */
    const overdueByStore = new Map();
    for (const store of region.stores || []) {
      try {
        const data = await fetchJson(`${baseUrl}/api/srs/open-weborders?store=${encodeURIComponent(store)}&t=${Date.now()}`, `open-weborders ${store}`, 30000);
        const rows = flattenOpenWeborders(data);
        const overdue = rows.filter((row) => row.overdue === true || isOverdueWithWeekendRule(orderCreatedAt(row), config.deadlineOperationalDays || 2));
        const target = ensureWeeklyStoreRow(overdueByStore, store);
        target.openCount = rows.length;
        target.oldestAgeHours = Math.max(0, ...overdue.map((row) => operationalDaysBetween(orderCreatedAt(row)) * 24));
        for (const row of overdue) addCurrentOverdueOrder(overdueByStore, store, row, orderKey(row), operationalDaysBetween(orderCreatedAt(row)) * 24);
      } catch (error) { warnings.push(error.message); }
    }
    await addLoggedWeeklyOverdueOrders(overdueByStore, { dateFrom, dateTo });
    /* Volledige periode-telling uit de dagelijkse overdue-snapshot (los van de
       mail-log) — zo telt "te laat in periode" ook resolved orders mee. */
    await addSnapshotWeeklyOverdueOrders(overdueByStore, { dateFrom, dateTo, ensureWeeklyStoreRow });

    const prev = previousPeriodRange(region.period, now);
    const skipStores = mergeSkipComparison(
      skipsByStore(cancellationRows, { dateFrom, dateTo, stores: region.stores || [] }),
      skipsByStore(cancellationRows, { dateFrom: prev.from, dateTo: prev.to, stores: region.stores || [] })
    );

    const summary = summarizeRegion({ region, scoreboardRows, overdueByStore, dragerRows, skipStores });
    summary.skipCompareLabel = prev.label;
    summary.skipComparePeriod = prev;
    if (!region.email) {
      results.push({ region: region.name, skipped: true, reason: 'Geen regiomanager e-mail ingesteld.', period: periodLabel, totals: summary.totals });
      continue;
    }

    const html = baseMailHtml({
      title: `Weekrapport ${region.name}`,
      intro: `Rapportage over ${periodLabel} — te late orders, skips (niet-leverbaar gemeld), labels, klantinschrijvingen en openstaande dragers.`,
      bodyHtml: reportHtml(summary, dateFrom, dateTo, periodLabel, {
        scoreboardWarnings,
        scoreboardDataQuality,
        cronWarnings: warnings.filter((w) => w.includes(periodKey) || w.includes(region.name))
      })
    });

    if (!dryRun) {
      await sendMail({
        to: region.email,
        cc: region.cc,
        subject: `GENTS ${periodLabel === 'vorige maand' ? 'maandrapport' : 'weekrapport'} ${region.name} - ${dateFrom} t/m ${dateTo}`,
        html,
        text: `Rapportage ${region.name} (${periodLabel}): ${summary.totals.overdueOrders} te late orders, ${summary.totals.currentOverdueOrders} nu nog te laat, ${summary.totals.processedAfterOverdue} verwerkt na te laat, ${summary.totals.skips} skips (${summary.skipCompareLabel || 'ervoor'}: ${summary.totals.prevSkips}, ${deltaLabel(summary.totals.deltaSkips)}).`
      });
      await appendMailLog({ type: 'region_manager_weekly_report', store: region.name, key: `${dateFrom}_${dateTo}`, status: 'sent', recipient: region.email });
    }

    /* Diagnostics & HTML preview meegestuurd zodat de admin in de UI direct
       kan zien wat er in de mail zou staan + welke data-bron eventueel faalde. */
    results.push({
      region: region.name,
      recipient: region.email,
      period: periodLabel,
      dateFrom,
      dateTo,
      dryRun,
      totals: summary.totals,
      diagnostics: {
        scoreboardWarnings: scoreboardWarnings || [],
        scoreboardDataQuality: scoreboardDataQuality || null,
        cronWarnings: warnings.filter((w) => w.includes(periodKey) || w.includes(region.name))
      },
      ...(dryRun ? { htmlPreview: html } : {})
    });
  }

  return res.status(200).json({ success: true, dryRun, schedule: config.schedule, warnings, results });
}

export default trackedCron('region-manager-weekly-report', handler);
