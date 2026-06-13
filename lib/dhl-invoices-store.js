import { readJsonBlob, mutateJsonBlob } from './json-blob-store.js';

/**
 * Opslag van geparste DHL-facturen (Vercel Blob). Eén JSON-array; idempotent op
 * factuurnummer (opnieuw inlezen werkt bij). Bron voor de transport-verdeling
 * (echte aantallen + kosten) en de SendCloud-reconciliatie.
 *
 * Gebruikt json-blob-store (cache-busted verse read + optimistische read-modify-
 * write) zodat een markSeen en een gelijktijdige (e-mail)upload elkaar niet
 * overschrijven en een GET ná een write direct de verse waarde ziet.
 */

const INVOICES_PATH = 'dhl-invoices/invoices.json';

export async function getInvoices() {
  return readJsonBlob(INVOICES_PATH, []);
}

export async function saveInvoice(invoice) {
  let saved = null;
  await mutateJsonBlob(
    INVOICES_PATH,
    (current) => {
      const all = Array.isArray(current) ? current : [];
      const idx = all.findIndex((x) => x.invoiceNumber && x.invoiceNumber === invoice.invoiceNumber);
      const now = new Date().toISOString();
      const record = {
        ...invoice,
        id: invoice.id || invoice.invoiceNumber || String(Date.now()),
        updatedAt: now,
      };
      if (idx >= 0) {
        /* Re-inlezen van dezelfde factuur: behoud createdAt + seenAt (niet
           opnieuw als 'nieuw' tellen). */
        all[idx] = { ...all[idx], ...record };
        saved = all[idx];
        return all;
      }
      /* Nieuwe factuur: seenAt=null → toont als NIEUW tot de gebruiker 'm zag.
         via = hoe binnengekomen (upload | email). */
      saved = { ...record, createdAt: now, seenAt: null, via: invoice.source || 'upload' };
      return [saved, ...all];
    },
    { fallback: [] }
  );
  return saved;
}

/**
 * Bewaar MEERDERE facturen in ÉÉN read-modify-write. Nodig bij bulk-inlezen:
 * losse saveInvoice-calls na elkaar verliezen data doordat Vercel Blob `list()`
 * eventually-consistent is (elke read kan een net-geschreven versie missen →
 * overschrijven). Eén bulk-write leest één keer en voegt alles ineens toe.
 */
export async function saveInvoices(invoices) {
  const items = (Array.isArray(invoices) ? invoices : []).filter((x) => x && x.invoiceNumber);
  if (!items.length) return { added: 0, updated: 0 };
  let added = 0;
  let updated = 0;
  await mutateJsonBlob(
    INVOICES_PATH,
    (current) => {
      const all = Array.isArray(current) ? current : [];
      const now = new Date().toISOString();
      added = 0;
      updated = 0;
      for (const invoice of items) {
        const idx = all.findIndex((x) => x.invoiceNumber && x.invoiceNumber === invoice.invoiceNumber);
        const record = {
          ...invoice,
          id: invoice.id || invoice.invoiceNumber || String(Date.now()),
          updatedAt: now,
        };
        if (idx >= 0) {
          all[idx] = { ...all[idx], ...record };
          updated++;
        } else {
          all.unshift({ ...record, createdAt: now, seenAt: null, via: invoice.source || 'upload' });
          added++;
        }
      }
      return all;
    },
    { fallback: [] }
  );
  return { added, updated };
}

/** Markeer één factuur (of '*' = alle) als gezien → uit de 'nieuw'-telling. */
export async function markInvoiceSeen(id) {
  let changed = 0;
  await mutateJsonBlob(
    INVOICES_PATH,
    (current) => {
      const all = Array.isArray(current) ? current : [];
      const now = new Date().toISOString();
      changed = 0;
      for (const inv of all) {
        const match = id === '*' || String(inv.id) === String(id) || String(inv.invoiceNumber) === String(id);
        if (match && !inv.seenAt) {
          inv.seenAt = now;
          changed++;
        }
      }
      return all;
    },
    { fallback: [] }
  );
  return changed;
}

export async function removeInvoice(id) {
  let removed = false;
  await mutateJsonBlob(
    INVOICES_PATH,
    (current) => {
      const all = Array.isArray(current) ? current : [];
      const next = all.filter((x) => String(x.id) !== String(id) && String(x.invoiceNumber) !== String(id));
      removed = next.length !== all.length;
      return next;
    },
    { fallback: [] }
  );
  return removed;
}
