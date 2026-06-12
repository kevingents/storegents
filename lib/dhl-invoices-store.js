import { put, list } from '@vercel/blob';

/**
 * Opslag van geparste DHL-facturen (Vercel Blob). Eén JSON-array; idempotent op
 * factuurnummer (opnieuw inlezen overschrijft). Bron voor de transport-verdeling
 * (echte aantallen + kosten) en de SendCloud-reconciliatie.
 */

const INVOICES_PATH = 'dhl-invoices/invoices.json';

async function readInvoices() {
  try {
    const result = await list({ prefix: INVOICES_PATH, limit: 1 });
    const blob = (result.blobs || []).find((b) => b.pathname === INVOICES_PATH) || result.blobs?.[0];
    if (!blob) return [];
    const r = await fetch(blob.url);
    if (!r.ok) return [];
    const raw = await r.text();
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('[dhl-invoices-store] read:', e.message);
    return [];
  }
}

async function writeInvoices(arr) {
  await put(INVOICES_PATH, JSON.stringify(arr), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
  });
}

export async function getInvoices() {
  return readInvoices();
}

export async function saveInvoice(invoice) {
  const all = await readInvoices();
  const idx = all.findIndex((x) => x.invoiceNumber && x.invoiceNumber === invoice.invoiceNumber);
  const record = {
    ...invoice,
    id: invoice.id || invoice.invoiceNumber || String(Date.now()),
    updatedAt: new Date().toISOString(),
  };
  if (idx >= 0) {
    all[idx] = { ...all[idx], ...record };
  } else {
    all.unshift({ ...record, createdAt: new Date().toISOString() });
  }
  await writeInvoices(all);
  return record;
}

export async function removeInvoice(id) {
  const all = await readInvoices();
  const next = all.filter((x) => String(x.id) !== String(id) && String(x.invoiceNumber) !== String(id));
  if (next.length === all.length) return false;
  await writeInvoices(next);
  return true;
}
