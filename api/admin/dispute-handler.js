/**
 * Admin endpoint voor automatisch afhandelen van Shopify Payments disputes.
 *
 *   GET    /api/admin/dispute-handler                  → open disputes + stats
 *   POST   ?action=preview   body { disputeId? }       → DRY-RUN: toon evidence zonder te posten
 *   POST   ?action=handle    body { disputeId, submit? } → evidence opslaan (submit=true = definitief)
 *   POST   ?action=handle-all body { submit? }          → alle open disputes verwerken
 */

import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import {
  fetchOpenDisputes,
  handleDispute,
  handleAllOpenDisputes
} from '../../lib/shopify-dispute-handler.js';
import { getReturnRequests } from '../../lib/returnista-client.js';

export const maxDuration = 120;

const clean = (v) => String(v == null ? '' : v).trim();
const parseBody = (req) => (req.body && typeof req.body === 'object') ? req.body : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      /* Geef overview van open disputes + Returnista-matches.
         Fouten per stap worden apart gevangen zodat we altijd een nuttige
         response terugkrijgen i.p.v. een blinde 500. */
      let disputes = [], disputeError = null;
      let returnRequests = [], returnistaError = null;

      try {
        disputes = await fetchOpenDisputes({ limit: 50 });
      } catch (e) {
        disputeError = e.message;
        console.error('[dispute-handler] fetchOpenDisputes fout:', e.message);
      }
      try {
        returnRequests = await getReturnRequests({ maxRecords: 1000 });
      } catch (e) {
        returnistaError = e.message;
        console.warn('[dispute-handler] getReturnRequests fout:', e.message);
      }
      /* Vereenvoudigde matching-stats voor overview.
         REST API geeft order_id (numeriek) ipv order-naam; we matchen op beide. */
      const enriched = disputes.map((d) => {
        const orderName = d.order?.name || (d.order?.orderId ? `#${d.order.orderId}` : '');
        const orderId = String(d.order?.orderId || '');
        const nr = orderName.replace(/^#/, '').toLowerCase();
        const matched = returnRequests.filter((r) => {
          const rNr = clean(r.purchaseOrderNumber || r.shopifyOrderNr || '').replace(/^#/, '').toLowerCase();
          const rId = clean(r.shopifyOrderId || '');
          return (nr && rNr === nr) || (orderId && rId === orderId);
        });
        return {
          id: d.id,
          gid: d.gid,
          status: d.status,
          type: d.type,
          amount: d.amount,
          evidenceDueBy: d.evidenceDueBy,
          evidenceSentOn: d.evidenceSentOn,
          orderName: orderName || `order ${orderId}`,
          orderId,
          customerEmail: d.order?.customer?.email || d.order?.email || '',
          reason: d.reasonDetails?.reason,
          returnistaMatches: matched.length,
          returnistaResolutions: matched.map((r) => r.requestedResolution || r.resolution),
          returnistaStatuses: matched.map((r) => r.status),
          alreadySubmitted: !!d.evidenceSentOn
        };
      });
      return res.status(200).json({
        success: !disputeError,
        count: disputes.length,
        disputes: enriched,
        errors: { disputes: disputeError, returnista: returnistaError }
      });
    }

    const action = clean(req.query?.action);
    const body = parseBody(req);

    /* Preview of handle één dispute */
    if (action === 'preview' || action === 'handle') {
      const disputeId = clean(body.disputeId);
      if (!disputeId) return res.status(400).json({ success: false, message: 'disputeId verplicht.' });

      /* Haal alle open disputes op en vind de juiste. */
      const [allDisputes, allReturnRequests] = await Promise.all([
        fetchOpenDisputes({ limit: 50 }),
        getReturnRequests({ maxRecords: 1000 }).catch(() => [])
      ]);
      const dispute = allDisputes.find((d) => d.id === disputeId || d.id.endsWith(`/${disputeId}`));
      if (!dispute) return res.status(404).json({ success: false, message: `Dispute ${disputeId} niet gevonden of niet meer openstaand.` });

      const dryRun = action === 'preview' || body.dryRun !== false;
      const submit = !dryRun && !!body.submit;
      const result = await handleDispute(dispute, allReturnRequests, { dryRun, submit });
      return res.status(result.ok ? 200 : 502).json({ success: result.ok, ...result });
    }

    /* Handle alle open disputes in 1 run. */
    if (action === 'handle-all') {
      const dryRun = body.dryRun !== false; /* default DRY-RUN */
      const submit = !dryRun && !!body.submit;
      const [allReturnRequests] = await Promise.all([
        getReturnRequests({ maxRecords: 2000 }).catch(() => [])
      ]);
      const result = await handleAllOpenDisputes(allReturnRequests, { dryRun, submit, maxDisputes: 50 });
      return res.status(200).json({ success: true, ...result });
    }

    return res.status(400).json({ success: false, message: 'Onbekende action.' });
  } catch (e) {
    console.error('[admin/dispute-handler]', e);
    return res.status(500).json({ success: false, message: e.message || 'Dispute-handler fout.' });
  }
}
