import { put, list } from '@vercel/blob';

const STORE_PATH = 'reserveringen/items.json';
const DEFAULT_GELDIGHEID_DAGEN = 7;

async function readBlobText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Reserveringen kunnen niet worden gelezen.');
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
    console.error('[reserveringen-store] read error:', error);
    return [];
  }
}

async function saveAll(items) {
  await put(STORE_PATH, JSON.stringify(items, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
}

/* Status-flow:
   'open'      → reservering actief, artikel apart gehangen
   'opgehaald' → klant heeft artikel meegenomen, reservering afgesloten
   'verlopen'  → geldig-tot datum gepasseerd zonder ophalen
   'opgeheven' → handmatig opgeheven (artikel terug in winkel-voorraad) */
const ALLOWED_STATUSES = new Set(['open', 'opgehaald', 'verlopen', 'opgeheven']);

function defaultGeldigTot() {
  const d = new Date();
  d.setDate(d.getDate() + DEFAULT_GELDIGHEID_DAGEN);
  return d.toISOString().slice(0, 10);
}

export async function getReserveringen({ store = '', status = '', includeAll = false, limit = 200 } = {}) {
  const all = await loadAll();
  let rows = all.slice();
  if (store) {
    const target = String(store).trim().toLowerCase();
    rows = rows.filter((r) => String(r.store || '').trim().toLowerCase() === target);
  }
  if (status) {
    rows = rows.filter((r) => String(r.status || '').toLowerCase() === String(status).toLowerCase());
  } else if (!includeAll) {
    /* Default: alleen open + opgehaald van laatste 30d, geen verouderde */
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
    rows = rows.filter((r) => {
      if (r.status === 'open') return true;
      if (new Date(r.updatedAt || r.createdAt || 0) >= cutoff) return true;
      return false;
    });
  }
  rows.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return rows.slice(0, limit);
}

export async function createReservering(input) {
  const store = String(input.store || '').trim();
  if (!store) throw new Error('Geen winkel opgegeven.');
  const employeeName = String(input.employeeName || '').trim();
  if (!employeeName) throw new Error('Geen medewerker-naam opgegeven.');

  const item = {
    sku: String(input.sku || '').trim(),
    barcode: String(input.barcode || '').trim(),
    title: String(input.title || '').trim(),
    size: String(input.size || '').trim(),
    color: String(input.color || '').trim(),
    quantity: Math.max(1, Math.floor(Number(input.quantity || 1))),
    price: Number(input.price || 0) || 0,
    image: String(input.image || '').trim()
  };
  if (!item.sku && !item.barcode) throw new Error('Geen SKU of barcode opgegeven.');
  if (!item.title) throw new Error('Geen artikel-titel.');

  const reservering = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    store,
    resBranchId: String(input.resBranchId || '').trim(),
    resBranchName: String(input.resBranchName || '').trim(),
    employeeName,
    item,
    /* Klant: optioneel — kan later toegevoegd worden */
    customer: {
      name: String(input.customerName || '').trim(),
      phone: String(input.customerPhone || '').trim(),
      email: String(input.customerEmail || '').trim().toLowerCase(),
      srsCustomerId: String(input.srsCustomerId || '').trim()
    },
    reason: String(input.reason || 'klant_apart').trim(), /* 'klant_apart' | 'klant_komt' | 'apart_hangen' */
    note: String(input.note || '').trim().slice(0, 500),
    geldigTot: String(input.geldigTot || '').trim() || defaultGeldigTot(),
    status: 'open',
    statusHistory: [{ status: 'open', at: new Date().toISOString(), by: employeeName }],
    srsSyncStatus: 'pending', /* placeholder voor toekomstige SRS Uitwisseling-sync */
    srsTransactionId: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const all = await loadAll();
  all.push(reservering);
  await saveAll(all);
  return reservering;
}

export async function updateReservering(id, patch = {}, actor = '') {
  const target = String(id || '').trim();
  if (!target) throw new Error('Geen reservering-id opgegeven.');
  const all = await loadAll();
  const idx = all.findIndex((r) => r.id === target);
  if (idx === -1) throw new Error('Reservering niet gevonden.');
  const current = all[idx];
  const next = { ...current };

  if (patch.status) {
    const status = String(patch.status).toLowerCase();
    if (!ALLOWED_STATUSES.has(status)) throw new Error(`Ongeldige status: ${status}`);
    if (status !== current.status) {
      next.status = status;
      next.statusHistory = [
        ...(Array.isArray(current.statusHistory) ? current.statusHistory : []),
        { status, at: new Date().toISOString(), by: actor || 'systeem', note: patch.note || '' }
      ];
    }
  }
  if (patch.geldigTot !== undefined) next.geldigTot = String(patch.geldigTot || '').trim();
  if (patch.note !== undefined) next.note = String(patch.note || '').trim().slice(0, 500);
  if (patch.srsSyncStatus) next.srsSyncStatus = String(patch.srsSyncStatus).trim();
  if (patch.srsTransactionId) next.srsTransactionId = String(patch.srsTransactionId).trim();
  if (patch.customer) {
    next.customer = { ...(current.customer || {}), ...patch.customer };
  }
  next.updatedAt = new Date().toISOString();

  all[idx] = next;
  await saveAll(all);
  return next;
}

export async function expireOudeReserveringen() {
  /* Markeer 'open' reserveringen waarvan geldigTot < vandaag als 'verlopen'.
     Wordt aangeroepen door een dagelijkse cron (toevoegen aan vercel.json). */
  const today = new Date().toISOString().slice(0, 10);
  const all = await loadAll();
  let touched = 0;
  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    if (r.status === 'open' && r.geldigTot && r.geldigTot < today) {
      all[i] = {
        ...r,
        status: 'verlopen',
        statusHistory: [
          ...(Array.isArray(r.statusHistory) ? r.statusHistory : []),
          { status: 'verlopen', at: new Date().toISOString(), by: 'systeem', note: 'Auto-verlopen na geldig-tot datum' }
        ],
        updatedAt: new Date().toISOString()
      };
      touched++;
    }
  }
  if (touched > 0) await saveAll(all);
  return { processed: all.length, expired: touched };
}
