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
    const params = new URLSearchParams({
      createdFrom: fromDate,
      sort: '-createdAt',
      limit: String(limit),
      page: String(page)
    });
    if (createdTo) params.set('createdTo', createdTo);
    /* URLSearchParams want array support is via append — handmatig voor expand=A&expand=B */
    params.append('expand', 'consumer');
    params.append('expand', 'returnReason');

    const result = await returnistaFetch(`/return-requests?${params.toString()}`);
    const items = result.data || [];
    records.push(...items);
    hasMore = Boolean(result.hasMore) && items.length === limit;
    page += 1;
    /* Veiligheids-cap op pagina's (2000 records / 50 per page = 40 pages max) */
    if (page > 200) {
      console.warn(`[returnista] getReturnRequests safety-cap bereikt na 200 pages — tail mogelijk niet meegenomen (${records.length} records).`);
      records.truncated = true;
      break;
    }
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
    if (page > 200) {
      console.warn(`[returnista] getReturnOrders safety-cap bereikt na 200 pages — tail mogelijk niet meegenomen (${records.length} records).`);
      records.truncated = true;
      break;
    }
  }

  return records;
}

/* Vertaal Returnista English reason → Nederlandse label */
const REASON_NL = {
  "Doesn't meet expectations": 'Voldoet niet aan verwachting',
  'Damaged or defective': 'Beschadigd of defect',
  'Wrong item received': 'Verkeerd artikel ontvangen',
  'Too small': 'Te klein',
  'Too large': 'Te groot',
  'Too big': 'Te groot',
  "Doesn't fit": 'Past niet',
  'Changed my mind': 'Andere keuze',
  'Found cheaper elsewhere': 'Elders goedkoper',
  'Ordered multiple sizes': 'Meerdere maten besteld',
  'Late delivery': 'Te laat geleverd',
  'Different from description': 'Anders dan omschrijving',
  'Quality issue': 'Kwaliteitsprobleem',
  'Color different than expected': 'Kleur anders dan verwacht'
};

function pickReasonLabel(req) {
  /* Voorkeurs-volgorde:
     1. canonical description uit expand=returnReason
     2. comment (free-text van klant) als die zinvol lijkt
     3. genormaliseerde sub_return_reasons.* code
     4. fallback: '(geen reden)' — NIET de UUID */
  const desc = String(req.returnReason?.description || '').trim();
  if (desc) return REASON_NL[desc] || desc;

  const comment = String(req.returnReasonComment || '').trim();
  if (comment && comment !== '.' && comment.length >= 3) {
    /* sub_return_reasons.foo_bar → "Foo Bar" */
    if (comment.startsWith('sub_return_reasons.')) {
      return comment.replace(/^sub_return_reasons\./, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
    return comment;
  }

  return '(geen reden ingevuld)';
}

/**
 * Mapt een Returnista return-request naar onze admin retour-row shape.
 * Eén return-request = één geretourneerde orderregel (product).
 *
 * Verwacht dat de fetch `expand=consumer&expand=returnReason` heeft gebruikt,
 * anders blijven consumer-velden leeg en valt reason terug op comment/code.
 */
export function normalizeReturnRequest(req) {
  const product = req.product || {};
  const resolution = req.resolution || {};
  const consumer = req.consumer || {};
  const attributes = Array.isArray(product.attributes) ? product.attributes : [];
  const colorAttr = attributes.find((a) => String(a.name || '').toLowerCase() === 'kleur') ||
                    attributes.find((a) => String(a.name || '').toLowerCase() === 'color');
  const sizeAttr = attributes.find((a) => String(a.name || '').toLowerCase() === 'size') ||
                   attributes.find((a) => String(a.name || '').toLowerCase() === 'maat');

  const fullName = [consumer.firstName, consumer.lastName].filter(Boolean).join(' ').trim();
  const reasonLabel = pickReasonLabel(req);

  return {
    id: req.id || '',
    returnOrderId: req.returnOrderId || '',
    consumerId: req.consumerId || '',
    purchaseOrderNumber: String(req.purchaseOrderNumber || '').replace(/^#/, ''),
    orderNr: String(req.purchaseOrderNumber || '').replace(/^#/, ''),
    shopifyOrderNr: String(req.purchaseOrderNumber || '').replace(/^#/, ''),
    shopifyOrderId: String(req.shopifyOrderId || req.purchaseOrderId || ''),

    /* Klantgegevens uit expand=consumer */
    customerName: fullName || '(onbekende klant)',
    customerEmail: String(consumer.email || ''),
    customerCity: String(consumer.shippingAddress?.city || ''),
    customerPostal: String(consumer.shippingAddress?.postalCode || ''),

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
    returnReasonDescription: String(req.returnReason?.description || ''),
    reason: reasonLabel,

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
