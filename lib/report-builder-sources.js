/**
 * lib/report-builder-sources.js
 *
 * ════════════════════════════════════════════════════════════════════════
 *  WAT IS DIT?
 * ════════════════════════════════════════════════════════════════════════
 *
 * Data-source registry voor de Rapport-bouwer. Per bron definieer je:
 *   - availableColumns  : welke velden bestaan + type (voor formatting/sort)
 *   - defaultColumns    : sensible defaults bij eerste open
 *   - availableFilters  : welke filter-dimensies + type (voor UI)
 *   - fetcher           : async () => rows[]  — RAW data, geen filtering
 *
 * De applyQuery() functie hieronder doet de zware werk: filtering, group/
 * aggregate, sort, limit. Bron-fetchers leveren alleen RAW rows aan.
 *
 * ════════════════════════════════════════════════════════════════════════
 *  HOE EEN NIEUWE BRON TOEVOEGEN
 * ════════════════════════════════════════════════════════════════════════
 *
 * 1. Voeg entry toe aan REPORT_BUILDER_SOURCES hieronder
 * 2. Geef availableColumns + defaultColumns op
 * 3. Geef availableFilters op (en welke kolom ze targetten via 'field')
 * 4. Schrijf een fetcher die rows[] returnt (kan async, mag elke vorm hebben
 *    zolang elke row een plain object is met de velden uit availableColumns)
 * 5. Klaar — frontend pikt 'm op via /api/admin/report-builder/sources GET
 *
 * ════════════════════════════════════════════════════════════════════════
 *  TYPES
 * ════════════════════════════════════════════════════════════════════════
 *
 * Column type: 'string' | 'number' | 'eur' | 'date' | 'datetime' | 'boolean'
 * Filter type: 'date-range' | 'multi-select' | 'text' | 'number-range' | 'boolean'
 *
 * Filter heeft `field` (kolom-key) of `customApply: async (rows, value) => rows`
 * voor complexe filters.
 */

import { getMailLog } from './gents-mail-log-store.js';
import { getDeclarations } from './declarations-store.js';
import { readAllRequests as readStockCorrections } from './stock-corrections-store.js';
import { getWeborderRequests, normalizeWeborder } from './weborder-request-store.js';
import { getVoucherLogs } from './voucher-log-store.js';
import { getCronLog } from './gents-cron-log-store.js';
import { list as listBlobs } from '@vercel/blob';
import { getStoreNameByBranchId } from './branch-metrics.js';
import { listBranchesFromConfig } from './business-config.js';
import { readVoorraadRows, readLocatiesRows } from './srs-voorraad-store.js';

const EXCHANGE_STATE_KEY = 'srs-exchanges/open-exchange-state.json';

async function readExchangeStateBlob() {
  try {
    const result = await listBlobs({ prefix: EXCHANGE_STATE_KEY, limit: 1 });
    const blob = (result.blobs || []).find((b) => b.pathname === EXCHANGE_STATE_KEY) || result.blobs?.[0];
    if (!blob?.url) return [];
    const response = await fetch(blob.url, { cache: 'no-store' });
    if (!response.ok) return [];
    const data = JSON.parse((await response.text()) || '{}');
    return Object.entries(data.exchanges || {}).map(([id, ex]) => ({
      id,
      store: ex.storeName || getStoreNameByBranchId(ex.branchId) || 'Onbekend',
      branchId: ex.branchId || '',
      createdAt: ex.firstDetectedAt || ex.createdAt || '',
      closedAt: ex.closedAt || '',
      isOpen: !ex.closedAt,
      ageHours: ex.firstDetectedAt
        ? Math.floor((Date.now() - new Date(ex.firstDetectedAt).getTime()) / 36e5)
        : 0
    }));
  } catch (err) {
    console.error('[report-builder-sources] readExchangeStateBlob:', err);
    return [];
  }
}

/* ──────────────────────────────────────────────────────────────────────
 * BRON-REGISTRY
 * ────────────────────────────────────────────────────────────────────── */

export const REPORT_BUILDER_SOURCES = {

  /* ═════════════════════ MAIL-LOG ═════════════════════ */
  'mail-log': {
    key: 'mail-log',
    label: 'Mail-log',
    description: 'Verzonden mails per type, status en winkel. Filter op periode + type voor mail-audit.',
    icon: 'mail',
    availableColumns: [
      { key: 'createdAt',  label: 'Verzonden op',  type: 'datetime' },
      { key: 'type',       label: 'Mail-type',     type: 'string' },
      { key: 'recipient',  label: 'Ontvanger',     type: 'string' },
      { key: 'store',      label: 'Winkel',        type: 'string' },
      { key: 'status',     label: 'Status',        type: 'string' },
      { key: 'order',      label: 'Order #',       type: 'string' },
      { key: 'subject',    label: 'Onderwerp',     type: 'string' }
    ],
    defaultColumns: ['createdAt', 'type', 'store', 'recipient', 'status'],
    availableFilters: [
      { key: 'dateRange', label: 'Periode',         type: 'date-range',   field: 'createdAt' },
      { key: 'type',      label: 'Mail-type',       type: 'multi-select', field: 'type',
        options: ['pickup', 'weborder', 'service', 'voucher', 'loyalty', 'birthday', 'pickup-reminder'] },
      { key: 'status',    label: 'Status',          type: 'multi-select', field: 'status',
        options: ['sent', 'error', 'pending', 'bounced'] },
      { key: 'store',     label: 'Winkel',          type: 'multi-select', field: 'store', source: 'stores' },
      { key: 'recipient', label: 'Ontvanger bevat', type: 'text',         field: 'recipient' }
    ],
    fetcher: async () => {
      const rows = await getMailLog();
      return rows.map((r) => ({
        createdAt: r.createdAt || r.sentAt || '',
        type:      r.type || '',
        recipient: r.recipient || r.to || '',
        store:     r.store || '',
        status:    r.status || 'sent',
        order:     r.order || r.orderId || '',
        subject:   r.subject || ''
      }));
    }
  },

  /* ═════════════════════ DECLARATIES ═════════════════════ */
  'declarations': {
    key: 'declarations',
    label: 'Declaraties',
    description: 'Personeel declaraties met status, type, bedrag en winkel.',
    icon: 'note',
    availableColumns: [
      { key: 'createdAt',   label: 'Aangemaakt',  type: 'datetime' },
      { key: 'employee',    label: 'Medewerker',  type: 'string' },
      { key: 'store',       label: 'Winkel',      type: 'string' },
      { key: 'type',        label: 'Type',        type: 'string' },
      { key: 'description', label: 'Omschrijving',type: 'string' },
      { key: 'amount',      label: 'Bedrag',      type: 'eur' },
      { key: 'status',      label: 'Status',      type: 'string' },
      { key: 'approvedAt',  label: 'Goedgekeurd', type: 'datetime' }
    ],
    defaultColumns: ['createdAt', 'employee', 'store', 'type', 'amount', 'status'],
    availableFilters: [
      { key: 'dateRange', label: 'Periode',     type: 'date-range',   field: 'createdAt' },
      { key: 'status',    label: 'Status',      type: 'multi-select', field: 'status',
        options: ['open', 'approved', 'rejected', 'paid'] },
      { key: 'store',     label: 'Winkel',      type: 'multi-select', field: 'store', source: 'stores' },
      { key: 'amountMin', label: 'Bedrag vanaf', type: 'number-range', field: 'amount' }
    ],
    fetcher: async () => {
      const rows = await getDeclarations();
      return (rows || []).map((r) => ({
        createdAt:   r.createdAt || '',
        employee:    r.employeeName || r.employee || '',
        store:       r.store || '',
        type:        r.type || '',
        description: r.description || '',
        amount:      Number(r.amount || 0),
        status:      r.status || 'open',
        approvedAt:  r.approvedAt || ''
      }));
    }
  },

  /* ═════════════════════ STOCK-CORRECTIES ═════════════════════ */
  'stock-corrections': {
    key: 'stock-corrections',
    label: 'Voorraad-correcties',
    description: 'Handmatige voorraad-aanpassingen met reden en aanvrager.',
    icon: 'edit',
    availableColumns: [
      { key: 'createdAt',   label: 'Aangemaakt',  type: 'datetime' },
      { key: 'store',       label: 'Winkel',      type: 'string' },
      { key: 'status',      label: 'Status',      type: 'string' },
      { key: 'reason',      label: 'Reden',       type: 'string' },
      { key: 'requestedBy', label: 'Aangevraagd door', type: 'string' },
      { key: 'articleCount',label: 'Aantal regels', type: 'number' },
      { key: 'totalQty',    label: 'Totaal stuks', type: 'number' },
      { key: 'note',        label: 'Notitie',     type: 'string' }
    ],
    defaultColumns: ['createdAt', 'store', 'status', 'reason', 'totalQty'],
    availableFilters: [
      { key: 'dateRange', label: 'Periode', type: 'date-range',   field: 'createdAt' },
      { key: 'status',    label: 'Status',  type: 'multi-select', field: 'status',
        options: ['open', 'approved', 'rejected', 'processed'] },
      { key: 'store',     label: 'Winkel',  type: 'multi-select', field: 'store', source: 'stores' }
    ],
    fetcher: async () => {
      const rows = await readStockCorrections();
      return (rows || []).map((r) => {
        const arts = Array.isArray(r.articles) ? r.articles : [];
        return {
          createdAt:    r.createdAt || '',
          store:        r.store || '',
          status:       r.status || 'open',
          reason:       r.reason || '',
          requestedBy:  r.requestedBy?.name || r.requestedBy?.email || '',
          articleCount: arts.length,
          totalQty:     arts.reduce((sum, a) => sum + Math.abs(Number(a.qty || 0)), 0),
          note:         r.note || ''
        };
      });
    }
  },

  /* ═════════════════════ WEBORDERS ═════════════════════ */
  'weborders': {
    key: 'weborders',
    label: 'Weborders (open)',
    description: 'Openstaande weborders met status, fulfilment-winkel en leeftijd.',
    icon: 'package',
    availableColumns: [
      { key: 'createdAt',  label: 'Order-datum',     type: 'datetime' },
      { key: 'orderNr',    label: 'Order #',         type: 'string' },
      { key: 'sku',        label: 'SKU',             type: 'string' },
      { key: 'store',      label: 'Fulfilment-winkel', type: 'string' },
      { key: 'status',     label: 'Status',          type: 'string' },
      { key: 'ageHours',   label: 'Leeftijd (uur)',  type: 'number' },
      { key: 'isOverdue',  label: 'Te laat?',        type: 'boolean' },
      { key: 'price',      label: 'Prijs',           type: 'eur' }
    ],
    defaultColumns: ['createdAt', 'orderNr', 'store', 'status', 'ageHours', 'isOverdue'],
    availableFilters: [
      { key: 'dateRange', label: 'Order-datum', type: 'date-range',   field: 'createdAt' },
      { key: 'status',    label: 'Status',      type: 'multi-select', field: 'status',
        options: ['open', 'accepted', 'pending', 'unavailable', 'processed', 'cancelled'] },
      { key: 'store',     label: 'Winkel',      type: 'multi-select', field: 'store', source: 'stores' },
      { key: 'overdue',   label: 'Alleen te laat',  type: 'boolean',      field: 'isOverdue' }
    ],
    fetcher: async () => {
      const rows = await getWeborderRequests();
      const DEADLINE_H = 48;
      return (rows || []).map((r) => {
        const n = normalizeWeborder(r);
        const ageH = n.createdAt
          ? Math.floor((Date.now() - new Date(n.createdAt).getTime()) / 36e5)
          : 0;
        return {
          createdAt: n.createdAt || '',
          orderNr:   n.orderNr || n.orderId || '',
          sku:       n.sku || '',
          store:     n.fulfilmentStore || n.fulfillmentStore || '',
          status:    n.status || 'open',
          ageHours:  ageH,
          isOverdue: ageH > DEADLINE_H,
          price:     Number(n.price || 0)
        };
      });
    }
  },

  /* ═════════════════════ UITWISSELINGEN ═════════════════════ */
  'exchanges': {
    key: 'exchanges',
    label: 'Uitwisselingen',
    description: 'SRS uitwisselingen tussen filialen — open + afgerond.',
    icon: 'refresh',
    availableColumns: [
      { key: 'createdAt', label: 'Aangemaakt',  type: 'datetime' },
      { key: 'closedAt',  label: 'Afgerond op', type: 'datetime' },
      { key: 'store',     label: 'Winkel',      type: 'string' },
      { key: 'branchId',  label: 'Branch-ID',   type: 'string' },
      { key: 'isOpen',    label: 'Nog open?',   type: 'boolean' },
      { key: 'ageHours',  label: 'Open-tijd (uur)', type: 'number' }
    ],
    defaultColumns: ['createdAt', 'store', 'isOpen', 'ageHours', 'closedAt'],
    availableFilters: [
      { key: 'dateRange', label: 'Aangemaakt',  type: 'date-range',   field: 'createdAt' },
      { key: 'store',     label: 'Winkel',      type: 'multi-select', field: 'store', source: 'stores' },
      { key: 'openOnly',  label: 'Alleen open', type: 'boolean',      field: 'isOpen' }
    ],
    fetcher: readExchangeStateBlob
  },

  /* ═════════════════════ VOUCHERS ═════════════════════ */
  'vouchers': {
    key: 'vouchers',
    label: 'Vouchers',
    description: 'Voucher-acties: aangemaakt, ingewisseld, vervallen.',
    icon: 'gift',
    availableColumns: [
      { key: 'createdAt', label: 'Aangemaakt', type: 'datetime' },
      { key: 'code',      label: 'Voucher-code', type: 'string' },
      { key: 'type',      label: 'Type',       type: 'string' },
      { key: 'value',     label: 'Waarde',     type: 'eur' },
      { key: 'status',    label: 'Status',     type: 'string' },
      { key: 'customer',  label: 'Klant',      type: 'string' },
      { key: 'redeemedAt',label: 'Ingewisseld op', type: 'datetime' }
    ],
    defaultColumns: ['createdAt', 'code', 'type', 'value', 'status', 'customer'],
    availableFilters: [
      { key: 'dateRange', label: 'Periode', type: 'date-range',   field: 'createdAt' },
      { key: 'status',    label: 'Status',  type: 'multi-select', field: 'status',
        options: ['created', 'redeemed', 'expired', 'cancelled'] },
      { key: 'type',      label: 'Type',    type: 'multi-select', field: 'type',
        options: ['kadobon', 'tegoedbon', 'voucher', 'loyalty'] }
    ],
    fetcher: async () => {
      const rows = await getVoucherLogs();
      return (rows || []).map((r) => ({
        createdAt:  r.createdAt || '',
        code:       r.code || r.voucherCode || '',
        type:       r.type || '',
        value:      Number(r.value || r.amount || 0),
        status:     r.status || 'created',
        customer:   r.customerId || r.customerName || '',
        redeemedAt: r.redeemedAt || ''
      }));
    }
  },

  /* ═════════════════════ VOORRAAD (actueel vs ideaal) ═════════════════════ */
  'voorraad': {
    key: 'voorraad',
    label: 'Voorraad (actueel vs ideaal)',
    description: 'Voorraadstanden per filiaal/SKU met streefvoorraad + tekort. Bron: dagelijkse SRS-export.',
    icon: 'package',
    availableColumns: [
      { key: 'store',    label: 'Winkel',         type: 'string' },
      { key: 'filiaalNummer', label: 'Filiaal-nr', type: 'string' },
      { key: 'sku',      label: 'SKU',            type: 'string' },
      { key: 'voorraad', label: 'Voorraad',       type: 'number' },
      { key: 'ideaal',   label: 'Ideaal',         type: 'number' },
      { key: 'tekort',   label: 'Tekort',         type: 'number' }
    ],
    defaultColumns: ['store', 'sku', 'voorraad', 'ideaal', 'tekort'],
    availableFilters: [
      { key: 'store',      label: 'Winkel',        type: 'multi-select', field: 'store', source: 'stores' },
      { key: 'sku',        label: 'SKU bevat',     type: 'text',         field: 'sku' },
      { key: 'tekortMin',  label: 'Min. tekort',   type: 'number-range', field: 'tekort' },
      { key: 'voorraadMin',label: 'Voorraad-bereik', type: 'number-range', field: 'voorraad' }
    ],
    fetcher: async () => readVoorraadRows()
  },

  /* ═════════════════════ VOORRAADLOCATIES (bin-locaties) ═════════════════════ */
  'voorraadlocaties': {
    key: 'voorraadlocaties',
    label: 'Voorraad-locaties',
    description: 'Bin-locaties per filiaal met aantal, laatste inventarisatie en geblokkeerd-status.',
    icon: 'edit',
    availableColumns: [
      { key: 'store',               label: 'Winkel',      type: 'string' },
      { key: 'filiaalNummer',       label: 'Filiaal-nr',  type: 'string' },
      { key: 'locatie',             label: 'Locatie',     type: 'string' },
      { key: 'sku',                 label: 'SKU',         type: 'string' },
      { key: 'aantal',              label: 'Aantal',      type: 'number' },
      { key: 'lastInventarisation', label: 'Laatst geteld', type: 'datetime' },
      { key: 'geblokkeerd',         label: 'Geblokkeerd', type: 'boolean' }
    ],
    defaultColumns: ['store', 'locatie', 'sku', 'aantal', 'lastInventarisation', 'geblokkeerd'],
    availableFilters: [
      { key: 'store',       label: 'Winkel',        type: 'multi-select', field: 'store', source: 'stores' },
      { key: 'locatie',     label: 'Locatie bevat', type: 'text',         field: 'locatie' },
      { key: 'sku',         label: 'SKU bevat',     type: 'text',         field: 'sku' },
      { key: 'geblokkeerd', label: 'Alleen geblokkeerd', type: 'boolean', field: 'geblokkeerd' },
      { key: 'inventarisatie', label: 'Geteld in periode', type: 'date-range', field: 'lastInventarisation' }
    ],
    fetcher: async () => readLocatiesRows()
  },

  /* ═════════════════════ CRON-LOG ═════════════════════ */
  'cron-log': {
    key: 'cron-log',
    label: 'Cron-log',
    description: 'Run-historie van alle achtergrond-jobs met duur + status.',
    icon: 'clock',
    availableColumns: [
      { key: 'createdAt',  label: 'Gestart op', type: 'datetime' },
      { key: 'job',        label: 'Job',        type: 'string' },
      { key: 'status',     label: 'Status',     type: 'string' },
      { key: 'durationMs', label: 'Duur (ms)',  type: 'number' },
      { key: 'errorCount', label: 'Errors',     type: 'number' },
      { key: 'summary',    label: 'Samenvatting',type: 'string' }
    ],
    defaultColumns: ['createdAt', 'job', 'status', 'durationMs'],
    availableFilters: [
      { key: 'dateRange', label: 'Periode', type: 'date-range',   field: 'createdAt' },
      { key: 'status',    label: 'Status',  type: 'multi-select', field: 'status',
        options: ['success', 'error', 'partial', 'skipped'] }
    ],
    fetcher: async () => {
      const rows = await getCronLog();
      return (rows || []).map((r) => ({
        createdAt:  r.createdAt || '',
        job:        r.job || '',
        status:     r.status || 'success',
        durationMs: Number(r.durationMs || 0),
        errorCount: Number(r.errorCount || 0),
        summary:    typeof r.summary === 'string' ? r.summary : JSON.stringify(r.summary || {})
      }));
    }
  }
};

/* ──────────────────────────────────────────────────────────────────────
 * Public helpers
 * ────────────────────────────────────────────────────────────────────── */

/** Lijst alle data-sources (zonder fetcher, voor UI). */
export function listSources() {
  return Object.values(REPORT_BUILDER_SOURCES).map((s) => ({
    key: s.key,
    label: s.label,
    description: s.description,
    icon: s.icon,
    availableColumns: s.availableColumns,
    defaultColumns: s.defaultColumns,
    availableFilters: s.availableFilters.map((f) => ({
      key: f.key, label: f.label, type: f.type, field: f.field,
      options: f.options || null, source: f.source || null
    }))
  }));
}

/** Get 1 source-definitie incl. fetcher. */
export function getSource(key) {
  return REPORT_BUILDER_SOURCES[String(key || '').trim()] || null;
}

/* ──────────────────────────────────────────────────────────────────────
 * applyQuery — kernfunctie: filter + group + aggregate + sort + limit
 *
 * Input:  rows[], query = { filters, columns, groupBy, aggregate, sortBy, sortDir, limit, preview }
 * Output: { columns, rows, totalRows, executionMs }
 * ────────────────────────────────────────────────────────────────────── */

function valueMatchesFilter(row, filter, filterValue) {
  if (filterValue == null || filterValue === '') return true;
  const field = filter.field;
  if (!field) return true;
  const val = row[field];

  if (filter.type === 'date-range') {
    const { from, to } = filterValue || {};
    if (val == null || val === '') return false;
    const ts = String(val).slice(0, 10);
    if (from && ts < from) return false;
    if (to && ts > to) return false;
    return true;
  }
  if (filter.type === 'multi-select') {
    const arr = Array.isArray(filterValue) ? filterValue : [filterValue];
    if (!arr.length) return true;
    return arr.includes(val);
  }
  if (filter.type === 'text') {
    const needle = String(filterValue || '').toLowerCase().trim();
    if (!needle) return true;
    return String(val || '').toLowerCase().includes(needle);
  }
  if (filter.type === 'number-range') {
    const { min, max } = filterValue || {};
    const n = Number(val);
    if (min != null && n < Number(min)) return false;
    if (max != null && n > Number(max)) return false;
    return true;
  }
  if (filter.type === 'boolean') {
    if (filterValue === true || filterValue === 'true') return val === true || val === 'true';
    if (filterValue === false || filterValue === 'false') return val === false || val === 'false';
    return true;
  }
  return true;
}

function aggregateValue(values, op) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (op === 'count') return values.length;
  if (op === 'sum')   return nums.reduce((a, b) => a + b, 0);
  if (op === 'avg')   return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
  if (op === 'min')   return nums.length ? Math.min(...nums) : null;
  if (op === 'max')   return nums.length ? Math.max(...nums) : null;
  return null;
}

export async function applyQuery(sourceKey, query = {}) {
  const t0 = Date.now();
  const source = getSource(sourceKey);
  if (!source) throw new Error(`Onbekende data-bron: ${sourceKey}`);

  const allRows = await source.fetcher();
  const filtersDef = source.availableFilters || [];
  const filterValues = query.filters || {};

  /* 1. Filter */
  let rows = allRows.filter((row) => {
    for (const f of filtersDef) {
      if (!(f.key in filterValues)) continue;
      if (!valueMatchesFilter(row, f, filterValues[f.key])) return false;
    }
    return true;
  });
  const totalAfterFilter = rows.length;

  /* 2. Group + aggregate */
  const groupBy = String(query.groupBy || '').trim();
  const aggregate = query.aggregate; /* { [col]: 'sum'|'avg'|'count'|'min'|'max' } */
  let outColumns = Array.isArray(query.columns) && query.columns.length
    ? query.columns.filter((c) => source.availableColumns.some((col) => col.key === c))
    : source.defaultColumns.slice();

  if (groupBy && source.availableColumns.some((col) => col.key === groupBy)) {
    const groups = new Map();
    for (const r of rows) {
      const key = String(r[groupBy] ?? '');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const aggCols = aggregate && typeof aggregate === 'object' ? aggregate : {};
    rows = Array.from(groups.entries()).map(([key, group]) => {
      const out = { [groupBy]: key, _count: group.length };
      for (const [col, op] of Object.entries(aggCols)) {
        out[col] = aggregateValue(group.map((g) => g[col]), op);
      }
      return out;
    });
    /* Output-kolommen voor group-mode: groupBy + aggregated cols + _count */
    outColumns = [groupBy, ...Object.keys(aggCols), '_count'];
  }

  /* 3. Sort */
  const sortBy = String(query.sortBy || '').trim();
  if (sortBy && outColumns.includes(sortBy)) {
    const dir = query.sortDir === 'desc' ? -1 : 1;
    rows.sort((a, b) => {
      const av = a[sortBy]; const bv = b[sortBy];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv), 'nl') * dir;
    });
  }

  /* 4. Limit (preview overrules) */
  const limit = query.preview ? 50 : (Number(query.limit) > 0 ? Math.min(Number(query.limit), 10000) : 5000);
  const limitedRows = rows.slice(0, limit);

  /* Output-kolom definities voor UI (label + type) */
  const colDefs = outColumns.map((key) => {
    if (key === '_count') return { key, label: 'Aantal', type: 'number' };
    const def = source.availableColumns.find((c) => c.key === key);
    return def || { key, label: key, type: 'string' };
  });

  return {
    columns: colDefs,
    rows: limitedRows,
    totalRows: groupBy ? rows.length : totalAfterFilter,
    truncated: rows.length > limitedRows.length,
    executionMs: Date.now() - t0,
    sourceLabel: source.label,
    appliedFilters: filterValues,
    appliedGroupBy: groupBy || null,
    appliedAggregate: aggregate || null
  };
}

/* ──────────────────────────────────────────────────────────────────────
 * Helper voor UI: lijst beschikbare 'multi-select' opties uit interne bron
 * ────────────────────────────────────────────────────────────────────── */
export function resolveFilterOptionsSource(sourceKey) {
  if (sourceKey === 'stores') {
    return listBranchesFromConfig({ includeInternal: false }).map((b) => b.store);
  }
  return [];
}

export default {
  REPORT_BUILDER_SOURCES,
  listSources,
  getSource,
  applyQuery,
  resolveFilterOptionsSource
};
