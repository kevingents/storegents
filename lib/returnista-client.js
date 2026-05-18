/**
 * Returnista REST API client
 *
 * Docs: https://platform.returnista.com/reference/rest-api/
 * Base: https://core.returnista.com/api/v0
 * Auth: Bearer JWT from "Service User" account API key
 *
 * Env vars:
 *   RETURNISTA_API_TOKEN  — service user JWT
 *   RETURNISTA_ACCOUNT_ID — GENTS Returnista account UUID
 */

const RETURNISTA_BASE = 'https://core.returnista.com/api/v0';
const DEFAULT_TIMEOUT_MS = 30000;

function getConfig() {
  const token = String(process.env.RETURNISTA_API_TOKEN || '').trim();
  const accountId = String(process.env.RETURNISTA_ACCOUNT_ID || '').trim();
  if (!token) throw new Error('RETURNISTA_API_TOKEN ontbreekt in Vercel env vars.');
  if (!accountId) throw new Error('RETURNISTA_ACCOUNT_ID ontbreekt in Vercel env vars.');
  return { token, accountId };
}

async function returnistaFetch(path, { method = 'GET', query = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { token, accountId } = getConfig();
  const url = new URL(`${RETURNISTA_BASE}/account/${accountId}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v == null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      },
      signal: controller.signal
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
    if (!res.ok) {
      const msg = (data.errors && data.errors[0]?.message) || data.message || `Returnista ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/* Returnista API enforces max limit of 50 per page */
const MAX_PAGE_SIZE = 50;

/**
 * Haalt ALLE return-requests op vanaf createdFrom met paginatie tot maxRecords.
 * Default: laatste 90 dagen, max 2000 records.
 */
export async function getReturnRequests({ createdFrom, createdTo, maxRecords = 2000, pageSize = MAX_PAGE_SIZE } = {}) {
  const fromDate = createdFrom || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const records = [];
  let page = 1;
  let hasMore = true;
  const effectivePageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, pageSize));

  while (hasMore && records.length < maxRecords) {
    const limit = Math.min(effectivePageSize, maxRecords - records.length);
    const result = await returnistaFetch('/return-requests', {
      query: {
        createdFrom: fromDate,
        createdTo: createdTo || undefined,
        sort: '-createdAt',
        limit,
        page
      }
    });
    const items = result.data || [];
    records.push(...items);
    hasMore = Boolean(result.hasMore) && items.length === limit;
    page += 1;
    /* Veiligheids-cap op pagina's (2000 records / 50 per page = 40 pages max) */
    if (page > 200) break;
  }

  return records;
}

/**
 * Haalt return-orders op (top-level retour-pakketten).
 */
export async function getReturnOrders({ createdFrom, createdTo, maxRecords = 1000, pageSize = MAX_PAGE_SIZE } = {}) {
  const fromDate = createdFrom || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const records = [];
  let page = 1;
  let hasMore = true;
  const effectivePageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, pageSize));

  while (hasMore && records.length < maxRecords) {
    const limit = Math.min(effectivePageSize, maxRecords - records.length);
    const result = await returnistaFetch('/return-orders', {
      query: {
        createdFrom: fromDate,
        createdTo: createdTo || undefined,
        sort: '-createdAt',
        limit,
        page
      }
    });
    const items = result.data || [];
    records.push(...items);
    hasMore = Boolean(result.hasMore) && items.length === limit;
    page += 1;
    if (page > 200) break;
  }

  return records;
}

/**
 * Mapt een Returnista return-request naar onze admin retour-row shape.
 * Eén return-request = één geretourneerde orderregel (product).
 */
export function normalizeReturnRequest(req) {
  const product = req.product || {};
  const resolution = req.resolution || {};
  const attributes = Array.isArray(product.attributes) ? product.attributes : [];
  const colorAttr = attributes.find((a) => String(a.name || '').toLowerCase() === 'kleur') ||
                    attributes.find((a) => String(a.name || '').toLowerCase() === 'color');
  const sizeAttr = attributes.find((a) => String(a.name || '').toLowerCase() === 'size') ||
                   attributes.find((a) => String(a.name || '').toLowerCase() === 'maat');

  return {
    id: req.id || '',
    returnOrderId: req.returnOrderId || '',
    consumerId: req.consumerId || '',
    purchaseOrderNumber: String(req.purchaseOrderNumber || '').replace(/^#/, ''),
    orderNr: String(req.purchaseOrderNumber || '').replace(/^#/, ''),
    shopifyOrderNr: String(req.purchaseOrderNumber || '').replace(/^#/, ''),
    shopifyOrderId: String(req.purchaseOrderId || ''),

    /* Product */
    sku: String(product.sku || ''),
    barcode: String(product.barcode || ''),
    title: String(product.name || ''),
    productImage: product.thumbnailUrl || product.imageUrls?.[0] || '',
    color: colorAttr ? String(colorAttr.value || '') : '',
    size: sizeAttr ? String(sizeAttr.value || '') : '',
    quantity: 1,
    amount: Number(product.price?.value || 0),
    currency: product.price?.currency || 'EUR',

    /* Retour-proces */
    createdAt: req.createdAt || '',
    updatedAt: req.updatedAt || '',
    status: req.status || 'unknown',
    requestedResolution: req.requestedResolution || '',
    resolution: resolution.type || req.requestedResolution || '',
    resolutionStatus: resolution.status || '',
    returnReasonId: req.returnReasonId || '',
    returnReasonComment: req.returnReasonComment || '',
    reason: req.returnReasonComment || '',

    /* Vaste velden voor admin-portal compat */
    store: 'GENTS Magazijn',          /* Returnista → magazijn = online retour */
    branchId: '99',                   /* magazijn branchId */
    channel: 'online',                /* Returnista = online via definitie */
    source: 'returnista',
    success: ['Confirmed', 'Complete', 'Approved'].includes(String(req.status || '')),
    employeeName: 'Returnista (klant)',
    crossSellMade: false,
    crossSellAmount: 0,
    reasonChecked: Boolean(req.returnReasonId),
    error: ''
  };
}
