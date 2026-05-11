import { list, put } from '@vercel/blob';
import { listBranches } from './branch-metrics.js';

const CONFIG_PATH = 'admin/region-report-config.json';

const DEFAULT_REGION_NAMES = ['Regio 1', 'Regio 2', 'Regio 3', 'Regio 4'];

function clean(value) {
  return String(value ?? '').trim();
}

function splitList(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  return String(value || '')
    .split(/[\n,;]/)
    .map(clean)
    .filter(Boolean);
}

function normalizeRegion(input = {}, index = 0) {
  return {
    id: clean(input.id) || `region-${index + 1}`,
    name: clean(input.name) || DEFAULT_REGION_NAMES[index] || `Regio ${index + 1}`,
    managerName: clean(input.managerName || input.regioManagerName || input.manager || ''),
    email: clean(input.email || input.managerEmail || input.regioManagerEmail || ''),
    cc: splitList(input.cc),
    stores: Array.isArray(input.stores) ? input.stores.map(clean).filter(Boolean) : []
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
    version: 1,
    updatedAt: clean(input.updatedAt) || new Date().toISOString(),
    updatedBy: clean(input.updatedBy || ''),
    deadlineOperationalDays: Number(input.deadlineOperationalDays || process.env.WEBORDER_DEADLINE_OPERATIONAL_DAYS || 2),
    exchangeDeadlineOperationalDays: Number(input.exchangeDeadlineOperationalDays || process.env.EXCHANGE_DEADLINE_OPERATIONAL_DAYS || 7),
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
  for (const region of config.regions || []) {
    for (const store of region.stores || []) {
      rows.push({
        store,
        regionId: region.id,
        regionName: region.name,
        managerName: region.managerName,
        email: region.email,
        cc: region.cc || []
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
