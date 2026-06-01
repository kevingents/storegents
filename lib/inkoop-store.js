/**
 * lib/inkoop-store.js
 *
 * Inkoop-menu: leveranciers + inkooporders in één blob zodat schrijven atomair
 * is en het aantal blobs laag blijft.
 *
 * Blob inkoop/inkoop.json:
 *   {
 *     suppliers: { [id]: Supplier },
 *     orders:    { [id]: Order },
 *     counter:   { [year]: number },   // volgnummer per jaar voor PO-nummers
 *     updatedAt
 *   }
 *
 * Supplier: { id, srsId, name, email, ccEmails[], contactName, phone, address,
 *             leverancierscode, paymentTerms, deliveryDays, notes, active,
 *             createdAt, updatedAt, createdBy }
 * Order:    { id, orderNr, srsOrderNr, supplierId, supplierName, supplierEmail,
 *             branchId, branchName,
 *             status('concept'|'verstuurd'|'doorgezet'|'deels_ontvangen'|'ontvangen'|'geannuleerd'),
 *             orderDate, expectedDate, reference, notes,
 *             lines: [{ barcode, sku, description, color, size, quantity, purchasePrice }],
 *             totalPieces, totalValue,
 *             mailedAt, mailedTo, srsPushedAt, srsOrderNr, srsResult,
 *             history: [{ at, actor, action, detail }],
 *             createdAt, updatedAt, createdBy }
 *
 * Schrijven via mutateJsonBlob (verse cache-busted RMW + no-cache write) zodat een
 * directe reload altijd de nieuwe staat ziet (les uit kpi/customer-targets/recruitment).
 */

import { readJsonBlob, mutateJsonBlob } from './json-blob-store.js';

const PATH = 'inkoop/inkoop.json';
const EMPTY = { suppliers: {}, orders: {}, counter: {}, updatedAt: null };

const clean = (v) => String(v == null ? '' : v).trim();
const nowIso = () => new Date().toISOString();
const num = (v) => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function genId(prefix) {
  const rnd = (globalThis.crypto?.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2)));
  return `${prefix}_${rnd}`.replace(/-/g, '').slice(0, 28);
}

export const ORDER_STATUSES = Object.freeze(['concept', 'verstuurd', 'doorgezet', 'deels_ontvangen', 'ontvangen', 'geannuleerd']);
/* Statussen die als "openstaand" gelden (nog niet volledig afgehandeld). */
export const OPEN_STATUSES = Object.freeze(['concept', 'verstuurd', 'doorgezet', 'deels_ontvangen']);

const arr = (v) => Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);

async function readAll() {
  const d = await readJsonBlob(PATH, EMPTY);
  return {
    suppliers: (d && d.suppliers) || {},
    orders: (d && d.orders) || {},
    counter: (d && d.counter) || {},
    updatedAt: d?.updatedAt || null
  };
}

/* ── Leveranciers ──────────────────────────────────────────────────────── */

function normSupplier(s = {}, prev = {}) {
  return {
    id: prev.id || s.id || genId('lev'),
    srsId: clean(s.srsId ?? prev.srsId),
    name: clean(s.name ?? prev.name),
    email: clean(s.email ?? prev.email),
    ccEmails: arr(s.ccEmails ?? prev.ccEmails).map(clean).filter(Boolean),
    contactName: clean(s.contactName ?? prev.contactName),
    phone: clean(s.phone ?? prev.phone),
    address: String(s.address ?? prev.address ?? '').slice(0, 600),
    leverancierscode: clean(s.leverancierscode ?? prev.leverancierscode),
    paymentTerms: clean(s.paymentTerms ?? prev.paymentTerms),
    deliveryDays: Number(s.deliveryDays ?? prev.deliveryDays) || null,
    notes: String(s.notes ?? prev.notes ?? '').slice(0, 2000),
    active: s.active === undefined ? (prev.active !== false) : Boolean(s.active),
    createdAt: prev.createdAt || nowIso(),
    updatedAt: nowIso(),
    createdBy: prev.createdBy || clean(s.actor) || 'admin'
  };
}

export async function listSuppliers({ activeOnly = false } = {}) {
  const { suppliers } = await readAll();
  let rows = Object.values(suppliers);
  if (activeOnly) rows = rows.filter((s) => s.active !== false);
  return rows.sort((a, b) => String(a.name).localeCompare(String(b.name), 'nl'));
}

export async function getSupplier(id) {
  const { suppliers } = await readAll();
  return suppliers[clean(id)] || null;
}

export async function upsertSupplier(patch = {}, actor = 'admin') {
  if (!clean(patch.name)) throw new Error('Leveranciersnaam is verplicht.');
  const id = clean(patch.id);
  let saved = null;
  await mutateJsonBlob(PATH, (d0) => {
    const d = (d0 && typeof d0 === 'object') ? d0 : { ...EMPTY };
    const suppliers = d.suppliers || {};
    const prev = id ? (suppliers[id] || {}) : {};
    const row = normSupplier({ ...patch, actor }, prev);
    suppliers[row.id] = row;
    saved = row;
    return { ...d, suppliers, updatedAt: nowIso() };
  }, { fallback: { ...EMPTY } });
  return saved;
}

export async function deleteSupplier(id) {
  const key = clean(id);
  let removed = false;
  await mutateJsonBlob(PATH, (d0) => {
    const d = (d0 && typeof d0 === 'object') ? d0 : { ...EMPTY };
    const suppliers = d.suppliers || {};
    if (suppliers[key]) { delete suppliers[key]; removed = true; }
    return { ...d, suppliers, updatedAt: nowIso() };
  }, { fallback: { ...EMPTY } });
  return removed;
}

/**
 * Importeer/merge leveranciers uit SRS-historie (PurchaseOrders bevat
 * Supplier{Id,Name}). Bestaande lokale leverancier (zelfde srsId of naam) wordt
 * niet overschreven; alleen ontbrekende worden aangemaakt. Returnt {added, total}.
 */
export async function mergeSrsSuppliers(srsSuppliers = [], actor = 'srs-import') {
  let added = 0;
  await mutateJsonBlob(PATH, (d0) => {
    const d = (d0 && typeof d0 === 'object') ? d0 : { ...EMPTY };
    const suppliers = d.suppliers || {};
    const existing = Object.values(suppliers);
    const haveSrs = new Set(existing.map((s) => clean(s.srsId)).filter(Boolean));
    const haveName = new Set(existing.map((s) => clean(s.name).toLowerCase()).filter(Boolean));
    for (const s of srsSuppliers || []) {
      const srsId = clean(s.id);
      const name = clean(s.name);
      if (!name && !srsId) continue;
      if (srsId && haveSrs.has(srsId)) continue;
      if (name && haveName.has(name.toLowerCase())) continue;
      const row = normSupplier({ srsId, name, actor }, {});
      suppliers[row.id] = row;
      if (srsId) haveSrs.add(srsId);
      if (name) haveName.add(name.toLowerCase());
      added += 1;
    }
    return { ...d, suppliers, updatedAt: nowIso() };
  }, { fallback: { ...EMPTY } });
  const { suppliers } = await readAll();
  return { added, total: Object.keys(suppliers).length };
}

/* ── Inkooporders ──────────────────────────────────────────────────────── */

function normLines(lines = []) {
  return arr(lines).map((l) => ({
    barcode: clean(l.barcode),
    sku: clean(l.sku),
    description: clean(l.description),
    color: clean(l.color),
    size: clean(l.size),
    quantity: Math.max(0, Math.round(num(l.quantity))),
    purchasePrice: round2(num(l.purchasePrice))
  })).filter((l) => l.barcode || l.sku || l.description);
}

function lineTotals(lines) {
  const totalPieces = lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0);
  const totalValue = round2(lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.purchasePrice) || 0), 0));
  return { totalPieces, totalValue };
}

function nextOrderNr(counter) {
  const year = new Date().getUTCFullYear();
  const n = (Number(counter[year]) || 0) + 1;
  counter[year] = n;
  return `PO-${year}-${String(n).padStart(4, '0')}`;
}

export async function listOrders({ status = '', supplierId = '', branchId = '', openOnly = false } = {}) {
  const { orders } = await readAll();
  let rows = Object.values(orders);
  if (status) rows = rows.filter((o) => o.status === status);
  if (openOnly) rows = rows.filter((o) => OPEN_STATUSES.includes(o.status));
  if (supplierId) rows = rows.filter((o) => o.supplierId === supplierId);
  if (branchId) rows = rows.filter((o) => String(o.branchId) === String(branchId));
  return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function getOrder(id) {
  const { orders } = await readAll();
  return orders[clean(id)] || null;
}

export async function createOrder(input = {}, actor = 'admin') {
  if (!clean(input.supplierId) && !clean(input.supplierName)) throw new Error('Leverancier is verplicht.');
  const lines = normLines(input.lines);
  if (!lines.length) throw new Error('Voeg minstens één orderregel toe.');
  let saved = null;
  await mutateJsonBlob(PATH, (d0) => {
    const d = (d0 && typeof d0 === 'object') ? d0 : { ...EMPTY };
    const orders = d.orders || {};
    const counter = d.counter || {};
    const supplier = (d.suppliers || {})[clean(input.supplierId)] || {};
    const { totalPieces, totalValue } = lineTotals(lines);
    const row = {
      id: genId('po'),
      orderNr: nextOrderNr(counter),
      srsOrderNr: '',
      supplierId: clean(input.supplierId),
      supplierName: supplier.name || clean(input.supplierName),
      supplierEmail: supplier.email || clean(input.supplierEmail),
      branchId: clean(input.branchId),
      branchName: clean(input.branchName),
      status: 'concept',
      orderDate: clean(input.orderDate) || nowIso().slice(0, 10),
      expectedDate: clean(input.expectedDate),
      reference: clean(input.reference),
      notes: String(input.notes || '').slice(0, 2000),
      lines,
      totalPieces,
      totalValue,
      mailedAt: null,
      mailedTo: '',
      srsPushedAt: null,
      srsResult: null,
      history: [{ at: nowIso(), actor: clean(actor) || 'admin', action: 'aangemaakt', detail: `${lines.length} regels, ${totalPieces} stuks` }],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      createdBy: clean(actor) || 'admin'
    };
    orders[row.id] = row;
    saved = row;
    return { ...d, orders, counter, updatedAt: nowIso() };
  }, { fallback: { ...EMPTY } });
  return saved;
}

export async function updateOrder(id, patch = {}, actor = 'admin') {
  const key = clean(id);
  let saved = null;
  await mutateJsonBlob(PATH, (d0) => {
    const d = (d0 && typeof d0 === 'object') ? d0 : { ...EMPTY };
    const orders = d.orders || {};
    const prev = orders[key];
    if (!prev) return d;
    if (['doorgezet', 'ontvangen'].includes(prev.status)) throw new Error('Een doorgezette/ontvangen order kan niet meer gewijzigd worden.');
    const next = { ...prev };
    if (patch.supplierId !== undefined) {
      next.supplierId = clean(patch.supplierId);
      const sup = (d.suppliers || {})[next.supplierId];
      if (sup) { next.supplierName = sup.name; next.supplierEmail = sup.email; }
    }
    if (patch.supplierName !== undefined) next.supplierName = clean(patch.supplierName);
    if (patch.supplierEmail !== undefined) next.supplierEmail = clean(patch.supplierEmail);
    if (patch.branchId !== undefined) next.branchId = clean(patch.branchId);
    if (patch.branchName !== undefined) next.branchName = clean(patch.branchName);
    if (patch.orderDate !== undefined) next.orderDate = clean(patch.orderDate);
    if (patch.expectedDate !== undefined) next.expectedDate = clean(patch.expectedDate);
    if (patch.reference !== undefined) next.reference = clean(patch.reference);
    if (patch.notes !== undefined) next.notes = String(patch.notes || '').slice(0, 2000);
    if (patch.lines !== undefined) {
      next.lines = normLines(patch.lines);
      const t = lineTotals(next.lines);
      next.totalPieces = t.totalPieces;
      next.totalValue = t.totalValue;
    }
    next.updatedAt = nowIso();
    next.history = [...(prev.history || []), { at: nowIso(), actor: clean(actor) || 'admin', action: 'gewijzigd', detail: '' }];
    orders[key] = next;
    saved = next;
    return { ...d, orders, updatedAt: nowIso() };
  }, { fallback: { ...EMPTY } });
  return saved;
}

/** Status zetten met audit-regel. */
export async function setOrderStatus(id, status, actor = 'admin', detail = '') {
  if (!ORDER_STATUSES.includes(status)) throw new Error('Onbekende status.');
  const key = clean(id);
  let saved = null;
  await mutateJsonBlob(PATH, (d0) => {
    const d = (d0 && typeof d0 === 'object') ? d0 : { ...EMPTY };
    const orders = d.orders || {};
    const prev = orders[key];
    if (!prev) return d;
    const next = { ...prev, status, updatedAt: nowIso() };
    next.history = [...(prev.history || []), { at: nowIso(), actor: clean(actor) || 'admin', action: `status: ${status}`, detail: clean(detail) }];
    orders[key] = next;
    saved = next;
    return { ...d, orders, updatedAt: nowIso() };
  }, { fallback: { ...EMPTY } });
  return saved;
}

/** Registreer dat de order naar de leverancier is gemaild. */
export async function recordMail(id, { to, actor = 'admin' } = {}) {
  const key = clean(id);
  let saved = null;
  await mutateJsonBlob(PATH, (d0) => {
    const d = (d0 && typeof d0 === 'object') ? d0 : { ...EMPTY };
    const orders = d.orders || {};
    const prev = orders[key];
    if (!prev) return d;
    const next = { ...prev, mailedAt: nowIso(), mailedTo: clean(to), updatedAt: nowIso() };
    if (next.status === 'concept') next.status = 'verstuurd';
    next.history = [...(prev.history || []), { at: nowIso(), actor: clean(actor) || 'admin', action: 'gemaild', detail: clean(to) }];
    orders[key] = next;
    saved = next;
    return { ...d, orders, updatedAt: nowIso() };
  }, { fallback: { ...EMPTY } });
  return saved;
}

/** Registreer het resultaat van het doorzetten naar SRS. */
export async function recordSrsPush(id, { srsOrderNr, result, actor = 'admin' } = {}) {
  const key = clean(id);
  let saved = null;
  await mutateJsonBlob(PATH, (d0) => {
    const d = (d0 && typeof d0 === 'object') ? d0 : { ...EMPTY };
    const orders = d.orders || {};
    const prev = orders[key];
    if (!prev) return d;
    const next = {
      ...prev,
      srsPushedAt: nowIso(),
      srsOrderNr: clean(srsOrderNr) || prev.srsOrderNr,
      srsResult: result || null,
      status: prev.status === 'ontvangen' ? prev.status : 'doorgezet',
      updatedAt: nowIso()
    };
    next.history = [...(prev.history || []), { at: nowIso(), actor: clean(actor) || 'admin', action: 'doorgezet naar SRS', detail: clean(srsOrderNr) }];
    orders[key] = next;
    saved = next;
    return { ...d, orders, updatedAt: nowIso() };
  }, { fallback: { ...EMPTY } });
  return saved;
}

/**
 * Pas ontvangst-info toe vanuit SRS (reconcile). Werkt piecesReceived/-Open bij
 * en zet de status (deels_ontvangen/ontvangen/geannuleerd). Logt alleen een
 * history-regel als de status wijzigt (geen spam bij ongewijzigde sync).
 * @returns {Promise<{changed:boolean, order:object|null}>}
 */
export async function applyReceiving(id, { status, piecesReceived, piecesOrdered, piecesOpen, actor = 'srs-sync' } = {}) {
  const key = clean(id);
  let changed = false;
  let saved = null;
  await mutateJsonBlob(PATH, (d0) => {
    const d = (d0 && typeof d0 === 'object') ? d0 : { ...EMPTY };
    const orders = d.orders || {};
    const prev = orders[key];
    if (!prev) return d;
    const rcv = Math.max(0, Math.round(num(piecesReceived)));
    const ord = piecesOrdered != null ? Math.max(0, Math.round(num(piecesOrdered))) : (prev.piecesOrdered ?? prev.totalPieces ?? 0);
    const open = piecesOpen != null ? Math.max(0, Math.round(num(piecesOpen))) : Math.max(0, ord - rcv);
    const statusChanged = status && ORDER_STATUSES.includes(status) && status !== prev.status;
    const next = {
      ...prev,
      piecesReceived: rcv,
      piecesOrdered: ord,
      piecesOpen: open,
      receivedSyncAt: nowIso(),
      updatedAt: nowIso()
    };
    if (statusChanged) {
      next.status = status;
      next.history = [...(prev.history || []), { at: nowIso(), actor: clean(actor) || 'srs-sync', action: `status: ${status}`, detail: `${rcv}/${ord} ontvangen` }];
      changed = true;
    } else if ((prev.piecesReceived || 0) !== rcv) {
      changed = true;
    }
    orders[key] = next;
    saved = next;
    return { ...d, orders, updatedAt: nowIso() };
  }, { fallback: { ...EMPTY } });
  return { changed, order: saved };
}

export async function deleteOrder(id) {
  const key = clean(id);
  let removed = false;
  await mutateJsonBlob(PATH, (d0) => {
    const d = (d0 && typeof d0 === 'object') ? d0 : { ...EMPTY };
    const orders = d.orders || {};
    if (orders[key]) { delete orders[key]; removed = true; }
    return { ...d, orders, updatedAt: nowIso() };
  }, { fallback: { ...EMPTY } });
  return removed;
}

/** Aantal lokale openstaande orders (voor de menu-badge). */
export async function countOpenOrders() {
  const { orders } = await readAll();
  return Object.values(orders).filter((o) => OPEN_STATUSES.includes(o.status)).length;
}
