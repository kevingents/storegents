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
import { cancelFulfillment } from '../../lib/srs-weborders-cancel-client.js';

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

    /* Wanneer reservering wordt afgesloten (opgehaald / opgeheven / verlopen),
       moet de open weborder in SRS gecanceld worden zodat:
       - Voorraadreservering op RES-filiaal vrijvalt
       - Voorraad valt terug op winkel waar artikel fysiek staat
       - Winkel kan via SRS POS afrekenen op normale verkoop (= echte omzet)
       Reden: er mag GEEN omzet geboekt worden op het RES-filiaal.
       Voor 'verlopen': klant kwam niet → voorraad terug + admin/winkel kan
       het artikel opnieuw aanbieden. */
    const newStatus = String(body.status || '').toLowerCase();
    const skipCancel = Boolean(body.skipCancel);
    const CANCEL_TRIGGERS = new Set(['opgehaald', 'opgeheven', 'verlopen']);
    let cancel = null;
    let cancelError = null;
    const CANCELABLE_SYNC_STATES = new Set(['weborder_created', 'weborder_routed_to_res', 'route_failed']);
    if (!skipCancel && CANCEL_TRIGGERS.has(newStatus) && next.srsTransactionId && CANCELABLE_SYNC_STATES.has(next.srsSyncStatus)) {
      const item = next.item || {};
      try {
        cancel = await cancelFulfillment({
          orderNr: next.srsTransactionId,
          sku: item.sku || item.barcode,
          barcode: item.barcode || item.sku,
          pieces: Math.max(1, Number(item.quantity || 1)),
          price: Number(item.price || 0)
        });
        const success = Boolean(cancel?.success);
        next = await updateReservering(id, {
          srsSyncStatus: success ? 'weborder_cancelled' : 'cancel_failed',
          srsError: success ? '' : (cancel?.messages?.[0] || 'SRS-cancel niet bevestigd')
        }, body.actor || 'systeem');
      } catch (err) {
        cancelError = { message: err.message, fault: err.fault };
        try {
          next = await updateReservering(id, {
            srsSyncStatus: 'cancel_failed',
            srsError: err.message || String(err)
          }, body.actor || 'systeem');
        } catch (_) { /* swallow */ }
      }
    }

    return res.status(200).json({ success: true, reservering: next, cancel, cancelError });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
}
