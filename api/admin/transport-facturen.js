import { parseDhlInvoiceText } from '../../lib/dhl-invoice-parser.js';
import { getInvoices, saveInvoice, removeInvoice } from '../../lib/dhl-invoices-store.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

/**
 * /api/admin/transport-facturen — DHL-facturen (echte aantallen + kosten).
 *   GET                          → { success, invoices }
 *   POST { pdfBase64 }           → lees PDF, parse, verrijk (consument/zakelijk), bewaar
 *   DELETE ?id=                  → verwijder een factuur
 *
 * De DHL-factuur is de complete, kost-accurate bron (alle zendingen + gefactureerde
 * bedragen) — i.t.t. de handmatige SendCloud-portal-labels.
 */

export const config = { maxDuration: 30 };

function clean(v) {
  return String(v || '').trim();
}
function round(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function isAuthorized(req) {
  const adminToken = clean(process.env.ADMIN_TOKEN);
  if (!adminToken) return false;
  const token = clean(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query?.adminToken ||
    req.query?.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '');
  return token === adminToken;
}

/** consument (For You / Parcel Connect) vs zakelijk/intern (Europlus e.d.). */
function serviceCategory(name) {
  const s = clean(name).toLowerCase();
  if (s.includes('for you') || s.includes('foryou') || s.includes('parcel connect')) return 'consument';
  return 'zakelijk';
}

function enrich(parsed) {
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

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'DELETE', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'DELETE', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ success: true, invoices: await getInvoices() });
    }

    if (req.method === 'DELETE') {
      const removed = await removeInvoice(clean(req.query?.id));
      return res.status(200).json({ success: removed, removed });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const b64 = clean(body.pdfBase64).replace(/^data:[^,]*,/, '');
      if (!b64) return res.status(400).json({ success: false, message: 'pdfBase64 is verplicht.' });

      let text = '';
      try {
        // unpdf is serverless-vriendelijk (i.t.t. pdf-parse) en lazy-geïmporteerd
        // zodat een eventueel laad-probleem alleen de ingest raakt, niet GET.
        const { extractText, getDocumentProxy } = await import('unpdf');
        const pdf = await getDocumentProxy(new Uint8Array(Buffer.from(b64, 'base64')));
        const result = await extractText(pdf, { mergePages: true });
        text = result?.text || '';
      } catch (e) {
        return res.status(400).json({ success: false, message: `PDF kon niet gelezen worden: ${e.message}` });
      }

      const parsed = parseDhlInvoiceText(text);
      if (!parsed.totalShipments && !parsed.invoiceNumber) {
        return res.status(422).json({
          success: false,
          message: 'Geen herkenbare DHL-factuur (factuurnummer/zendingen niet gevonden).',
        });
      }

      const saved = await saveInvoice(
        enrich({ ...parsed, source: clean(body.source) || 'upload', addedBy: clean(body.employeeName) || 'portaal' })
      );
      return res.status(200).json({ success: true, invoice: saved });
    }

    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (error) {
    console.error('[admin/transport-facturen]', error);
    return res.status(500).json({ success: false, message: error.message || 'Verwerking mislukt.' });
  }
}
