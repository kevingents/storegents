import { ingestDhlInvoice, parseDhlInvoice } from '../../lib/dhl-invoice-ingest.js';
import { getInvoices, removeInvoice, markInvoiceSeen, saveInvoices } from '../../lib/dhl-invoices-store.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

/**
 * /api/admin/transport-facturen — DHL-facturen (echte aantallen + kosten).
 *   GET                          → { success, invoices, newCount }
 *   POST { pdfBase64 }           → lees PDF, parse, verrijk (consument/zakelijk), bewaar
 *   POST { markSeen }            → markeer factuur (of '*' = alle) als gezien
 *   DELETE ?id=                  → verwijder een factuur
 *
 * De DHL-factuur is de complete, kost-accurate bron (alle zendingen + gefactureerde
 * bedragen) — i.t.t. de handmatige SendCloud-portal-labels. De extract→parse→verrijk
 * →bewaar-keten zit in lib/dhl-invoice-ingest.js, gedeeld met de e-mail-inbound.
 */

export const config = { maxDuration: 30 };

function clean(v) {
  return String(v || '').trim();
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
      const invoices = await getInvoices();
      const newCount = invoices.filter((i) => !i.seenAt).length;
      return res.status(200).json({ success: true, invoices, newCount });
    }

    if (req.method === 'DELETE') {
      const removed = await removeInvoice(clean(req.query?.id));
      return res.status(200).json({ success: removed, removed });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);

      /* Markeer als gezien (factuur-id of '*' voor alles). */
      if (body.markSeen) {
        const changed = await markInvoiceSeen(clean(body.markSeen));
        return res.status(200).json({ success: true, changed });
      }

      /* Bulk-opslaan van al-geparste facturen in ÉÉN write. Voorkomt dataverlies
         bij meerdere uploads (losse saveInvoice-calls verliezen data door de
         eventually-consistent blob-list). Client: parse elk los (parseOnly),
         verzamel, en stuur de objecten hier in één keer. */
      if (Array.isArray(body.bulkSave)) {
        const result = await saveInvoices(body.bulkSave);
        return res.status(200).json({ success: true, ...result });
      }

      const b64 = clean(body.pdfBase64).replace(/^data:[^,]*,/, '');
      if (!b64) return res.status(400).json({ success: false, message: 'pdfBase64 is verplicht.' });

      try {
        const meta = { source: clean(body.source) || 'upload', addedBy: clean(body.employeeName) || 'portaal' };
        const bytes = Buffer.from(b64, 'base64');
        /* parseOnly: parse + verrijk, maar NIET opslaan (voor bulk-flow). */
        if (body.parseOnly) {
          const invoice = await parseDhlInvoice(bytes, meta);
          return res.status(200).json({ success: true, parsed: true, invoice });
        }
        const saved = await ingestDhlInvoice(bytes, meta);
        return res.status(200).json({ success: true, invoice: saved });
      } catch (e) {
        const status = e.code === 'NOT_DHL' ? 422 : e.code === 'PDF_UNREADABLE' ? 400 : 500;
        return res.status(status).json({ success: false, message: e.message });
      }
    }

    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (error) {
    console.error('[admin/transport-facturen]', error);
    return res.status(500).json({ success: false, message: error.message || 'Verwerking mislukt.' });
  }
}
