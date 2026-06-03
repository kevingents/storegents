/**
 * Report data-fetchers.
 *
 * Mapt een `reportKey` (matchend met de RAPPORTAGES catalog in de frontend)
 * naar een fetcher-functie die {columns, rows, title, subtitle, totals,
 * filters} teruggeeft — een uniforme structuur voor CSV/PDF/email.
 *
 * Niet elke rapportage heeft een dedicated fetcher; sommige zijn UI-only
 * (drill-downs, configuratie-modals). Die kunnen niet server-side
 * geëxporteerd worden en geven success:false terug met een uitleg.
 *
 * Filters worden uit `params` gehaald (from, to, store, etc.).
 */

import { fmtEur, fmtDate, fmtDateTime } from './report-formats.js';
import { getMailLog } from './gents-mail-log-store.js';
import { getDeclarations } from './declarations-store.js';
import { getLabels } from './sendcloud-labels-store.js';
import { getSrsReturnLogs } from './srs-return-log-store.js';
import { getCronLog } from './gents-cron-log-store.js';
import { getVoucherLogs } from './voucher-log-store.js';
import { readRange as readSupplychainRange, aggregateSnapshots as aggregateSupplychain, periodToRange as supplychainPeriodToRange } from './supplychain-metrics-store.js';
import { readMetricsConfig as readSupplychainConfig } from './supplychain-metrics-config.js';
import { list as listBlobs } from '@vercel/blob';
import { getStoreNameByBranchId } from './branch-metrics.js';
import { readLedger, periodToRange as ledgerPeriodToRange, aggregateLedger } from './srs-retail-ledger.js';
import { getSrsOpenWeborders } from './srs-open-weborders-client.js';
import { isOpenWeborderStatus, isClosedWeborderStatus } from './weborder-request-store.js';
import { isShipOverdue } from './ship-deadline.js';
import { getShipCutoffConfig } from './order-cutoff-config-store.js';
import { readTopCustomers } from './top-customers-store.js';
import { readRetourRedenen, aggregateRetourRedenen, retourDetailsInRange, RETOUR_REASON_LABELS } from './retour-redenen-store.js';

function dateRangeFromParams(params) {
  const fromStr = String(params.from || params.dateFrom || '').trim();
  const toStr = String(params.to || params.dateTo || '').trim();
  const fromMs = fromStr ? new Date(fromStr + 'T00:00:00').getTime() : 0;
  const toMs = toStr ? new Date(toStr + 'T23:59:59').getTime() : 0;
  return { fromStr, toStr, fromMs, toMs };
}

function inRange(ts, fromMs, toMs) {
  if (!fromMs && !toMs) return true;
  const v = typeof ts === 'number' ? ts : new Date(ts || 0).getTime();
  if (Number.isNaN(v)) return false;
  if (fromMs && v < fromMs) return false;
  if (toMs && v > toMs) return false;
  return true;
}

/* ─── Mail log ──────────────────────────────────────────────────────── */

async function fetchMailLog(params = {}) {
  const { fromStr, toStr, fromMs, toMs } = dateRangeFromParams(params);
  const all = await getMailLog();
  const rows = (all || [])
    .filter((m) => inRange(m.createdAt || m.sentAt, fromMs, toMs))
    .filter((m) => {
      if (params.store && String(m.store || '').toLowerCase() !== String(params.store).toLowerCase()) return false;
      if (params.status && String(m.status || '').toLowerCase() !== String(params.status).toLowerCase()) return false;
      if (params.type && String(m.type || '').toLowerCase() !== String(params.type).toLowerCase()) return false;
      return true;
    });

  return {
    title: 'Mail log',
    subtitle: 'Alle verzonden mails uit het GENTS Winkelportaal',
    filters: { Van: fromStr, Tot: toStr, Winkel: params.store || '', Status: params.status || '', Type: params.type || '' },
    columns: [
      { key: 'createdAt', label: 'Tijd' },
      { key: 'type', label: 'Type' },
      { key: 'store', label: 'Winkel' },
      { key: 'recipient', label: 'Ontvanger' },
      { key: 'subject', label: 'Onderwerp' },
      { key: 'status', label: 'Status' },
      { key: 'error', label: 'Fout' }
    ],
    rows: rows.map((m) => ({
      createdAt: fmtDateTime(m.createdAt || m.sentAt),
      type: m.type || '',
      store: m.store || '',
      recipient: m.recipient || m.to || '',
      subject: m.subject || '',
      status: m.status || '',
      error: m.error || ''
    })),
    totals: {
      Totaal: rows.length,
      Verstuurd: rows.filter((r) => r.status === 'sent').length,
      Fouten: rows.filter((r) => r.status === 'error').length
    }
  };
}

/* ─── Declaraties ───────────────────────────────────────────────────── */

async function fetchDeclarations(params = {}) {
  const { fromStr, toStr, fromMs, toMs } = dateRangeFromParams(params);
  const all = await getDeclarations();
  const rows = (all || [])
    .filter((d) => inRange(d.createdAt || d.date, fromMs, toMs))
    .filter((d) => {
      if (params.store && String(d.store || '').toLowerCase() !== String(params.store).toLowerCase()) return false;
      if (params.status) {
        const st = String(d.status || (d.paidAt ? 'paid' : 'pending')).toLowerCase();
        if (st !== String(params.status).toLowerCase()) return false;
      }
      return true;
    });

  const totalOpen = rows.filter((d) => !d.paidAt && d.status !== 'paid').reduce((s, d) => s + Number(d.amount || 0), 0);
  const totalPaid = rows.filter((d) => d.paidAt || d.status === 'paid').reduce((s, d) => s + Number(d.amount || 0), 0);

  return {
    title: 'Declaraties',
    subtitle: 'Open + uitbetaalde declaraties per winkel',
    filters: { Van: fromStr, Tot: toStr, Winkel: params.store || '', Status: params.status || '' },
    columns: [
      { key: 'createdAt', label: 'Ingediend' },
      { key: 'store', label: 'Winkel' },
      { key: 'description', label: 'Omschrijving' },
      { key: 'category', label: 'Categorie' },
      { key: 'amount', label: 'Bedrag' },
      { key: 'status', label: 'Status' },
      { key: 'paidAt', label: 'Uitbetaald' }
    ],
    rows: rows.map((d) => ({
      createdAt: fmtDate(d.createdAt || d.date),
      store: d.store || '',
      description: d.description || d.title || '',
      category: d.category || '',
      amount: fmtEur(d.amount),
      status: d.status || (d.paidAt ? 'paid' : 'pending'),
      paidAt: d.paidAt ? fmtDate(d.paidAt) : ''
    })),
    totals: {
      Totaal: rows.length,
      'Open bedrag': fmtEur(totalOpen),
      'Uitbetaald bedrag': fmtEur(totalPaid)
    }
  };
}

/* ─── Sendcloud labels ──────────────────────────────────────────────── */

async function fetchSendcloudLabels(params = {}) {
  const { fromStr, toStr, fromMs, toMs } = dateRangeFromParams(params);
  const all = await getLabels();
  const rows = (all || [])
    .filter((l) => inRange(l.createdAt || l.date, fromMs, toMs))
    .filter((l) => {
      if (params.store && String(l.store || '').toLowerCase() !== String(params.store).toLowerCase()) return false;
      return true;
    });

  const totalCost = rows.reduce((s, l) => s + Number(l.shippingCost || 0), 0);

  return {
    title: 'Verzendlabels (Sendcloud)',
    subtitle: 'Aantal labels + kosten per periode',
    filters: { Van: fromStr, Tot: toStr, Winkel: params.store || '' },
    columns: [
      { key: 'createdAt', label: 'Aangemaakt' },
      { key: 'store', label: 'Winkel' },
      { key: 'orderNumber', label: 'Order' },
      { key: 'carrier', label: 'Vervoerder' },
      { key: 'trackingNumber', label: 'Tracking' },
      { key: 'shippingCost', label: 'Kosten' },
      { key: 'status', label: 'Status' }
    ],
    rows: rows.map((l) => ({
      createdAt: fmtDateTime(l.createdAt || l.date),
      store: l.store || '',
      orderNumber: l.orderNumber || l.orderNr || '',
      carrier: l.carrier || '',
      trackingNumber: l.trackingNumber || '',
      shippingCost: fmtEur(l.shippingCost),
      status: l.status || ''
    })),
    totals: {
      'Aantal labels': rows.length,
      'Totale kosten': fmtEur(totalCost)
    }
  };
}

/* ─── Retouren (winkel-side via SRS return log) ─────────────────────── */

async function fetchReturns(params = {}) {
  const { fromStr, toStr, fromMs, toMs } = dateRangeFromParams(params);
  const all = await getSrsReturnLogs();
  const rows = (all || [])
    .filter((r) => inRange(r.createdAt || r.date, fromMs, toMs))
    .filter((r) => {
      if (params.store && String(r.store || '').toLowerCase() !== String(params.store).toLowerCase()) return false;
      return true;
    });

  return {
    title: 'Retouren — winkel',
    subtitle: 'Geregistreerde winkel-retouren via /api/return-refund',
    filters: { Van: fromStr, Tot: toStr, Winkel: params.store || '' },
    columns: [
      { key: 'createdAt', label: 'Datum' },
      { key: 'store', label: 'Winkel' },
      { key: 'orderNumber', label: 'Order' },
      { key: 'employeeName', label: 'Medewerker' },
      { key: 'reason', label: 'Reden' },
      { key: 'refundAmount', label: 'Refund' },
      { key: 'status', label: 'Status' }
    ],
    rows: rows.map((r) => ({
      createdAt: fmtDateTime(r.createdAt || r.date),
      store: r.store || '',
      orderNumber: r.orderNumber || r.orderNr || '',
      employeeName: r.employeeName || '',
      reason: r.reason || '',
      refundAmount: fmtEur(r.refundAmount),
      status: r.success ? 'Verwerkt' : (r.error || 'Fout')
    })),
    totals: {
      Totaal: rows.length,
      Succesvol: rows.filter((r) => r.success).length,
      Fouten: rows.filter((r) => !r.success).length,
      'Totaal refund': fmtEur(rows.reduce((s, r) => s + Number(r.refundAmount || 0), 0))
    }
  };
}

/* ─── Top retour-redenen ────────────────────────────────────────────── */

async function fetchReturnReasons(params = {}) {
  const { fromStr, toStr, fromMs, toMs } = dateRangeFromParams(params);
  const all = await getSrsReturnLogs();
  const filtered = (all || []).filter((r) => inRange(r.createdAt, fromMs, toMs));
  const reasonMap = new Map();
  for (const r of filtered) {
    const reason = String(r.reason || 'Onbekend').trim() || 'Onbekend';
    reasonMap.set(reason, (reasonMap.get(reason) || 0) + 1);
  }
  const total = filtered.length;
  const rows = [...reasonMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({
      reason,
      count,
      pct: total ? `${(count / total * 100).toFixed(1)}%` : '0%'
    }));

  return {
    title: 'Retour-redenen — top 10',
    subtitle: 'Frequentste opgegeven retour-redenen',
    filters: { Van: fromStr, Tot: toStr },
    columns: [
      { key: 'reason', label: 'Reden' },
      { key: 'count', label: 'Aantal' },
      { key: 'pct', label: '% van totaal' }
    ],
    rows,
    totals: { 'Unieke redenen': rows.length, 'Totaal retouren': total }
  };
}

/* ─── Cron-overzicht (laatste runs) ─────────────────────────────────── */

async function fetchCronOverview(params = {}) {
  const all = await getCronLog();
  const rows = (all || []).slice(0, 500);

  return {
    title: 'Cron-overzicht',
    subtitle: 'Laatste 500 cron-runs',
    filters: {},
    columns: [
      { key: 'createdAt', label: 'Tijd' },
      { key: 'job', label: 'Job' },
      { key: 'status', label: 'Status' },
      { key: 'durationMs', label: 'Duur (ms)' },
      { key: 'error', label: 'Fout' }
    ],
    rows: rows.map((c) => ({
      createdAt: fmtDateTime(c.createdAt || c.timestamp),
      job: c.job || c.name || '',
      status: c.success === false || c.error ? 'fout' : (c.status || 'success'),
      durationMs: c.durationMs || '',
      error: c.error || c.message || ''
    })),
    totals: {
      Totaal: rows.length,
      Fouten: rows.filter((r) => !r.success && r.error).length
    }
  };
}

/* ─── Voucher beheer ────────────────────────────────────────────────── */

async function fetchVouchers(params = {}) {
  const { fromStr, toStr, fromMs, toMs } = dateRangeFromParams(params);
  const all = await getVoucherLogs();
  const rows = (all || []).filter((v) => inRange(v.createdAt, fromMs, toMs));

  return {
    title: 'Voucher log',
    subtitle: 'Aangemaakte + ingewisselde loyalty-vouchers',
    filters: { Van: fromStr, Tot: toStr },
    columns: [
      { key: 'createdAt', label: 'Datum' },
      { key: 'customerEmail', label: 'Klant' },
      { key: 'voucherCode', label: 'Code' },
      { key: 'amount', label: 'Bedrag' },
      { key: 'status', label: 'Status' },
      { key: 'redeemedAt', label: 'Ingewisseld' }
    ],
    rows: rows.map((v) => ({
      createdAt: fmtDateTime(v.createdAt),
      customerEmail: v.customerEmail || v.email || '',
      voucherCode: v.voucherCode || v.code || '',
      amount: fmtEur(v.amount),
      status: v.status || (v.redeemedAt ? 'ingewisseld' : 'open'),
      redeemedAt: v.redeemedAt ? fmtDateTime(v.redeemedAt) : ''
    })),
    totals: {
      Totaal: rows.length,
      Ingewisseld: rows.filter((r) => r.redeemedAt).length,
      'Totaal bedrag': fmtEur(rows.reduce((s, r) => s + Number(r.amount || 0), 0))
    }
  };
}

/* ─── Supplychain dashboard snapshot ────────────────────────────────── */

async function fetchSupplychainSnapshot(params = {}) {
  /* Periode bepalen: ?period=week|month|quarter|year, óf from/to */
  let range;
  if (params.from && params.to) {
    range = { from: String(params.from).slice(0, 10), to: String(params.to).slice(0, 10), period: 'custom' };
  } else {
    range = supplychainPeriodToRange(String(params.period || 'month'));
  }

  const [{ metrics }, days] = await Promise.all([
    readSupplychainConfig(),
    readSupplychainRange(range.from, range.to)
  ]);
  const enabled = metrics.filter((m) => m.enabled);
  const agg = aggregateSupplychain(days, enabled);

  /* Bouw row-per-filiaal met alle metric-kolommen */
  const columns = [
    { key: 'store', label: 'Filiaal' },
    ...enabled.map((m) => ({ key: m.key, label: m.label }))
  ];
  const rows = Object.values(agg.byBranch).map((b) => {
    const row = { store: b.store || b.branchId };
    for (const m of enabled) {
      const v = b.metrics?.[m.key];
      row[m.key] = v == null ? '—' : v;
    }
    return row;
  });

  return {
    title: 'Supplychain dashboard',
    subtitle: `Voorraad-kwaliteit per filiaal — ${range.period === 'custom' ? `${range.from} → ${range.to}` : range.period}`,
    filters: { Van: range.from, Tot: range.to, Periode: range.period },
    columns,
    rows,
    totals: {
      Filialen: rows.length,
      Dagen: agg.dayCount,
      ...Object.fromEntries(enabled.filter((m) => m.unit === 'count').slice(0, 4).map((m) => [m.label, agg.totals[m.key] || 0]))
    }
  };
}

/* ─── Catalogus van rapport-fetchers ────────────────────────────────── */

/**
 * reportKey → fetcher mapping. Elke fetcher krijgt `params` (uit query/body)
 * en geeft een normalized rapport-object terug.
 *
 * Niet alle frontend-rapportages staan hier — sommige zijn UI-modals zonder
 * server-side equivalent. Die geven we een nette foutmelding voor.
 */

/* ─── Omzet per winkel (retail-ledger) ──────────────────────────────
   Bron: srs-retail-ledger blob (dagelijkse omzet/bonnen/refund per filiaal).
   Snel (geen live SRS) — zelfde data als het periode-/omzet-dashboard. */
async function fetchOmzetReport(params = {}) {
  const { fromStr, toStr } = dateRangeFromParams(params);
  const range = (fromStr && toStr)
    ? ledgerPeriodToRange('custom', { from: fromStr, to: toStr })
    : ledgerPeriodToRange(String(params.period || 'maand'));
  const ledger = await readLedger();
  const agg = aggregateLedger(ledger, { from: range.from, to: range.to });
  const storeFilter = String(params.store || '').trim().toLowerCase();
  let filialen = agg.filialen || [];
  if (storeFilter) filialen = filialen.filter((f) => String(f.store || '').toLowerCase() === storeFilter);

  return {
    title: 'Omzet per winkel',
    subtitle: `${range.from} t/m ${range.to}${storeFilter ? ` · ${params.store}` : ''}`,
    filters: { Van: range.from, Tot: range.to, Winkel: params.store || null },
    columns: [
      { key: 'store', label: 'Winkel' },
      { key: 'bonnen', label: 'Bonnen' },
      { key: 'omzet', label: 'Netto omzet' },
      { key: 'gross', label: 'Bruto omzet' },
      { key: 'refund', label: 'Retour' },
      { key: 'items', label: 'Stuks (netto)' },
      { key: 'conversie', label: 'Conversie' },
      { key: 'gemBesteding', label: 'Gem. besteding' }
    ],
    rows: filialen.map((f) => ({
      store: f.store,
      bonnen: f.bonnen,
      omzet: fmtEur(f.omzet),
      gross: fmtEur(f.gross),
      refund: fmtEur(f.refund),
      items: f.items,
      conversie: f.conversie == null ? '—' : `${f.conversie}%`,
      gemBesteding: fmtEur(f.gemBesteding)
    })),
    totals: {
      Winkels: agg.totals.winkels,
      Bonnen: agg.totals.bonnen,
      'Netto omzet': fmtEur(agg.totals.omzet),
      'Bruto omzet': fmtEur(agg.totals.gross),
      Retour: fmtEur(agg.totals.refund),
      'Stuks (netto)': agg.totals.items
    }
  };
}

/* ─── Open weborders (helpers) ──────────────────────────────────────── */
function weborderAgeHours(item = {}) {
  const ms = new Date(item.createdAt || item.orderDate || item.created || item.dateTime || 0).getTime();
  if (!ms || Number.isNaN(ms)) return 0;
  return Math.max(0, Math.round((Date.now() - ms) / 36e5));
}

function openWeborderRow(item) {
  return {
    orderNr: item.orderNr || item.orderId || '',
    createdAt: fmtDateTime(item.createdAt),
    store: item.fulfilmentStore || item.fulfillmentStore || item.store || '',
    sku: item.sku || item.barcode || '',
    customer: item.customerName || item.customerEmail || '',
    ageHours: `${weborderAgeHours(item)} u`
  };
}

const OPEN_WEBORDER_COLUMNS = [
  { key: 'orderNr', label: 'Order' },
  { key: 'createdAt', label: 'Besteld' },
  { key: 'store', label: 'Winkel' },
  { key: 'sku', label: 'Artikel' },
  { key: 'customer', label: 'Klant' },
  { key: 'ageHours', label: 'Leeftijd' }
];

async function loadOpenWeborderItems(storeFilter) {
  const data = await getSrsOpenWeborders({});
  let items = (data.items || []).filter((it) => isOpenWeborderStatus(it.status) && !isClosedWeborderStatus(it.status));
  const sf = String(storeFilter || '').trim().toLowerCase();
  if (sf) items = items.filter((it) => String(it.fulfilmentStore || it.fulfillmentStore || it.store || '').toLowerCase() === sf);
  return items;
}

/* ─── Openstaande orders (alle open weborder-regels) ────────────────── */
async function fetchOpenWeborders(params = {}) {
  const items = (await loadOpenWeborderItems(params.store)).sort((a, b) => weborderAgeHours(b) - weborderAgeHours(a));
  return {
    title: 'Openstaande orders',
    subtitle: `${items.length} open regel(s)${params.store ? ` · ${params.store}` : ''}`,
    filters: { Winkel: params.store || null },
    columns: OPEN_WEBORDER_COLUMNS,
    rows: items.map(openWeborderRow),
    totals: { 'Open regels': items.length }
  };
}

/* ─── Te late orders (open + voorbij de verzend-cutoff) ──────────────
   Te laat = open weborder die de verzend-deadline heeft overschreden
   (configureerbare cutoff, default 1 werkdag na 14:00). Zelfde definitie
   als de Te-laat-pagina (winkel-config als default-kanaal). */
async function fetchOverdueWeborders(params = {}) {
  const [items, cutoff] = await Promise.all([
    loadOpenWeborderItems(params.store),
    getShipCutoffConfig()
  ]);
  const cfg = cutoff.winkel || {};
  const overdue = items
    .filter((it) => isShipOverdue({ orderedAt: it.createdAt, config: cfg }))
    .sort((a, b) => weborderAgeHours(b) - weborderAgeHours(a));
  return {
    title: 'Te late orders',
    subtitle: `${overdue.length} te laat${params.store ? ` · ${params.store}` : ''} · cutoff ${cfg.cutoffHour ?? 14}:${String(cfg.cutoffMinute ?? 0).padStart(2, '0')}`,
    filters: { Winkel: params.store || null, Cutoff: `${cfg.cutoffHour ?? 14}:${String(cfg.cutoffMinute ?? 0).padStart(2, '0')}` },
    columns: OPEN_WEBORDER_COLUMNS,
    rows: overdue.map(openWeborderRow),
    totals: { 'Te late regels': overdue.length, 'Totaal open': items.length }
  };
}

/* ─── Top klanten (Shopify lifetime besteding, blob-snapshot) ────────
   Bron: reports/top-customers.json, dagelijks gevuld door de
   top-customers-snapshot cron. Geen live API-call tijdens export. */
async function fetchTopCustomers(params = {}) {
  const snap = await readTopCustomers();
  const limit = Math.max(1, Math.min(1000, Number(params.limit || 100)));
  const rows = (snap.customers || []).slice(0, limit);
  const subtitle = snap.generatedAt
    ? `Lifetime besteding (Shopify) · ${snap.scanned} klanten gescand${snap.truncated ? ' (gedeeltelijk — page-cap)' : ''} · bijgewerkt ${fmtDateTime(snap.generatedAt)}`
    : 'Nog geen snapshot — wordt dagelijks gevuld door de top-customers-snapshot cron.';
  return {
    title: 'Top klanten',
    subtitle,
    filters: { Limiet: limit },
    columns: [
      { key: 'rank', label: '#' },
      { key: 'name', label: 'Klant' },
      { key: 'email', label: 'E-mail' },
      { key: 'orderCount', label: 'Orders' },
      { key: 'totalSpent', label: 'Lifetime besteding' },
      { key: 'avgOrder', label: 'Gem. order' }
    ],
    rows: rows.map((c, i) => ({
      rank: i + 1,
      name: c.name || '—',
      email: c.email || '',
      orderCount: Number(c.orderCount || 0),
      totalSpent: fmtEur(c.totalSpent),
      avgOrder: fmtEur(c.avgOrder)
    })),
    totals: {
      Klanten: rows.length,
      'Totaal besteding (top)': fmtEur(rows.reduce((s, c) => s + Number(c.totalSpent || 0), 0))
    }
  };
}

/* ─── Winkel-retouren per reden (klacht/retour/ruiling) ─────────────
   Bron: retour-redenen blob (per winkel/dag, opgebouwd uit verkopen-export).
   Periode-instelbaar; pure winkel-retouren (excl. webshop). */
async function fetchWinkelRetourRedenen(params = {}) {
  const { fromStr, toStr } = dateRangeFromParams(params);
  const range = (fromStr && toStr)
    ? ledgerPeriodToRange('custom', { from: fromStr, to: toStr })
    : ledgerPeriodToRange(String(params.period || 'maand'));
  const data = await readRetourRedenen();
  const agg = aggregateRetourRedenen(data, { from: range.from, to: range.to });
  const storeFilter = String(params.store || '').trim().toLowerCase();
  const rows = storeFilter ? agg.perStore.filter((r) => String(r.store || '').toLowerCase() === storeFilter) : agg.perStore;

  return {
    title: 'Winkel-retouren per reden',
    subtitle: `${range.from} t/m ${range.to}${storeFilter ? ` · ${params.store}` : ''}`,
    filters: { Van: range.from, Tot: range.to, Winkel: params.store || null },
    columns: [
      { key: 'store', label: 'Winkel' },
      { key: 'klacht', label: 'Klacht' },
      { key: 'retour', label: 'Retour' },
      { key: 'ruiling', label: 'Ruiling' },
      { key: 'overig', label: 'Overig' },
      { key: 'totaal', label: 'Totaal' },
      { key: 'bedrag', label: 'Bedrag' }
    ],
    rows: rows.map((r) => ({
      store: r.store,
      klacht: r.klacht.regels,
      retour: r.retour.regels,
      ruiling: r.ruiling.regels,
      overig: r.overig.regels,
      totaal: r.totaalRegels,
      bedrag: fmtEur(r.totaalEur)
    })),
    totals: {
      Winkels: rows.length,
      Klachten: agg.totals.klacht.regels,
      Retouren: agg.totals.retour.regels,
      Ruilingen: agg.totals.ruiling.regels,
      'Totaal regels': agg.totaalRegels,
      'Totaal bedrag': fmtEur(agg.totaalEur)
    }
  };
}

/* ─── Winkel-retouren — detailregels ────────────────────────────────── */
async function fetchWinkelRetourDetail(params = {}) {
  const { fromStr, toStr } = dateRangeFromParams(params);
  const range = (fromStr && toStr)
    ? ledgerPeriodToRange('custom', { from: fromStr, to: toStr })
    : ledgerPeriodToRange(String(params.period || 'maand'));
  const data = await readRetourRedenen();
  const limit = Math.max(1, Math.min(20000, Number(params.limit || 5000)));
  const rows = retourDetailsInRange(data, { from: range.from, to: range.to, store: params.store }).slice(0, limit);

  return {
    title: 'Winkel-retouren — detail',
    subtitle: `${range.from} t/m ${range.to} · ${rows.length} regels${params.store ? ` · ${params.store}` : ''}`,
    filters: { Van: range.from, Tot: range.to, Winkel: params.store || null },
    columns: [
      { key: 'date', label: 'Datum' },
      { key: 'store', label: 'Winkel' },
      { key: 'reden', label: 'Reden' },
      { key: 'sku', label: 'SKU' },
      { key: 'stuks', label: 'Stuks' },
      { key: 'eur', label: 'Bedrag' },
      { key: 'origBon', label: 'Origineel bon' },
      { key: 'bon', label: 'Retour-bon' }
    ],
    rows: rows.map((d) => ({
      date: d.date,
      store: d.store,
      reden: RETOUR_REASON_LABELS[d.reden] || d.reden,
      sku: d.sku,
      stuks: d.stuks,
      eur: fmtEur(d.eur),
      origBon: d.origBon,
      bon: d.bon
    })),
    totals: { Regels: rows.length, 'Totaal bedrag': fmtEur(rows.reduce((s, d) => s + Number(d.eur || 0), 0)) }
  };
}

export const REPORT_FETCHERS = {
  'mail-log': fetchMailLog,
  'omzet-rapport': fetchOmzetReport,
  'openstaande-orders': fetchOpenWeborders,
  'te-laat-orders': fetchOverdueWeborders,
  'top-klanten': fetchTopCustomers,
  'winkel-retour-redenen': fetchWinkelRetourRedenen,
  'winkel-retour-detail': fetchWinkelRetourDetail,
  'declaraties': fetchDeclarations,
  'sendcloud-labels': fetchSendcloudLabels,
  'retour-redenen': fetchReturnReasons,
  'top-retour-producten': fetchReturns,
  'frequent-returners': fetchReturns,
  'size-bracketing': fetchReturns,
  'cron-overzicht': fetchCronOverview,
  'automation-status': fetchCronOverview,
  'voucher-beheer': fetchVouchers,
  'finance-open-bedragen': fetchDeclarations,
  'winkel-weekrapport': fetchSendcloudLabels,  /* placeholder mapping — toont labels per winkel */
  'supplychain-snapshot': fetchSupplychainSnapshot
};

/**
 * Bouw een rapport. Returnt null als de key onbekend is.
 */
export async function buildReport(reportKey, params = {}) {
  const fetcher = REPORT_FETCHERS[reportKey];
  if (!fetcher) return null;
  const data = await fetcher(params);
  return {
    ...data,
    generatedAt: new Date().toISOString(),
    reportKey
  };
}

/**
 * Lijst van keys waarvoor we een fetcher hebben — frontend kan checken
 * of een rapport server-side exporteerbaar is.
 */
export function getSupportedReportKeys() {
  return Object.keys(REPORT_FETCHERS);
}
