/**
 * lib/dhl-invoice-ingest.js
 *
 * Eén gedeelde verwerkingsketen voor DHL-facturen, gebruikt door zowel de
 * handmatige upload (api/admin/transport-facturen) als de automatische
 * e-mail-inbound (api/webhooks/resend-inbound). Stappen:
 *   PDF-bytes → unpdf-tekst → parseDhlInvoiceText → verrijk (consument/zakelijk)
 *   → saveInvoice (idempotent op factuurnummer).
 *
 * unpdf is serverless-vriendelijk (i.t.t. pdf-parse) en wordt lazy geïmporteerd.
 */

import { parseDhlInvoiceText } from './dhl-invoice-parser.js';
import { saveInvoice } from './dhl-invoices-store.js';

function round(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** consument (For You / Parcel Connect) vs zakelijk/intern (Europlus e.d.). */
export function serviceCategory(name) {
  const s = String(name || '').toLowerCase();
  if (s.includes('for you') || s.includes('foryou') || s.includes('parcel connect')) return 'consument';
  return 'zakelijk';
}

/** Voeg per-categorie uitsplitsing (aantal/kosten/%) toe aan een geparste factuur. */
export function enrich(parsed) {
  const services = (parsed.services || []).map((s) => ({ ...s, category: serviceCategory(s.service) }));
  const sum = (cat) =>
    services
      .filter((s) => s.category === cat)
      .reduce((a, s) => ({ count: a.count + s.count, cost: round(a.cost + s.total) }), { count: 0, cost: 0 });
  const consument = sum('consument');
  const zakelijk = sum('zakelijk');
  const total = parsed.totalShipments || services.reduce((a, s) => a + s.count, 0);
  const pct = (n) => (total ? Math.round((n / total) * 1000) / 10 : 0);
  return {
    ...parsed,
    services,
    breakdown: {
      consument: { ...consument, pct: pct(consument.count) },
      zakelijk: { ...zakelijk, pct: pct(zakelijk.count) },
    },
  };
}

/** Lees PDF-tekst uit bytes met unpdf (serverless-vriendelijk). */
export async function extractPdfText(bytes) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  return text || '';
}

/**
 * Verwerk een DHL-factuur-PDF en bewaar 'm.
 * @param {Buffer|Uint8Array} bytes  rauwe PDF-bytes
 * @param {object} meta              { source: 'upload'|'email', addedBy }
 * @returns {Promise<object>}        het bewaarde factuur-record
 * @throws  Error met code 'PDF_UNREADABLE' of 'NOT_DHL'
 */
export async function ingestDhlInvoice(bytes, meta = {}) {
  let text = '';
  try {
    text = await extractPdfText(bytes);
  } catch (e) {
    const err = new Error(`PDF kon niet gelezen worden: ${e.message}`);
    err.code = 'PDF_UNREADABLE';
    throw err;
  }

  const parsed = parseDhlInvoiceText(text);
  if (!parsed.totalShipments && !parsed.invoiceNumber) {
    const err = new Error('Geen herkenbare DHL-factuur (factuurnummer/zendingen niet gevonden).');
    err.code = 'NOT_DHL';
    throw err;
  }

  return saveInvoice(
    enrich({ ...parsed, source: meta.source || 'upload', addedBy: meta.addedBy || 'portaal' })
  );
}
