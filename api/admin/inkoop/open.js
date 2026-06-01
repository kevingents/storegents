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

export const maxDuration = 30;

function clean(v) { return String(v == null ? '' : v).trim(); }

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    const days = Math.min(Math.max(Number(req.query.days) || 60, 7), 365);
    const branchId = clean(req.query.branchId);
    const supplierId = clean(req.query.supplierId);

    /* SRS open PO's (best-effort: een SRS-fout mag de lokale lijst niet blokkeren). */
    let srs = { orders: [], openCount: 0, piecesOpen: 0 };
    let srsError = null;
    try {
      srs = await getPurchaseOrders({ days, status: 'open', branchId });
    } catch (e) {
      srsError = e.message || String(e);
    }

    /* Lokale open orders (concept/verstuurd/doorgezet/deels-ontvangen). */
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
