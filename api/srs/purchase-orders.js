import { getPurchaseOrders, purchaseOrderSafetyIdeas } from '../../lib/srs-purchase-orders-client.js';
import { getSrsBranchId } from '../../lib/srs-branches.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

function clean(value) {
  return String(value || '').trim();
}

function branchIdFromRequest(req) {
  const explicit = clean(req.query.branchId || req.query.branch_id);
  if (explicit) return explicit;

  const store = clean(req.query.store);
  if (!store || store === 'GENTS Administratie' || store === 'GENTS Magazijn') return '';

  return getSrsBranchId(store);
}

function buildRiskSignals(orders) {
  const recentReceived = [];
  const partiallyReceived = [];
  const openBySupplier = new Map();

  for (const order of orders || []) {
    const supplier = order.supplier?.name || order.supplier?.id || 'Onbekende leverancier';
    if (!openBySupplier.has(supplier)) openBySupplier.set(supplier, { supplier, openOrders: 0, openPieces: 0 });
    if (order.isOpen) {
      const row = openBySupplier.get(supplier);
      row.openOrders += 1;
      row.openPieces += Number(order.piecesOpen || 0);
    }

    if (Number(order.piecesReceived || 0) > 0) {
      recentReceived.push({
        orderNr: order.orderNr,
        orderReference: order.orderReference,
        supplier: order.supplier?.name || '',
        branchId: order.branchId,
        branchName: order.branchName,
        orderDate: order.orderDate,
        piecesReceived: order.piecesReceived,
        note: 'Recent ontvangen: controleer of deze SKU’s zijn meegenomen in balansen/tellingen.'
      });
    }

    if (Number(order.piecesReceived || 0) > 0 && Number(order.piecesOpen || 0) > 0) {
      partiallyReceived.push({
        orderNr: order.orderNr,
        orderReference: order.orderReference,
        supplier: order.supplier?.name || '',
        piecesReceived: order.piecesReceived,
        piecesOpen: order.piecesOpen,
        note: 'Deels ontvangen: voorkom dat open regels per ongeluk als voorraadverschil worden gezien.'
      });
    }
  }

  return {
    recentReceived,
    partiallyReceived,
    openBySupplier: Array.from(openBySupplier.values()).filter((row) => row.openOrders > 0).sort((a, b) => b.openPieces - a.openPieces)
  };
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (!requireAdmin(req, res)) return;

  try {
    const from = clean(req.query.from || req.query.dateFrom);
    const until = clean(req.query.until || req.query.to || req.query.dateTo);
    const days = Number(req.query.days || 30);
    const status = clean(req.query.status || 'all').toLowerCase();
    const branchId = branchIdFromRequest(req);

    const result = await getPurchaseOrders({ from, until, days, branchId, status });
    const riskSignals = buildRiskSignals(result.orders || []);

    return res.status(200).json({
      ...result,
      mode: 'magazijn_purchase_orders',
      branchId: branchId || 'all',
      riskSignals,
      safetyIdeas: purchaseOrderSafetyIdeas(),
      note: 'Admin-only magazijn endpoint voor PurchaseOrders. Gebruik status=open, status=closed of status=all.'
    });
  } catch (error) {
    console.error('SRS purchase orders error:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'PurchaseOrders konden niet worden opgehaald.',
      details: error.fault || null
    });
  }
}
