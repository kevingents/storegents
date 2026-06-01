/**
 * /api/admin/inkoop/orders
 *
 * GET    ?status= | ?open=1 | ?supplierId= | ?branchId=  → lokale orders
 *        ?id=...                                          → één order (detail)
 * POST   { mode, ... }
 *          mode 'create'  { supplierId|supplierName, branchId, lines[], ... }
 *          mode 'update'  { id, ...velden }
 *          mode 'status'  { id, status, detail? }
 *          mode 'mail'    { id, to?, cc?, message? }      → mail naar leverancier
 *          mode 'push'    { id }                          → doorzetten naar SRS
 * DELETE ?id=...
 *
 * Auth: admin-token vereist.
 */

import { corsJson, requireAdmin } from '../../../lib/request-guards.js';
import {
  listOrders, getOrder, createOrder, updateOrder, setOrderStatus,
  recordMail, recordSrsPush, deleteOrder, getSupplier
} from '../../../lib/inkoop-store.js';
import { applyReceiving } from '../../../lib/inkoop-store.js';
import { getSrsBranchId } from '../../../lib/srs-branches.js';
import { createPurchaseOrderInSrs, cancelPurchaseOrderInSrs, receivePurchaseOrderInSrs } from '../../../lib/srs-purchase-order-create-client.js';
import { reconcileFromSrs } from '../../../lib/inkoop-reconcile.js';
import { sendMail, baseMailHtml, rowsTable } from '../../../lib/gents-mailer.js';

export const maxDuration = 30;

function clean(v) { return String(v == null ? '' : v).trim(); }
function esc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function euro(n) { return '€ ' + (Number(n) || 0).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
}
function actorOf(req) {
  return clean(req.headers['x-gents-actor'] || parseBody(req).actor || req.query.actor || '') || 'admin';
}

/* Is dit een voorlopige bestelling (pre-order) of een definitieve order?
   Definitief = doorgezet naar SRS (heeft srsOrderNr) of een ontvangst-status. */
function isPreOrder(order) {
  if (clean(order.srsOrderNr)) return false;
  return !['doorgezet', 'deels_ontvangen', 'ontvangen'].includes(order.status);
}

export function orderMailLabel(order) {
  return isPreOrder(order) ? 'Voorlopige bestelling (pre-order)' : 'Inkooporder';
}

/* Order-e-mail naar de leverancier (HTML). */
function buildSupplierMail(order, message) {
  const pre = isPreOrder(order);
  /* Bij een pre-order tonen we geen inkoopprijzen (die vul je later in). */
  const cols = [
    { label: 'Artikel', value: (l) => l.description || l.sku || l.barcode || '' },
    { label: 'Barcode/SKU', value: (l) => l.barcode || l.sku || '' },
    { label: 'Maat', value: (l) => l.size || '' },
    { label: 'Aantal', value: (l) => String(l.quantity || 0) }
  ];
  if (!pre) cols.push({ label: 'Inkoopprijs', value: (l) => euro(l.purchasePrice) });
  /* rowsTable escapet zelf elke cel — hier dus géén esc() gebruiken. */
  const linesHtml = rowsTable(order.lines || [], cols);

  const kind = pre ? 'Voorlopige bestelling (pre-order)' : 'Inkooporder';
  const intro = `${kind} ${esc(order.orderNr)}${order.reference ? ' — ref. ' + esc(order.reference) : ''}`;
  const meta = [
    order.branchName ? `Aflevering: ${esc(order.branchName)}` : '',
    order.expectedDate ? `Gewenste leverdatum: ${esc(order.expectedDate)}` : '',
    pre ? `Totaal: ${order.totalPieces || 0} stuks` : `Totaal: ${order.totalPieces || 0} stuks · ${euro(order.totalValue)}`
  ].filter(Boolean).join(' &middot; ');

  const preBanner = pre
    ? `<div style="margin:0 0 16px;padding:12px 14px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;color:#9a3412;font-size:13px">
         <strong>VOORLOPIGE BESTELLING (pre-order).</strong> Dit is een voorlopige bestelling met barcode en aantal.
         Prijzen en definitieve details volgen in de uiteindelijke inkooporder. Graag bevestigen op beschikbaarheid.
       </div>`
    : '';

  const bodyHtml = `
    ${preBanner}
    ${message ? `<p style="margin:0 0 16px">${esc(message).replace(/\n/g, '<br>')}</p>` : ''}
    <p style="margin:0 0 12px;color:#444">${meta}</p>
    ${linesHtml}
    ${order.notes ? `<p style="margin:16px 0 0;color:#666"><strong>Opmerking:</strong> ${esc(order.notes)}</p>` : ''}`;
  return baseMailHtml({
    title: `${kind} ${esc(order.orderNr)}`,
    intro,
    bodyHtml,
    footer: 'GENTS Herenmode · Verstuurd via het GENTS-portaal.'
  });
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'DELETE', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const id = clean(req.query.id);
      if (id) {
        const order = await getOrder(id);
        if (!order) return res.status(404).json({ success: false, message: 'Order niet gevonden.' });
        return res.status(200).json({ success: true, order });
      }
      const orders = await listOrders({
        status: clean(req.query.status),
        supplierId: clean(req.query.supplierId),
        branchId: clean(req.query.branchId),
        openOnly: clean(req.query.open) === '1'
      });
      return res.status(200).json({ success: true, count: orders.length, orders });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const mode = clean(body.mode || 'create').toLowerCase();
      const actor = actorOf(req);

      if (mode === 'create') {
        /* Resolve branchId uit naam als alleen de winkelnaam is meegegeven. */
        if (!clean(body.branchId) && clean(body.branchName)) {
          body.branchId = getSrsBranchId(clean(body.branchName)) || '';
        }
        const order = await createOrder(body, actor);
        return res.status(200).json({ success: true, order });
      }

      if (mode === 'update') {
        if (!clean(body.id)) return res.status(400).json({ success: false, message: 'id is verplicht.' });
        if (!clean(body.branchId) && clean(body.branchName)) {
          body.branchId = getSrsBranchId(clean(body.branchName)) || '';
        }
        const order = await updateOrder(body.id, body, actor);
        if (!order) return res.status(404).json({ success: false, message: 'Order niet gevonden.' });
        return res.status(200).json({ success: true, order });
      }

      if (mode === 'status') {
        const order = await setOrderStatus(clean(body.id), clean(body.status), actor, clean(body.detail));
        if (!order) return res.status(404).json({ success: false, message: 'Order niet gevonden.' });
        return res.status(200).json({ success: true, order });
      }

      if (mode === 'mail') {
        const order = await getOrder(clean(body.id));
        if (!order) return res.status(404).json({ success: false, message: 'Order niet gevonden.' });
        const supplier = order.supplierId ? await getSupplier(order.supplierId) : null;
        const to = clean(body.to) || order.supplierEmail || supplier?.email || '';
        if (!to) return res.status(400).json({ success: false, message: 'Geen e-mailadres voor deze leverancier. Vul het bij de leverancier in of geef "to" mee.' });
        const cc = body.cc || supplier?.ccEmails || [];
        const html = buildSupplierMail(order, clean(body.message));
        await sendMail({ to, cc, subject: `${orderMailLabel(order)} ${order.orderNr} — GENTS Herenmode`, html });
        const updated = await recordMail(order.id, { to, actor });
        return res.status(200).json({ success: true, mailedTo: to, order: updated });
      }

      if (mode === 'push') {
        const order = await getOrder(clean(body.id));
        if (!order) return res.status(404).json({ success: false, message: 'Order niet gevonden.' });
        const supplier = order.supplierId ? await getSupplier(order.supplierId) : null;
        try {
          const result = await createPurchaseOrderInSrs(order, { srsSupplierId: supplier?.srsId });
          const updated = await recordSrsPush(order.id, { srsOrderNr: result.srsOrderNr, result, actor });
          return res.status(200).json({ success: true, srs: result, order: updated });
        } catch (e) {
          if (e.code === 'PO_PUSH_DISABLED') {
            /* Geen harde fout: order blijft staan, doorzetten is alleen nog niet aan. */
            return res.status(200).json({ success: false, pushEnabled: false, message: e.message });
          }
          throw e;
        }
      }

      if (mode === 'receive') {
        const order = await getOrder(clean(body.id));
        if (!order) return res.status(404).json({ success: false, message: 'Order niet gevonden.' });
        if (!clean(order.srsOrderNr)) return res.status(400).json({ success: false, message: 'Order is nog niet doorgezet naar SRS; binnenmelden kan pas daarna.' });
        /* items meegegeven (per regel ontvangen aantal), anders default: alle openstaande stuks. */
        const items = Array.isArray(body.items) && body.items.length
          ? body.items
          : (order.lines || []).map((l) => ({ barcode: l.barcode, sku: l.sku, pieces: l.quantity, purchasePrice: l.purchasePrice }));
        try {
          const result = await receivePurchaseOrderInSrs(order.srsOrderNr, items);
          const rcv = Number(result.piecesReceived) || 0;
          const ord = Number(result.piecesOrdered) || order.totalPieces || 0;
          const status = ord > 0 && rcv >= ord ? 'ontvangen' : 'deels_ontvangen';
          const { order: updated } = await applyReceiving(order.id, { status, piecesReceived: rcv, piecesOrdered: ord, piecesOpen: Math.max(0, ord - rcv), actor });
          return res.status(200).json({ success: true, srs: result, order: updated });
        } catch (e) {
          if (e.code === 'PO_PUSH_DISABLED') return res.status(200).json({ success: false, pushEnabled: false, message: e.message });
          throw e;
        }
      }

      if (mode === 'cancel') {
        const order = await getOrder(clean(body.id));
        if (!order) return res.status(404).json({ success: false, message: 'Order niet gevonden.' });
        let srsResult = null;
        if (clean(order.srsOrderNr)) {
          try { srsResult = await cancelPurchaseOrderInSrs(order.srsOrderNr); }
          catch (e) { if (e.code !== 'PO_PUSH_DISABLED') throw e; }
        }
        const updated = await setOrderStatus(order.id, 'geannuleerd', actor, srsResult ? 'geannuleerd in SRS' : 'lokaal geannuleerd');
        return res.status(200).json({ success: true, srs: srsResult, order: updated });
      }

      if (mode === 'reconcile') {
        const rec = await reconcileFromSrs({ days: Math.min(Math.max(Number(body.days) || 120, 7), 365) });
        return res.status(200).json({ success: true, ...rec });
      }

      return res.status(400).json({ success: false, message: `Onbekende mode: ${mode}` });
    }

    if (req.method === 'DELETE') {
      const id = clean(req.query.id || parseBody(req).id);
      if (!id) return res.status(400).json({ success: false, message: 'id is verplicht.' });
      const removed = await deleteOrder(id);
      return res.status(200).json({ success: removed, removed });
    }

    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (e) {
    console.error('[admin/inkoop/orders]', e);
    return res.status(e.status || 500).json({ success: false, message: e.message || 'Onbekende fout.', details: e.fault || null });
  }
}
