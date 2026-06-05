/**
 * Admin endpoint voor customer-service inquiries — vooral store-credit →
 * cash-refund verzoeken.
 *
 *   GET    /api/admin/customer-inquiries                → list + stats
 *   GET    ?id=…                                         → 1 inquiry detail
 *   POST   ?action=create     body { email, orderName, type, message, source }
 *   POST   ?action=lookup     body { email }            → preview customer + giftcards
 *   POST   ?action=resolve    body { id, dryRun?, allowAutoLarge?, resolvedBy? }
 *   POST   ?action=reject     body { id, reason, resolvedBy? }
 *   POST   ?action=note       body { id, note, by }
 */

import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import {
  addInquiry,
  updateInquiry,
  markInquiryResolved,
  markInquiryRejected,
  getInquiry,
  listInquiries,
  readInquiriesStats,
  INQUIRY_TYPES
} from '../../lib/customer-inquiries-store.js';
import {
  processStoreCreditToCashRefund,
  findGiftCardsForCustomer,
  lookupOrderByName
} from '../../lib/shopify-refund-from-credit.js';

export const maxDuration = 60;
const clean = (v) => String(v == null ? '' : v).trim();
const parseBody = (req) => (req.body && typeof req.body === 'object') ? req.body : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;

  try {
    /* GET — list of detail */
    if (req.method === 'GET') {
      const id = clean(req.query?.id);
      if (id) {
        const inq = await getInquiry(id);
        if (!inq) return res.status(404).json({ success: false, message: 'Inquiry niet gevonden.' });
        return res.status(200).json({ success: true, inquiry: inq });
      }
      const [list, stats] = await Promise.all([
        listInquiries({
          status: clean(req.query?.status),
          type: clean(req.query?.type),
          limit: Number(req.query?.limit) || 100
        }),
        readInquiriesStats()
      ]);
      return res.status(200).json({ success: true, inquiries: list, stats, types: INQUIRY_TYPES });
    }

    /* POST */
    const action = clean(req.query?.action);
    const body = parseBody(req);

    if (action === 'create') {
      const email = clean(body.email);
      if (!email) return res.status(400).json({ success: false, message: 'email verplicht.' });
      const entry = await addInquiry(body);
      return res.status(200).json({ success: true, inquiry: entry });
    }

    if (action === 'lookup') {
      const email = clean(body.email);
      if (!email) return res.status(400).json({ success: false, message: 'email verplicht.' });
      try {
        const [gcLookup, order] = await Promise.all([
          findGiftCardsForCustomer(email),
          body.orderName ? lookupOrderByName(body.orderName).catch(() => null) : null
        ]);
        return res.status(200).json({
          success: true,
          customer: gcLookup?.customer || null,
          giftCards: gcLookup?.cards || [],
          order
        });
      } catch (e) {
        return res.status(502).json({ success: false, message: e.message || 'Shopify-lookup faalde.' });
      }
    }

    if (action === 'resolve') {
      const id = clean(body.id);
      if (!id) return res.status(400).json({ success: false, message: 'id verplicht.' });
      const inq = await getInquiry(id);
      if (!inq) return res.status(404).json({ success: false, message: 'Inquiry niet gevonden.' });
      if (inq.type !== INQUIRY_TYPES.STORE_CREDIT_TO_REFUND) {
        return res.status(400).json({ success: false, message: `Type "${inq.type}" heeft geen automatische resolve — gebruik /note + /reject.` });
      }
      const resolvedBy = clean(body.resolvedBy) || clean(req.headers['x-admin-user']) || 'admin';
      const dryRun = body.dryRun !== false; /* default DRY-RUN */
      try {
        const result = await processStoreCreditToCashRefund({
          email: inq.email,
          orderName: inq.orderName,
          giftCardId: inq.giftCardCode || undefined,
          dryRun,
          allowAutoLarge: !!body.allowAutoLarge,
          resolvedBy
        });
        if (!result.ok) {
          /* Niet auto-resolven; admin krijgt feedback en kan handmatig beslissen. */
          return res.status(200).json({ success: true, dryRun, result, inquiry: inq });
        }
        if (dryRun) {
          return res.status(200).json({ success: true, dryRun: true, result, inquiry: inq });
        }
        /* Live uitgevoerd → markeer als resolved met het summary. */
        const updated = await markInquiryResolved(id, {
          resolvedBy,
          resolution: result.summary,
          note: `Auto-resolved: cash refund €${result.summary?.refundedAmount?.toFixed(2)} ${result.summary?.currency} naar oorspronkelijke betaalmethode.`
        });
        return res.status(200).json({ success: true, result, inquiry: updated });
      } catch (e) {
        return res.status(502).json({ success: false, message: e.message || 'Resolve-actie faalde.' });
      }
    }

    if (action === 'reject') {
      const id = clean(body.id);
      if (!id) return res.status(400).json({ success: false, message: 'id verplicht.' });
      const updated = await markInquiryRejected(id, {
        resolvedBy: clean(body.resolvedBy) || clean(req.headers['x-admin-user']) || 'admin',
        reason: clean(body.reason)
      });
      if (!updated) return res.status(404).json({ success: false, message: 'Inquiry niet gevonden.' });
      return res.status(200).json({ success: true, inquiry: updated });
    }

    if (action === 'note') {
      const id = clean(body.id);
      if (!id) return res.status(400).json({ success: false, message: 'id verplicht.' });
      const updated = await updateInquiry(id, {
        note: body.note,
        noteBy: body.by,
        status: body.status || undefined
      });
      if (!updated) return res.status(404).json({ success: false, message: 'Inquiry niet gevonden.' });
      return res.status(200).json({ success: true, inquiry: updated });
    }

    return res.status(400).json({ success: false, message: 'Onbekende action.' });
  } catch (e) {
    console.error('[admin/customer-inquiries]', e);
    return res.status(500).json({ success: false, message: e.message || 'Customer-inquiries fout.' });
  }
}
