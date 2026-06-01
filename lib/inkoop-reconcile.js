/**
 * lib/inkoop-reconcile.js
 *
 * Spiegelt lokale inkooporders (die naar SRS zijn doorgezet en een srsOrderNr
 * hebben) tegen GetPurchaseOrders, en zet ze automatisch op deels_ontvangen /
 * ontvangen / geannuleerd op basis van de SRS-stand. Geen dubbele invoer: SRS
 * is leidend voor de ontvangen aantallen.
 */

import { getPurchaseOrders } from './srs-purchase-orders-client.js';
import { listOrders, applyReceiving } from './inkoop-store.js';

/* SRS levert OrderNr soms met voorloopnullen ("00000336"); normaliseer voor match. */
function normNr(nr) {
  const s = String(nr || '').trim().replace(/^0+/, '');
  return s || '0';
}

/* Bepaal de nieuwe lokale status op basis van een SRS-order. Houdt de huidige
   status aan zolang er nog niets ontvangen is (verstuurd/doorgezet blijven staan). */
export function statusFromSrs(srsOrder, currentStatus) {
  const statusName = String(srsOrder?.status?.name || '').toLowerCase();
  const statusId = String(srsOrder?.status?.id || '');
  if (statusId === '2' || statusName.includes('annul')) return 'geannuleerd';
  const ordered = Number(srsOrder?.piecesOrdered) || 0;
  const received = Number(srsOrder?.piecesReceived) || 0;
  if (ordered > 0 && received >= ordered) return 'ontvangen';
  if (received > 0) return 'deels_ontvangen';
  return currentStatus;
}

/**
 * Reconcile alle lokale orders met een srsOrderNr tegen de SRS-stand.
 * @param {object} [opts]
 * @param {number} [opts.days=120]      venster voor de SRS-fetch (genegeerd als srsOrders meegegeven)
 * @param {Array}  [opts.srsOrders]     vooraf opgehaalde SRS-orders (hergebruik i.p.v. extra call)
 * @returns {Promise<{updated:number, checked:number, changes:Array}>}
 */
export async function reconcileFromSrs({ days = 120, srsOrders = null } = {}) {
  let orders = srsOrders;
  if (!orders) {
    const r = await getPurchaseOrders({ days, status: 'all' });
    orders = r.orders || [];
  }
  const byNr = new Map();
  for (const o of orders) byNr.set(normNr(o.orderNr), o);

  const locals = await listOrders({});
  const targets = locals.filter((lo) => lo.srsOrderNr);
  let updated = 0;
  const changes = [];

  for (const lo of targets) {
    const so = byNr.get(normNr(lo.srsOrderNr));
    if (!so) continue;
    const newStatus = statusFromSrs(so, lo.status);
    const received = Number(so.piecesReceived) || 0;
    const ordered = Number(so.piecesOrdered) || 0;
    const open = Math.max(0, ordered - received);
    if (newStatus !== lo.status || received !== (lo.piecesReceived || 0)) {
      const res = await applyReceiving(lo.id, { status: newStatus, piecesReceived: received, piecesOrdered: ordered, piecesOpen: open, actor: 'srs-sync' });
      if (res.changed) {
        updated += 1;
        changes.push({ id: lo.id, orderNr: lo.orderNr, srsOrderNr: lo.srsOrderNr, status: newStatus, piecesReceived: received, piecesOrdered: ordered });
      }
    }
  }
  return { updated, checked: targets.length, changes };
}
