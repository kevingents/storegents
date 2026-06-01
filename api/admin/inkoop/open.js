/**
 * /api/admin/inkoop/open
 *
 * Openstaande inkooporders = SRS-PO's (status open, uit GetPurchaseOrders) +
 * lokale orders die nog niet (volledig) zijn afgehandeld. Geeft ook een
 * samenvatting per leverancier zodat je snel ziet waar veel openstaat.
 *
 * Query: ?days=60 (SRS-venster), ?branchId=, ?supplierId=
 * Auth: admin-token vereist.
 */

import { corsJson, requireAdmin } from '../../../lib/request-guards.js';
import { getPurchaseOrders } from '../../../lib/srs-purchase-orders-client.js';
import { listOrders } from '../../../lib/inkoop-store.js';
import { reconcileFromSrs } from '../../../lib/inkoop-reconcile.js';

export const maxDuration = 30;

function clean(v) { return String(v == null ? '' : v).trim(); }

/* Harde timeout zodat een trage SRS-SOAP-call de Vercel-functie nooit over de
   limiet duwt (anders krijgt de browser een platform-timeout zonder CORS-headers
   → "Failed to fetch"). Bij timeout vallen we terug op alleen lokale orders. */
function withTimeout(promise, ms, label) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout na ${ms}ms`)), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    const days = Math.min(Math.max(Number(req.query.days) || 60, 7), 365);
    const branchId = clean(req.query.branchId);
    const supplierId = clean(req.query.supplierId);

    /* SRS-orders (status all, zodat ontvangen orders ook in de set zitten voor de
       reconcile). Best-effort: een SRS-fout mag de lokale lijst niet blokkeren. */
    let srsAll = { orders: [] };
    let srsError = null;
    let reconciled = 0;
    try {
      srsAll = await withTimeout(getPurchaseOrders({ days, status: 'all', branchId }), 9000, 'SRS PurchaseOrders');
      /* Spiegel lokale doorgezette orders tegen de SRS-stand (deels/volledig ontvangen). */
      try {
        const rec = await reconcileFromSrs({ srsOrders: srsAll.orders });
        reconciled = rec.updated;
      } catch (_) { /* reconcile is best-effort */ }
    } catch (e) {
      srsError = e.message || String(e);
    }

    /* Alleen de openstaande SRS-orders tonen. */
    const srsOpenOrders = (srsAll.orders || []).filter((o) => o.isOpen);
    const srs = {
      orders: srsOpenOrders,
      openCount: srsOpenOrders.length,
      piecesOpen: srsOpenOrders.reduce((s, o) => s + (Number(o.piecesOpen) || 0), 0)
    };

    /* Lokale open orders (na reconcile, dus net bijgewerkte statussen). */
    const local = await listOrders({ openOnly: true, branchId, supplierId });

    /* Samenvatting per leverancier (SRS + lokaal samen). */
    const bySupplier = new Map();
    const bump = (name, { srsPieces = 0, localPieces = 0, srsOrders = 0, localOrders = 0 }) => {
      const key = name || 'Onbekende leverancier';
      const row = bySupplier.get(key) || { supplier: key, srsOrders: 0, localOrders: 0, srsPieces: 0, localPieces: 0 };
      row.srsOrders += srsOrders; row.localOrders += localOrders;
      row.srsPieces += srsPieces; row.localPieces += localPieces;
      bySupplier.set(key, row);
    };
    for (const o of srs.orders || []) {
      bump(o.supplier?.name || o.supplier?.id, { srsOrders: 1, srsPieces: Number(o.piecesOpen) || 0 });
    }
    for (const o of local) {
      bump(o.supplierName, { localOrders: 1, localPieces: Number(o.totalPieces) || 0 });
    }
    const summary = Array.from(bySupplier.values())
      .sort((a, b) => (b.srsPieces + b.localPieces) - (a.srsPieces + a.localPieces));

    return res.status(200).json({
      success: true,
      window: { days },
      srsError,
      reconciled,
      srs: {
        count: (srs.orders || []).length,
        openCount: srs.openCount || 0,
        piecesOpen: srs.piecesOpen || 0,
        orders: srs.orders || []
      },
      local: {
        count: local.length,
        orders: local
      },
      summaryBySupplier: summary
    });
  } catch (e) {
    console.error('[admin/inkoop/open]', e);
    return res.status(e.status || 500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
