import { list, put } from '@vercel/blob';
import { listBranches } from './branch-metrics.js';
import { getStoreMailSettings, normalizeStore } from './gents-mail-config.js';

const CONFIG_PATH = 'admin/region-report-config.json';
const DEFAULT_REGION_NAMES = ['Regio 1', 'Regio 2', 'Regio 3', 'Regio 4'];

function clean(value) {
  return String(value ?? '').trim();
}

function splitList(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  return String(value || '').split(/[\n,;]/).map(clean).filter(Boolean);
}

function findByStore(map, store) {
  if (!map || typeof map !== 'object') return {};
  return map[store] || map[normalizeStore(store)] || map[Object.keys(map).find((key) => normalizeStore(key) === normalizeStore(store))] || {};
}

function cityEmail(store) {
  const city = clean(store)
    .replace(/^GENTS\s+/i, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '')
    .toLowerCase();
  return city ? `${city}@gents.nl` : '';
}

function normalizeContacts(input = {}) {
  const saved = input.storeContacts && typeof input.storeContacts === 'object' ? input.storeContacts : {};
  const configured = getStoreMailSettings();
  const contacts = {};

  for (const branch of listBranches()) {
    const store = branch.store;
    const raw = findByStore(saved, store);
    const env = findByStore(configured, store);
    const fallback = cityEmail(store);
    const email = clean(raw.email || raw.storeEmail || env.email || fallback);
    contacts[store] = {
      store,
      email,
      cc: splitList(raw.cc || env.cc || ''),
      source: raw.email || raw.storeEmail ? 'shopify' : env.email ? 'env' : fallback ? 'city-fallback' : 'missing'
    };
  }

  return contacts;
}

/* Sections die getoond kunnen worden in het rapport. Per regio aan/uit
   schakelbaar. Default = alles aan zodat bestaande configuraties hetzelfde
   blijven. */
const SECTION_KEYS = ['pickpack', 'overdueOrders', 'overdueExchanges', 'customerSignups', 'shippingLabels'];

function normalizeSections(input = {}) {
  if (!input || typeof input !== 'object') input = {};
  const out = {};
  for (const key of SECTION_KEYS) {
    /* Default true tenzij expliciet false */
    out[key] = input[key] !== false;
  }
  return out;
}

const ALLOWED_PERIODS = new Set(['last-week', 'last-2-weeks', 'last-month']);

function normalizePeriod(value) {
  const cleaned = clean(value).toLowerCase();
  return ALLOWED_PERIODS.has(cleaned) ? cleaned : 'last-week';
}

function normalizeRegion(input = {}, index = 0) {
  return {
    id: clean(input.id) || `region-${index + 1}`,
    name: clean(input.name) || DEFAULT_REGION_NAMES[index] || `Regio ${index + 1}`,
    managerName: clean(input.managerName || input.regioManagerName || input.manager || ''),
    email: clean(input.email || input.managerEmail || input.regioManagerEmail || ''),
    cc: splitList(input.cc),
    stores: Array.isArray(input.stores) ? input.stores.map(clean).filter(Boolean) : [],
    sections: normalizeSections(input.sections),
    period: normalizePeriod(input.period)
  };
}

/* Schedule voor wanneer de cron daadwerkelijk een mail stuurt. De Vercel-
   cron in vercel.json fireert dagelijks; de cron-handler checkt dit object
   en slaat dagen over die niet matchen.
   - frequency: 'weekly' | 'biweekly' | 'monthly'
   - dayOfWeek: 1=ma ... 7=zo (voor weekly/biweekly)
   - dayOfMonth: 1-28 (voor monthly)
   - hour: 0-23 — informatief (echt uur wordt bepaald door vercel.json cron) */
const ALLOWED_FREQUENCIES = new Set(['weekly', 'biweekly', 'monthly']);

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeSchedule(input = {}) {
  if (!input || typeof input !== 'object') input = {};
  const frequency = ALLOWED_FREQUENCIES.has(input.frequency) ? input.frequency : 'weekly';
  return {
    frequency,
    dayOfWeek: clampInt(input.dayOfWeek, 1, 7, 1),       /* default: maandag */
    dayOfMonth: clampInt(input.dayOfMonth, 1, 28, 1),    /* default: de 1e */
    hour: clampInt(input.hour, 0, 23, 8)                 /* default: 08:00 */
  };
}

function normalizeConfig(input = {}) {
  const defaultStores = listBranches().map((branch) => branch.store);
  const rawRegions = Array.isArray(input.regions) ? input.regions : [];
  const regions = Array.from({ length: 4 }).map((_, index) => normalizeRegion(rawRegions[index] || {}, index));
  const assigned = new Set(regions.flatMap((region) => region.stores));

  defaultStores.forEach((store, index) => {
    if (assigned.has(store)) return;
    regions[index % regions.length].stores.push(store);
  });

  return {
    version: 3,
    updatedAt: clean(input.updatedAt) || new Date().toISOString(),
    updatedBy: clean(input.updatedBy || ''),
    deadlineOperationalDays: Number(input.deadlineOperationalDays || process.env.WEBORDER_DEADLINE_OPERATIONAL_DAYS || 2),
    exchangeDeadlineOperationalDays: Number(input.exchangeDeadlineOperationalDays || process.env.EXCHANGE_DEADLINE_OPERATIONAL_DAYS || 7),
    schedule: normalizeSchedule(input.schedule),
    storeContacts: normalizeContacts(input),
    regions
  };
}

async function readBlobText(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('Regio configuratie kon niet worden gelezen.');
  return response.text();
}

export async function getRegionReportConfig() {
  try {
    const result = await list({ prefix: CONFIG_PATH, limit: 1 });
    const blob = result.blobs.find((item) => item.pathname === CONFIG_PATH);
    if (!blob) return normalizeConfig();
    const raw = await readBlobText(blob.url);
    return normalizeConfig(JSON.parse(raw || '{}'));
  } catch (error) {
    console.error('Read region report config error:', error);
    return normalizeConfig();
  }
}

export async function saveRegionReportConfig(input = {}) {
  const config = normalizeConfig({ ...input, updatedAt: new Date().toISOString() });
  await put(CONFIG_PATH, JSON.stringify(config, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
  return config;
}

export function flattenRegionStores(config = {}) {
  const rows = [];
  const contacts = config.storeContacts || {};
  for (const region of config.regions || []) {
    for (const store of region.stores || []) {
      rows.push({
        store,
        regionId: region.id,
        regionName: region.name,
        managerName: region.managerName,
        email: region.email,
        cc: region.cc || [],
        storeEmail: contacts[store]?.email || cityEmail(store),
        storeCc: contacts[store]?.cc || []
      });
    }
  }
  return rows;
}

export function getRegionForStore(config = {}, store = '') {
  const key = clean(store).toLowerCase();
  return (config.regions || []).find((region) =>
    (region.stores || []).some((item) => clean(item).toLowerCase() === key)
  ) || null;
}
