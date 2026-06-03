import { put, list } from '@vercel/blob';
import { nlTodayIso } from './datetime-nl.js';

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
    srsSyncStatus: 'pending', /* 'pending' → 'weborder_created' (oude) → 'weborder_routed_to_res' (gelukt) / 'route_failed' / 'failed' */
    srsTransactionId: '',      /* SRS orderId (bv. R...) */
    srsFulfillmentId: '',      /* SRS leveropdracht-id na getFulfillments */
    srsError: '',              /* Laatste foutmelding bij SRS-sync */
    srsRawSnippet: '',         /* Eerste 500 chars van SRS-response voor debug */
    srsAttempts: 0,            /* Aantal SRS-pogingen */
    srsLastAttemptAt: '',      /* Wanneer laatste poging */
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
  if (patch.srsTransactionId !== undefined) next.srsTransactionId = String(patch.srsTransactionId || '').trim();
  if (patch.srsFulfillmentId !== undefined) next.srsFulfillmentId = String(patch.srsFulfillmentId || '').trim();
  if (patch.srsError !== undefined) {
    /* Defensive: srsError moet ALTIJD een string zijn. Soms wordt er per
       ongeluk een Error-object of fault-object meegegeven, wat in de UI
       als '[object Object]' verschijnt. */
    const raw = patch.srsError;
    let text = '';
    if (raw == null) text = '';
    else if (typeof raw === 'string') text = raw;
    else if (raw instanceof Error) text = raw.message || String(raw);
    else if (typeof raw === 'object') {
      try { text = raw.message ? String(raw.message) : JSON.stringify(raw); }
      catch { text = '[object — kon niet serialiseren]'; }
    } else text = String(raw);
    next.srsError = text.trim().slice(0, 500);
  }
  if (patch.srsRawSnippet !== undefined) {
    const raw = patch.srsRawSnippet;
    next.srsRawSnippet = (typeof raw === 'string' ? raw : String(raw || '')).slice(0, 500);
  }
  if (patch.srsAttempts !== undefined) next.srsAttempts = Number(patch.srsAttempts) || 0;
  if (patch.srsLastAttemptAt !== undefined) next.srsLastAttemptAt = String(patch.srsLastAttemptAt || '');
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
     Wordt aangeroepen door een dagelijkse cron (toevoegen aan vercel.json).
     BUG FIX: gebruik NL-datum i.p.v. UTC-slice — anders zet de cron die in
     de NL-avond/nacht draait reserveringen die nog vandaag geldig zijn
     direct op 'verlopen' (UTC-midnight valt 22-24 NL al in 'morgen'). */
  const today = nlTodayIso();
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
