/**
 * POST /api/reserveringen/update
 *
 * Wijzig reservering-status (opgehaald / opgeheven / verlopen) of patch
 * geldigTot / note / customer.
 *
 * Body: { id, status?, geldigTot?, note?, customer?, actor? }
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { updateReservering } from '../../lib/reserveringen-store.js';
import { payBill } from '../../lib/srs-bills-client.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen POST.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const id = String(body.id || '').trim();
    if (!id) return res.status(400).json({ success: false, message: 'Geef reservering-id mee.' });
    let next = await updateReservering(id, body, body.actor);

    /* Wanneer status naar 'opgehaald' gaat → markeer SRS Bill als betaald.
       Fail-soft: foutmelding wordt opgeslagen op reservering, maar status-
       update naar 'opgehaald' blijft staan zodat winkel verder kan. */
    let billPay = null;
    let billPayError = null;
    if (String(body.status || '').toLowerCase() === 'opgehaald' && next.srsBillNr && Number(next.srsBillAmount) > 0) {
      try {
        const result = await payBill({
          billNr: next.srsBillNr,
          amountPaid: Number(next.srsBillAmount),
          paymentMethod: String(body.paymentMethod || 'Pin'),
          branchId: next.srsBillBranchId || next.resBranchId,
          dateTime: new Date().toISOString().slice(0, 19)
        });
        billPay = result;
        next = await updateReservering(id, {
          srsSyncStatus: result.success ? 'paid' : next.srsSyncStatus,
          srsTransactionId: result.transactionId
        }, body.actor || 'systeem');
      } catch (err) {
        billPayError = { message: err.message, fault: err.fault };
        try {
          next = await updateReservering(id, { srsError: err.message }, 'systeem');
        } catch (_) {}
      }
    }

    return res.status(200).json({ success: true, reservering: next, billPay, billPayError });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
}
