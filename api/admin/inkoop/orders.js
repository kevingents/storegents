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
import { getSrsBranchId } from '../../../lib/srs-branches.js';
import { createPurchaseOrderInSrs } from '../../../lib/srs-purchase-order-create-client.js';
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

/* Order-e-mail naar de leverancier (HTML). */
function buildSupplierMail(order, message) {
  /* rowsTable escapet zelf elke cel — hier dus géén esc() gebruiken. */
  const linesHtml = rowsTable(order.lines || [], [
    { label: 'Artikel', value: (l) => l.description || l.sku || l.barcode || '' },
    { label: 'Barcode/SKU', value: (l) => l.barcode || l.sku || '' },
    { label: 'Maat', value: (l) => l.size || '' },
    { label: 'Aantal', value: (l) => String(l.quantity || 0) },
    { label: 'Inkoopprijs', value: (l) => euro(l.purchasePrice) }
  ]);
  const intro = `Inkooporder ${esc(order.orderNr)}${order.reference ? ' — ref. ' + esc(order.reference) : ''}`;
  const meta = [
    order.branchName ? `Aflevering: ${esc(order.branchName)}` : '',
    order.expectedDate ? `Gewenste leverdatum: ${esc(order.expectedDate)}` : '',
    `Totaal: ${order.totalPieces || 0} stuks · ${euro(order.totalValue)}`
  ].filter(Boolean).join(' &middot; ');
  const bodyHtml = `
    ${message ? `<p style="margin:0 0 16px">${esc(message).replace(/\n/g, '<br>')}</p>` : ''}
    <p style="margin:0 0 12px;color:#444">${meta}</p>
    ${linesHtml}
    ${order.notes ? `<p style="margin:16px 0 0;color:#666"><strong>Opmerking:</strong> ${esc(order.notes)}</p>` : ''}`;
  return baseMailHtml({
    title: `Inkooporder ${esc(order.orderNr)}`,
    intro,
    bodyHtml,
    footer: 'GENTS Herenmode · Deze inkooporder is verstuurd via het GENTS-portaal.'
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
        await sendMail({ to, cc, subject: `Inkooporder ${order.orderNr} — GENTS Herenmode`, html });
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
