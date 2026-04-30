import { addOrderCancellation } from '../../../lib/order-cancellation-store.js';
import { verifySrsCancellationTarget } from '../../../lib/srs-order-cancellation-client.js';
import { corsJson, requirePost } from '../../../lib/request-guards.js';
import { getBranchIdByStore } from '../../../lib/branch-metrics.js';

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_error) { return {}; }
  }
  return req.body;
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['POST', 'OPTIONS'])) return;
  if (!requirePost(req, res)) return;

  try {
    const body = parseBody(req);
    const store = String(body.store || '').trim();
    const orderNr = String(body.orderNr || body.orderName || '').trim().replace(/^#/, '');
    const type = body.type === 'full' ? 'full' : 'partial';
    const items = Array.isArray(body.items) ? body.items : [];

    if (!store) return res.status(400).json({ success: false, message: 'Winkel ontbreekt.' });
    if (!orderNr) return res.status(400).json({ success: false, message: 'Ordernummer ontbreekt.' });
    if (type === 'partial' && !items.length) return res.status(400).json({ success: false, message: 'Kies minimaal een artikelregel voor deelannulering.' });

    const branchId = body.branchId || getBranchIdByStore?.(store) || '';
    const verification = await verifySrsCancellationTarget({ orderNr, branchId, items });

    if (!verification.ok) {
      return res.status(409).json({
        success: false,
        message: verification.reason,
        srs: {
          fulfilments: verification.fulfilments || []
        }
      });
    }

    const amount = Number(body.amount || items.reduce((sum, item) => sum + (Number(item.amount || item.price || 0) * Number(item.quantity || 1)), 0));

    const { cancellation, duplicate } = await addOrderCancellation({
      store,
      employeeName: body.employeeName || '',
      orderNr,
      type,
      reason: body.reason || 'Niet leverbaar',
      customerEmail: body.customerEmail || '',
      customerName: body.customerName || '',
      amount,
      currency: body.currency || 'EUR',
      items,
      status: 'requested',
      srsStatus: 'pending',
      refundStatus: 'pending',
      mailStatus: 'pending'
    });

    return res.status(200).json({
      success: true,
      duplicate,
      cancellation,
      message: duplicate ? 'Deze annulering stond al klaar.' : 'Annulering is vastgelegd en klaar voor verwerking.'
    });
  } catch (error) {
    console.error('Order cancellation request error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Annulering kon niet worden vastgelegd.' });
  }
}
