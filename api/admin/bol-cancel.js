/**
 * Admin endpoint voor het annuleren van bol-orders.
 *
 *   GET    /api/admin/bol-cancel                    → stats + reason-codes
 *   POST   ?action=cancel                            → body { bolOrderId, reasonCode, reasonText?, orderItemIds?, cancelledBy? }
 *   POST   ?action=mark-only                         → body { bolOrderId, reasonCode, reasonText? } — sla over de Bol-call (recovery)
 *   GET    ?action=is-cancelled&bolOrderId=…         → check
 */

import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import {
  cancelBolOrderEverywhere,
  BOL_CANCEL_REASONS
} from '../../lib/bol-cancel-push.js';
import {
  readBolCancellationsStats,
  isBolOrderCancelled,
  readBolCancellationsState
} from '../../lib/bol-cancellations-store.js';

export const maxDuration = 60;
const clean = (v) => String(v == null ? '' : v).trim();
const parseBody = (req) => (req.body && typeof req.body === 'object') ? req.body : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;

  try {
    const action = clean(req.query?.action);

    if (req.method === 'GET' && action === 'is-cancelled') {
      const id = clean(req.query?.bolOrderId);
      return res.status(200).json({ success: true, bolOrderId: id, cancelled: await isBolOrderCancelled(id) });
    }
    if (req.method === 'GET') {
      const [stats, state] = await Promise.all([readBolCancellationsStats(), readBolCancellationsState()]);
      return res.status(200).json({
        success: true,
        reasons: BOL_CANCEL_REASONS,
        stats,
        cancelled: state.cancelled || {}
      });
    }

    const body = parseBody(req);

    if (action === 'cancel') {
      const bolOrderId = clean(body.bolOrderId);
      if (!bolOrderId) return res.status(400).json({ success: false, message: 'bolOrderId verplicht.' });
      const result = await cancelBolOrderEverywhere(bolOrderId, {
        reasonCode: clean(body.reasonCode) || 'OUT_OF_STOCK',
        reasonText: clean(body.reasonText),
        cancelledBy: clean(body.cancelledBy) || clean(req.headers['x-admin-user']) || 'admin',
        orderItemIds: Array.isArray(body.orderItemIds) ? body.orderItemIds : undefined
      });
      const status = result.ok ? 200 : 502;
      return res.status(status).json({ success: result.ok, ...result });
    }

    if (action === 'mark-only') {
      const bolOrderId = clean(body.bolOrderId);
      if (!bolOrderId) return res.status(400).json({ success: false, message: 'bolOrderId verplicht.' });
      const result = await cancelBolOrderEverywhere(bolOrderId, {
        reasonCode: clean(body.reasonCode) || 'OTHER',
        reasonText: clean(body.reasonText) || 'Handmatig in Bol geannuleerd, alleen state-markering.',
        cancelledBy: clean(body.cancelledBy) || clean(req.headers['x-admin-user']) || 'admin',
        skipBolApi: true
      });
      return res.status(200).json({ success: result.ok, ...result });
    }

    return res.status(400).json({ success: false, message: 'Onbekende action.' });
  } catch (e) {
    console.error('[admin/bol-cancel]', e);
    return res.status(500).json({ success: false, message: e.message || 'Bol-cancel fout.' });
  }
}
