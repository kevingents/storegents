import { put, list } from '@vercel/blob';
import { findProductById } from './facilitair-products-config.js';

const STORE_PATH = 'facilitair/orders.json';

async function readBlobText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Facilitair-orders kon niet worden gelezen.');
  return response.text();
}

async function loadAll() {
  try {
    const result = await list({ prefix: STORE_PATH, limit: 1 });
    const blob = result.blobs.find((item) => item.pathname === STORE_PATH);
    if (!blob) return [];
    const raw = await readBlobText(blob.url);
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('[facilitair-orders-store] read error:', error);
    return [];
  }
}

async function saveAll(orders) {
  await put(STORE_PATH, JSON.stringify(orders, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
}

/* ─────────────────────────────────────────────────────────────────────────
   STATUS-FLOW
     'open'          → submitted door winkel, wacht op admin
     'in_behandeling'→ admin bezig (besteld bij leverancier)
     'onderweg'      → admin heeft bevestigd, levering verwacht
     'geleverd'      → afgehandeld
     'afgewezen'     → admin keurt af (met reden)
   ───────────────────────────────────────────────────────────────────────── */

const ALLOWED_STATUSES = new Set(['open', 'in_behandeling', 'onderweg', 'geleverd', 'afgewezen']);

function sanitizeItem(input) {
  const id = String(input.id || '').trim();
  const product = findProductById(id);
  if (!product) return null;
  const quantity = Math.max(0, Math.floor(Number(input.quantity || 0)));
  if (quantity <= 0) return null;
  return {
    id: product.id,
    name: product.name,
    category: product.category,
    unit: product.unit,
    quantity,
    advisedQuantity: Number(input.advisedQuantity || 0) || 0
  };
}

export async function getFacilitairOrders({ store = '', status = '', limit = 200 } = {}) {
  const all = await loadAll();
  let rows = all.slice();
  if (store) {
    const target = String(store).trim().toLowerCase();
    rows = rows.filter((row) => String(row.store || '').trim().toLowerCase() === target);
  }
  if (status) {
    rows = rows.filter((row) => String(row.status || '').trim().toLowerCase() === String(status).trim().toLowerCase());
  }
  rows.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return rows.slice(0, limit);
}

export async function getLastFacilitairOrderForStore(store) {
  const target = String(store || '').trim().toLowerCase();
  if (!target) return null;
  const all = await loadAll();
  const matching = all
    .filter((row) => String(row.store || '').trim().toLowerCase() === target)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return matching[0] || null;
}

/**
 * Maak een nieuwe bestelling aan vanuit een winkel-submit.
 */
export async function createFacilitairOrder(input) {
  const store = String(input.store || '').trim();
  if (!store) throw new Error('Geen winkel opgegeven.');
  const employeeName = String(input.employeeName || '').trim();
  if (!employeeName) throw new Error('Geen medewerker-naam opgegeven.');
  const items = Array.isArray(input.items)
    ? input.items.map(sanitizeItem).filter(Boolean)
    : [];
  if (!items.length) throw new Error('Geen producten geselecteerd (alle hoeveelheden waren 0).');

  const order = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    store,
    employeeName,
    items,
    note: String(input.note || '').trim().slice(0, 1000),
    snapshotVolumes: input.snapshotVolumes || null, /* { transactions, weborders } op moment van bestellen */
    status: 'open',
    statusHistory: [{ status: 'open', at: new Date().toISOString(), by: employeeName }],
    processedBy: '',
    processedAt: '',
    deliveryEta: '',
    adminNote: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const all = await loadAll();
  all.push(order);
  await saveAll(all);
  return order;
}

/**
 * Admin: pas status / details aan.
 */
export async function updateFacilitairOrder(id, patch = {}) {
  const target = String(id || '').trim();
  if (!target) throw new Error('Geen ordernummer opgegeven.');
  const all = await loadAll();
  const idx = all.findIndex((row) => row.id === target);
  if (idx === -1) throw new Error('Bestelling niet gevonden.');
  const current = all[idx];
  const next = { ...current };

  if (patch.status) {
    const status = String(patch.status).trim().toLowerCase();
    if (!ALLOWED_STATUSES.has(status)) throw new Error(`Ongeldige status: ${status}`);
    if (status !== current.status) {
      next.status = status;
      next.statusHistory = [
        ...(Array.isArray(current.statusHistory) ? current.statusHistory : []),
        { status, at: new Date().toISOString(), by: patch.actor || 'admin', note: patch.note || '' }
      ];
    }
  }
  if (patch.deliveryEta !== undefined) next.deliveryEta = String(patch.deliveryEta || '').trim();
  if (patch.adminNote !== undefined) next.adminNote = String(patch.adminNote || '').trim().slice(0, 1000);
  if (patch.processedBy !== undefined) next.processedBy = String(patch.processedBy || '').trim();
  if (patch.status === 'in_behandeling' || patch.status === 'onderweg' || patch.status === 'geleverd') {
    if (!next.processedAt) next.processedAt = new Date().toISOString();
  }
  next.updatedAt = new Date().toISOString();

  all[idx] = next;
  await saveAll(all);
  return next;
}

/**
 * Maandelijks rapportage-aggregaat per winkel.
 * Geeft per maand totaal aantal items per product-id.
 */
export async function getMonthlyFacilitairReport(store, months = 6) {
  const target = String(store || '').trim().toLowerCase();
  const all = await loadAll();
  const filtered = target
    ? all.filter((row) => String(row.store || '').trim().toLowerCase() === target)
    : all;

  const buckets = new Map(); /* 'YYYY-MM' → { 'product-id': totalQty } */
  for (const order of filtered) {
    const month = String(order.createdAt || '').slice(0, 7); /* YYYY-MM */
    if (!month) continue;
    const bucket = buckets.get(month) || {};
    for (const item of order.items || []) {
      bucket[item.id] = (bucket[item.id] || 0) + Number(item.quantity || 0);
    }
    buckets.set(month, bucket);
  }

  const sortedMonths = Array.from(buckets.keys()).sort().slice(-months);
  return sortedMonths.map((month) => ({ month, items: buckets.get(month) }));
}
